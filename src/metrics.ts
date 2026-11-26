import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm'
import { clock, type EngineContext } from './context.js'
import { channelMetrics, channels, jobs, postMetrics, postMetricSamples, type Platform } from './db/schema.js'
import { channelDriver } from './jobs/driver.js'
import { errorFields, log } from './log.js'
import type { CallBudget } from './budget.js'
import { notPaused, pauseForRateLimit } from './pause.js'
import { RateLimited, ReauthRequired } from './platforms/types.js'
import { emitWebhookEvents, metricChanges, watchedPostMetricsIntervalMs, watchedPostMetricsWindowMs, webhookWatches } from './webhooks.js'
import { markNeedsReauth } from './token-check.js'

/** Posts older than this are no longer refreshed; their last numbers stay. */
export const metricsWindowMs = 90 * 86_400_000
/** How often the worker looks for due posts, and how many it reads per pass. */
export const metricsIntervalMs = 5 * 60_000
export const metricsBatchSize = 20

const hourMs = 60 * 60_000

/** Hourly for two days, every six hours until day 14, then daily: numbers move fastest right after publishing. */
export function nextCollection(publishedAt: Date, now: Date) {
  const age = now.getTime() - publishedAt.getTime()
  const interval = age < 2 * 24 * hourMs ? hourMs : age < 14 * 24 * hourMs ? 6 * hourMs : 24 * hourMs
  return new Date(now.getTime() + interval)
}

/** With a webhook watching the channel's post metrics, a post's first two days are read every 15 minutes. */
export function nextWatchedCollection(publishedAt: Date, now: Date) {
  const regular = nextCollection(publishedAt, now)
  if (now.getTime() - publishedAt.getTime() >= watchedPostMetricsWindowMs) return regular
  return new Date(Math.min(regular.getTime(), now.getTime() + watchedPostMetricsIntervalMs))
}

export function metricsRetryDelayMs(failureCount: number) {
  return Math.min(hourMs * 2 ** Math.max(0, failureCount - 1), 24 * hourMs)
}

/**
 * Reads the numbers of published posts that are due, one at a time. A
 * failure only delays that post; it never touches the job or the channel.
 * A read starts when the budget has a call left; each of its further
 * requests (up to five on Meta) spends one more.
 */
export async function collectDueMetrics(context: EngineContext, limit = metricsBatchSize, budget?: CallBudget) {
  const platforms = [...context.adapters].filter(([, adapter]) => adapter.metrics).map(([platform]) => platform) as Platform[]
  if (!platforms.length) return { collected: 0, failed: 0 }
  const now = clock(context)
  const due = await context.db.select({ job: jobs, channel: channels, failureCount: postMetrics.failureCount, previous: postMetrics.values,
    previousAt: postMetrics.collectedAt }).from(jobs)
    .innerJoin(channels, eq(channels.id, jobs.channelId))
    .leftJoin(postMetrics, eq(postMetrics.jobId, jobs.id))
    .leftJoin(channelMetrics, eq(channelMetrics.channelId, channels.id))
    .where(and(eq(jobs.state, 'published'), isNotNull(jobs.receipt), gt(jobs.publishAt, new Date(now.getTime() - metricsWindowMs)),
      eq(channels.status, 'active'), inArray(channels.platform, platforms), isNotNull(channels.providerAppId),
      or(isNull(postMetrics.jobId), lte(postMetrics.nextCollectAt, now)), notPaused(now)))
    .orderBy(asc(sql`coalesce(${postMetrics.nextCollectAt}, ${jobs.publishAt})`))
    .limit(limit)

  let collected = 0
  let failed = 0
  for (const { job, channel, failureCount, previous, previousAt } of due) {
    if (budget && !budget.allows(channel.platform)) continue
    if (budget && !budget.take(channel.platform)) break
    const base = { jobId: job.id, organizationId: job.organizationId, channelId: channel.id }
    try {
      const { app, token } = await channelDriver(context, context.db, channel)
      const result = await context.adapters.get(channel.platform)!.metrics!(app, {
        channel: { id: channel.id, kind: channel.kind, externalId: channel.externalId }, token, externalId: job.receipt!.externalId,
        spendCall: () => budget?.spend(channel.platform),
      })
      const finished = clock(context)
      await context.db.transaction(async transaction => {
        const watched = await webhookWatches(transaction, job.organizationId, channel.id, 'post.metrics.changed')
        const values = { values: result.values, unavailable: [...new Set(result.unavailable)], collectedAt: finished,
          nextCollectAt: (watched ? nextWatchedCollection : nextCollection)(job.publishAt, finished), failureCount: 0, lastError: null, updatedAt: finished }
        await transaction.insert(postMetrics).values({ ...base, ...values }).onConflictDoUpdate({ target: postMetrics.jobId, set: values })
        await transaction.insert(postMetricSamples).values({ ...base, collectedAt: finished, values: result.values })
        const before = previousAt ? (previous ?? {}) as Record<string, number> : null
        const { changed, changes } = metricChanges(before, result.values as Record<string, number>)
        if (watched && changed) {
          await emitWebhookEvents(transaction, { organizationId: job.organizationId, type: 'post.metrics.changed', channelId: channel.id, occurredAt: finished,
            items: [{ jobId: job.id, postId: job.postId, revision: job.revision, channelId: channel.id, platform: channel.platform, kind: channel.kind,
              externalId: job.receipt!.externalId, url: job.receipt!.url ?? null, values: result.values, previous: before, changes,
              unavailable: values.unavailable, collectedAt: finished.toISOString() }] })
        }
      })
      collected++
    } catch (error) {
      if (error instanceof RateLimited) {
        // Not the post's fault: the whole channel waits, and this post is read after the pause.
        const until = await pauseForRateLimit(context.db, channel, error, clock(context))
        await context.db.insert(postMetrics).values({ ...base, nextCollectAt: until }).onConflictDoUpdate({ target: postMetrics.jobId, set: { nextCollectAt: until } })
        failed++
        continue
      }
      if (error instanceof ReauthRequired) await markNeedsReauth(context, channel, 'read_refused')
      const failures = (failureCount ?? 0) + 1
      const finished = clock(context)
      const values = { nextCollectAt: new Date(finished.getTime() + metricsRetryDelayMs(failures)), failureCount: failures,
        lastError: (error instanceof Error ? error.message : 'Metrics collection failed').slice(0, 500), updatedAt: finished }
      await context.db.insert(postMetrics).values({ ...base, ...values }).onConflictDoUpdate({ target: postMetrics.jobId, set: values })
      log('warn', 'metrics collection failed', { jobId: job.id, failures, ...errorFields(error) })
      failed++
    }
  }
  return { collected, failed }
}

/** Collected numbers of the given jobs. Jobs never read successfully are left out. */
export async function readMetrics(context: EngineContext, organizationId: string, jobIds: string[]) {
  if (!jobIds.length) return []
  const rows = await context.db.select().from(postMetrics)
    .where(and(eq(postMetrics.organizationId, organizationId), inArray(postMetrics.jobId, jobIds), isNotNull(postMetrics.collectedAt)))
  return rows.map(row => ({ jobId: row.jobId, channelId: row.channelId, values: row.values, unavailable: row.unavailable,
    collectedAt: row.collectedAt!.toISOString() }))
}

/** Samples of each job, oldest first; jobs of other tenants are left out. */
export async function readMetricHistory(context: EngineContext, organizationId: string, jobIds: string[]) {
  if (!jobIds.length) return []
  const owned = await context.db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.organizationId, organizationId), inArray(jobs.id, jobIds)))
  const ids = new Set(owned.map(job => job.id))
  const samples = ids.size ? await context.db.select().from(postMetricSamples)
    .where(and(eq(postMetricSamples.organizationId, organizationId), inArray(postMetricSamples.jobId, [...ids])))
    .orderBy(asc(postMetricSamples.collectedAt), asc(postMetricSamples.id)) : []
  return [...new Set(jobIds)].filter(id => ids.has(id)).map(jobId => ({ jobId,
    samples: samples.filter(sample => sample.jobId === jobId).map(sample => ({ collectedAt: sample.collectedAt.toISOString(), values: sample.values })) }))
}
