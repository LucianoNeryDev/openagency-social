import { and, asc, eq, isNotNull, isNull, lt, or } from 'drizzle-orm'
import type { CallBudget } from './budget.js'
import { adapterFor, clock, recordEvent, type EngineContext } from './context.js'
import { channels } from './db/schema.js'
import { EngineError } from './errors.js'
import { channelDriver } from './jobs/driver.js'
import { errorFields, log } from './log.js'
import { RateLimited, ReauthRequired } from './platforms/types.js'
import { changeChannelStatus } from './webhooks.js'

/** Each connected channel's token is proved at most this often. */
export const tokenCheckEveryMs = 24 * 60 * 60_000
/** How often the worker looks for channels due a check. */
export const tokenCheckIntervalMs = 60 * 60_000
const perPass = 25

type ChannelRow = typeof channels.$inferSelect

/**
 * Marks an active channel `needs_reauth` because the platform refused its
 * token, as publishing does: the control plane hears it (status webhook)
 * before a post is due, instead of when the post fails.
 */
export async function markNeedsReauth(context: EngineContext, channel: Pick<ChannelRow, 'id' | 'organizationId'>, reason: 'token_check_refused' | 'read_refused') {
  const now = clock(context)
  const changed = await context.db.transaction(async transaction => {
    const [current] = await transaction.select({ status: channels.status }).from(channels).where(eq(channels.id, channel.id)).for('update').limit(1)
    if (current?.status !== 'active') return false
    await changeChannelStatus(transaction, channel.id, 'needs_reauth', reason, now)
    await recordEvent(transaction, { organizationId: channel.organizationId, kind: 'channel.needs_reauth', channelId: channel.id, detail: { reason } })
    await transaction.update(channels).set({ tokenCheckedAt: now }).where(eq(channels.id, channel.id))
    return true
  })
  if (changed) log('warn', 'channel needs a new login', { channelId: channel.id, reason })
  return changed
}

/**
 * The daily token check: one cheap read per connected OAuth channel a day,
 * so a revoked or expired login is found before a post is due. A refusal
 * marks the channel `needs_reauth`; a refresh token the platform refuses does
 * the same on the way (src/credentials.ts). Transient errors are tried again
 * at the next pass.
 */
export async function checkDueTokens(context: EngineContext, budget?: CallBudget) {
  const now = clock(context)
  const due = await context.db.select().from(channels)
    .where(and(eq(channels.status, 'active'), isNotNull(channels.providerAppId), isNull(channels.browserAccountId),
      or(isNull(channels.tokenCheckedAt), lt(channels.tokenCheckedAt, new Date(now.getTime() - tokenCheckEveryMs)))))
    .orderBy(asc(channels.tokenCheckedAt)).limit(perPass)
  let valid = 0
  let refused = 0
  let failed = 0
  for (const channel of due) {
    const adapter = adapterFor(context, channel.platform)
    if (!adapter.checkCredential) {
      await context.db.update(channels).set({ tokenCheckedAt: now }).where(eq(channels.id, channel.id))
      continue
    }
    if (budget && !budget.allows(channel.platform)) continue
    if (budget && !budget.take(channel.platform)) break
    try {
      const driver = await channelDriver(context, context.db, channel)
      await adapter.checkCredential(driver.app, { channel: { id: channel.id, kind: channel.kind, externalId: channel.externalId }, token: driver.token,
        ...(budget ? { spendCall: () => budget.spend(channel.platform) } : {}) })
      await context.db.update(channels).set({ tokenCheckedAt: clock(context) }).where(eq(channels.id, channel.id))
      valid++
    } catch (error) {
      if (error instanceof ReauthRequired) {
        await markNeedsReauth(context, channel, 'token_check_refused')
        refused++
      } else if (error instanceof EngineError && error.code === 'channel_inactive') {
        // The refresh token was refused on the way: the channel is already marked.
        refused++
      } else {
        failed++
        if (!(error instanceof RateLimited)) log('warn', 'token check failed', { channelId: channel.id, ...errorFields(error) })
      }
    }
  }
  return { checked: valid + refused, valid, refused, failed }
}
