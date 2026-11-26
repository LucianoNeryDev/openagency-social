import { and, asc, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm'
import type { CallBudget } from './budget.js'
import { clock, type EngineContext } from './context.js'
import { channelMetrics, channelMetricSamples, channels, type Platform } from './db/schema.js'
import { channelDriver } from './jobs/driver.js'
import { errorFields, log } from './log.js'
import { metricsRetryDelayMs } from './metrics.js'
import { notPaused, pauseForRateLimit, SlowDown } from './pause.js'
import { RateLimited, ReauthRequired } from './platforms/types.js'
import { accountEventTypes, emitWebhookEvents, metricChanges, watchedChannelMetricsIntervalMs, watchedEventTypes } from './webhooks.js'
import { collectChannelActivity } from './channel-activity.js'
import { markNeedsReauth } from './token-check.js'

/** Account numbers are read every six hours. */
export const channelMetricsIntervalMs = 6 * 60 * 60_000
export const channelMetricsBatchSize = 10
export const maxHistoryDays = 400

const dayMs = 86_400_000

/** Platforms whose adapter reads account numbers. */
function supportedPlatforms(context: EngineContext) {
  return [...context.adapters].filter(([, adapter]) => adapter.accountMetrics).map(([platform]) => platform) as Platform[]
}

/**
 * Reads the account numbers of active OAuth channels that are due, one at a
 * time. Each success updates the latest numbers and appends a sample. A read
 * starts when the budget has a call left; each of its further requests (up to
 * four on Meta) spends one more.
 */
export async function collectDueChannelMetrics(context: EngineContext, budget?: CallBudget, limit = channelMetricsBatchSize) {
  const platforms = supportedPlatforms(context)
  if (!platforms.length) return { collected: 0, failed: 0 }
  const now = clock(context)
  const due = await context.db.select({ channel: channels, failureCount: channelMetrics.failureCount, previous: channelMetrics.values,
    previousAt: channelMetrics.collectedAt }).from(channels)
    .leftJoin(channelMetrics, eq(channelMetrics.channelId, channels.id))
    .where(and(eq(channels.status, 'active'), inArray(channels.platform, platforms), isNotNull(channels.providerAppId),
      or(isNull(channelMetrics.channelId), lte(channelMetrics.nextCollectAt, now)), notPaused(now)))
    .orderBy(asc(sql`coalesce(${channelMetrics.nextCollectAt}, ${channels.createdAt})`))
    .limit(limit)

  let collected = 0
  let failed = 0
  for (const { channel, failureCount, previous, previousAt } of due) {
    if (budget && !budget.allows(channel.platform)) continue
    if (budget && !budget.take(channel.platform)) break
    const base = { channelId: channel.id, organizationId: channel.organizationId }
    // A webhook watching the account (numbers, profile or posts) has it read every 30 minutes.
    const watching = await watchedEventTypes(context.db, channel.organizationId, channel.id)
    const watched = accountEventTypes.some(type => watching.has(type))
    try {
      const { app, token } = await channelDriver(context, context.db, channel)
      const slowDown = new SlowDown()
      const result = await context.adapters.get(channel.platform)!.accountMetrics!(app, {
        channel: { id: channel.id, kind: channel.kind, externalId: channel.externalId }, token, now: clock(context),
        spendCall: () => budget?.spend(channel.platform), slowDown: slowDown.note,
      })
      const finished = clock(context)
      await context.db.transaction(async transaction => {
        const values = { values: result.values, unavailable: [...new Set(result.unavailable)], collectedAt: finished,
          nextCollectAt: new Date(finished.getTime() + (watched ? watchedChannelMetricsIntervalMs : channelMetricsIntervalMs)), failureCount: 0, lastError: null, updatedAt: finished }
        await transaction.insert(channelMetrics).values({ ...base, ...values }).onConflictDoUpdate({ target: channelMetrics.channelId, set: values })
        await transaction.insert(channelMetricSamples).values({ ...base, collectedAt: finished, values: result.values })
        const before = previousAt ? (previous ?? {}) as Record<string, number> : null
        const { changed, changes } = metricChanges(before, result.values as Record<string, number>)
        if (watching.has('channel.metrics.changed') && changed) {
          await emitWebhookEvents(transaction, { organizationId: channel.organizationId, type: 'channel.metrics.changed', channelId: channel.id, occurredAt: finished,
            items: [{ channelId: channel.id, platform: channel.platform, kind: channel.kind, name: channel.name, values: result.values, previous: before, changes,
              unavailable: values.unavailable, collectedAt: finished.toISOString() }] })
        }
      })
      await slowDown.apply(context.db, channel, finished)
      collected++
    } catch (error) {
      const finished = clock(context)
      if (error instanceof RateLimited) {
        const until = await pauseForRateLimit(context.db, channel, error, finished)
        log('warn', 'channel rate limited', { channelId: channel.id, scope: error.scope, until: until.toISOString() })
        failed++
        continue
      }
      if (error instanceof ReauthRequired) await markNeedsReauth(context, channel, 'read_refused')
      const failures = (failureCount ?? 0) + 1
      const values = { nextCollectAt: new Date(finished.getTime() + metricsRetryDelayMs(failures)), failureCount: failures,
        lastError: (error instanceof Error ? error.message : 'Account metrics collection failed').slice(0, 500), updatedAt: finished }
      await context.db.insert(channelMetrics).values({ ...base, ...values }).onConflictDoUpdate({ target: channelMetrics.channelId, set: values })
      log('warn', 'channel metrics collection failed', { channelId: channel.id, failures, ...errorFields(error) })
      failed++
    }
    // Profile and posts ride on the account read, and only while a webhook asks for them.
    const profile = watching.has('channel.profile.changed')
    const posts = watching.has('channel.post.created')
    if (profile || posts) await collectChannelActivity(context, channel, { profile, posts }, budget)
  }
  return { collected, failed }
}

/**
 * Latest account numbers and the samples of the last `days` days for the
 * tenant's channels (all of them when `channelIds` is absent). Browser
 * channels and platforms without an account API are `supported: false`.
 */
export async function readChannelMetrics(context: EngineContext, organizationId: string, channelIds: string[] | undefined, days: number) {
  const rows = await context.db.select({ channel: channels, latest: channelMetrics }).from(channels)
    .leftJoin(channelMetrics, eq(channelMetrics.channelId, channels.id))
    .where(and(eq(channels.organizationId, organizationId), channelIds ? inArray(channels.id, channelIds) : undefined))
    .orderBy(channels.name, channels.id)
  const supported = new Set(supportedPlatforms(context))
  const isSupported = (channel: typeof channels.$inferSelect) => supported.has(channel.platform) && channel.providerAppId !== null
  const ids = rows.filter(row => isSupported(row.channel)).map(row => row.channel.id)
  const since = new Date(clock(context).getTime() - days * dayMs)
  const samples = ids.length ? await context.db.select().from(channelMetricSamples)
    .where(and(eq(channelMetricSamples.organizationId, organizationId), inArray(channelMetricSamples.channelId, ids), gte(channelMetricSamples.collectedAt, since)))
    .orderBy(asc(channelMetricSamples.collectedAt), asc(channelMetricSamples.id)) : []
  const byChannel = new Map<string, Array<{ collectedAt: string, values: typeof samples[number]['values'] }>>()
  for (const sample of samples) {
    const list = byChannel.get(sample.channelId) ?? []
    list.push({ collectedAt: sample.collectedAt.toISOString(), values: sample.values })
    byChannel.set(sample.channelId, list)
  }
  return rows.map(({ channel, latest }) => {
    const ok = isSupported(channel)
    return { channelId: channel.id, platform: channel.platform, kind: channel.kind, supported: ok,
      latest: ok && latest?.collectedAt ? { values: latest.values, unavailable: latest.unavailable, collectedAt: latest.collectedAt.toISOString() } : null,
      samples: ok ? byChannel.get(channel.id) ?? [] : [] }
  })
}
