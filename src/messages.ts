import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, notInArray, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { CallBudget } from './budget.js'
import { channelTarget, lockControls, readPublishing } from './channels.js'
import { adapterFor, clock, recordEvent, type EngineContext } from './context.js'
import { windowOpenUntil } from './conversations.js'
import { TransientCredentialError } from './credentials.js'
import type { Executor } from './db/client.js'
import {
  channels, conversationChecks, conversations, directMessages, outgoingMessageCancellations, outgoingMessages, type OutgoingMessageState,
} from './db/schema.js'
import { conflict, EngineError, invalid, notFound } from './errors.js'
import { advisoryLock, dashboardIdentifier, hex64, isUniqueViolation, sendRetryDelayMs, sha256Json } from './exactly-once.js'
import { channelDriver } from './jobs/driver.js'
import { errorFields, log } from './log.js'
import { normalizeReplyText } from './platforms/reply-match.js'
import { RateLimited, type FindReplyOutcome, type MessageRules, type SendMessageOutcome } from './platforms/types.js'
import { messageAvailability, permissionName } from './reply-availability.js'
import { changeChannelStatus, emitMessageOutcome } from './webhooks.js'
import { messageDigest } from './digests.js'
import { approvalFields, approvalRefinement, approvalRefinementMessage, checkAutomation } from './answering/drafts.js'
import { queueControlEvent } from './control-events.js'
import type { ApprovedVia, DeliveryStatus } from './db/schema.js'

// Direct messages, send side: the exactly-once contract of comment
// replies, for one table of outgoing messages.

type Outgoing = typeof outgoingMessages.$inferSelect

const minuteMs = 60_000
const hourMs = 60 * minuteMs

/** A queued message more than this past its `sendAt` is not sent any more. */
export const maxMessageLatenessMs = hourMs
/** A new submission more than this past its `sendAt` is refused (`too_late`): there would be no time left to cancel it. */
export const maxSubmissionLatenessMs = 5 * minuteMs
/** `sendAt` is at most this far ahead of the submission. */
export const maxSendAheadMs = hourMs
/** Looks without a match before a person may say an uncertain message did not go out: the 1, 5 and 15 minute ones. */
export const missesBeforeNotSent = 3
export const messageLeaseMs = 5 * minuteMs
export const maxMessageAttempts = 3
/** Looks at the conversation for an uncertain message, after its attempt: a day in all. */
export const messageReconcileDelaysMs = [1, 5, 15, 60, 180, 360, 1_440].map(minutes => minutes * minuteMs)
export const messageReconcileSkewMs = 5 * minuteMs
export const messagesPerChannelHour = 60
export const messagesPerChannelDay = 500
/** How often the worker sends due messages and looks for uncertain ones. */
export const messagesIntervalMs = 5_000
const messagesPerPass = 10
const reconcilesPerPass = 5

export { messageDigest }

/** The longest platform error detail kept with a message. */
export const maxErrorDetailLength = 300

/**
 * A platform's error as it may be stored and logged: the platform's codes and
 * a short message, with anything that looks like a phone number, an email
 * address or a link replaced, so a person's details never reach the record.
 */
export function safeErrorDetail(detail: string | undefined) {
  if (!detail) return null
  const cleaned = detail.replace(/\s+/g, ' ')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]')
    .replace(/\bhttps?:\/\/\S+/gi, '[link]')
    // Error codes (up to six digits, as in 131047 or 2494010 after a slash) stay; longer runs are numbers or IDs of people.
    .replace(/\+?\d[\d ().-]{6,}\d/g, match => /^\d{1,7}$/.test(match) ? match : '[number]')
    .trim()
  return Array.from(cleaned).slice(0, maxErrorDetailLength).join('') || null
}

/** One key per (organization, dashboard message, revision, digest): a second submission of it is the same message. */
export function messageRequestKey(organizationId: string, messageId: string, revision: number, digest: string) {
  return sha256Json(['social-message-send-v1', organizationId, messageId, revision, digest])
}

/** Whether the text is within the platform's limit: characters on Messenger, UTF-8 bytes on Instagram. */
export function messageFits(rules: Pick<MessageRules, 'maxLength' | 'unit'>, text: string) {
  const length = rules.unit === 'bytes' ? Buffer.byteLength(text, 'utf8') : Array.from(text).length
  return length <= rules.maxLength
}

/** Whether the person's window is still open at `at`: 24 hours from their newest stored message. */
export function windowOpenAt(lastInboundAt: Date | null, at: Date) {
  const until = windowOpenUntil(lastInboundAt)
  return until !== null && at.getTime() <= until.getTime()
}

export const messageSubmissionSchema = z.strictObject({
  requestKey: hex64,
  messageId: dashboardIdentifier,
  revision: z.number().int().positive(),
  digest: hex64,
  conversationId: z.uuid(),
  // Already trimmed by the dashboard: the digest covers the exact text.
  text: z.string().min(1).max(5_000).refine(value => value.trim() === value, 'must be trimmed'),
  approvedByUserId: dashboardIdentifier,
  approvedAt: z.iso.datetime({ offset: true }),
  sendAt: z.iso.datetime({ offset: true }),
  ...approvalFields,
}).refine(approvalRefinement, approvalRefinementMessage)
export type MessageSubmission = z.infer<typeof messageSubmissionSchema>

const lockRequestKey = (executor: Executor, organizationId: string, requestKey: string) => advisoryLock(executor, `message-key:${organizationId}:${requestKey}`)

/** An outgoing message as the dashboard reads it. A key cancelled before it arrived has no message behind it: its fields are null. */
export interface OutgoingMessageView {
  id: string | null
  requestKey: string
  messageId: string | null
  revision: number | null
  digest: string | null
  conversationId: string | null
  channelId: string | null
  /** `person`, or `automation` with the engine draft it sends. */
  approvedVia: ApprovedVia | null
  draftId: string | null
  state: OutgoingMessageState
  errorCode: string | null
  /** The platform's error code and a short message, without personal details (`safeErrorDetail`); null once sent. */
  errorDetail: string | null
  permission: string | null
  platformMessageId: string | null
  /** Always null: Meta gives messages no permalink. Kept so the view mirrors a reply's. */
  url: null
  attemptCount: number
  reconciling: boolean
  sendAt: string | null
  attemptedAt: string | null
  settledAt: string | null
  settledBy: string | null
  /** The stored conversation message it became, once a sync read it. */
  directMessageId: string | null
  resolution: 'sent' | 'not_sent' | null
  notSentAllowed: boolean
  /** Where the platform reports it got to after the send (WhatsApp): `sent`, `delivered`, `read` or `failed`; null where it does not report. */
  deliveryStatus: DeliveryStatus | null
  /** For a `failed` delivery: `outside_window`, `recipient_unavailable`, `message_not_allowed`, `rate_limited` or `rejected`. */
  deliveryErrorCode: string | null
  deliveryUpdatedAt: string | null
  updatedAt: string
}

export function notSentAllowed(message: Pick<Outgoing, 'state' | 'reconciling' | 'reconcileMisses'>) {
  return message.state === 'uncertain' && (!message.reconciling || message.reconcileMisses >= missesBeforeNotSent)
}

export function outgoingView(message: Outgoing, directMessageId: string | null = null): OutgoingMessageView {
  return {
    id: message.id, requestKey: message.requestKey, messageId: message.messageId, revision: message.revision, digest: message.digest,
    conversationId: message.conversationId, channelId: message.channelId, approvedVia: message.approvedVia, draftId: message.draftId, state: message.state,
    errorCode: message.errorCode, errorDetail: message.errorDetail ?? null,
    permission: message.permission ? permissionName(message.permission) : null, platformMessageId: message.platformMessageId, url: null, attemptCount: message.attemptCount,
    reconciling: message.reconciling, sendAt: message.sendAt.toISOString(), attemptedAt: message.attemptedAt?.toISOString() ?? null,
    settledAt: message.settledAt?.toISOString() ?? null, settledBy: message.settledBy ?? null, directMessageId, resolution: message.resolution ?? null,
    notSentAllowed: notSentAllowed(message), deliveryStatus: message.deliveryStatus ?? null, deliveryErrorCode: message.deliveryErrorCode ?? null,
    deliveryUpdatedAt: message.deliveryUpdatedAt?.toISOString() ?? null, updatedAt: message.updatedAt.toISOString(),
  }
}

function tombstoneView(row: typeof outgoingMessageCancellations.$inferSelect, input?: MessageSubmission): OutgoingMessageView {
  const at = row.createdAt.toISOString()
  return {
    id: null, requestKey: row.requestKey, messageId: input?.messageId ?? null, revision: input?.revision ?? null, digest: input?.digest ?? null,
    conversationId: input?.conversationId ?? null, channelId: null, approvedVia: input ? input.approvedVia ?? 'person' : null, draftId: input?.draftId ?? null,
    state: 'cancelled', errorCode: 'cancelled_before_submit', errorDetail: null, permission: null,
    platformMessageId: null, url: null, attemptCount: 0, reconciling: false, sendAt: input ? new Date(input.sendAt).toISOString() : null, attemptedAt: null,
    settledAt: at, settledBy: null, directMessageId: null, resolution: null, notSentAllowed: false, deliveryStatus: null, deliveryErrorCode: null,
    deliveryUpdatedAt: null, updatedAt: at,
  }
}

async function directMessageIdOf(executor: Executor, message: Outgoing) {
  if (!message.platformMessageId) return null
  const [row] = await executor.select({ id: directMessages.id }).from(directMessages)
    .where(and(eq(directMessages.channelId, message.channelId), eq(directMessages.externalId, message.platformMessageId))).limit(1)
  return row?.id ?? null
}

/** Messages that were or will be sent count toward the limits: not cancelled ones, nor those that failed before any attempt. */
const counted = and(ne(outgoingMessages.state, 'cancelled'), or(ne(outgoingMessages.state, 'failed'), gt(outgoingMessages.attemptCount, 0)))

/** Settles a message as sent with a platform ID, in a savepoint: false when another message holds that ID. */
async function settleSent(executor: Executor, id: string, values: Partial<typeof outgoingMessages.$inferInsert>) {
  try {
    await executor.transaction(async savepoint => {
      await savepoint.update(outgoingMessages).set(values).where(eq(outgoingMessages.id, id))
    })
    return true
  } catch (error) {
    if (isUniqueViolation(error)) return false
    throw error
  }
}

/**
 * Accepts a message revision, once. Recomputes the digest and the request
 * key, then checks under the tenant's controls lock what the engine can: the
 * conversation is the tenant's, the channel can message and is neither
 * paused nor missing the permission, the text fits, the person's window is
 * open at `sendAt`, and the channel is within its limits.
 */
export async function submitMessage(context: EngineContext, organizationId: string, input: MessageSubmission) {
  const digest = messageDigest(input)
  if (digest !== input.digest) throw invalid('digest_mismatch', 'The text does not match the digest')
  if (messageRequestKey(organizationId, input.messageId, input.revision, digest) !== input.requestKey) throw invalid('request_key_mismatch', 'Unexpected request key')
  const sendAt = new Date(input.sendAt)
  if (sendAt.getTime() < Date.parse(input.approvedAt)) throw invalid('invalid_send_at', 'sendAt must not be before approvedAt')
  const approvedVia: ApprovedVia = input.approvedVia ?? 'person'
  return context.db.transaction(async transaction => {
    const now = clock(context)
    await lockRequestKey(transaction, organizationId, input.requestKey)
    const [existing] = await transaction.select().from(outgoingMessages).where(eq(outgoingMessages.requestKey, input.requestKey)).limit(1)
    if (existing) {
      const same = existing.organizationId === organizationId && existing.messageId === input.messageId && existing.revision === input.revision
        && existing.conversationId === input.conversationId && existing.text === input.text && existing.approvedByUserId === input.approvedByUserId
        && existing.approvedAt.getTime() === Date.parse(input.approvedAt) && existing.sendAt.getTime() === sendAt.getTime()
        && existing.approvedVia === approvedVia && existing.draftId === (input.draftId ?? null)
      if (!same) throw conflict('revision_conflict', 'This request key was already submitted with other values')
      return { message: outgoingView(existing, await directMessageIdOf(transaction, existing)), created: false }
    }
    const [tombstone] = await transaction.select().from(outgoingMessageCancellations)
      .where(and(eq(outgoingMessageCancellations.organizationId, organizationId), eq(outgoingMessageCancellations.requestKey, input.requestKey))).limit(1)
    if (tombstone) return { message: tombstoneView(tombstone, input), created: false }
    const [other] = await transaction.select({ id: outgoingMessages.id }).from(outgoingMessages)
      .where(and(eq(outgoingMessages.organizationId, organizationId), eq(outgoingMessages.messageId, input.messageId), eq(outgoingMessages.revision, input.revision))).limit(1)
    if (other) throw conflict('revision_conflict', 'This message revision was already submitted under another key')
    if (now.getTime() - sendAt.getTime() > maxSubmissionLatenessMs) {
      throw conflict('too_late', 'The message arrived more than five minutes after its send time; submit it again', { maxLatenessMs: maxSubmissionLatenessMs })
    }
    if (sendAt.getTime() - now.getTime() > maxSendAheadMs) throw invalid('invalid_send_at', 'sendAt must be within the next hour')
    // An automatic send of an engine draft: the engine's own records must allow it (ADR 0004).
    if (approvedVia === 'automation') {
      await checkAutomation(transaction, organizationId, { kind: 'message', conversationId: input.conversationId, draftId: input.draftId!,
        revision: input.revision, digest, sendAt })
    }

    const [conversation] = await transaction.select().from(conversations)
      .where(and(eq(conversations.organizationId, organizationId), eq(conversations.id, input.conversationId))).limit(1)
    const [channel] = conversation ? await transaction.select().from(channels).where(eq(channels.id, conversation.channelId)).limit(1) : []
    if (!conversation || !channel) throw notFound('Conversation')
    const availability = messageAvailability(context, channel)
    if (!availability.available) {
      if (availability.reason === 'missing_permission') {
        throw conflict('missing_permission', `Messaging needs the ${availability.permission} permission; connect the channel again`, { permission: availability.permission })
      }
      if (availability.reason === 'channel_inactive') throw conflict('channel_inactive', 'The channel needs to be reconnected')
      throw conflict('not_supported', 'Direct messages are not available on this channel')
    }
    const rules = adapterFor(context, channel.platform).messageRules!(channel.kind)!
    if (!messageFits(rules, input.text)) {
      throw new EngineError(400, 'text_too_long', `Messages on this channel are at most ${rules.maxLength} ${rules.unit}`, { maxLength: rules.maxLength, unit: rules.unit })
    }
    if (!conversation.participantExternalId) throw conflict('recipient_unknown', 'The platform did not say who is in this conversation')
    await lockControls(transaction, organizationId)
    const controls = await readPublishing(transaction, organizationId)
    if (controls.paused || controls.pausedChannelIds.includes(channel.id)) throw conflict('paused', 'Publishing is paused')
    if (!windowOpenAt(conversation.lastInboundAt, sendAt)) {
      // Outside the window WhatsApp takes only an approved template, which the engine does not send.
      throw conflict('outside_window', 'The person last wrote more than 24 hours before sendAt', { windowOpenUntil: windowOpenUntil(conversation.lastInboundAt)?.toISOString() ?? null,
        ...(conversation.platform === 'whatsapp' ? { templateRequired: true } : {}) })
    }

    // Counted under a lock per channel, so concurrent submissions cannot both pass.
    await advisoryLock(transaction, `message-channel:${channel.id}`)
    const [recent] = await transaction.select({
      hour: sql<number>`count(*) filter (where ${outgoingMessages.sendAt} > ${new Date(sendAt.getTime() - hourMs)})::int`, day: sql<number>`count(*)::int`,
    }).from(outgoingMessages).where(and(eq(outgoingMessages.channelId, channel.id), gt(outgoingMessages.sendAt, new Date(sendAt.getTime() - 24 * hourMs)), counted))
    if (recent!.hour >= messagesPerChannelHour) throw conflict('rate_limited', `At most ${messagesPerChannelHour} messages an hour on a channel`, { limit: messagesPerChannelHour })
    if (recent!.day >= messagesPerChannelDay) throw conflict('daily_limit', `At most ${messagesPerChannelDay} messages a day on a channel`, { limit: messagesPerChannelDay })

    const [created] = await transaction.insert(outgoingMessages).values({
      organizationId, channelId: channel.id, conversationId: conversation.id, requestKey: input.requestKey, messageId: input.messageId, revision: input.revision,
      digest, text: input.text, approvedByUserId: input.approvedByUserId, approvedAt: new Date(input.approvedAt), approvedVia, draftId: input.draftId ?? null, sendAt,
      notBefore: new Date(Math.max(now.getTime(), sendAt.getTime())), createdAt: now, updatedAt: now,
    }).returning()
    await recordEvent(transaction, { organizationId, kind: 'message.queued', channelId: channel.id,
      detail: { messageId: input.messageId, revision: input.revision, conversationId: conversation.id, approvedByUserId: input.approvedByUserId, approvedVia,
        ...(input.draftId ? { draftId: input.draftId } : {}) } })
    return { message: outgoingView(created!), created: true }
  })
}

/** Withdraws a message the worker has not claimed; the claim and the cancel lock the same row. An unknown key leaves a tombstone. */
export async function cancelMessage(context: EngineContext, organizationId: string, requestKey: string) {
  return context.db.transaction(async transaction => {
    const now = clock(context)
    await lockRequestKey(transaction, organizationId, requestKey)
    const [found] = await transaction.select().from(outgoingMessages).where(eq(outgoingMessages.requestKey, requestKey)).for('update').limit(1)
    if (found && found.organizationId !== organizationId) throw notFound('Message')
    if (!found) {
      await transaction.insert(outgoingMessageCancellations).values({ requestKey, organizationId, createdAt: now }).onConflictDoNothing()
      const [tombstone] = await transaction.select().from(outgoingMessageCancellations)
        .where(and(eq(outgoingMessageCancellations.requestKey, requestKey), eq(outgoingMessageCancellations.organizationId, organizationId))).limit(1)
      // The key's tombstone belongs to another tenant: answer as for an unknown message.
      if (!tombstone) throw notFound('Message')
      await recordEvent(transaction, { organizationId, kind: 'message.cancelled_before_submit' })
      return { message: tombstoneView(tombstone) }
    }
    if (found.state === 'cancelled') return { message: outgoingView(found) }
    if (found.state !== 'queued') throw conflict('too_late', 'The message is already being sent or settled', { state: found.state })
    const [cancelled] = await transaction.update(outgoingMessages).set({ state: 'cancelled', errorCode: 'cancelled', settledAt: now, updatedAt: now })
      .where(eq(outgoingMessages.id, found.id)).returning()
    await recordEvent(transaction, { organizationId, kind: 'message.cancelled', channelId: found.channelId, detail: { messageId: found.messageId } })
    return { message: outgoingView(cancelled!) }
  })
}

/**
 * A person checked the conversation and says whether an uncertain message
 * went out; nothing is sent. `not_sent` waits for the 15-minute look, and the
 * looks go on after it: a message found then overrides the person.
 */
export async function resolveMessage(context: EngineContext, organizationId: string, requestKey: string, outcome: 'sent' | 'not_sent') {
  return context.db.transaction(async transaction => {
    const now = clock(context)
    const [found] = await transaction.select().from(outgoingMessages)
      .where(and(eq(outgoingMessages.organizationId, organizationId), eq(outgoingMessages.requestKey, requestKey))).for('update').limit(1)
    if (!found) throw notFound('Message')
    if (found.state !== 'uncertain') throw conflict('not_uncertain', 'Only an uncertain message can be resolved', { state: found.state })
    if (outcome === 'not_sent' && !notSentAllowed(found)) {
      throw conflict('still_checking', 'The message is still being looked for in the conversation; it can be marked as not sent after the 15-minute look',
        { state: found.state, misses: found.reconcileMisses })
    }
    const [settled] = await transaction.update(outgoingMessages).set(outcome === 'sent'
      ? { state: 'sent', errorCode: null, reconciling: false, resolution: 'sent', settledBy: 'operator', settledAt: now, updatedAt: now }
      : { state: 'failed', errorCode: 'resolved_not_sent', resolution: 'not_sent', settledBy: 'operator', settledAt: now, updatedAt: now })
      .where(eq(outgoingMessages.id, found.id)).returning()
    await recordEvent(transaction, { organizationId, kind: 'message.resolved', channelId: found.channelId, detail: { outcome, stillLooking: settled!.reconciling } })
    await emitMessageOutcome(transaction, found.id, now)
    return { message: outgoingView(settled!, await directMessageIdOf(transaction, settled!)) }
  })
}

/**
 * The tenant's outgoing messages, newest first: of one conversation or all,
 * optionally in one state or with these request keys. Keys cancelled before
 * they arrived come back as cancelled when no other filter excludes them.
 */
export async function listOutgoingMessages(context: EngineContext, organizationId: string, options: { conversationId?: string, state?: OutgoingMessageState,
  requestKeys?: string[], limit: number }) {
  const rows = await context.db.select({ message: outgoingMessages, directMessageId: directMessages.id }).from(outgoingMessages)
    .leftJoin(directMessages, and(eq(directMessages.channelId, outgoingMessages.channelId), eq(directMessages.externalId, outgoingMessages.platformMessageId)))
    .where(and(eq(outgoingMessages.organizationId, organizationId), options.conversationId ? eq(outgoingMessages.conversationId, options.conversationId) : undefined,
      options.state ? eq(outgoingMessages.state, options.state) : undefined, options.requestKeys ? inArray(outgoingMessages.requestKey, options.requestKeys) : undefined))
    .orderBy(desc(outgoingMessages.createdAt), desc(outgoingMessages.id)).limit(options.limit)
  const views = rows.map(row => outgoingView(row.message, row.directMessageId))
  // A tombstone names no conversation, and its state is cancelled.
  if (!options.requestKeys || options.conversationId || (options.state && options.state !== 'cancelled')) return views
  const known = new Set(views.map(view => view.requestKey))
  const missing = options.requestKeys.filter(key => !known.has(key))
  const tombstones = missing.length ? await context.db.select().from(outgoingMessageCancellations)
    .where(and(eq(outgoingMessageCancellations.organizationId, organizationId), inArray(outgoingMessageCancellations.requestKey, missing))) : []
  return [...views, ...tombstones.map(row => tombstoneView(row))]
}

export interface ClaimedMessage {
  id: string
  organizationId: string
  attemptedAt: Date
}

/**
 * Claims one due message. Pause, channel state, lateness and the person's
 * window are checked again under the lock pause updates take, and `sending`
 * with its lease commits before the platform is called.
 */
export async function claimNextMessage(context: EngineContext): Promise<ClaimedMessage | null> {
  for (let skipped = 0; skipped < 50; skipped++) {
    const result = await context.db.transaction(async transaction => {
      const now = clock(context)
      const [message] = await transaction.select().from(outgoingMessages).where(and(eq(outgoingMessages.state, 'queued'), lte(outgoingMessages.notBefore, now)))
        .orderBy(asc(outgoingMessages.notBefore)).limit(1).for('update', { skipLocked: true })
      if (!message) return null
      await lockControls(transaction, message.organizationId)
      const controls = await readPublishing(transaction, message.organizationId)
      const [channel] = await transaction.select({ status: channels.status }).from(channels).where(eq(channels.id, message.channelId)).limit(1)
      const [conversation] = await transaction.select({ lastInboundAt: conversations.lastInboundAt }).from(conversations)
        .where(eq(conversations.id, message.conversationId)).limit(1)
      const refusal = controls.paused || controls.pausedChannelIds.includes(message.channelId) ? 'paused'
        : channel?.status !== 'active' ? 'channel_inactive'
          : now.getTime() - message.sendAt.getTime() > maxMessageLatenessMs ? 'too_late'
            : !windowOpenAt(conversation?.lastInboundAt ?? null, now) ? 'outside_window' : null
      if (refusal) {
        const state: OutgoingMessageState = refusal === 'paused' ? 'cancelled' : 'failed'
        await transaction.update(outgoingMessages).set({ state, errorCode: refusal, settledAt: now, updatedAt: now }).where(eq(outgoingMessages.id, message.id))
        await recordEvent(transaction, { organizationId: message.organizationId, kind: `message.${state}`, channelId: message.channelId, detail: { reason: refusal } })
        await emitMessageOutcome(transaction, message.id, now)
        return 'skipped' as const
      }
      await transaction.update(outgoingMessages).set({ state: 'sending', attemptCount: message.attemptCount + 1, attemptedAt: now,
        leaseUntil: new Date(now.getTime() + messageLeaseMs), updatedAt: now }).where(eq(outgoingMessages.id, message.id))
      await recordEvent(transaction, { organizationId: message.organizationId, kind: 'message.sending', channelId: message.channelId,
        detail: { attempt: message.attemptCount + 1 } })
      return { id: message.id, organizationId: message.organizationId, attemptedAt: now }
    })
    if (result !== 'skipped') return result
  }
  return null
}

/** Makes the one platform request of a claimed message and records its outcome. A lost claim sends and records nothing. */
export async function executeMessage(context: EngineContext, claimed: ClaimedMessage): Promise<SendMessageOutcome> {
  let outcome: SendMessageOutcome | null
  try {
    outcome = await sendClaimed(context, claimed)
  } catch (error) {
    // Unexpected failure inside the adapter: the message may exist.
    log('error', 'message send threw', { outgoingMessageId: claimed.id, ...errorFields(error) })
    outcome = { kind: 'uncertain', code: 'internal', detail: 'Unexpected error during the send' }
  }
  if (!outcome) {
    log('warn', 'message claim lost before the platform request; nothing sent', { outgoingMessageId: claimed.id })
    await recordEvent(context.db, { organizationId: claimed.organizationId, kind: 'message.claim_lost', detail: { outgoingMessageId: claimed.id } })
    return { kind: 'failed', retryable: false, code: 'claim_lost', detail: 'The claim ran out before the platform request' }
  }
  await settleMessage(context, claimed, outcome)
  return outcome
}

/** The platform request of a claimed message; null when the claim no longer holds just before it. */
async function sendClaimed(context: EngineContext, claimed: ClaimedMessage): Promise<SendMessageOutcome | null> {
  const [message] = await context.db.select().from(outgoingMessages).where(eq(outgoingMessages.id, claimed.id)).limit(1)
  const [channel] = message ? await context.db.select().from(channels).where(eq(channels.id, message.channelId)).limit(1) : []
  const [conversation] = message ? await context.db.select().from(conversations).where(eq(conversations.id, message.conversationId)).limit(1) : []
  if (!message || !channel || !conversation) return { kind: 'failed', retryable: false, code: 'conversation_gone', detail: 'Message, channel or conversation missing' }
  if (!conversation.participantExternalId) return { kind: 'failed', retryable: false, code: 'recipient_unknown', detail: 'No participant to answer' }
  const adapter = adapterFor(context, channel.platform)
  if (!adapter.sendMessage) return { kind: 'failed', retryable: false, code: 'not_supported', detail: channel.platform }
  let driver
  try {
    driver = await channelDriver(context, context.db, channel)
  } catch (error) {
    if (error instanceof TransientCredentialError) return { kind: 'failed', retryable: true, code: 'token_refresh_failed', detail: error.message }
    return { kind: 'failed', retryable: false, code: 'channel_inactive', detail: error instanceof Error ? error.message : 'Channel unavailable' }
  }
  // The claim must still hold just before the request; a fresh lease covers the request itself.
  const now = clock(context)
  const [held] = await context.db.update(outgoingMessages).set({ leaseUntil: new Date(now.getTime() + messageLeaseMs), updatedAt: now })
    .where(and(eq(outgoingMessages.id, claimed.id), eq(outgoingMessages.state, 'sending'), eq(outgoingMessages.attemptedAt, claimed.attemptedAt),
      gt(outgoingMessages.leaseUntil, now))).returning({ id: outgoingMessages.id })
  if (!held) return null
  // Where only notifications bring messages (WhatsApp), the person's newest one is marked as read once the answer is accepted.
  const [newest] = webhookOnly(context, channel) ? await context.db.select({ externalId: directMessages.externalId }).from(directMessages)
    .where(and(eq(directMessages.conversationId, conversation.id), eq(directMessages.direction, 'in'))).orderBy(desc(directMessages.sentAt)).limit(1) : []
  return adapter.sendMessage(driver.app, { channel: channelTarget(channel), token: driver.token, recipientExternalId: conversation.participantExternalId,
    text: message.text, outgoingId: message.id, ...(newest ? { readExternalId: newest.externalId } : {}) })
}

/** Whether a channel's conversations come only from notifications, never read back (WhatsApp). */
function webhookOnly(context: EngineContext, channel: Pick<typeof channels.$inferSelect, 'platform' | 'kind'>) {
  return context.adapters.get(channel.platform)?.messageRules?.(channel.kind)?.inbound === 'webhook'
}

/**
 * Where the platform's conversation cannot be read back (WhatsApp), a sent
 * message is stored in the conversation by the engine itself, as the sync
 * stores the brand's messages elsewhere, so the thread and the answering
 * step see it. Once per platform ID.
 */
async function recordOwnMessage(context: EngineContext, executor: Executor, message: Outgoing, platformMessageId: string, at: Date) {
  const [channel] = await executor.select({ platform: channels.platform, kind: channels.kind }).from(channels).where(eq(channels.id, message.channelId)).limit(1)
  if (!channel || !webhookOnly(context, channel)) return
  const inserted = await executor.insert(directMessages).values({ organizationId: message.organizationId, channelId: message.channelId,
    conversationId: message.conversationId, externalId: platformMessageId, direction: 'out', text: message.text, attachments: [], sentAt: at, firstSeenAt: at })
    .onConflictDoNothing({ target: [directMessages.channelId, directMessages.externalId] }).returning({ id: directMessages.id })
  if (inserted.length) {
    await executor.update(conversations).set({ lastMessageAt: sql`greatest(${conversations.lastMessageAt}, ${at}::timestamptz)`, updatedAt: at })
      .where(eq(conversations.id, message.conversationId))
  }
}

/** A confirmed message settles the record even when it arrives late: after the sweeper, after a person's `not_sent` (kept), or a person's `sent` (ID recorded). */
function settlesLate(message: Outgoing, outcome: SendMessageOutcome) {
  return outcome.kind === 'sent' && (message.state === 'uncertain' || (message.state === 'failed' && message.errorCode === 'resolved_not_sent')
    || (message.state === 'sent' && !message.platformMessageId))
}

/** Records a send's outcome; anything but a confirmation that arrives late is left to reconciliation. */
export async function settleMessage(context: EngineContext, claimed: ClaimedMessage, outcome: SendMessageOutcome) {
  await context.db.transaction(async transaction => {
    const now = clock(context)
    const [message] = await transaction.select().from(outgoingMessages).where(eq(outgoingMessages.id, claimed.id)).for('update').limit(1)
    if (!message || message.attemptedAt?.getTime() !== claimed.attemptedAt.getTime()) return
    const base = { organizationId: message.organizationId, channelId: message.channelId }
    if (message.state !== 'sending' && !settlesLate(message, outcome)) {
      await recordEvent(transaction, { ...base, kind: 'message.late_outcome', detail: { outcome: outcome.kind } })
      return
    }
    let values: Partial<typeof outgoingMessages.$inferInsert>
    if (outcome.kind === 'sent') {
      values = { state: 'sent', platformMessageId: outcome.externalId, errorCode: null, errorDetail: null, reconciling: false, settledBy: 'worker', settledAt: now }
      if (!await settleSent(transaction, message.id, { ...values, leaseUntil: null, updatedAt: now })) {
        // Another message holds this platform ID: a person decides.
        if (message.state === 'sending') {
          await transaction.update(outgoingMessages).set({ state: 'uncertain', errorCode: 'platform_id_conflict', reconciling: false, leaseUntil: null, updatedAt: now })
            .where(eq(outgoingMessages.id, message.id))
        }
        await recordEvent(transaction, { ...base, kind: 'message.platform_id_conflict', detail: { platformMessageId: outcome.externalId } })
        return
      }
      if (message.resolution === 'not_sent') {
        await recordEvent(transaction, { ...base, kind: 'message.resolution_overridden', detail: { resolution: 'not_sent', settledBy: 'worker' } })
      }
      await recordOwnMessage(context, transaction, message, outcome.externalId, now)
    } else if (outcome.kind === 'uncertain') {
      values = { state: 'uncertain', errorCode: outcome.code, errorDetail: safeErrorDetail(outcome.detail), reconciling: true, reconcileCount: 0, reconcileMisses: 0,
        notBefore: new Date(Math.max(now.getTime(), claimed.attemptedAt.getTime() + messageReconcileDelaysMs[0]!)) }
    } else if (outcome.retryable && message.attemptCount < maxMessageAttempts && now.getTime() - message.sendAt.getTime() < maxMessageLatenessMs) {
      values = { state: 'queued', errorCode: outcome.code, errorDetail: safeErrorDetail(outcome.detail),
        notBefore: new Date(now.getTime() + sendRetryDelayMs(message.attemptCount)) }
    } else {
      values = { state: 'failed', errorCode: outcome.code, errorDetail: safeErrorDetail(outcome.detail), permission: outcome.permission ?? null, settledAt: now }
    }
    if (outcome.kind !== 'sent') await transaction.update(outgoingMessages).set({ ...values, leaseUntil: null, updatedAt: now }).where(eq(outgoingMessages.id, message.id))
    if (outcome.kind === 'failed' && outcome.permission) {
      // Messages stay unavailable on the channel until it connects again.
      await transaction.update(channels).set({ refusedScopes: sql`array(select distinct unnest(${channels.refusedScopes} || array[${outcome.permission}]::text[]))`,
        updatedAt: now }).where(eq(channels.id, message.channelId))
    }
    if (outcome.kind === 'failed' && outcome.reauth) {
      await changeChannelStatus(transaction, message.channelId, 'needs_reauth', 'message_refused', now)
      await recordEvent(transaction, { ...base, kind: 'channel.needs_reauth', detail: { reason: 'message_refused' } })
    }
    if (outcome.kind === 'sent') {
      // Read the conversations within 30 s (a minute after the last sync at most), so the message shows up and links back.
      await transaction.update(conversationChecks).set({ updatedAt: now, nextCheckAt: sql`least(${conversationChecks.nextCheckAt},
        greatest(${new Date(now.getTime() + 30_000)}::timestamptz, coalesce(${conversationChecks.checkedAt} + interval '1 minute', ${now}::timestamptz)))` })
        .where(eq(conversationChecks.channelId, message.channelId))
    }
    await recordEvent(transaction, { ...base, kind: `message.${values.state}`,
      detail: outcome.kind === 'sent' ? { platformMessageId: outcome.externalId } : { code: outcome.code, detail: safeErrorDetail(outcome.detail) } })
    // A message a person already said was sent is not announced twice.
    if ((values.state === 'sent' || values.state === 'failed') && message.state !== values.state) await emitMessageOutcome(transaction, message.id, now)
    else if (values.state === 'uncertain') await queueControlEvent(transaction, 'messages.changed', message.organizationId, now)
  })
}

/** Messages whose worker vanished after the claim: the request may have been made, so they become uncertain. */
export async function sweepMessages(context: EngineContext) {
  const now = clock(context)
  return context.db.transaction(async transaction => {
    const open = await transaction.select().from(outgoingMessages).where(and(eq(outgoingMessages.state, 'sending'), lt(outgoingMessages.leaseUntil, now)))
      .limit(100).for('update', { skipLocked: true })
    for (const message of open) {
      const first = (message.attemptedAt ?? now).getTime() + messageReconcileDelaysMs[0]!
      await transaction.update(outgoingMessages).set({ state: 'uncertain', errorCode: 'abandoned', reconciling: true, reconcileCount: 0, reconcileMisses: 0,
        leaseUntil: null, notBefore: new Date(Math.max(now.getTime(), first)), updatedAt: now }).where(eq(outgoingMessages.id, message.id))
      await recordEvent(transaction, { organizationId: message.organizationId, kind: 'message.uncertain', channelId: message.channelId, detail: { reason: 'abandoned' } })
      await queueControlEvent(transaction, 'messages.changed', message.organizationId, now)
    }
    return open.map(message => message.id)
  })
}

const lookingFor = and(eq(outgoingMessages.reconciling, true), inArray(outgoingMessages.state, ['uncertain', 'failed']))

/**
 * Another message that may own a match: in the same conversation, with the
 * same normalised text, attempted late enough to fall in the same window,
 * and still unsettled or sent without a platform ID.
 */
async function rivalFor(executor: Executor, message: Outgoing) {
  const attempted = (message.attemptedAt ?? message.updatedAt).getTime()
  const others = await executor.select({ id: outgoingMessages.id, text: outgoingMessages.text }).from(outgoingMessages).where(and(
    eq(outgoingMessages.conversationId, message.conversationId), ne(outgoingMessages.id, message.id),
    gte(outgoingMessages.attemptedAt, new Date(attempted - 2 * messageReconcileSkewMs)),
    or(inArray(outgoingMessages.state, ['sending', 'uncertain']), and(eq(outgoingMessages.state, 'failed'), eq(outgoingMessages.reconciling, true)),
      and(eq(outgoingMessages.state, 'sent'), isNull(outgoingMessages.platformMessageId)))))
  const text = normalizeReplyText(message.text)
  return others.find(other => normalizeReplyText(other.text) === text) ?? null
}

/**
 * Looks in the conversation for messages whose next check is due: the
 * newest 20, for one from the channel's own account since the attempt (less
 * five minutes), with the same text, that no other message holds. One match
 * settles it; several, or a rival, stop the looks (`ambiguous`). Never sends.
 * Each look is one call from the budget.
 */
export async function reconcileDueMessages(context: EngineContext, budget?: CallBudget, limit = reconcilesPerPass) {
  const now = clock(context)
  const blocked = budget ? [...context.adapters.keys()].filter(platform => !budget.allows(platform)) : []
  const due = await context.db.select({ message: outgoingMessages, channel: channels, conversation: conversations }).from(outgoingMessages)
    .innerJoin(channels, eq(channels.id, outgoingMessages.channelId)).innerJoin(conversations, eq(conversations.id, outgoingMessages.conversationId))
    .where(and(lookingFor, lte(outgoingMessages.notBefore, now), blocked.length ? notInArray(channels.platform, blocked) : undefined))
    .orderBy(asc(outgoingMessages.notBefore)).limit(limit)
  let found = 0
  for (const { message, channel, conversation } of due) {
    if (budget && !budget.take(channel.platform)) break
    const check = message.reconcileCount + 1
    const attempted = (message.attemptedAt ?? message.updatedAt).getTime()
    const nextDelay = messageReconcileDelaysMs[check]
    // Claims this check first, so a crash does not repeat it at once.
    const [claimed] = await context.db.update(outgoingMessages).set({ reconcileCount: check, updatedAt: clock(context),
      notBefore: new Date(nextDelay === undefined ? now.getTime() + hourMs : Math.max(now.getTime(), attempted + nextDelay)) })
      .where(and(eq(outgoingMessages.id, message.id), lookingFor, eq(outgoingMessages.reconcileCount, message.reconcileCount))).returning({ id: outgoingMessages.id })
    if (!claimed) continue
    try {
      let result: FindReplyOutcome
      if (message.reportedMessageId) {
        // A status report named this message (WhatsApp echoes the engine's outgoing ID): no need to read the platform.
        result = { kind: 'found', externalId: message.reportedMessageId }
      } else {
        const adapter = adapterFor(context, channel.platform)
        if (!adapter.findMessage) throw new Error('Messages cannot be looked up on this channel')
        const driver = await channelDriver(context, context.db, channel)
        const others = await context.db.select({ id: outgoingMessages.platformMessageId }).from(outgoingMessages)
          .where(and(eq(outgoingMessages.channelId, channel.id), ne(outgoingMessages.id, message.id), isNotNull(outgoingMessages.platformMessageId)))
        result = await adapter.findMessage(driver.app, { channel: channelTarget(channel), token: driver.token, conversationExternalId: conversation.externalId,
          text: message.text, since: new Date(attempted - messageReconcileSkewMs), excludeExternalIds: others.flatMap(row => row.id ? [row.id] : []) })
      }
      if (await recordLook(context, message, result, nextDelay === undefined, Boolean(message.reportedMessageId))) found++
    } catch (error) {
      if (error instanceof RateLimited) {
        // A rate limit is not a check: look again in an hour.
        await context.db.update(outgoingMessages).set({ reconcileCount: message.reconcileCount, notBefore: new Date(clock(context).getTime() + hourMs),
          updatedAt: clock(context) }).where(and(eq(outgoingMessages.id, message.id), lookingFor))
      } else if (nextDelay === undefined) {
        await context.db.update(outgoingMessages).set({ reconciling: false, updatedAt: clock(context) }).where(and(eq(outgoingMessages.id, message.id), lookingFor))
      }
      log('warn', 'message reconcile failed', { outgoingMessageId: message.id, check, ...errorFields(error) })
    }
  }
  return { checked: due.length, found }
}

/** Records one look under the message's row lock, which says whether the match was taken meanwhile or a rival may own it. True when settled as sent. */
async function recordLook(context: EngineContext, looked: Outgoing, result: FindReplyOutcome, last: boolean, reported = false) {
  return context.db.transaction(async transaction => {
    const at = clock(context)
    const [message] = await transaction.select().from(outgoingMessages).where(and(eq(outgoingMessages.id, looked.id), lookingFor)).for('update').limit(1)
    if (!message) return false
    const base = { organizationId: message.organizationId, channelId: message.channelId }
    let outcome = result
    // A report that names this very message by its outgoing ID has no rival: only text matches can be confused.
    if (outcome.kind === 'found' && !reported) {
      const rival = await rivalFor(transaction, message)
      if (rival) {
        outcome = { kind: 'ambiguous', detail: 'Another message with the same text in this conversation may own the match' }
        await recordEvent(transaction, { ...base, kind: 'message.reconciled.rival', detail: { rivalId: rival.id } })
      }
    }
    if (outcome.kind === 'found' && await settleSent(transaction, message.id, { state: 'sent', platformMessageId: outcome.externalId, errorCode: null,
      reconciling: false, settledBy: 'reconcile', settledAt: at, updatedAt: at })) {
      await recordEvent(transaction, { ...base, kind: 'message.reconciled.sent',
        detail: { platformMessageId: outcome.externalId, ...(message.resolution === 'not_sent' ? { overrides: 'resolved_not_sent' } : {}) } })
      await recordOwnMessage(context, transaction, message, outcome.externalId, at)
      if (message.state !== 'sent') await emitMessageOutcome(transaction, message.id, at)
      return true
    }
    if (outcome.kind === 'ambiguous') {
      // The person's answer stays on a message they said did not go out; only an uncertain one is marked ambiguous.
      await transaction.update(outgoingMessages).set({ reconciling: false, ...(message.state === 'uncertain' ? { errorCode: 'ambiguous' } : {}), updatedAt: at })
        .where(eq(outgoingMessages.id, message.id))
      await recordEvent(transaction, { ...base, kind: 'message.reconciled.ambiguous' })
      return false
    }
    // Nothing found (or a match another message took meanwhile): one more miss, and after the last look a person decides.
    await transaction.update(outgoingMessages).set({ reconcileMisses: message.reconcileMisses + 1, ...(last ? { reconciling: false } : {}), updatedAt: at })
      .where(eq(outgoingMessages.id, message.id))
    if (last) await recordEvent(transaction, { ...base, kind: 'message.reconciled.not_found' })
    return false
  })
}

/** One pass of the worker: sends due messages one after another, then looks for uncertain ones. */
export async function runMessages(context: EngineContext, budget?: CallBudget) {
  let sent = 0
  for (let index = 0; index < messagesPerPass; index++) {
    const claimed = await claimNextMessage(context)
    if (!claimed) break
    const outcome = await executeMessage(context, claimed)
    log(outcome.kind === 'sent' ? 'info' : 'warn', 'message attempt finished', { outgoingMessageId: claimed.id, outcome: outcome.kind,
      ...(outcome.kind === 'sent' ? {} : { code: outcome.code, detail: safeErrorDetail(outcome.detail) }) })
    sent++
  }
  const reconciled = await reconcileDueMessages(context, budget)
  return { sent, reconciled }
}
