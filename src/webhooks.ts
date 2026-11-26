import { randomUUID } from 'node:crypto'
import { and, asc, count, desc, eq, gt, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { clock, recordEvent, type EngineContext } from './context.js'
import { openToken, sealToken } from './crypto/envelope.js'
import type { Executor } from './db/client.js'
import {
  channelMetrics, channels, conversations, jobs, outgoingMessages, postMetrics, replies, webhookDeliveries, webhookEventTypes, webhooks, type WebhookEventType,
} from './db/schema.js'
import { conflict, invalid, notFound } from './errors.js'
import { errorFields, log } from './log.js'
import { queueControlEvent } from './control-events.js'
import { createWebhookSender, newWebhookSecret, signWebhook, webhookUrlProblem, type WebhookResult } from './webhook-sender.js'

const minuteMs = 60_000
const hourMs = 60 * minuteMs
const dayMs = 24 * hourMs

export const maxWebhooksPerTenant = 10
/** How often the worker looks for due deliveries, and how many it sends at once. */
export const webhooksIntervalMs = 5_000
export const webhookBatchSize = 10
/** A claimed delivery is tried again after this when its worker dies mid-request. */
export const deliveryLeaseMs = 2 * minuteMs
/** Wait after each failed attempt; the last failure gives up, about 23 hours after the event. */
export const deliveryRetryDelaysMs = [30_000, 2 * minuteMs, 10 * minuteMs, 30 * minuteMs, hourMs, 3 * hourMs, 6 * hourMs, 12 * hourMs] as const
export const maxDeliveryAttempts = deliveryRetryDelaysMs.length + 1
/** A webhook whose every attempt failed for this long is disabled. */
export const disableAfterFailingMs = 3 * dayMs
/** After a rotation the previous secret still signs this long. */
export const previousSecretLifetimeMs = dayMs
export const deliveriesRetentionMs = 30 * dayMs

/** A webhook watching metrics has them read this often (post metrics only in a post's first two days). */
export const watchedPostMetricsIntervalMs = 15 * minuteMs
export const watchedPostMetricsWindowMs = 2 * dayMs
export const watchedChannelMetricsIntervalMs = 30 * minuteMs

const defaultSender = createWebhookSender()
const secretContext = (id: string) => `webhook:${id}`

const webhookUrl = z.string().max(2_000).superRefine((value, context) => {
  const problem = webhookUrlProblem(value)
  if (problem) context.addIssue({ code: 'custom', message: `url ${problem}` })
})
const eventTypes = z.array(z.enum(webhookEventTypes)).min(1).max(webhookEventTypes.length).transform(values => [...new Set(values)])
const channelIdList = z.array(z.uuid()).min(1).max(100).transform(values => [...new Set(values)]).nullable()
const description = z.string().trim().max(200).nullable()

export const webhookCreateSchema = z.strictObject({ url: webhookUrl, eventTypes, channelIds: channelIdList.default(null), description: description.default(null) })
export const webhookUpdateSchema = z.strictObject({ url: webhookUrl.optional(), eventTypes: eventTypes.optional(), channelIds: channelIdList.optional(),
  description: description.optional(), enabled: z.boolean().optional() })
  .refine(value => Object.keys(value).length > 0, 'nothing to change')

type WebhookRow = typeof webhooks.$inferSelect

function publicWebhook(row: WebhookRow, now: Date) {
  return { id: row.id, url: row.url, description: row.description, eventTypes: row.eventTypes, channelIds: row.channelIds, status: row.status,
    disabledReason: row.disabledReason, failingSince: row.failingSince?.toISOString() ?? null, lastDeliveredAt: row.lastDeliveredAt?.toISOString() ?? null,
    previousSecretExpiresAt: row.previousSecretExpiresAt && row.previousSecretExpiresAt > now ? row.previousSecretExpiresAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }
}

function sealed(context: EngineContext, id: string, secret: string) {
  const value = sealToken(context.keyring, secret, secretContext(id))
  return { secretKeyId: value.keyId, secretNonce: value.nonce, secretCiphertext: value.ciphertext }
}

async function assertOwnChannels(executor: Executor, organizationId: string, channelIds: string[] | null) {
  if (!channelIds) return
  const owned = await executor.select({ id: channels.id }).from(channels).where(and(eq(channels.organizationId, organizationId), inArray(channels.id, channelIds)))
  if (owned.length !== channelIds.length) throw invalid('unknown_channel', 'A channel does not belong to this tenant')
}

async function ownWebhook(executor: Executor, organizationId: string, id: string, lock = false) {
  const query = executor.select().from(webhooks).where(and(eq(webhooks.id, id), eq(webhooks.organizationId, organizationId))).limit(1)
  const [row] = lock ? await query.for('update') : await query
  if (!row) throw notFound('Webhook')
  return row
}

/** Registers an endpoint. The secret is returned here and on rotation only. */
export async function createWebhook(context: EngineContext, organizationId: string, input: z.output<typeof webhookCreateSchema>) {
  return context.db.transaction(async transaction => {
    const now = clock(context)
    // Serializes creations per tenant, so the limit holds under concurrent requests.
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtext(${`webhooks:${organizationId}`}))`)
    const [{ value: existing } = { value: 0 }] = await transaction.select({ value: count() }).from(webhooks).where(eq(webhooks.organizationId, organizationId))
    if (existing >= maxWebhooksPerTenant) throw conflict('webhook_limit', `At most ${maxWebhooksPerTenant} webhooks per tenant`)
    await assertOwnChannels(transaction, organizationId, input.channelIds)
    const id = randomUUID()
    const secret = newWebhookSecret()
    const [row] = await transaction.insert(webhooks).values({ id, organizationId, url: input.url, description: input.description || null,
      eventTypes: input.eventTypes, channelIds: input.channelIds, ...sealed(context, id, secret), createdAt: now, updatedAt: now }).returning()
    await pullCollectionForward(transaction, organizationId, input.channelIds, input.eventTypes, now)
    await recordEvent(transaction, { organizationId, kind: 'webhook.created', detail: { webhookId: id, eventTypes: input.eventTypes } })
    return { webhook: publicWebhook(row!, now), secret }
  })
}

export async function listWebhooks(context: EngineContext, organizationId: string) {
  const rows = await context.db.select().from(webhooks).where(eq(webhooks.organizationId, organizationId)).orderBy(asc(webhooks.createdAt), asc(webhooks.id))
  const now = clock(context)
  return rows.map(row => publicWebhook(row, now))
}

/**
 * Changes an endpoint. Disabling fails its pending deliveries; enabling
 * clears the failure record but sends nothing that was missed.
 */
export async function updateWebhook(context: EngineContext, organizationId: string, id: string, input: z.output<typeof webhookUpdateSchema>) {
  return context.db.transaction(async transaction => {
    const now = clock(context)
    const current = await ownWebhook(transaction, organizationId, id, true)
    if (input.channelIds !== undefined) await assertOwnChannels(transaction, organizationId, input.channelIds)
    const values: Partial<typeof webhooks.$inferInsert> = { updatedAt: now }
    if (input.url !== undefined) values.url = input.url
    if (input.eventTypes !== undefined) values.eventTypes = input.eventTypes
    if (input.channelIds !== undefined) values.channelIds = input.channelIds
    if (input.description !== undefined) values.description = input.description || null
    if (input.enabled === true && current.status !== 'active') Object.assign(values, { status: 'active', disabledReason: null, failingSince: null })
    if (input.enabled === false && current.status !== 'disabled') {
      Object.assign(values, { status: 'disabled', disabledReason: 'disabled' })
      await failPending(transaction, id, 'webhook_disabled', now)
    }
    const [row] = await transaction.update(webhooks).set(values).where(eq(webhooks.id, id)).returning()
    if (row!.status === 'active') await pullCollectionForward(transaction, organizationId, row!.channelIds, row!.eventTypes, now)
    await recordEvent(transaction, { organizationId, kind: 'webhook.updated', detail: { webhookId: id, status: row!.status } })
    return publicWebhook(row!, now)
  })
}

/** Removes an endpoint with its delivery log. */
export async function deleteWebhook(context: EngineContext, organizationId: string, id: string) {
  await context.db.transaction(async transaction => {
    await ownWebhook(transaction, organizationId, id, true)
    await transaction.delete(webhooks).where(eq(webhooks.id, id))
    await recordEvent(transaction, { organizationId, kind: 'webhook.deleted', detail: { webhookId: id } })
  })
  return { deleted: true }
}

/** A new secret; the previous one keeps signing for a day, so receivers can switch without dropping deliveries. */
export async function rotateWebhookSecret(context: EngineContext, organizationId: string, id: string) {
  return context.db.transaction(async transaction => {
    const now = clock(context)
    const current = await ownWebhook(transaction, organizationId, id, true)
    const secret = newWebhookSecret()
    const [row] = await transaction.update(webhooks).set({ ...sealed(context, id, secret),
      previousSecretKeyId: current.secretKeyId, previousSecretNonce: current.secretNonce, previousSecretCiphertext: current.secretCiphertext,
      previousSecretExpiresAt: new Date(now.getTime() + previousSecretLifetimeMs), updatedAt: now }).where(eq(webhooks.id, id)).returning()
    await recordEvent(transaction, { organizationId, kind: 'webhook.secret_rotated', detail: { webhookId: id } })
    return { webhook: publicWebhook(row!, now), secret }
  })
}

/** Queues a `webhook.test` event to one endpoint, whatever events it takes. */
export async function testWebhook(context: EngineContext, organizationId: string, id: string) {
  const now = clock(context)
  const row = await ownWebhook(context.db, organizationId, id)
  if (row.status !== 'active') throw conflict('webhook_disabled', 'The webhook is disabled')
  const [delivery] = await context.db.insert(webhookDeliveries).values({ webhookId: id, organizationId, eventType: 'webhook.test',
    payload: { type: 'webhook.test', timestamp: now.toISOString(), data: { organizationId, webhookId: id } }, nextAttemptAt: now, createdAt: now }).returning()
  return { delivery: publicDelivery(delivery!) }
}

type DeliveryRow = typeof webhookDeliveries.$inferSelect

function publicDelivery(row: DeliveryRow) {
  return { id: row.id, eventType: row.eventType, state: row.state, attemptCount: row.attemptCount,
    nextAttemptAt: row.state === 'pending' ? row.nextAttemptAt.toISOString() : null, lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
    lastStatus: row.lastStatus, lastError: row.lastError, deliveredAt: row.deliveredAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString() }
}

/** The newest deliveries of one endpoint, newest first. The bodies are not returned. */
export async function listDeliveries(context: EngineContext, organizationId: string, id: string, options: { limit: number, state?: DeliveryRow['state'] }) {
  await ownWebhook(context.db, organizationId, id)
  const rows = await context.db.select().from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.webhookId, id), options.state ? eq(webhookDeliveries.state, options.state) : undefined))
    .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id)).limit(options.limit)
  return rows.map(publicDelivery)
}

/** Sends a finished delivery again, with the same ID and body; the attempt count starts over. */
export async function redeliver(context: EngineContext, organizationId: string, id: string, deliveryId: string) {
  const now = clock(context)
  const row = await ownWebhook(context.db, organizationId, id)
  if (row.status !== 'active') throw conflict('webhook_disabled', 'The webhook is disabled')
  const [delivery] = await context.db.update(webhookDeliveries).set({ state: 'pending', attemptCount: 0, nextAttemptAt: now })
    .where(and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.webhookId, id))).returning()
  if (!delivery) throw notFound('Delivery')
  return { delivery: publicDelivery(delivery) }
}

/** Active webhooks of the tenant that take `type` for this channel (or for every channel). */
function subscribed(organizationId: string, type: WebhookEventType, channelId: string | null) {
  return and(eq(webhooks.organizationId, organizationId), eq(webhooks.status, 'active'), sql`${type} = any(${webhooks.eventTypes})`,
    channelId ? or(isNull(webhooks.channelIds), sql`${channelId}::uuid = any(${webhooks.channelIds})`) : undefined)
}

/**
 * Queues events for every endpoint that takes them, in the caller's
 * transaction: an event is queued exactly when its change commits. All
 * items share the type and channel. Returns the number of deliveries queued.
 */
export async function emitWebhookEvents(executor: Executor, event: { organizationId: string, type: WebhookEventType, channelId: string | null,
  occurredAt: Date, items: Array<Record<string, unknown>> }) {
  if (!event.items.length) return 0
  const targets = await executor.select({ id: webhooks.id }).from(webhooks).where(subscribed(event.organizationId, event.type, event.channelId))
  if (!targets.length) return 0
  const timestamp = event.occurredAt.toISOString()
  const rows = targets.flatMap(target => event.items.map(data => ({ webhookId: target.id, organizationId: event.organizationId, eventType: event.type,
    payload: { type: event.type, timestamp, data: { organizationId: event.organizationId, ...data } }, nextAttemptAt: event.occurredAt, createdAt: event.occurredAt })))
  for (let start = 0; start < rows.length; start += 500) await executor.insert(webhookDeliveries).values(rows.slice(start, start + 500))
  return rows.length
}

/**
 * After any change of a job's state, in its transaction: the control plane
 * hears `jobs.changed` (ADR 0005), and the tenant's webhooks get
 * `post.published`, `post.failed`, `post.uncertain` or `post.cancelled`. A
 * failure that will be retried, or a job queued again, sends no webhook.
 */
export async function emitJobOutcome(executor: Executor, job: typeof jobs.$inferSelect, now: Date) {
  await queueControlEvent(executor, 'jobs.changed', job.organizationId, now)
  if (job.state !== 'published' && job.state !== 'failed' && job.state !== 'uncertain' && job.state !== 'cancelled') return 0
  const [channel] = await executor.select({ platform: channels.platform, kind: channels.kind }).from(channels).where(eq(channels.id, job.channelId)).limit(1)
  const base = { jobId: job.id, postId: job.postId, revision: job.revision, channelId: job.channelId, platform: channel?.platform ?? null, kind: channel?.kind ?? null }
  return emitWebhookEvents(executor, { organizationId: job.organizationId, type: `post.${job.state}`,
    channelId: job.channelId, occurredAt: now, items: [job.state === 'published'
      ? { ...base, externalId: job.receipt?.externalId ?? null, url: job.receipt?.url ?? null, publishedAt: now.toISOString() }
      : { ...base, code: job.lastError }] })
}

/** Whether an active webhook of the tenant takes `type` for this channel: metrics are then read more often. */
export async function webhookWatches(executor: Executor, organizationId: string, channelId: string, type: WebhookEventType) {
  const [row] = await executor.select({ id: webhooks.id }).from(webhooks).where(subscribed(organizationId, type, channelId)).limit(1)
  return Boolean(row)
}

/** `reply.sent` or `reply.failed` for a comment reply that just settled that way (or was cancelled by a pause), in the settling transaction. */
export async function emitReplyOutcome(executor: Executor, id: string, now: Date) {
  const [reply] = await executor.select().from(replies).where(eq(replies.id, id)).limit(1)
  if (!reply) return 0
  // The control plane hears that a receipt changed (ADR 0005), whatever the tenant's webhooks take.
  await queueControlEvent(executor, 'replies.changed', reply.organizationId, now)
  if (reply.state !== 'sent' && reply.state !== 'failed') return 0
  const [job] = await executor.select({ postId: jobs.postId }).from(jobs).where(eq(jobs.id, reply.jobId)).limit(1)
  return emitWebhookEvents(executor, { organizationId: reply.organizationId, type: reply.state === 'sent' ? 'reply.sent' : 'reply.failed',
    channelId: reply.channelId, occurredAt: now, items: [{ replyId: reply.replyId, revision: reply.revision, requestKey: reply.requestKey, jobId: reply.jobId,
      postId: job?.postId ?? null, channelId: reply.channelId, parentExternalId: reply.parentExternalId, platformReplyId: reply.platformReplyId, url: reply.url,
      errorCode: reply.errorCode, settledBy: reply.settledBy }] })
}

/** `message.sent` or `message.failed` for a direct message that just settled that way (or was cancelled by a pause), in the settling transaction. */
export async function emitMessageOutcome(executor: Executor, id: string, now: Date) {
  const [message] = await executor.select().from(outgoingMessages).where(eq(outgoingMessages.id, id)).limit(1)
  if (!message) return 0
  await queueControlEvent(executor, 'messages.changed', message.organizationId, now)
  if (message.state !== 'sent' && message.state !== 'failed') return 0
  const [conversation] = await executor.select({ platform: conversations.platform }).from(conversations).where(eq(conversations.id, message.conversationId)).limit(1)
  return emitWebhookEvents(executor, { organizationId: message.organizationId, type: message.state === 'sent' ? 'message.sent' : 'message.failed',
    channelId: message.channelId, occurredAt: now, items: [{ messageId: message.messageId, revision: message.revision, requestKey: message.requestKey,
      conversationId: message.conversationId, channelId: message.channelId, platform: conversation?.platform ?? null, platformMessageId: message.platformMessageId,
      errorCode: message.errorCode, settledBy: message.settledBy }] })
}

type ChannelRow = typeof channels.$inferSelect

/** `channel.status.changed` for a channel now in `status`; `previous` is null for a channel just connected. */
export async function emitChannelStatus(executor: Executor, channel: ChannelRow, previous: ChannelRow['status'] | null, reason: string, now: Date) {
  if (previous === channel.status) return 0
  return emitWebhookEvents(executor, { organizationId: channel.organizationId, type: 'channel.status.changed', channelId: channel.id, occurredAt: now,
    items: [{ channelId: channel.id, platform: channel.platform, kind: channel.kind, name: channel.name, status: channel.status, previousStatus: previous, reason }] })
}

/** Sets a channel's status under a row lock and tells webhooks when it changed. */
export async function changeChannelStatus(executor: Executor, channelId: string, status: ChannelRow['status'], reason: string, now: Date) {
  const [current] = await executor.select().from(channels).where(eq(channels.id, channelId)).for('update').limit(1)
  if (!current) return
  const [updated] = await executor.update(channels).set({ status, updatedAt: now }).where(eq(channels.id, channelId)).returning()
  await emitChannelStatus(executor, updated!, current.status, reason, now)
}

/** The event types active webhooks of the tenant take for this channel. */
export async function watchedEventTypes(executor: Executor, organizationId: string, channelId: string) {
  const rows = await executor.select({ eventTypes: webhooks.eventTypes }).from(webhooks)
    .where(and(eq(webhooks.organizationId, organizationId), eq(webhooks.status, 'active'),
      or(isNull(webhooks.channelIds), sql`${channelId}::uuid = any(${webhooks.channelIds})`)))
  return new Set(rows.flatMap(row => row.eventTypes))
}

/** Events read from the account itself: while a webhook takes one, the account is read every 30 minutes. */
export const accountEventTypes: readonly WebhookEventType[] = ['channel.metrics.changed', 'channel.profile.changed', 'channel.post.created']

/** A new or widened metrics subscription brings the next reads forward to the watched cadence. */
async function pullCollectionForward(executor: Executor, organizationId: string, channelIds: string[] | null, types: WebhookEventType[], now: Date) {
  const scope = (column: typeof postMetrics.channelId | typeof channelMetrics.channelId) => channelIds ? inArray(column, channelIds) : undefined
  if (types.some(type => accountEventTypes.includes(type))) {
    await executor.update(channelMetrics).set({ nextCollectAt: sql`least(${channelMetrics.nextCollectAt}, ${new Date(now.getTime() + watchedChannelMetricsIntervalMs)})` })
      .where(and(eq(channelMetrics.organizationId, organizationId), scope(channelMetrics.channelId), eq(channelMetrics.failureCount, 0)))
  }
  if (types.includes('post.metrics.changed')) {
    const young = executor.select({ id: jobs.id }).from(jobs)
      .where(and(eq(jobs.organizationId, organizationId), gt(jobs.publishAt, new Date(now.getTime() - watchedPostMetricsWindowMs))))
    await executor.update(postMetrics).set({ nextCollectAt: sql`least(${postMetrics.nextCollectAt}, ${new Date(now.getTime() + watchedPostMetricsIntervalMs)})` })
      .where(and(eq(postMetrics.organizationId, organizationId), scope(postMetrics.channelId), eq(postMetrics.failureCount, 0), inArray(postMetrics.jobId, young)))
  }
}

/**
 * What moved between two metric reads: `changes` holds the difference of
 * each number present in both. `changed` is false when no number moved,
 * appeared or went away. A first read (no previous numbers) counts as changed
 * when it has any number.
 */
export function metricChanges(previous: Record<string, number> | null, values: Record<string, number>) {
  if (!previous) return { changed: Object.keys(values).length > 0, changes: {} as Record<string, number> }
  const changes: Record<string, number> = {}
  let changed = false
  for (const name of new Set([...Object.keys(previous), ...Object.keys(values)])) {
    const before = previous[name]
    const after = values[name]
    if (before === after) continue
    changed = true
    if (typeof before === 'number' && typeof after === 'number') changes[name] = after - before
  }
  return { changed, changes }
}

async function failPending(executor: Executor, webhookId: string, reason: string, now: Date) {
  await executor.update(webhookDeliveries).set({ state: 'failed', lastError: reason, lastAttemptAt: now })
    .where(and(eq(webhookDeliveries.webhookId, webhookId), eq(webhookDeliveries.state, 'pending')))
}

function secretsOf(context: EngineContext, row: WebhookRow, now: Date) {
  const secrets = [openToken(context.keyring, { keyId: row.secretKeyId, nonce: row.secretNonce, ciphertext: row.secretCiphertext }, secretContext(row.id))]
  if (row.previousSecretKeyId && row.previousSecretNonce && row.previousSecretCiphertext && row.previousSecretExpiresAt && row.previousSecretExpiresAt > now) {
    secrets.push(openToken(context.keyring, { keyId: row.previousSecretKeyId, nonce: row.previousSecretNonce, ciphertext: row.previousSecretCiphertext }, secretContext(row.id)))
  }
  return secrets
}

/**
 * Sends due deliveries, up to `limit` at once. Each is claimed (its attempt
 * counted and its next try pushed a lease ahead) and committed before the
 * request, so a worker that dies mid-request leaves it to be tried again:
 * delivery is at least once. A 2xx settles it; anything else is tried again
 * after the next delay, and the last failure gives up. A 410 disables the
 * webhook at once, and so does failing every attempt for three days.
 */
export async function deliverDueWebhooks(context: EngineContext, limit = webhookBatchSize) {
  const now = clock(context)
  const claimed = await context.db.transaction(async transaction => {
    const due = await transaction.select({ delivery: webhookDeliveries, webhook: webhooks }).from(webhookDeliveries)
      .innerJoin(webhooks, eq(webhooks.id, webhookDeliveries.webhookId))
      .where(and(eq(webhookDeliveries.state, 'pending'), lte(webhookDeliveries.nextAttemptAt, now), eq(webhooks.status, 'active')))
      .orderBy(asc(webhookDeliveries.nextAttemptAt)).limit(limit).for('update', { of: webhookDeliveries, skipLocked: true })
    if (!due.length) return []
    await transaction.update(webhookDeliveries).set({ attemptCount: sql`${webhookDeliveries.attemptCount} + 1`, lastAttemptAt: now,
      nextAttemptAt: new Date(now.getTime() + deliveryLeaseMs) }).where(inArray(webhookDeliveries.id, due.map(row => row.delivery.id)))
    return due.map(row => ({ ...row, delivery: { ...row.delivery, attemptCount: row.delivery.attemptCount + 1 } }))
  })
  if (!claimed.length) return { delivered: 0, failed: 0 }
  const sender = context.webhookSender ?? defaultSender
  const results = await Promise.all(claimed.map(async ({ delivery, webhook }) => {
    let result: WebhookResult
    try {
      const body = JSON.stringify(delivery.payload)
      const timestamp = Math.floor(clock(context).getTime() / 1000)
      result = await sender({ url: webhook.url, body, headers: { 'webhook-id': delivery.id, 'webhook-timestamp': String(timestamp),
        'webhook-signature': signWebhook(secretsOf(context, webhook, now), delivery.id, timestamp, body) } })
    } catch (error) {
      log('error', 'webhook send threw', { deliveryId: delivery.id, ...errorFields(error) })
      result = { kind: 'failed', status: null, error: 'internal' }
    }
    await settleDelivery(context, delivery, webhook, result)
    return result.kind
  }))
  return { delivered: results.filter(kind => kind === 'delivered').length, failed: results.filter(kind => kind === 'failed').length }
}

async function settleDelivery(context: EngineContext, delivery: DeliveryRow, webhook: WebhookRow, result: WebhookResult) {
  await context.db.transaction(async transaction => {
    const now = clock(context)
    if (result.kind === 'delivered') {
      await transaction.update(webhookDeliveries).set({ state: 'delivered', deliveredAt: now, lastStatus: result.status, lastError: null })
        .where(and(eq(webhookDeliveries.id, delivery.id), eq(webhookDeliveries.state, 'pending')))
      await transaction.update(webhooks).set({ failingSince: null, lastDeliveredAt: now }).where(eq(webhooks.id, webhook.id))
      return
    }
    const [current] = await transaction.update(webhooks).set({ failingSince: sql`coalesce(${webhooks.failingSince}, ${now})` })
      .where(eq(webhooks.id, webhook.id)).returning()
    const reason = current?.status !== 'active' ? null : result.status === 410 ? 'gone'
      : current.failingSince && current.failingSince <= new Date(now.getTime() - disableAfterFailingMs) ? 'failing' : null
    const final = delivery.attemptCount >= maxDeliveryAttempts || reason !== null
    await transaction.update(webhookDeliveries).set({ lastStatus: result.status, lastError: result.error.slice(0, 500),
      ...(final ? { state: 'failed' as const } : { nextAttemptAt: new Date(now.getTime() + deliveryRetryDelaysMs[delivery.attemptCount - 1]!) }) })
      .where(and(eq(webhookDeliveries.id, delivery.id), eq(webhookDeliveries.state, 'pending')))
    if (!reason) return
    await transaction.update(webhooks).set({ status: 'disabled', disabledReason: reason, updatedAt: now }).where(eq(webhooks.id, webhook.id))
    await failPending(transaction, webhook.id, 'webhook_disabled', now)
    await recordEvent(transaction, { organizationId: webhook.organizationId, kind: 'webhook.disabled', detail: { webhookId: webhook.id, reason } })
    log('warn', 'webhook disabled', { webhookId: webhook.id, reason })
  })
}

/** Deliveries older than 30 days, whatever became of them. */
export async function deleteExpiredDeliveries(executor: Executor, now: Date) {
  const deleted = await executor.delete(webhookDeliveries).where(lt(webhookDeliveries.createdAt, new Date(now.getTime() - deliveriesRetentionMs)))
    .returning({ id: webhookDeliveries.id })
  return deleted.length
}
