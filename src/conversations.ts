import { and, asc, desc, eq, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm'
import type { CallBudget } from './budget.js'
import { channelTarget } from './channels.js'
import { clock, type EngineContext } from './context.js'
import type { Executor } from './db/client.js'
import {
  channelKinds, channels, conversationChecks, conversations, directMessages, outgoingMessages, type MessagingPlatform,
} from './db/schema.js'
import { notFound } from './errors.js'
import { channelDriver } from './jobs/driver.js'
import { errorFields, log } from './log.js'
import { RateLimited, ReauthRequired, type PlatformAdapter, type PlatformConversation, type PlatformMessage } from './platforms/types.js'
import { decodeCursor, encodeCursor, responseRetryDelayMs } from './responses.js'
import { messagesRetentionMs } from './retention.js'
import { emitWebhookEvents } from './webhooks.js'
import { markNeedsReauth } from './token-check.js'

// Direct messages, read side. The content read here is untrusted:
// this module stores it and makes channels due, and holds no sending code.

const minuteMs = 60_000
const hourMs = 60 * minuteMs
const dayMs = 24 * hourMs

/** How often the worker looks for due syncs, and how many channels it syncs per pass. */
export const conversationsIntervalMs = 15_000
const syncsPerPass = 5
/** Fallback cadence when no notification arrives. */
export const conversationSyncIntervalMs = 30 * minuteMs
/** At most one sync a minute per channel, however often it is asked for. */
export const minSyncGapMs = minuteMs
/** A claimed sync whose worker died is taken again after this. */
const syncLeaseMs = 5 * minuteMs
/** A refused read (a missing permission, messaging turned off) is tried again once a day. */
export const unavailableSyncRetryMs = dayMs
/** The person's last message opens a 24-hour window for answering. */
export const answerWindowMs = 24 * hourMs

/** 15 minutes after a rate limit, doubling with each one in a row, to at most 4 hours. */
export function conversationBackoffMs(rateLimitCount: number) {
  return Math.min(15 * minuteMs * 2 ** Math.max(0, rateLimitCount - 1), 4 * hourMs)
}

/** Until when the channel may answer, from the person's newest stored message; null when they never wrote. */
export function windowOpenUntil(lastInboundAt: Date | null) {
  return lastInboundAt ? new Date(lastInboundAt.getTime() + answerWindowMs) : null
}

/** Channels the configured adapters read conversations on: active OAuth channels of a kind with message rules that are read, not only notified (WhatsApp). */
function messagingChannels(context: EngineContext): SQL | null {
  const read = (rules: ReturnType<NonNullable<PlatformAdapter['messageRules']>>) => Boolean(rules && rules.inbound !== 'webhook')
  const pairs = [...context.adapters].flatMap(([platform, adapter]) => adapter.conversations && adapter.messageRules
    ? channelKinds.filter(kind => read(adapter.messageRules!(kind))).map(kind => and(eq(channels.platform, platform), eq(channels.kind, kind))!) : [])
  return pairs.length ? and(eq(channels.status, 'active'), sql`${channels.providerAppId} is not null`, or(...pairs))! : null
}

/** Creates the missing checks of channels that can message, due at once. Channels connected before direct messages existed get theirs here. */
async function ensureChecks(context: EngineContext, scope?: SQL) {
  const messaging = messagingChannels(context)
  if (!messaging) return
  const now = clock(context)
  const missing = await context.db.select({ id: channels.id, organizationId: channels.organizationId }).from(channels)
    .leftJoin(conversationChecks, eq(conversationChecks.channelId, channels.id))
    .where(and(messaging, isNull(conversationChecks.channelId), scope)).limit(500)
  if (!missing.length) return
  await context.db.insert(conversationChecks).values(missing.map(row => ({ channelId: row.id, organizationId: row.organizationId, nextCheckAt: now, createdAt: now, updatedAt: now })))
    .onConflictDoNothing()
}

/** Brings checks forward to now, but never within a minute of their last sync. Returns the channels made due. */
async function makeDue(executor: Executor, scope: SQL, now: Date) {
  const rows = await executor.update(conversationChecks).set({ updatedAt: now,
    nextCheckAt: sql`least(${conversationChecks.nextCheckAt}, greatest(${now}::timestamptz, coalesce(${conversationChecks.checkedAt} + ${`${minSyncGapMs} milliseconds`}::interval, ${now}::timestamptz)))` })
    .where(scope).returning({ channelId: conversationChecks.channelId })
  return rows.map(row => row.channelId)
}

/** The dashboard asks for a sync of the tenant's channels, or of one. */
export async function requestConversationSync(context: EngineContext, organizationId: string, channelId?: string) {
  if (channelId) {
    const [channel] = await context.db.select({ id: channels.id }).from(channels)
      .where(and(eq(channels.organizationId, organizationId), eq(channels.id, channelId))).limit(1)
    if (!channel) throw notFound('Channel')
  }
  await ensureChecks(context, and(eq(channels.organizationId, organizationId), channelId ? eq(channels.id, channelId) : undefined))
  const channelIds = await makeDue(context.db, and(eq(conversationChecks.organizationId, organizationId),
    channelId ? eq(conversationChecks.channelId, channelId) : undefined)!, clock(context))
  return { channelIds }
}

/**
 * Meta's webhook told the dashboard that something changed on these Pages
 * or Instagram accounts; the dashboard forwards only their IDs. Nothing in
 * the notification is trusted: the matching channels are read again.
 */
export async function notifyMeta(context: EngineContext, objects: Array<{ object: 'page' | 'instagram', id: string }>) {
  const pages = objects.filter(value => value.object === 'page').map(value => value.id)
  const accounts = objects.filter(value => value.object === 'instagram').map(value => value.id)
  const matching = or(
    pages.length ? and(eq(channels.platform, 'meta'), eq(channels.kind, 'facebook_page'), inArray(channels.externalId, pages)) : undefined,
    accounts.length ? and(inArray(channels.platform, ['meta', 'instagram']), eq(channels.kind, 'instagram_account'), inArray(channels.externalId, accounts)) : undefined)
  if (!matching) return { channelIds: [] }
  await ensureChecks(context, matching)
  const ids = context.db.select({ id: channels.id }).from(channels).where(matching)
  return { channelIds: await makeDue(context.db, inArray(conversationChecks.channelId, ids), clock(context)) }
}

type Channel = typeof channels.$inferSelect

const latest = (dates: Date[]) => dates.length ? new Date(Math.max(...dates.map(value => value.getTime()))) : null

/**
 * Stores one conversation and its messages in one transaction. Messages are
 * never updated: a message stored once stays as it was. Webhooks hear of each
 * inbound message the first time it is stored, oldest first, when it was sent
 * after `announceSince`: a channel's history, read on its first syncs, is not
 * announced, so an auto-responder only sees new messages.
 */
async function storeConversation(context: EngineContext, channel: Channel, platform: MessagingPlatform, conversation: PlatformConversation,
  messages: PlatformMessage[], now: Date, announceSince: Date) {
  // A message past retention was deleted, or soon will be: it is not stored (and announced) again.
  const horizon = now.getTime() - messagesRetentionMs
  const unique = [...new Map(messages.filter(message => message.sentAt.getTime() >= horizon).map(message => [message.externalId, message])).values()]
  const lastInbound = latest(unique.filter(message => !message.fromChannel).map(message => message.sentAt))
  const lastMessage = latest(unique.map(message => message.sentAt)) ?? conversation.updatedAt
  const participant = conversation.participant
  const keep = (column: string) => sql`case when excluded.participant_external_id is not null then excluded.${sql.identifier(column)}
    else ${sql.identifier('conversations')}.${sql.identifier(column)} end`
  await context.db.transaction(async transaction => {
    const [stored] = await transaction.insert(conversations).values({ organizationId: channel.organizationId, channelId: channel.id, platform,
      externalId: conversation.externalId, participantExternalId: participant?.externalId ?? null, participantName: participant?.name ?? null,
      participantUsername: participant?.username ?? null, updatedTime: conversation.updatedAt, lastInboundAt: lastInbound, lastMessageAt: lastMessage,
      createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: [conversations.channelId, conversations.externalId], set: {
        participantExternalId: keep('participant_external_id'), participantName: keep('participant_name'), participantUsername: keep('participant_username'),
        updatedTime: sql`excluded.updated_time`,
        // `greatest` skips nulls: a page without the person's messages keeps the stored time.
        lastInboundAt: sql`greatest(${conversations.lastInboundAt}, excluded.last_inbound_at)`,
        lastMessageAt: sql`greatest(${conversations.lastMessageAt}, excluded.last_message_at)`, updatedAt: now,
      } }).returning()
    if (!unique.length) return
    // Only the rows stored for the first time come back.
    const inserted = await transaction.insert(directMessages).values(unique.map(message => ({ organizationId: channel.organizationId, channelId: channel.id,
      conversationId: stored!.id, externalId: message.externalId, direction: message.fromChannel ? 'out' as const : 'in' as const, text: message.text,
      attachments: message.attachments, sentAt: message.sentAt, firstSeenAt: now })))
      .onConflictDoNothing({ target: [directMessages.channelId, directMessages.externalId] }).returning()
    const received = inserted.filter(row => row.direction === 'in' && row.sentAt >= announceSince).sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime())
    await emitWebhookEvents(transaction, { organizationId: channel.organizationId, type: 'message.received', channelId: channel.id, occurredAt: now,
      items: received.map(message => ({ channelId: channel.id, conversationId: stored!.id, messageId: message.id, platform,
        participant: { name: stored!.participantName, username: stored!.participantUsername }, text: message.text, attachments: message.attachments,
        sentAt: message.sentAt.toISOString() })) })
  })
}

type SyncResult = { kind: 'ok', pending: boolean } | { kind: 'unavailable', reason: string }

/**
 * One sync: the newest page of conversations, then the messages of each
 * whose `updated_time` moved since it was stored. Each request spends one
 * call from the budget; conversations the budget leaves out are read on a
 * sync a minute later (`pending`), and are not marked as read meanwhile.
 */
async function syncChannel(context: EngineContext, channel: Channel, announceSince: Date, budget?: CallBudget): Promise<SyncResult> {
  const adapter = context.adapters.get(channel.platform)
  const rules = adapter?.messageRules?.(channel.kind)
  if (!adapter?.conversations || !adapter.conversationMessages || !rules) return { kind: 'unavailable', reason: 'Messages are not read on this channel.' }
  const { app, token } = await channelDriver(context, context.db, channel)
  const target = channelTarget(channel)
  const listed = await adapter.conversations(app, { channel: target, token })
  if (listed.kind === 'unavailable') return listed
  const ids = listed.conversations.map(conversation => conversation.externalId)
  const stored = ids.length ? await context.db.select({ externalId: conversations.externalId, updatedTime: conversations.updatedTime }).from(conversations)
    .where(and(eq(conversations.channelId, channel.id), inArray(conversations.externalId, ids))) : []
  const known = new Map(stored.map(row => [row.externalId, row.updatedTime.getTime()]))
  let pending = false
  for (const conversation of listed.conversations) {
    const before = known.get(conversation.externalId)
    if (before !== undefined && before >= conversation.updatedAt.getTime()) continue
    if (budget && !budget.take(channel.platform)) {
      pending = true
      break
    }
    let messages: PlatformMessage[]
    try {
      messages = await adapter.conversationMessages(app, { channel: target, token, conversationExternalId: conversation.externalId })
    } catch (error) {
      if (error instanceof RateLimited || error instanceof ReauthRequired) throw error
      // One conversation that cannot be read does not hold up the others; it is tried on the next sync.
      log('warn', 'conversation read failed', { channelId: channel.id, ...errorFields(error) })
      continue
    }
    await storeConversation(context, channel, rules.platform, conversation, messages, clock(context), announceSince)
  }
  return { kind: 'ok', pending }
}

/**
 * Syncs due channels, one after another: each claimed under `FOR UPDATE SKIP
 * LOCKED` with a lease, so two workers never read the same channel at once.
 * Spends from the collectors' call budget; a channel the budget cannot pay
 * for is released for the next pass.
 */
export async function collectDueConversations(context: EngineContext, budget?: CallBudget, limit = syncsPerPass) {
  const messaging = messagingChannels(context)
  if (!messaging) return { synced: 0, failed: 0 }
  await ensureChecks(context)
  const now = clock(context)
  const leaseEnd = new Date(now.getTime() + syncLeaseMs)
  const claimed = await context.db.transaction(async transaction => {
    const rows = await transaction.select({ check: conversationChecks, channel: channels }).from(conversationChecks)
      .innerJoin(channels, eq(channels.id, conversationChecks.channelId))
      .where(and(lte(conversationChecks.nextCheckAt, now), or(isNull(conversationChecks.backoffUntil), lte(conversationChecks.backoffUntil, now)), messaging))
      .orderBy(asc(conversationChecks.nextCheckAt)).limit(limit).for('update', { of: conversationChecks, skipLocked: true })
    if (rows.length) {
      await transaction.update(conversationChecks).set({ checkedAt: now, nextCheckAt: leaseEnd, updatedAt: now })
        .where(inArray(conversationChecks.channelId, rows.map(row => row.check.channelId)))
    }
    return rows
  })

  let synced = 0
  let failed = 0
  for (const { check, channel } of claimed) {
    const save = (values: Partial<typeof conversationChecks.$inferInsert> & { nextCheckAt: Date }) => context.db.update(conversationChecks)
      // A sync asked for while this one ran keeps its earlier time.
      .set({ ...values, updatedAt: clock(context), nextCheckAt: sql`least(${values.nextCheckAt}::timestamptz,
        case when ${conversationChecks.nextCheckAt} < ${leaseEnd}::timestamptz then ${conversationChecks.nextCheckAt} end)` })
      .where(eq(conversationChecks.channelId, channel.id))
    if (budget && (!budget.allows(channel.platform) || !budget.take(channel.platform))) {
      // Not paid for: released as it was, for the next pass.
      await context.db.update(conversationChecks).set({ checkedAt: check.checkedAt, nextCheckAt: check.nextCheckAt, updatedAt: clock(context) })
        .where(eq(conversationChecks.channelId, channel.id))
      continue
    }
    try {
      const result = await syncChannel(context, channel, check.createdAt, budget)
      const finished = clock(context)
      if (result.kind === 'unavailable') {
        await save({ failureCount: 0, rateLimitCount: 0, backoffUntil: null, lastError: result.reason.slice(0, 500),
          nextCheckAt: new Date(finished.getTime() + unavailableSyncRetryMs) })
      } else {
        await save({ failureCount: 0, rateLimitCount: 0, backoffUntil: null, lastError: null,
          nextCheckAt: new Date(finished.getTime() + (result.pending ? minSyncGapMs : conversationSyncIntervalMs)) })
      }
      synced++
    } catch (error) {
      const finished = clock(context)
      failed++
      if (error instanceof RateLimited) {
        const count = check.rateLimitCount + 1
        const until = new Date(finished.getTime() + conversationBackoffMs(count))
        // The backoff holds even against a sync asked for meanwhile.
        await context.db.update(conversationChecks).set({ rateLimitCount: count, backoffUntil: until, nextCheckAt: until, lastError: error.message.slice(0, 500),
          updatedAt: finished }).where(eq(conversationChecks.channelId, channel.id))
        log('warn', 'conversations rate limited', { channelId: channel.id, until: until.toISOString() })
        continue
      }
      if (error instanceof ReauthRequired) await markNeedsReauth(context, channel, 'read_refused')
      const failures = check.failureCount + 1
      await save({ failureCount: failures, lastError: (error instanceof Error ? error.message : 'Reading conversations failed').slice(0, 500),
        nextCheckAt: new Date(finished.getTime() + responseRetryDelayMs(failures)) })
      log('warn', 'conversations sync failed', { channelId: channel.id, failures, ...errorFields(error) })
    }
  }
  return { synced, failed }
}

/**
 * The tenant's conversations, newest first by their last message; `after`
 * continues from the previous page. `lastMessage` is the newest stored one.
 */
export async function listConversations(context: EngineContext, organizationId: string, options: { channelId?: string, after?: string, limit: number }) {
  const after = options.after ? decodeCursor(options.after) : null
  const rows = await context.db.select().from(conversations)
    .where(and(eq(conversations.organizationId, organizationId), options.channelId ? eq(conversations.channelId, options.channelId) : undefined,
      after ? sql`(${conversations.lastMessageAt}, ${conversations.id}) < (${after.firstSeenAt}, ${after.id})` : undefined))
    .orderBy(desc(conversations.lastMessageAt), desc(conversations.id)).limit(options.limit)
  const newest = rows.length ? await context.db.selectDistinctOn([directMessages.conversationId], {
    conversationId: directMessages.conversationId, direction: directMessages.direction, text: directMessages.text, sentAt: directMessages.sentAt,
  }).from(directMessages).where(inArray(directMessages.conversationId, rows.map(row => row.id)))
    .orderBy(directMessages.conversationId, desc(directMessages.sentAt), desc(directMessages.id)) : []
  const last = new Map(newest.map(row => [row.conversationId, row]))
  const end = rows.at(-1)
  return {
    conversations: rows.map(row => conversationView(row, last.get(row.id) ?? null)),
    next: end && rows.length === options.limit ? encodeCursor(end.lastMessageAt, end.id) : null,
  }
}

/** One of the tenant's conversations, as the list shows it: the dashboard reads its window before submitting. */
export async function getConversation(context: EngineContext, organizationId: string, conversationId: string) {
  const [row] = await context.db.select().from(conversations)
    .where(and(eq(conversations.organizationId, organizationId), eq(conversations.id, conversationId))).limit(1)
  if (!row) throw notFound('Conversation')
  const [message] = await context.db.select({ direction: directMessages.direction, text: directMessages.text, sentAt: directMessages.sentAt }).from(directMessages)
    .where(eq(directMessages.conversationId, row.id)).orderBy(desc(directMessages.sentAt), desc(directMessages.id)).limit(1)
  return { conversation: conversationView(row, message ?? null) }
}

/** A WhatsApp participant's phone number, as `+<digits>`, when Meta gave it; null elsewhere. */
export function participantPhone(row: Pick<typeof conversations.$inferSelect, 'platform' | 'participantExternalId'>) {
  return row.platform === 'whatsapp' && row.participantExternalId && /^\d{5,20}$/.test(row.participantExternalId) ? `+${row.participantExternalId}` : null
}

function conversationView(row: typeof conversations.$inferSelect, message: { direction: 'in' | 'out', text: string, sentAt: Date } | null) {
  const phone = participantPhone(row)
  return { id: row.id, channelId: row.channelId, platform: row.platform,
    participant: { name: row.participantName, username: row.participantUsername, ...(phone ? { phone } : {}) },
    lastMessageAt: row.lastMessageAt.toISOString(), lastInboundAt: row.lastInboundAt?.toISOString() ?? null,
    windowOpenUntil: windowOpenUntil(row.lastInboundAt)?.toISOString() ?? null,
    lastMessage: message ? { direction: message.direction, text: message.text, sentAt: message.sentAt.toISOString() } : null }
}

/** One conversation's stored messages, newest first; `before` continues from the previous page. `outgoingKey` names the engine's send. */
export async function listConversationMessages(context: EngineContext, organizationId: string, conversationId: string, options: { before?: string, limit: number }) {
  const [conversation] = await context.db.select({ id: conversations.id }).from(conversations)
    .where(and(eq(conversations.organizationId, organizationId), eq(conversations.id, conversationId))).limit(1)
  if (!conversation) throw notFound('Conversation')
  const before = options.before ? decodeCursor(options.before) : null
  const outgoingKey = sql<string | null>`(select ${outgoingMessages.requestKey} from ${outgoingMessages}
    where ${outgoingMessages.channelId} = ${directMessages.channelId} and ${outgoingMessages.platformMessageId} = ${directMessages.externalId} limit 1)`
  const rows = await context.db.select({ message: directMessages, outgoingKey }).from(directMessages)
    .where(and(eq(directMessages.conversationId, conversationId),
      before ? sql`(${directMessages.sentAt}, ${directMessages.id}) < (${before.firstSeenAt}, ${before.id})` : undefined))
    .orderBy(desc(directMessages.sentAt), desc(directMessages.id)).limit(options.limit)
  const end = rows.at(-1)
  return {
    messages: rows.map(({ message, outgoingKey }) => ({ id: message.id, direction: message.direction, text: message.text, attachments: message.attachments,
      sentAt: message.sentAt.toISOString(), ...(outgoingKey ? { outgoingKey } : {}) })),
    next: end && rows.length === options.limit ? encodeCursor(end.message.sentAt, end.message.id) : null,
  }
}
