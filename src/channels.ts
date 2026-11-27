import { createHash, randomBytes } from 'node:crypto'
import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm'
import { adapterFor, clock, recordEvent, resolveProviderApp, type EngineContext } from './context.js'
import { storeCredential } from './credentials.js'
import type { Executor } from './db/client.js'
import {
  channelCredentials, channels, conversationChecks, jobs, oauthStates, outgoingMessages, publishingControls, replies, type ChannelKind, type Platform,
} from './db/schema.js'
import { conflict, EngineError, invalid, notFound } from './errors.js'
import type { ChannelTarget, ConnectedAccount } from './platforms/types.js'
import { messageAvailability, replyAvailability, type MessageAvailability, type ReplyAvailability } from './reply-availability.js'
import type { LengthUnit } from './text-length.js'
import { forgetChannelConversations, forgetChannelResponses } from './retention.js'
import { changeChannelStatus, emitChannelStatus } from './webhooks.js'

const stateLifetimeMs = 10 * 60_000

export interface ChannelView {
  id: string
  platform: string
  kind: string
  name: string
  externalId: string
  status: string
  /** The longest post text, counted in `lengthUnit`. */
  maxLength: number
  maxMedia: number
  lengthUnit: LengthUnit
  /** The longest `title` setting, where the kind takes one. */
  titleMaxLength?: number
  /** Whether people can reply to comments on it, and why not. */
  replies: ReplyAvailability
  /** Whether direct messages can be sent on it, and why not. */
  messages: MessageAvailability
}

/** What an adapter is told about a channel. Instagram channels are named @username, which tells the account's own comments. */
export function channelTarget(channel: Pick<typeof channels.$inferSelect, 'id' | 'kind' | 'externalId' | 'name'>): ChannelTarget {
  const handle = channel.kind === 'instagram_account' && /^@[\w.]{1,100}$/.test(channel.name) ? channel.name.slice(1) : undefined
  return { id: channel.id, kind: channel.kind, externalId: channel.externalId, ...(handle ? { handle } : {}) }
}

export async function startConnect(context: EngineContext, organizationId: string, providerAppId: string) {
  const app = await resolveProviderApp(context, context.db, providerAppId)
  if (app.ownerKind === 'tenant' && app.ownerOrganizationId !== organizationId) throw notFound('Provider app')
  const state = randomBytes(32).toString('base64url')
  await context.db.insert(oauthStates).values({ stateHash: hashState(state), organizationId, providerAppId,
    expiresAt: new Date(clock(context).getTime() + stateLifetimeMs) })
  return { authorizeUrl: adapterFor(context, app.platform).authorizeUrl(app, state), state }
}

export async function finishConnect(context: EngineContext, organizationId: string, state: string, code: string) {
  // Single use: the state is consumed before the code is exchanged.
  const [claimed] = await context.db.update(oauthStates).set({ usedAt: clock(context) })
    .where(and(eq(oauthStates.stateHash, hashState(state)), eq(oauthStates.organizationId, organizationId),
      isNull(oauthStates.usedAt), gt(oauthStates.expiresAt, clock(context))))
    .returning({ providerAppId: oauthStates.providerAppId })
  if (!claimed) throw invalid('invalid_state', 'The authorization request expired or was already used')
  const app = await resolveProviderApp(context, context.db, claimed.providerAppId)
  const accounts = await adapterFor(context, app.platform).finishConnect(app, code)
  const connected = await context.db.transaction(async transaction => {
    const ids: string[] = []
    for (const account of accounts) ids.push(await storeConnectedAccount(context, transaction, organizationId, app.id, app.platform, account, 'channel.connected'))
    return ids
  })
  return { channels: connected.length ? await listChannels(context, organizationId, connected) : [] }
}

/** Stores one account a connect returned as the tenant's channel, with its sealed grant, as connected or reconnected. Returns the channel ID. */
export async function storeConnectedAccount(context: EngineContext, transaction: Executor, organizationId: string, providerAppId: string, platform: Platform,
  account: ConnectedAccount, eventKind: string) {
  // A new grant: its scopes as the platform reported them, and no permission refused yet.
  const grant = { grantedScopes: account.grantedScopes ?? null, refusedScopes: [] }
  const parent = { parentExternalId: account.parentExternalId ?? null }
  const previous = await previousStatus(transaction, providerAppId, account.externalId, organizationId)
  const [channel] = await transaction.insert(channels).values({ organizationId, providerAppId, platform,
    kind: account.kind, externalId: account.externalId, name: account.name, ...parent, ...grant })
    .onConflictDoUpdate({ target: [channels.providerAppId, channels.externalId, channels.organizationId],
      set: { name: account.name, kind: account.kind, status: 'active', ...parent, ...grant, updatedAt: clock(context) } })
    .returning()
  await emitChannelStatus(transaction, channel!, previous, previous ? 'reconnected' : 'connected', clock(context))
  await storeCredential(context, transaction, channel!.id, { accessToken: account.token, expiresAt: account.tokenExpiresAt,
    ...(account.refreshToken ? { refreshToken: account.refreshToken } : {}) })
  await scheduleConversations(context, transaction, channel!)
  await recordEvent(transaction, { organizationId, kind: eventKind, channelId: channel!.id, detail: { providerAppId, externalId: account.externalId } })
  return channel!.id
}

/**
 * A channel that can message has its conversations read at once after a
 * connect: a reconnect clears the last failure and any backoff.
 */
async function scheduleConversations(context: EngineContext, executor: Executor, channel: typeof channels.$inferSelect) {
  const rules = context.adapters.get(channel.platform)?.messageRules?.(channel.kind)
  // Webhook-only kinds (WhatsApp) have nothing to read.
  if (!rules || rules.inbound === 'webhook') return
  const now = clock(context)
  const values = { nextCheckAt: now, failureCount: 0, lastError: null, backoffUntil: null, rateLimitCount: 0, updatedAt: now }
  // A reconnect keeps the time watching began, so it announces nothing twice.
  await executor.insert(conversationChecks).values({ channelId: channel.id, organizationId: channel.organizationId, ...values, createdAt: now })
    .onConflictDoUpdate({ target: conversationChecks.channelId, set: values })
}

/** The status of the tenant's channel for this account before a connect, or null when it is new. */
async function previousStatus(executor: Executor, providerAppId: string, externalId: string, organizationId: string) {
  const [row] = await executor.select({ status: channels.status }).from(channels)
    .where(and(eq(channels.providerAppId, providerAppId), eq(channels.externalId, externalId), eq(channels.organizationId, organizationId))).for('update').limit(1)
  return row?.status ?? null
}

/** Channel kinds each OAuth platform can hold. */
const platformKinds: Record<Platform, readonly ChannelKind[]> = {
  meta: ['facebook_page', 'instagram_account'], instagram: ['instagram_account'], youtube: ['youtube_channel'],
  // Browser platforms have no OAuth grants to import.
  tiktok: [], x: [], linkedin: [], threads: [], pinterest: [], reddit: [],
  whatsapp: ['whatsapp_number'],
}

export interface ImportedChannel {
  organizationId: string
  providerAppId: string
  kind: ChannelKind
  externalId: string
  name: string
  credential: { accessToken: string, refreshToken?: string, expiresAt: Date | null }
}

/**
 * Operator migration: stores a grant obtained outside the engine's connect
 * flow (another tool's OAuth tokens for the same provider app), as if the
 * owner had just connected the channel.
 */
export async function importChannel(context: EngineContext, input: ImportedChannel) {
  const app = await resolveProviderApp(context, context.db, input.providerAppId)
  if (app.ownerKind === 'tenant' && app.ownerOrganizationId !== input.organizationId) throw notFound('Provider app')
  if (!platformKinds[app.platform].includes(input.kind)) throw invalid('unsupported_channel', `A ${app.platform} provider app cannot hold ${input.kind} channels`)
  return context.db.transaction(async transaction => {
    // An imported grant's scopes are unknown until a send or a renewal tells.
    const grant = { grantedScopes: null, refusedScopes: [] }
    const previous = await previousStatus(transaction, app.id, input.externalId, input.organizationId)
    const [channel] = await transaction.insert(channels).values({ organizationId: input.organizationId, providerAppId: app.id, platform: app.platform,
      kind: input.kind, externalId: input.externalId, name: input.name, ...grant })
      .onConflictDoUpdate({ target: [channels.providerAppId, channels.externalId, channels.organizationId],
        set: { name: input.name, kind: input.kind, status: 'active', ...grant, updatedAt: clock(context) } })
      .returning()
    await emitChannelStatus(transaction, channel!, previous, previous ? 'reconnected' : 'connected', clock(context))
    await storeCredential(context, transaction, channel!.id, input.credential)
    await scheduleConversations(context, transaction, channel!)
    await recordEvent(transaction, { organizationId: input.organizationId, kind: 'channel.imported', channelId: channel!.id,
      detail: { providerAppId: app.id, externalId: input.externalId } })
    return { channelId: channel!.id }
  })
}

export async function listChannels(context: EngineContext, organizationId: string, ids?: string[]): Promise<ChannelView[]> {
  const rows = await context.db.select().from(channels)
    .where(and(eq(channels.organizationId, organizationId), ids ? inArray(channels.id, ids) : undefined))
    .orderBy(channels.name)
  return rows.map(row => {
    const limits = adapterFor(context, row.platform).limits(row.kind)
    return { id: row.id, platform: row.platform, kind: row.kind, name: row.name, externalId: row.externalId, status: row.status, ...limits,
      lengthUnit: limits.lengthUnit ?? 'characters',
      replies: replyAvailability(context, row), messages: messageAvailability(context, row) }
  })
}

/** Removes the credential. Refused while a job, a reply or a message on the channel is unsettled. */
export async function disableChannel(context: EngineContext, organizationId: string, channelId: string) {
  return context.db.transaction(async transaction => {
    const [channel] = await transaction.select().from(channels)
      .where(and(eq(channels.organizationId, organizationId), eq(channels.id, channelId))).for('update').limit(1)
    if (!channel) throw notFound('Channel')
    const [busy] = await transaction.select({ id: jobs.id }).from(jobs)
      .where(and(eq(jobs.channelId, channelId), inArray(jobs.state, ['queued', 'running', 'uncertain']))).limit(1)
    if (busy) throw conflict('channel_busy', 'Cancel or settle the jobs on this channel first')
    const [replying] = await transaction.select({ id: replies.id }).from(replies)
      .where(and(eq(replies.channelId, channelId), inArray(replies.state, ['queued', 'sending', 'uncertain']))).limit(1)
    if (replying) throw conflict('channel_busy', 'Cancel or settle the replies on this channel first')
    const [messaging] = await transaction.select({ id: outgoingMessages.id }).from(outgoingMessages)
      .where(and(eq(outgoingMessages.channelId, channelId), inArray(outgoingMessages.state, ['queued', 'sending', 'uncertain']))).limit(1)
    if (messaging) throw conflict('channel_busy', 'Cancel or settle the messages on this channel first')
    await transaction.delete(channelCredentials).where(eq(channelCredentials.channelId, channelId))
    // Comments and direct messages are third-party personal data; they go with the channel.
    await forgetChannelResponses(transaction, channelId)
    await forgetChannelConversations(transaction, channelId)
    await changeChannelStatus(transaction, channelId, 'disabled', 'disabled', clock(context))
    await recordEvent(transaction, { organizationId, kind: 'channel.disabled', channelId })
    return { disabled: true }
  })
}

export const defaultDailyLimit = 10

export async function setPublishing(context: EngineContext, organizationId: string, paused: boolean, pausedChannelIds: string[], maxPostsPerChannelPerDay?: number) {
  return context.db.transaction(async transaction => {
    await lockControls(transaction, organizationId)
    const values = { paused, pausedChannelIds: [...new Set(pausedChannelIds)].sort(), updatedAt: clock(context),
      ...(maxPostsPerChannelPerDay === undefined ? {} : { maxPostsPerChannelPerDay }) }
    await transaction.insert(publishingControls).values({ organizationId, ...values })
      .onConflictDoUpdate({ target: publishingControls.organizationId, set: values })
    await recordEvent(transaction, { organizationId, kind: 'publishing.updated', detail: { paused, pausedChannelIds: values.pausedChannelIds, maxPostsPerChannelPerDay } })
    return readPublishing(transaction, organizationId)
  })
}

export async function readPublishing(executor: Executor, organizationId: string) {
  const [row] = await executor.select().from(publishingControls).where(eq(publishingControls.organizationId, organizationId)).limit(1)
  return { paused: row?.paused ?? false, pausedChannelIds: row?.pausedChannelIds ?? [], maxPostsPerChannelPerDay: row?.maxPostsPerChannelPerDay ?? defaultDailyLimit }
}

/** Serializes pause updates with job claims for one tenant. */
export async function lockControls(executor: Executor, organizationId: string) {
  await executor.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`controls:${organizationId}`}, 0))`)
}

function hashState(state: string) {
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(state)) throw new EngineError(400, 'invalid_state', 'The authorization request expired or was already used')
  return createHash('sha256').update(state).digest('hex')
}
