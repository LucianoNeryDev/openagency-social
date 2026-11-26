import { and, asc, desc, eq, exists, gt, inArray, isNotNull, isNull, lte, or, sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import type { CallBudget } from './budget.js'
import { clock, type EngineContext } from './context.js'
import { channelTarget } from './channels.js'
import { channelMetrics, channels, jobs, postResponses, replies, responseChecks, type Platform, type ResponseCheckState } from './db/schema.js'
import { EngineError } from './errors.js'
import { channelDriver } from './jobs/driver.js'
import { errorFields, log } from './log.js'
import { notPaused, pauseForRateLimit, SlowDown } from './pause.js'
import { RateLimited, ReauthRequired, type PlatformResponse } from './platforms/types.js'
import { responsesRetentionMs } from './retention.js'
import { emitWebhookEvents } from './webhooks.js'
import { markNeedsReauth } from './token-check.js'

const minuteMs = 60_000
const hourMs = 60 * minuteMs
const dayMs = 24 * hourMs

/** How often the worker looks for due checks, and how many it makes per pass. */
export const responsesIntervalMs = 15_000
export const responsesBatchSize = 8
/** Watched posts may take a few checks of the same channel in one pass, one after another. */
export const watchedChecksPerChannel = 3
/** Posts older than this are no longer checked; what was read stays until retention. */
export const responsesWindowMs = 90 * dayMs
export const watchMs = 5 * minuteMs
export const watchedIntervalMs = 30_000
/** YouTube reads draw on the project's daily quota, which uploads need too. */
export const youtubeWatchedIntervalMs = 2 * minuteMs
/** A missing permission is asked about again once a day. */
export const unavailableRetryMs = dayMs
export const maxTextLength = 5_000

/**
 * 2 min for a day, 10 min for a week, hourly for a month, every 6 h until day
 * 90, then null (stop). YouTube is slower (10 min, 30 min, 3 h, 12 h): its
 * reads spend the project's daily quota.
 */
export function responseCheckInterval(platform: Platform, publishedAt: Date, now: Date) {
  const age = now.getTime() - publishedAt.getTime()
  const youtube = platform === 'youtube'
  if (age < dayMs) return youtube ? 10 * minuteMs : 2 * minuteMs
  if (age < 7 * dayMs) return youtube ? 30 * minuteMs : 10 * minuteMs
  if (age < 30 * dayMs) return youtube ? 3 * hourMs : hourMs
  if (age < responsesWindowMs) return youtube ? 12 * hourMs : 6 * hourMs
  return null
}

export function watchedInterval(platform: Platform) {
  return platform === 'youtube' ? youtubeWatchedIntervalMs : watchedIntervalMs
}

/** The next check after a successful one: about every 30 s while watched (2 min on YouTube). Null once the post is too old. */
export function nextResponseCheck(platform: Platform, publishedAt: Date, now: Date, watchUntil: Date | null) {
  const interval = responseCheckInterval(platform, publishedAt, now)
  if (interval === null) return null
  const watched = watchUntil !== null && watchUntil.getTime() > now.getTime()
  return new Date(now.getTime() + (watched ? Math.min(interval, watchedInterval(platform)) : interval))
}

/** 2 min, doubling to at most 6 h. */
export function responseRetryDelayMs(failureCount: number) {
  return Math.min(2 * minuteMs * 2 ** Math.max(0, failureCount - 1), 6 * hourMs)
}

function supportedPlatforms(context: EngineContext) {
  return [...context.adapters].filter(([, adapter]) => adapter.responses).map(([platform]) => platform) as Platform[]
}

const clip = (value: string | null, length: number) => value === null ? null : Array.from(value).slice(0, length).join('')

/**
 * Inserts new responses and refreshes changed ones. A response missing from
 * the page is never deleted: the read covers only the newest few hundred.
 */
async function storeResponses(context: EngineContext, job: { id: string, organizationId: string, postId: string, channelId: string, platform: Platform },
  responses: PlatformResponse[], now: Date) {
  const unique = new Map(responses.map(response => [response.externalId, response]))
  if (!unique.size) return
  const rows = [...unique.values()].map(response => ({
    organizationId: job.organizationId, channelId: job.channelId, jobId: job.id, externalId: response.externalId,
    parentExternalId: response.parentExternalId, authorName: clip(response.authorName, 200), authorHandle: clip(response.authorHandle, 200),
    text: clip(response.text, maxTextLength)!, likeCount: response.likeCount, replyCount: response.replyCount, publishedAt: response.publishedAt,
    firstSeenAt: now, updatedAt: now, url: response.url, fromChannel: response.fromChannel ?? null,
  }))
  const changed = ['parent_external_id', 'author_name', 'author_handle', 'text', 'like_count', 'reply_count', 'url', 'from_channel']
    .map(column => sql`${sql.identifier('post_responses')}.${sql.identifier(column)} is distinct from excluded.${sql.identifier(column)}`)
  await context.db.transaction(async transaction => {
    const stored = await transaction.insert(postResponses).values(rows).onConflictDoUpdate({
      target: [postResponses.channelId, postResponses.externalId],
      set: { parentExternalId: sql`excluded.parent_external_id`, authorName: sql`excluded.author_name`, authorHandle: sql`excluded.author_handle`,
        text: sql`excluded.text`, likeCount: sql`excluded.like_count`, replyCount: sql`excluded.reply_count`, url: sql`excluded.url`,
        fromChannel: sql`excluded.from_channel`, updatedAt: now },
      setWhere: sql.join(changed, sql` or `),
    }).returning({ id: postResponses.id, externalId: postResponses.externalId, parentExternalId: postResponses.parentExternalId,
      authorName: postResponses.authorName, authorHandle: postResponses.authorHandle, text: postResponses.text, publishedAt: postResponses.publishedAt,
      url: postResponses.url, fromChannel: postResponses.fromChannel, inserted: sql<boolean>`(xmax = 0)` })
    // Webhooks hear of each response the first time it is stored, oldest first; never of an update.
    const created = stored.filter(row => row.inserted).sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime())
    await emitWebhookEvents(transaction, { organizationId: job.organizationId, type: 'comment.created', channelId: job.channelId, occurredAt: now,
      items: created.map(response => ({ responseId: response.id, jobId: job.id, postId: job.postId, channelId: job.channelId, platform: job.platform,
        externalId: response.externalId, parentExternalId: response.parentExternalId, author: { name: response.authorName, handle: response.authorHandle },
        text: response.text, publishedAt: response.publishedAt.toISOString(), url: response.url, fromChannel: response.fromChannel })) })
  })
}

/** Watched posts first; then the most overdue; posts never checked (backfill) after those, newest first. */
export function pickDueChecks<T extends { channelId: string, watched: boolean }>(ordered: T[], limit: number) {
  const perChannel = new Map<string, number>()
  const picked: T[] = []
  for (const row of ordered) {
    if (picked.length >= limit) break
    const taken = perChannel.get(row.channelId) ?? 0
    if (taken >= (row.watched ? watchedChecksPerChannel : 1)) continue
    perChannel.set(row.channelId, taken + 1)
    picked.push(row)
  }
  return picked
}

/**
 * Reads the comments of due posts, watched posts first, within the shared
 * call budget and YouTube's daily share. Unwatched posts get one check per
 * channel per pass; checks run one after another, never two on a channel at
 * once. The text read here is untrusted and only stored.
 */
export async function collectDueResponses(context: EngineContext, budget?: CallBudget, limit = responsesBatchSize) {
  const platforms = supportedPlatforms(context)
  if (!platforms.length) return { checked: 0, failed: 0 }
  const now = clock(context)
  const watched = sql<boolean>`coalesce(${responseChecks.watchUntil} > ${now}, false)`
  const rows = await context.db.select({ job: jobs, channel: channels, check: responseChecks, watched }).from(jobs)
    .innerJoin(channels, eq(channels.id, jobs.channelId))
    .leftJoin(responseChecks, eq(responseChecks.jobId, jobs.id))
    .leftJoin(channelMetrics, eq(channelMetrics.channelId, channels.id))
    .where(and(eq(jobs.state, 'published'), isNotNull(jobs.receipt), gt(jobs.publishAt, new Date(now.getTime() - responsesWindowMs)),
      eq(channels.status, 'active'), inArray(channels.platform, platforms), isNotNull(channels.providerAppId),
      or(isNull(responseChecks.jobId), lte(responseChecks.nextCheckAt, now)), notPaused(now)))
    .orderBy(desc(watched), asc(sql`coalesce(${responseChecks.nextCheckAt}, ${now})`), desc(jobs.publishAt))
    .limit(200)
  const due = pickDueChecks(rows.map(row => ({ ...row, channelId: row.channel.id })), limit)

  let checked = 0
  let failed = 0
  for (const { job, channel, check } of due) {
    if (budget && !budget.allows(channel.platform)) continue
    if (budget && !budget.take(channel.platform)) break
    const base = { jobId: job.id, organizationId: job.organizationId, channelId: channel.id }
    const save = async (values: Partial<typeof responseChecks.$inferInsert> & { nextCheckAt: Date }, nextOnConflict?: SQL) => {
      const set = { ...values, updatedAt: clock(context) }
      await context.db.insert(responseChecks).values({ ...base, ...set })
        .onConflictDoUpdate({ target: responseChecks.jobId, set: nextOnConflict ? { ...set, nextCheckAt: nextOnConflict } : set })
    }
    try {
      const { app, token } = await channelDriver(context, context.db, channel)
      const slowDown = new SlowDown()
      const result = await context.adapters.get(channel.platform)!.responses!(app, {
        channel: channelTarget(channel), token, externalId: job.receipt!.externalId,
        morePages: () => budget?.take(channel.platform) ?? true, slowDown: slowDown.note,
      })
      const finished = clock(context)
      if (result.kind === 'unavailable') {
        await save({ state: 'unavailable', reason: result.reason.slice(0, 500), checkedAt: finished, failureCount: 0, lastError: null,
          nextCheckAt: new Date(finished.getTime() + unavailableRetryMs) })
      } else {
        await storeResponses(context, { id: job.id, organizationId: job.organizationId, postId: job.postId, channelId: channel.id, platform: channel.platform },
          result.responses, finished)
        const next = nextResponseCheck(channel.platform, job.publishAt, finished, check?.watchUntil ?? null)
          ?? new Date(job.publishAt.getTime() + responsesWindowMs)
        // A watch call made while this check ran must not be overwritten by the slower cadence.
        const watchedNext = new Date(finished.getTime() + watchedInterval(channel.platform))
        await save({ state: 'ok', reason: null, checkedAt: finished, failureCount: 0, lastError: null, nextCheckAt: next },
          sql`least(${next}, case when ${responseChecks.watchUntil} > ${finished} then ${watchedNext}::timestamptz end)`)
      }
      await slowDown.apply(context.db, channel, finished)
      checked++
    } catch (error) {
      const finished = clock(context)
      failed++
      if (error instanceof RateLimited) {
        const until = await pauseForRateLimit(context.db, channel, error, finished)
        await save({ nextCheckAt: until })
        log('warn', 'channel rate limited', { channelId: channel.id, scope: error.scope, until: until.toISOString() })
        continue
      }
      if (error instanceof ReauthRequired) await markNeedsReauth(context, channel, 'read_refused')
      const failures = (check?.failureCount ?? 0) + 1
      const message = (error instanceof Error ? error.message : 'Reading responses failed').slice(0, 500)
      const reason = error instanceof ReauthRequired || (error instanceof EngineError && error.code === 'channel_inactive')
        ? 'The channel must be connected again.' : 'Reading the comments failed; the engine is retrying.'
      await save({ state: 'failing', reason, failureCount: failures, lastError: message,
        nextCheckAt: new Date(finished.getTime() + responseRetryDelayMs(failures)) })
      log('warn', 'responses check failed', { jobId: job.id, failures, ...errorFields(error) })
    }
  }
  return { checked, failed }
}

/**
 * Watches published jobs for five minutes: their responses are read about
 * every 30 s meanwhile (every 2 min on YouTube). Jobs that wait out a failure, a missing permission
 * or a rate limit keep waiting.
 */
export async function watchResponses(context: EngineContext, organizationId: string, jobIds: string[]) {
  const now = clock(context)
  const watchUntil = new Date(now.getTime() + watchMs)
  const platforms = supportedPlatforms(context)
  const rows = platforms.length ? await context.db.select({ id: jobs.id, channelId: jobs.channelId }).from(jobs)
    .innerJoin(channels, eq(channels.id, jobs.channelId))
    .where(and(eq(jobs.organizationId, organizationId), inArray(jobs.id, jobIds), eq(jobs.state, 'published'), isNotNull(jobs.receipt),
      inArray(channels.platform, platforms), isNotNull(channels.providerAppId), eq(channels.status, 'active'),
      gt(jobs.publishAt, new Date(now.getTime() - responsesWindowMs)))) : []
  if (rows.length) {
    await context.db.insert(responseChecks)
      .values(rows.map(row => ({ jobId: row.id, organizationId, channelId: row.channelId, nextCheckAt: now, watchUntil, updatedAt: now })))
      .onConflictDoUpdate({ target: responseChecks.jobId, set: { watchUntil, updatedAt: now,
        nextCheckAt: sql`case when ${responseChecks.state} in ('ok', 'pending') then least(${responseChecks.nextCheckAt}, ${now}) else ${responseChecks.nextCheckAt} end` } })
  }
  return { watchUntil: watchUntil.toISOString() }
}

const cursorSchema = z.object({ t: z.iso.datetime(), id: z.uuid() })

export function encodeCursor(firstSeenAt: Date, id: string) {
  return Buffer.from(JSON.stringify({ t: firstSeenAt.toISOString(), id })).toString('base64url')
}

export function decodeCursor(cursor: string) {
  try {
    const value = cursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')))
    return { firstSeenAt: new Date(value.t), id: value.id }
  } catch {
    throw new EngineError(400, 'invalid_cursor', 'The cursor is not valid')
  }
}

/**
 * Responses in the order they were first seen. Without `after`, the newest
 * `limit`, newest first; with it, those first seen after the cursor, oldest
 * first, so a client can append. `status` covers the requested jobs, or the
 * newest 500 jobs with stored responses or checked in the last 90 days.
 */
export async function readResponses(context: EngineContext, organizationId: string, options: { jobIds?: string[], after?: string, limit: number }) {
  const after = options.after ? decodeCursor(options.after) : null
  const scope = and(eq(postResponses.organizationId, organizationId), options.jobIds ? inArray(postResponses.jobId, options.jobIds) : undefined)
  // The dashboard reply a response came from, by the platform's reply ID.
  const replyId = sql<string | null>`(select ${replies.replyId} from ${replies} where ${replies.channelId} = ${postResponses.channelId}
    and ${replies.platformReplyId} = ${postResponses.externalId} limit 1)`
  const rows = await context.db.select({ response: postResponses, platform: channels.platform, replyId }).from(postResponses)
    .innerJoin(channels, eq(channels.id, postResponses.channelId))
    .where(and(scope, after ? sql`(${postResponses.firstSeenAt}, ${postResponses.id}) > (${after.firstSeenAt}, ${after.id})` : undefined))
    .orderBy(...(after ? [asc(postResponses.firstSeenAt), asc(postResponses.id)] : [desc(postResponses.firstSeenAt), desc(postResponses.id)]))
    .limit(options.limit)
  const newest = after ? rows.at(-1) : rows[0]
  const cursor = newest ? encodeCursor(newest.response.firstSeenAt, newest.response.id) : options.after ?? null

  const statusJobIds = options.jobIds ?? await statusJobsOf(context, organizationId)

  return {
    responses: rows.map(({ response, platform, replyId }) => ({
      id: response.id, jobId: response.jobId, channelId: response.channelId, platform, externalId: response.externalId,
      parentExternalId: response.parentExternalId, author: { name: response.authorName, handle: response.authorHandle }, text: response.text,
      likeCount: response.likeCount, replyCount: response.replyCount, publishedAt: response.publishedAt.toISOString(),
      firstSeenAt: response.firstSeenAt.toISOString(), updatedAt: response.updatedAt.toISOString(), url: response.url,
      fromChannel: response.fromChannel, replyId,
    })),
    status: await responseStatus(context, organizationId, statusJobIds),
    cursor,
  }
}

/** The whole-tenant status list covers at most this many jobs, newest first. */
export const maxStatusJobs = 500

/**
 * Without `jobIds`: the newest 500 jobs (by publishAt) that were checked in
 * the last 90 days or have stored responses, so a post whose comments cannot
 * be read (a missing permission) still gets its status line in the feed.
 * Both lists read only the tenant's jobs in their window, through
 * `jobs_organization_publish`, and find each job's check or responses by job
 * ID; each list is cut at 500 before they are merged.
 */
async function statusJobsOf(context: EngineContext, organizationId: string) {
  const now = clock(context).getTime()
  const newest = [desc(jobs.publishAt), desc(jobs.id)]
  const [checked, answered] = await Promise.all([
    context.db.select({ id: jobs.id, publishAt: jobs.publishAt }).from(jobs).innerJoin(responseChecks, eq(responseChecks.jobId, jobs.id))
      .where(and(eq(jobs.organizationId, organizationId), gt(jobs.publishAt, new Date(now - responsesWindowMs))))
      .orderBy(...newest).limit(maxStatusJobs),
    // Responses are deleted at the retention horizon: older jobs have none.
    context.db.select({ id: jobs.id, publishAt: jobs.publishAt }).from(jobs)
      .where(and(eq(jobs.organizationId, organizationId), gt(jobs.publishAt, new Date(now - responsesRetentionMs)),
        exists(context.db.select({ one: sql`1` }).from(postResponses).where(eq(postResponses.jobId, jobs.id)))))
      .orderBy(...newest).limit(maxStatusJobs),
  ])
  const merged = new Map([...checked, ...answered].map(row => [row.id, row]))
  return [...merged.values()].sort((a, b) => b.publishAt.getTime() - a.publishAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    .slice(0, maxStatusJobs).map(row => row.id)
}

async function responseStatus(context: EngineContext, organizationId: string, jobIds: string[]) {
  if (!jobIds.length) return []
  const now = clock(context)
  // Only the columns the status needs: the job payload can be large, and this runs on every dashboard poll.
  const rows = await context.db.select({
    id: jobs.id, state: jobs.state, publishAt: jobs.publishAt, platform: channels.platform, providerAppId: channels.providerAppId,
    channelStatus: channels.status, checkState: responseChecks.state, reason: responseChecks.reason, checkedAt: responseChecks.checkedAt,
    nextCheckAt: responseChecks.nextCheckAt,
  }).from(jobs)
    .innerJoin(channels, eq(channels.id, jobs.channelId))
    .leftJoin(responseChecks, eq(responseChecks.jobId, jobs.id))
    .where(and(eq(jobs.organizationId, organizationId), inArray(jobs.id, jobIds)))
  const supported = new Set(supportedPlatforms(context))
  const byId = new Map(rows.map(row => [row.id, row]))
  return [...new Set(jobIds)].flatMap(jobId => {
    const row = byId.get(jobId)
    if (!row) return []
    if (!supported.has(row.platform) || row.providerAppId === null) {
      return [{ jobId, state: 'not_supported' as ResponseCheckState, reason: 'Comments are not read on this platform.', checkedAt: null, nextCheckAt: null }]
    }
    if (row.state !== 'published') {
      return [{ jobId, state: 'not_supported' as ResponseCheckState, reason: 'The post was not published on this channel.', checkedAt: null, nextCheckAt: null }]
    }
    const active = row.channelStatus === 'active' && now.getTime() - row.publishAt.getTime() < responsesWindowMs
    return [{ jobId, state: row.checkState ?? 'pending', reason: row.reason ?? null, checkedAt: row.checkedAt?.toISOString() ?? null,
      nextCheckAt: active ? (row.nextCheckAt ?? now).toISOString() : null }]
  })
}
