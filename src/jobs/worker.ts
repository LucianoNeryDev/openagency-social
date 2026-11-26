import { and, asc, eq, inArray, isNotNull, isNull, lt, lte, sql } from 'drizzle-orm'
import { lockControls, readPublishing } from '../channels.js'
import { adapterFor, clock, recordEvent, type EngineContext } from '../context.js'
import { attempts, channels, jobLanes, jobs, oauthStates, type JobLane, type JobState } from '../db/schema.js'
import { channelDriver } from './driver.js'
import { refreshIdleCredentials, TransientCredentialError } from '../credentials.js'
import { errorFields, log } from '../log.js'
import { loadMedia, publicMediaUrl } from '../media.js'
import { CallBudget } from '../budget.js'
import { collectDueChannelMetrics } from '../channel-metrics.js'
import { collectDueMetrics, metricsIntervalMs } from '../metrics.js'
import { collectDueResponses, responsesIntervalMs } from '../responses.js'
import { repliesIntervalMs, runReplies, sweepReplies } from '../replies.js'
import { collectDueConversations, conversationsIntervalMs } from '../conversations.js'
import { messagesIntervalMs, runMessages, sweepMessages } from '../messages.js'
import { applyRetention, retentionIntervalMs } from '../retention.js'
import { checkDueTokens, tokenCheckIntervalMs } from '../token-check.js'
import { answeringIntervalMs, runAnswering } from '../answering/pipeline.js'
import { AttemptClosedError, type PublishOutcome } from '../platforms/types.js'
import { changeChannelStatus, deliverDueWebhooks, emitJobOutcome, webhooksIntervalMs } from '../webhooks.js'

export const maxAttempts = 5
/** A job later than this after publishAt is not started any more. */
export const maxLatenessMs = 60 * 60_000
/** An attempt still open this long after its start or last heartbeat is treated as lost. */
export const abandonedAfterMs = 10 * 60_000
/** A queued job this long past its time has not started: readiness reports publishing as late. */
export const lateStartMs = 15 * 60_000
/** How often idle keep-alive grants are checked. */
export const idleRefreshIntervalMs = 60 * 60_000

export interface ClaimedJob {
  jobId: string
  attemptId: string
  organizationId: string
  lane?: JobLane
}

export interface LaneSlots {
  /** Standard posts: photos, text, links. */
  standard: number
  video: number
  browser: number
}

/**
 * Claims one due job. Pause and channel state are re-checked under the same
 * lock that pause updates take, and the claim commits before any platform
 * call, so a crash leaves an open attempt for the sweeper.
 */
export async function claimNext(context: EngineContext, lanes: readonly JobLane[] = jobLanes): Promise<ClaimedJob | null> {
  if (!lanes.length) return null
  for (let skipped = 0; skipped < 50; skipped++) {
    const result = await context.db.transaction(async transaction => {
      const now = clock(context)
      const [job] = await transaction.select().from(jobs)
        .where(and(eq(jobs.state, 'queued'), lte(jobs.notBefore, now), inArray(jobs.lane, [...lanes])))
        .orderBy(asc(jobs.notBefore)).limit(1).for('update', { skipLocked: true })
      if (!job) return null
      await lockControls(transaction, job.organizationId)
      const controls = await readPublishing(transaction, job.organizationId)
      const [channel] = await transaction.select().from(channels).where(eq(channels.id, job.channelId)).limit(1)
      const reason = controls.paused || controls.pausedChannelIds.includes(job.channelId) ? 'paused'
        : channel?.status !== 'active' ? 'channel_inactive'
          : now.getTime() - job.publishAt.getTime() > maxLatenessMs ? 'too_late' : null
      if (reason) {
        const state: JobState = reason === 'paused' ? 'cancelled' : 'failed'
        log(reason === 'paused' ? 'info' : 'warn', 'job not started', { jobId: job.id, channelId: job.channelId, reason })
        const [updated] = await transaction.update(jobs).set({ state, lastError: reason, updatedAt: now }).where(eq(jobs.id, job.id)).returning()
        await recordEvent(transaction, { organizationId: job.organizationId, kind: `job.${state}`, jobId: job.id, channelId: job.channelId, detail: { reason } })
        await emitJobOutcome(transaction, updated!, now)
        return 'skipped' as const
      }
      const [attempt] = await transaction.insert(attempts).values({ jobId: job.id, startedAt: now }).returning({ id: attempts.id })
      await transaction.update(jobs).set({ state: 'running', attemptCount: job.attemptCount + 1, updatedAt: now }).where(eq(jobs.id, job.id))
      await recordEvent(transaction, { organizationId: job.organizationId, kind: 'job.running', jobId: job.id, channelId: job.channelId, detail: { attempt: job.attemptCount + 1 } })
      return { jobId: job.id, attemptId: attempt!.id, organizationId: job.organizationId, lane: job.lane }
    })
    if (result !== 'skipped') return result
  }
  return null
}

/** Not a platform outcome: the attempt was closed before its visible request, and its job is queued again. */
export const interrupted = { kind: 'failed', retryable: true, code: 'interrupted', detail: 'Stopped before the post was sent' } as const

export async function executeClaimed(context: EngineContext, claimed: ClaimedJob): Promise<PublishOutcome> {
  let outcome: PublishOutcome
  try {
    outcome = await publishClaimed(context, claimed)
  } catch (error) {
    if (error instanceof AttemptClosedError) return interrupted
    // Unexpected failure inside the adapter: the post may exist.
    log('error', 'publish threw', { jobId: claimed.jobId, ...errorFields(error) })
    outcome = { kind: 'uncertain', code: 'internal', detail: 'Unexpected error during publish' }
  }
  await settleAttempt(context, claimed, outcome)
  return outcome
}

async function publishClaimed(context: EngineContext, claimed: ClaimedJob): Promise<PublishOutcome> {
  const [job] = await context.db.select().from(jobs).where(eq(jobs.id, claimed.jobId)).limit(1)
  const [channel] = job ? await context.db.select().from(channels).where(eq(channels.id, job.channelId)).limit(1) : []
  if (!job || !channel) return { kind: 'failed', retryable: false, code: 'missing', detail: 'Job or channel missing' }
  // Nothing has been sent yet, so preparation failures are definite.
  let prepared
  try {
    const driver = await channelDriver(context, context.db, channel)
    const now = clock(context)
    const files = (await loadMedia(context.db, job.organizationId, job.payload.mediaIds)).map(file => ({ ...file,
      ...(context.publicMedia ? { publicUrl: publicMediaUrl(context.publicMedia, job.organizationId, file.id, now) } : {}) }))
    prepared = { ...driver, files }
  } catch (error) {
    log('error', 'job preparation failed', { jobId: job.id, ...errorFields(error) })
    // A token refresh that failed on the network can be tried again.
    if (error instanceof TransientCredentialError) return { kind: 'failed', retryable: true, code: 'token_refresh_failed', detail: error.message }
    return { kind: 'failed', retryable: false, code: 'preparation_failed', detail: error instanceof Error ? error.message : 'Preparation failed' }
  }
  return adapterFor(context, channel.platform).publish(prepared.app, {
    attemptId: claimed.attemptId, channel: { id: channel.id, kind: channel.kind, externalId: channel.externalId }, token: prepared.token,
    ...(prepared.browserAccount ? { browserAccount: prepared.browserAccount } : {}),
    content: job.payload.content, media: prepared.files, settings: job.payload.settings,
    heartbeat: async () => { await context.db.update(attempts).set({ heartbeatAt: clock(context) }).where(eq(attempts.id, claimed.attemptId)) },
    beforeVisible: () => markSent(context, claimed.attemptId),
  })
}

/**
 * Records that the visible request is about to go out, unless the attempt was
 * closed meanwhile (by a stopping engine that queued the job again): then
 * nothing may be sent. The row lock orders this against requeueUnsent.
 */
export async function markSent(context: EngineContext, attemptId: string) {
  const now = clock(context)
  const marked = await context.db.update(attempts).set({ sentAt: now, heartbeatAt: now })
    .where(and(eq(attempts.id, attemptId), isNull(attempts.finishedAt))).returning({ id: attempts.id })
  if (!marked.length) throw new AttemptClosedError()
}

/**
 * Closes open attempts that never sent their visible request and queues their
 * jobs again at once: nothing reached the platform. The interrupted attempt
 * does not count against the job's tries. Returns the requeued job IDs.
 */
export async function requeueUnsent(context: EngineContext, attemptIds: string[], reason: 'interrupted' | 'abandoned') {
  if (!attemptIds.length) return []
  return context.db.transaction(async transaction => {
    const now = clock(context)
    const closed = await transaction.update(attempts).set({ finishedAt: now, outcome: 'failed_retryable', errorCode: reason, detail: 'Stopped before the post was sent' })
      .where(and(inArray(attempts.id, attemptIds), isNull(attempts.finishedAt), isNull(attempts.sentAt))).returning({ jobId: attempts.jobId })
    if (!closed.length) return []
    const requeued = await transaction.update(jobs).set({ state: 'queued', notBefore: now, lastError: reason, updatedAt: now,
      attemptCount: sql`greatest(${jobs.attemptCount} - 1, 0)` })
      .where(and(inArray(jobs.id, closed.map(row => row.jobId)), eq(jobs.state, 'running'))).returning()
    for (const job of requeued) {
      await recordEvent(transaction, { organizationId: job.organizationId, kind: 'job.requeued', jobId: job.id, channelId: job.channelId, detail: { reason } })
      await emitJobOutcome(transaction, job, now)
    }
    return requeued.map(job => job.id)
  })
}

export function retryDelayMs(attemptCount: number) {
  return Math.min(60_000 * 2 ** Math.max(0, attemptCount - 1), 15 * 60_000)
}

export async function settleAttempt(context: EngineContext, claimed: ClaimedJob, outcome: PublishOutcome) {
  await context.db.transaction(async transaction => {
    const now = clock(context)
    const [job] = await transaction.select().from(jobs).where(eq(jobs.id, claimed.jobId)).for('update').limit(1)
    if (!job) return
    const attemptOutcome = outcome.kind === 'published' ? 'succeeded' as const : outcome.kind === 'uncertain' ? 'uncertain' as const
      : outcome.retryable ? 'failed_retryable' as const : 'failed_final' as const
    await transaction.update(attempts).set({ finishedAt: now, outcome: attemptOutcome,
      errorCode: outcome.kind === 'published' ? null : outcome.code, detail: outcome.kind === 'published' ? null : outcome.detail.slice(0, 2_000) })
      .where(and(eq(attempts.id, claimed.attemptId), isNull(attempts.finishedAt)))

    // The sweeper may have marked a slow attempt uncertain. A confirmed
    // result still settles it; anything else leaves it for reconcile.
    if (job.state !== 'running' && !(job.state === 'uncertain' && outcome.kind === 'published')) {
      await recordEvent(transaction, { organizationId: job.organizationId, kind: 'job.late_outcome', jobId: job.id, detail: { outcome: outcome.kind } })
      return
    }
    let values: Partial<typeof jobs.$inferInsert>
    if (outcome.kind === 'published') {
      values = { state: 'published', receipt: { externalId: outcome.externalId, url: outcome.url, settledBy: 'worker' }, lastError: null }
    } else if (outcome.kind === 'uncertain') {
      values = { state: 'uncertain', lastError: outcome.code }
    } else if (outcome.retryable && job.attemptCount < maxAttempts) {
      values = { state: 'queued', notBefore: new Date(now.getTime() + retryDelayMs(job.attemptCount)), lastError: outcome.code }
    } else {
      values = { state: 'failed', lastError: outcome.retryable ? `retries_exhausted:${outcome.code}` : outcome.code }
    }
    const [updated] = await transaction.update(jobs).set({ ...values, updatedAt: now }).where(eq(jobs.id, job.id)).returning()
    await emitJobOutcome(transaction, updated!, now)
    if (outcome.kind === 'failed' && outcome.reauth) {
      await changeChannelStatus(transaction, job.channelId, 'needs_reauth', 'publish_refused', now)
      await recordEvent(transaction, { organizationId: job.organizationId, kind: 'channel.needs_reauth', channelId: job.channelId })
    }
    await recordEvent(transaction, { organizationId: job.organizationId, kind: `job.${values.state}`, jobId: job.id, channelId: job.channelId,
      detail: outcome.kind === 'published' ? { externalId: outcome.externalId } : { code: outcome.code } })
  })
}

/**
 * Settles attempts that outlived any request timeout (their engine died):
 * one that never sent its visible request is queued again, one that did
 * turns its job uncertain.
 */
export async function sweep(context: EngineContext) {
  const now = clock(context)
  const cutoff = new Date(now.getTime() - abandonedAfterMs)
  const lost = and(isNull(attempts.finishedAt), lt(sql`coalesce(${attempts.heartbeatAt}, ${attempts.startedAt})`, cutoff), eq(jobs.state, 'running'))
  const unsent = await context.db.select({ attemptId: attempts.id }).from(attempts).innerJoin(jobs, eq(jobs.id, attempts.jobId))
    .where(and(lost, isNull(attempts.sentAt)))
  const requeued = await requeueUnsent(context, unsent.map(row => row.attemptId), 'abandoned')
  if (requeued.length) log('warn', 'attempts abandoned before sending, queued again', { jobIds: requeued })
  const swept = await context.db.transaction(async transaction => {
    const open = await transaction.select({ attemptId: attempts.id, jobId: attempts.jobId }).from(attempts)
      .innerJoin(jobs, eq(jobs.id, attempts.jobId))
      .where(and(lost, isNotNull(attempts.sentAt)))
      .for('update', { of: jobs, skipLocked: true })
    if (!open.length) return []
    await transaction.update(attempts).set({ finishedAt: now, outcome: 'uncertain', errorCode: 'abandoned' })
      .where(inArray(attempts.id, open.map(row => row.attemptId)))
    const updated = await transaction.update(jobs).set({ state: 'uncertain', lastError: 'abandoned', updatedAt: now })
      .where(inArray(jobs.id, open.map(row => row.jobId))).returning()
    for (const job of updated) {
      await recordEvent(transaction, { organizationId: job.organizationId, kind: 'job.uncertain', jobId: job.id, channelId: job.channelId, detail: { reason: 'abandoned' } })
      await emitJobOutcome(transaction, job, now)
    }
    return updated.map(job => job.id)
  })
  await context.db.delete(oauthStates).where(lt(oauthStates.expiresAt, new Date(now.getTime() - 86_400_000)))
  return swept
}

export interface WorkerHealth {
  enabled: boolean
  /** When the last tick finished; null before the first. */
  lastTickAt: Date | null
  pollMs: number
}

export class Worker {
  private timer: NodeJS.Timeout | undefined
  // Publish tasks in flight, with the attempt each one holds.
  private readonly running = new Map<Promise<unknown>, ClaimedJob>()
  private lastTickAt: Date | null = null
  private enabled = false
  private stopping = false
  private ticking = false
  private lastIdleRefresh = 0
  private lastMetrics = 0
  private lastResponses = 0
  private lastReplies = 0
  private lastConversations = 0
  private lastMessages = 0
  private lastRetention = 0
  private lastWebhooks = 0
  private lastAnswering = 0
  private lastTokenCheck = 0
  // Collectors run beside publishing, never in its way: one pass of each at a time, outside the job slots.
  private metrics: Promise<void> | undefined
  private responses: Promise<void> | undefined
  // Approved comment replies: sent one after another, outside the job slots.
  private replies: Promise<void> | undefined
  // Direct messages: conversations are read by one pass, and sent by another that never reads them.
  private conversations: Promise<void> | undefined
  private messages: Promise<void> | undefined
  private retention: Promise<void> | undefined
  // Webhook deliveries: a few requests at once, outside the job slots.
  private webhooks: Promise<void> | undefined
  // AI answers: decides and drafts what the readers stored, after they committed. Holds no reading or sending code.
  private answering: Promise<void> | undefined
  // The daily token check: one cheap read per channel, from the shared read budget.
  private tokenCheck: Promise<void> | undefined
  // Post, account and comment reads share about 60 platform calls a minute; each request spends one.
  private readonly budget = new CallBudget()

  constructor(private readonly context: EngineContext, private readonly options: { concurrency: number, pollMs: number, slots?: Partial<LaneSlots> }) {}

  /** Slots per lane: standard posts take `concurrency`, videos and browser jobs one each unless set. */
  private slots(): LaneSlots {
    return { standard: this.options.concurrency, video: 1, browser: 1, ...this.options.slots }
  }

  private freeLanes(): JobLane[] {
    const slots = this.slots()
    const busy = new Map<JobLane, number>()
    for (const claimed of this.running.values()) busy.set(claimed.lane ?? 'standard', (busy.get(claimed.lane ?? 'standard') ?? 0) + 1)
    return jobLanes.filter(lane => (busy.get(lane) ?? 0) < slots[lane])
  }

  start() {
    this.enabled = true
    this.timer = setInterval(() => void this.tick(), this.options.pollMs)
    void this.tick()
  }

  health(): WorkerHealth {
    return { enabled: this.enabled, lastTickAt: this.lastTickAt, pollMs: this.options.pollMs }
  }

  /**
   * Stops claiming, then gives work in flight up to `graceMs` to finish. Half
   * way, attempts that have not sent their visible request are closed and
   * their jobs queued again (the next engine starts them at once); attempts
   * that did send get the rest of the grace. Whatever is still open after it
   * is left to the next engine's sweeper (uncertain, then reconcile).
   */
  async stop(graceMs = 25_000) {
    this.stopping = true
    clearInterval(this.timer)
    const background = [this.metrics, this.responses, this.replies, this.conversations, this.messages, this.retention, this.webhooks, this.answering, this.tokenCheck]
    const settled = (ms: number) => Promise.race([
      Promise.allSettled([...this.running.keys(), ...background]).then(() => true),
      new Promise<false>(resolve => setTimeout(() => resolve(false), ms).unref()),
    ])
    if (await settled(graceMs / 2)) return
    const open = [...this.running.values()].map(claimed => claimed.attemptId)
    const requeued = await requeueUnsent(this.context, open, 'interrupted').catch(error => {
      log('error', 'requeue on shutdown failed', errorFields(error))
      return []
    })
    if (requeued.length) log('info', 'jobs queued again on shutdown, nothing was sent', { jobIds: requeued })
    if (await settled(graceMs / 2)) return
    if (this.running.size) log('warn', 'shutdown grace over with attempts still open', { jobIds: [...this.running.values()].map(claimed => claimed.jobId) })
  }

  async tick() {
    if (this.ticking || this.stopping) return
    this.ticking = true
    try {
      const swept = await sweep(this.context)
      if (swept.length) log('error', 'attempts abandoned after sending, jobs uncertain', { jobIds: swept })
      const sweptReplies = await sweepReplies(this.context)
      if (sweptReplies.length) log('warn', 'reply attempts abandoned', { replyIds: sweptReplies })
      const sweptMessages = await sweepMessages(this.context)
      if (sweptMessages.length) log('warn', 'message attempts abandoned', { outgoingMessageIds: sweptMessages })
      if (Date.now() - this.lastIdleRefresh >= idleRefreshIntervalMs) {
        this.lastIdleRefresh = Date.now()
        const renewed = await refreshIdleCredentials(this.context)
        if (renewed) log('info', 'idle tokens refreshed', { count: renewed })
      }
      if (!this.metrics && Date.now() - this.lastMetrics >= metricsIntervalMs) {
        this.lastMetrics = Date.now()
        this.metrics = collectDueMetrics(this.context, undefined, this.budget)
          .then(result => { if (result.collected || result.failed) log('info', 'metrics collected', result) })
          .catch(error => log('error', 'metrics pass failed', errorFields(error)))
          .then(() => collectDueChannelMetrics(this.context, this.budget))
          .then(result => { if (result && (result.collected || result.failed)) log('info', 'channel metrics collected', result) })
          .catch(error => log('error', 'channel metrics pass failed', errorFields(error)))
          .finally(() => { this.metrics = undefined })
      }
      if (!this.responses && Date.now() - this.lastResponses >= responsesIntervalMs) {
        this.lastResponses = Date.now()
        this.responses = collectDueResponses(this.context, this.budget)
          .then(result => { if (result.failed) log('info', 'responses checked', result) })
          .catch(error => log('error', 'responses pass failed', errorFields(error)))
          .finally(() => { this.responses = undefined })
      }
      if (!this.replies && Date.now() - this.lastReplies >= repliesIntervalMs) {
        this.lastReplies = Date.now()
        this.replies = runReplies(this.context, this.budget)
          .then(result => { if (result.sent || result.reconciled.checked) log('info', 'replies processed', result) })
          .catch(error => log('error', 'replies pass failed', errorFields(error)))
          .finally(() => { this.replies = undefined })
      }
      if (!this.conversations && Date.now() - this.lastConversations >= conversationsIntervalMs) {
        this.lastConversations = Date.now()
        this.conversations = collectDueConversations(this.context, this.budget)
          .then(result => { if (result.failed) log('info', 'conversations synced', result) })
          .catch(error => log('error', 'conversations pass failed', errorFields(error)))
          .finally(() => { this.conversations = undefined })
      }
      if (!this.messages && Date.now() - this.lastMessages >= messagesIntervalMs) {
        this.lastMessages = Date.now()
        this.messages = runMessages(this.context, this.budget)
          .then(result => { if (result.sent || result.reconciled.checked) log('info', 'messages processed', result) })
          .catch(error => log('error', 'messages pass failed', errorFields(error)))
          .finally(() => { this.messages = undefined })
      }
      if (!this.webhooks && Date.now() - this.lastWebhooks >= webhooksIntervalMs) {
        this.lastWebhooks = Date.now()
        this.webhooks = deliverDueWebhooks(this.context)
          .then(result => { if (result.failed) log('info', 'webhooks delivered', result) })
          .catch(error => log('error', 'webhooks pass failed', errorFields(error)))
          .finally(() => { this.webhooks = undefined })
      }
      if (!this.answering && Date.now() - this.lastAnswering >= answeringIntervalMs) {
        this.lastAnswering = Date.now()
        this.answering = runAnswering(this.context)
          .then(result => { if (result.drafted || result.failed) log('info', 'inbound items decided', result) })
          .catch(error => log('error', 'answering pass failed', errorFields(error)))
          .finally(() => { this.answering = undefined })
      }
      if (!this.tokenCheck && Date.now() - this.lastTokenCheck >= tokenCheckIntervalMs) {
        this.lastTokenCheck = Date.now()
        this.tokenCheck = checkDueTokens(this.context, this.budget)
          .then(result => { if (result.refused || result.failed) log('info', 'tokens checked', result) })
          .catch(error => log('error', 'token check pass failed', errorFields(error)))
          .finally(() => { this.tokenCheck = undefined })
      }
      if (!this.retention && Date.now() - this.lastRetention >= retentionIntervalMs) {
        this.lastRetention = Date.now()
        // In the background: a slow or failing sweep must not hold back job claims.
        this.retention = applyRetention(this.context)
          .then(deleted => { if (Object.values(deleted).some(Boolean)) log('info', 'expired data deleted', deleted) })
          .catch(error => log('error', 'retention pass failed', errorFields(error)))
          .finally(() => { this.retention = undefined })
      }
      while (!this.stopping) {
        const lanes = this.freeLanes()
        if (!lanes.length) break
        const claimed = await claimNext(this.context, lanes)
        if (!claimed) break
        const task = executeClaimed(this.context, claimed)
          .then(outcome => log(outcome.kind === 'published' || outcome === interrupted ? 'info' : outcome.kind === 'uncertain' ? 'error' : 'warn',
            'job attempt finished', { jobId: claimed.jobId, outcome: outcome.kind, ...(outcome.kind === 'published' ? {} : { code: outcome.code }) }))
          .catch(error => log('error', 'job settle failed', { jobId: claimed.jobId, ...errorFields(error) }))
          .finally(() => this.running.delete(task))
        this.running.set(task, claimed)
      }
      this.lastTickAt = new Date()
    } catch (error) {
      log('error', 'worker tick failed', errorFields(error))
    } finally {
      this.ticking = false
    }
  }
}
