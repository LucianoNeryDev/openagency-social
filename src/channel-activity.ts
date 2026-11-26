import { and, eq, inArray, sql } from 'drizzle-orm'
import type { CallBudget } from './budget.js'
import { clock, type EngineContext } from './context.js'
import { channelActivity, jobs, type channels } from './db/schema.js'
import { channelDriver } from './jobs/driver.js'
import { errorFields, log } from './log.js'
import { pauseForRateLimit } from './pause.js'
import { RateLimited, ReauthRequired, type ChannelProfile, type PlatformPost } from './platforms/types.js'
import { emitWebhookEvents } from './webhooks.js'
import { markNeedsReauth } from './token-check.js'

/** Post IDs remembered per account: far more than one read returns, so a post never comes back as new. */
export const maxSeenPosts = 200
/** A post published this long before the previous read is not new, even if unseen: it scrolled into view. */
const lateArrivalMs = 24 * 60 * 60_000

const profileFields = ['name', 'username', 'description', 'website', 'category', 'pictureUrl'] as const

/**
 * Meta and Instagram sign picture URLs with a query that changes on every
 * read; the path names the image. Two URLs are the same picture when they
 * differ only after the path.
 */
function comparable(field: typeof profileFields[number], value: string | null | undefined) {
  if (!value) return null
  if (field !== 'pictureUrl') return value
  try {
    const url = new URL(value)
    return `${url.host}${url.pathname}`
  } catch {
    return value
  }
}

export function profileChanges(previous: Record<string, string | null> | null, profile: ChannelProfile) {
  if (!previous) return []
  return profileFields.filter(field => comparable(field, previous[field]) !== comparable(field, profile[field]))
}

/** Posts not seen before, oldest first. The first read only remembers what is there. */
export function newPosts(seen: string[] | null, posts: PlatformPost[], previousCheck: Date | null) {
  if (!seen) return []
  const known = new Set(seen)
  const since = previousCheck ? previousCheck.getTime() - lateArrivalMs : null
  return posts.filter(post => !known.has(post.externalId) && (since === null || !post.publishedAt || post.publishedAt.getTime() >= since))
    .reverse()
}

/**
 * Reads the profile and newest posts of one channel a webhook watches, and
 * queues `channel.profile.changed` and `channel.post.created` for what moved.
 * A failure is recorded on the activity row and never touches the channel;
 * a rate limit pauses the channel as the other reads do.
 */
export async function collectChannelActivity(context: EngineContext, channel: typeof channels.$inferSelect,
  watched: { profile: boolean, posts: boolean }, budget?: CallBudget) {
  const adapter = context.adapters.get(channel.platform)
  if (!adapter?.accountActivity || !channel.providerAppId) return 'skipped' as const
  if (budget && (!budget.allows(channel.platform) || !budget.take(channel.platform))) return 'skipped' as const
  const [previous] = await context.db.select().from(channelActivity).where(eq(channelActivity.channelId, channel.id)).limit(1)
  const base = { channelId: channel.id, organizationId: channel.organizationId }
  try {
    const { app, token } = await channelDriver(context, context.db, channel)
    const result = await adapter.accountActivity(app, { channel: { id: channel.id, kind: channel.kind, externalId: channel.externalId }, token,
      spendCall: () => budget?.spend(channel.platform) })
    const finished = clock(context)
    const profile: Record<string, string | null> = { ...result.profile }
    const changed = profileChanges(previous?.profile ?? null, result.profile)
    const created = newPosts(previous?.seenPostIds ?? null, result.posts, previous?.checkedAt ?? null)
    const seen = [...new Set([...result.posts.map(post => post.externalId), ...(previous?.seenPostIds ?? [])])].slice(0, maxSeenPosts)
    await context.db.transaction(async transaction => {
      const values = { profile, seenPostIds: seen, checkedAt: finished, failureCount: 0, lastError: null, updatedAt: finished }
      await transaction.insert(channelActivity).values({ ...base, ...values }).onConflictDoUpdate({ target: channelActivity.channelId, set: values })
      const event = { name: channel.name, platform: channel.platform, kind: channel.kind, channelId: channel.id }
      if (watched.profile && changed.length) {
        await emitWebhookEvents(transaction, { organizationId: channel.organizationId, type: 'channel.profile.changed', channelId: channel.id, occurredAt: finished,
          items: [{ ...event, profile: result.profile, previous: previous!.profile, changed }] })
      }
      if (watched.posts && created.length) {
        // A post the engine published says which job it came from.
        const ours = await transaction.select({ id: jobs.id, postId: jobs.postId, externalId: sql<string>`${jobs.receipt}->>'externalId'` }).from(jobs)
          .where(and(eq(jobs.channelId, channel.id), eq(jobs.state, 'published'),
            inArray(sql`${jobs.receipt}->>'externalId'`, created.map(post => post.externalId))))
        const byExternalId = new Map(ours.map(job => [job.externalId, job]))
        await emitWebhookEvents(transaction, { organizationId: channel.organizationId, type: 'channel.post.created', channelId: channel.id, occurredAt: finished,
          items: created.map(post => ({ ...event, externalId: post.externalId, type: post.type, text: post.text, url: post.url,
            publishedAt: post.publishedAt?.toISOString() ?? null, ...(post.privacy ? { privacy: post.privacy } : {}),
            jobId: byExternalId.get(post.externalId)?.id ?? null, postId: byExternalId.get(post.externalId)?.postId ?? null })) })
      }
    })
    return 'read' as const
  } catch (error) {
    const finished = clock(context)
    if (error instanceof RateLimited) {
      await pauseForRateLimit(context.db, channel, error, finished)
      return 'failed' as const
    }
    if (error instanceof ReauthRequired) await markNeedsReauth(context, channel, 'read_refused')
    const values = { failureCount: (previous?.failureCount ?? 0) + 1, lastError: (error instanceof Error ? error.message : 'Activity read failed').slice(0, 500), updatedAt: finished }
    await context.db.insert(channelActivity).values({ ...base, ...values }).onConflictDoUpdate({ target: channelActivity.channelId, set: values })
    log('warn', 'channel activity read failed', { channelId: channel.id, failures: values.failureCount, ...errorFields(error) })
    return 'failed' as const
  }
}
