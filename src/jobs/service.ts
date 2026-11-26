import { createHash } from 'node:crypto'
import { z } from 'zod'
import { and, desc, eq, inArray, ne, notInArray, sql } from 'drizzle-orm'
import { lockControls, readPublishing } from '../channels.js'
import { adapterFor, clock, recordEvent, type EngineContext } from '../context.js'
import { emitJobOutcome } from '../webhooks.js'
import { channelDriver } from './driver.js'
import { attempts, channels, jobs, type JobLane, type JobPayload } from '../db/schema.js'
import { conflict, invalid, notFound } from '../errors.js'
import { loadMediaInfo } from '../media.js'

export const minimumLeadMs = 5 * 60_000
/** Reconcile may only conclude "not published" after this long. */
export const propagationWindowMs = 15 * 60_000

export interface SubmitInput {
  organizationId: string
  postId: string
  revision: number
  approvedByUserId: string
  approvedAt: string
  publishAt: string
  content: string
  mediaIds: string[]
  channels: Array<{ channelId: string, settings: Record<string, unknown> }>
}

type JobRow = typeof jobs.$inferSelect

export function jobView(job: JobRow) {
  return { id: job.id, postId: job.postId, revision: job.revision, channelId: job.channelId, state: job.state,
    publishAt: job.publishAt.toISOString(), attemptCount: job.attemptCount, receipt: job.receipt,
    lastError: job.lastError, updatedAt: job.updatedAt.toISOString() }
}

export function payloadHash(value: { content: string, mediaIds: string[], publishAt: string, settings: Record<string, unknown> }) {
  return createHash('sha256').update(canonicalJson({ ...value, publishAt: new Date(value.publishAt).toISOString() })).digest('hex')
}

export async function submitJobs(context: EngineContext, input: SubmitInput) {
  const channelIds = input.channels.map(channel => channel.channelId)
  if (new Set(channelIds).size !== channelIds.length) throw invalid('duplicate_channel', 'Each channel may appear once')
  return context.db.transaction(async transaction => {
    await lockControls(transaction, input.organizationId)
    const hashes = new Map(input.channels.map(channel => [channel.channelId, payloadHash({ content: input.content, mediaIds: input.mediaIds, publishAt: input.publishAt, settings: channel.settings })]))
    const existing = await transaction.select().from(jobs)
      .where(and(eq(jobs.organizationId, input.organizationId), eq(jobs.postId, input.postId), eq(jobs.revision, input.revision)))
    if (existing.length) {
      const identical = existing.length === channelIds.length && existing.every(job => hashes.get(job.channelId) === job.payloadHash)
      if (!identical) throw conflict('revision_conflict', 'This revision was already submitted with different content or channels')
      return { jobs: existing.map(jobView), created: false }
    }

    const now = clock(context)
    const publishAt = new Date(input.publishAt)
    if (publishAt.getTime() < now.getTime() + minimumLeadMs) throw invalid('publish_at_too_soon', 'publishAt must be at least five minutes ahead')
    const controls = await readPublishing(transaction, input.organizationId)
    if (controls.paused || channelIds.some(id => controls.pausedChannelIds.includes(id))) throw conflict('paused', 'Publishing is paused')
    const rows = await transaction.select().from(channels)
      .where(and(eq(channels.organizationId, input.organizationId), inArray(channels.id, channelIds)))
    if (rows.length !== channelIds.length) throw notFound('Channel')
    const mediaInfo = await loadMediaInfo(transaction, input.organizationId, input.mediaIds)
    for (const target of input.channels) {
      const channel = rows.find(row => row.id === target.channelId)!
      if (channel.status !== 'active') throw conflict('channel_inactive', `Channel ${channel.name} needs to be reconnected`)
      const adapter = adapterFor(context, channel.platform)
      adapter.validateSettings(channel.kind, target.settings, mediaInfo, input.content)
      const limits = adapter.limits(channel.kind)
      if (input.content.length > limits.maxLength) throw invalid('content_too_long', `Content is too long for ${channel.name}`)
      if (input.mediaIds.length > limits.maxMedia) throw invalid('too_many_media', `Too many images for ${channel.name}`)
    }
    // Counted under the tenant lock, so concurrent submissions cannot both pass.
    const day = sql`(${publishAt.toISOString()}::timestamptz at time zone 'Europe/Rome')::date`
    const counts = await transaction.select({ channelId: jobs.channelId, count: sql<number>`count(*)::int` }).from(jobs)
      .where(and(eq(jobs.organizationId, input.organizationId), inArray(jobs.channelId, channelIds),
        notInArray(jobs.state, ['cancelled', 'failed']), sql`(${jobs.publishAt} at time zone 'Europe/Rome')::date = ${day}`))
      .groupBy(jobs.channelId)
    const full = counts.find(row => row.count >= controls.maxPostsPerChannelPerDay)
    if (full) throw conflict('daily_limit', `Daily limit of ${controls.maxPostsPerChannelPerDay} posts reached for a channel`, { channelId: full.channelId })

    const video = mediaInfo.some(file => file.mimeType.startsWith('video/'))
    const created = await transaction.insert(jobs).values(input.channels.map(target => {
      const channel = rows.find(row => row.id === target.channelId)!
      const payload: JobPayload = { content: input.content, mediaIds: input.mediaIds, settings: target.settings,
        approvedByUserId: input.approvedByUserId, approvedAt: input.approvedAt }
      return { organizationId: input.organizationId, postId: input.postId, revision: input.revision, channelId: target.channelId,
        lane: jobLane(channel, video), payload, payloadHash: hashes.get(target.channelId)!, publishAt, notBefore: publishAt }
    })).returning()
    for (const job of created) {
      await recordEvent(transaction, { organizationId: input.organizationId, kind: 'job.queued', jobId: job.id, channelId: job.channelId,
        detail: { postId: job.postId, revision: job.revision, approvedByUserId: input.approvedByUserId } })
    }
    return { jobs: created.map(jobView), created: true }
  })
}

export async function cancelJobs(context: EngineContext, organizationId: string, postId: string, revision: number) {
  return context.db.transaction(async transaction => {
    const rows = await transaction.select().from(jobs)
      .where(and(eq(jobs.organizationId, organizationId), eq(jobs.postId, postId), eq(jobs.revision, revision))).for('update')
    if (!rows.length) throw notFound('Jobs')
    const results = []
    for (const job of rows) {
      if (job.state === 'queued') {
        const now = clock(context)
        const [updated] = await transaction.update(jobs).set({ state: 'cancelled', lastError: 'cancelled', updatedAt: now }).where(eq(jobs.id, job.id)).returning()
        await recordEvent(transaction, { organizationId, kind: 'job.cancelled', jobId: job.id, channelId: job.channelId })
        await emitJobOutcome(transaction, updated!, now)
        results.push({ jobId: job.id, channelId: job.channelId, state: 'cancelled' as const, result: 'cancelled' as const })
      } else {
        results.push({ jobId: job.id, channelId: job.channelId, state: job.state, result: job.state === 'cancelled' ? 'cancelled' as const : 'too_late' as const })
      }
    }
    return { jobs: results }
  })
}

export async function listJobs(context: EngineContext, organizationId: string, postId: string) {
  const rows = await context.db.select().from(jobs).where(and(eq(jobs.organizationId, organizationId), eq(jobs.postId, postId)))
    .orderBy(desc(jobs.revision), jobs.channelId)
  return { jobs: rows.map(jobView) }
}

/** Operator action: read the platform and settle an uncertain job. */
export async function reconcileJob(context: EngineContext, organizationId: string, jobId: string) {
  const [job] = await context.db.select().from(jobs).where(and(eq(jobs.organizationId, organizationId), eq(jobs.id, jobId))).limit(1)
  if (!job) throw notFound('Job')
  if (job.state !== 'uncertain') throw conflict('not_uncertain', 'Only uncertain jobs can be reconciled')
  const [attempt] = await context.db.select().from(attempts).where(eq(attempts.jobId, job.id)).orderBy(desc(attempts.startedAt)).limit(1)
  const [channel] = await context.db.select().from(channels).where(eq(channels.id, job.channelId)).limit(1)
  if (!attempt || !channel) throw notFound('Attempt')
  const driver = await channelDriver(context, context.db, channel)
  const others = await context.db.select({ receipt: jobs.receipt }).from(jobs)
    .where(and(eq(jobs.channelId, channel.id), eq(jobs.state, 'published'), ne(jobs.id, job.id)))
  const outcome = await adapterFor(context, channel.platform).reconcile(driver.app, {
    attemptId: attempt.id, channel: { id: channel.id, kind: channel.kind, externalId: channel.externalId }, token: driver.token, content: job.payload.content, settings: job.payload.settings,
    since: new Date(attempt.startedAt.getTime() - 60_000),
    excludeExternalIds: others.flatMap(row => row.receipt ? [row.receipt.externalId] : []),
  })
  const now = clock(context)
  if (outcome.kind === 'ambiguous') return { job: jobView(job), result: 'ambiguous', detail: outcome.detail }
  if (outcome.kind === 'not_found' && now.getTime() - attempt.startedAt.getTime() < propagationWindowMs) {
    return { job: jobView(job), result: 'too_early', detail: 'Try again after the propagation window' }
  }
  return context.db.transaction(async transaction => {
    const values = outcome.kind === 'published'
      ? { state: 'published' as const, receipt: { externalId: outcome.externalId, url: outcome.url, settledBy: 'reconcile' as const }, lastError: null }
      : { state: 'failed' as const, lastError: 'not_found_on_platform' }
    const [updated] = await transaction.update(jobs).set({ ...values, updatedAt: now })
      .where(and(eq(jobs.id, job.id), eq(jobs.state, 'uncertain'))).returning()
    if (!updated) throw conflict('not_uncertain', 'The job changed while reconciling')
    await recordEvent(transaction, { organizationId, kind: `job.reconciled.${updated.state}`, jobId: job.id, channelId: job.channelId })
    await emitJobOutcome(transaction, updated, now)
    return { job: jobView(updated), result: updated.state }
  })
}

export const resolveJobSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ organizationId: z.string().min(1).max(200), outcome: z.literal('published'), externalId: z.string().min(1).max(200),
    url: z.url({ protocol: /^https$/ }).max(2_000).optional(), resolvedByUserId: z.string().min(1).max(200) }),
  z.strictObject({ organizationId: z.string().min(1).max(200), outcome: z.literal('not_published'), resolvedByUserId: z.string().min(1).max(200) }),
])

/**
 * A person settles an uncertain job, as for replies and messages, when
 * reconcile cannot (two posts share a caption, the platform hides the post,
 * or the person simply looked). `published` takes the post's platform ID, so
 * metrics and replies keep working; `not_published` fails the job, and the
 * post can be submitted again as a new revision. Recorded with who decided.
 */
export async function resolveJob(context: EngineContext, jobId: string, input: z.infer<typeof resolveJobSchema>) {
  return context.db.transaction(async transaction => {
    const now = clock(context)
    const [job] = await transaction.select().from(jobs).where(and(eq(jobs.organizationId, input.organizationId), eq(jobs.id, jobId))).for('update').limit(1)
    if (!job) throw notFound('Job')
    if (job.state !== 'uncertain') throw conflict('not_uncertain', 'Only an uncertain job can be resolved', { state: job.state })
    if (input.outcome === 'published') {
      const [taken] = await transaction.select({ id: jobs.id }).from(jobs)
        .where(and(eq(jobs.channelId, job.channelId), eq(jobs.state, 'published'), ne(jobs.id, job.id), sql`${jobs.receipt}->>'externalId' = ${input.externalId}`)).limit(1)
      if (taken) throw conflict('receipt_taken', 'Another post of this channel already has that platform ID')
    }
    const values = input.outcome === 'published'
      ? { state: 'published' as const, receipt: { externalId: input.externalId, ...(input.url ? { url: input.url } : {}), settledBy: 'operator' as const }, lastError: null }
      : { state: 'failed' as const, lastError: 'resolved_not_published' }
    const [updated] = await transaction.update(jobs).set({ ...values, updatedAt: now }).where(eq(jobs.id, job.id)).returning()
    await recordEvent(transaction, { organizationId: input.organizationId, kind: 'job.resolved', jobId: job.id, channelId: job.channelId,
      detail: { outcome: input.outcome, resolvedByUserId: input.resolvedByUserId } })
    await emitJobOutcome(transaction, updated!, now)
    return { job: jobView(updated!) }
  })
}

/** Browser channels drive a website for minutes; videos upload and process for minutes: each has its own slots. */
export function jobLane(channel: { browserAccountId: string | null }, video: boolean): JobLane {
  return channel.browserAccountId ? 'browser' : video ? 'video' : 'standard'
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}
