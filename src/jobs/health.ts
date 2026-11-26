import { and, count, eq, gte, isNotNull, lte, min, or } from 'drizzle-orm'
import { clock, type EngineContext } from '../context.js'
import { inboundDrafts, jobs } from '../db/schema.js'
import { lateStartMs, type WorkerHealth } from './worker.js'

export type PublishingStatus = 'ok' | 'stalled' | 'late' | 'off'

/** A worker that has not finished a tick for this long (at least a minute) is stalled. */
export function stalledAfterMs(pollMs: number) {
  return Math.max(4 * pollMs, 60_000)
}

/**
 * The worker's liveness and the oldest due job that has not started, for
 * readiness. `off` when this process runs no worker.
 */
export async function publishingHealth(context: EngineContext, worker: WorkerHealth | undefined) {
  const now = clock(context)
  const [row] = await context.db.select({ oldest: min(jobs.notBefore) }).from(jobs).where(and(eq(jobs.state, 'queued'), lte(jobs.notBefore, now)))
  const oldest = row?.oldest ? new Date(row.oldest) : null
  const waitingSeconds = oldest ? Math.max(0, Math.floor((now.getTime() - oldest.getTime()) / 1000)) : 0
  const lastTickAt = worker?.lastTickAt ?? null
  const status: PublishingStatus = !worker?.enabled ? 'off'
    : !lastTickAt || now.getTime() - lastTickAt.getTime() > stalledAfterMs(worker.pollMs) ? 'stalled'
      : waitingSeconds * 1000 >= lateStartMs ? 'late' : 'ok'
  return {
    publishing: status,
    worker: { enabled: Boolean(worker?.enabled), lastTickAt: lastTickAt?.toISOString() ?? null },
    oldestDueJob: oldest ? { notBefore: oldest.toISOString(), waitingSeconds } : null,
  }
}

/** Drafting is failing when, over the last hour, at least this many items failed and no more succeeded. */
export const answeringWindowMs = 60 * 60_000
export const answeringFailuresToAlert = 2

/**
 * Whether AI answers work: `failing` when the decision or drafting call failed
 * for at least two items in the last hour and succeeded for no more (a
 * provider out of funds, a revoked key), `off` without a draft model. Publishing
 * does not depend on it.
 */
export async function answeringHealth(context: EngineContext) {
  if (!context.draftModel) return { answering: 'off' as const, answeringLastHour: { failed: 0, drafted: 0 } }
  const since = new Date(clock(context).getTime() - answeringWindowMs)
  const recent = gte(inboundDrafts.createdAt, since)
  const [failedRow] = await context.db.select({ value: count() }).from(inboundDrafts)
    .where(and(recent, or(isNotNull(inboundDrafts.draftErrorCode), isNotNull(inboundDrafts.errorCode))))
  const [draftedRow] = await context.db.select({ value: count() }).from(inboundDrafts).where(and(recent, isNotNull(inboundDrafts.draftText)))
  const failed = Number(failedRow?.value ?? 0)
  const drafted = Number(draftedRow?.value ?? 0)
  return { answering: failed >= answeringFailuresToAlert && failed >= drafted ? 'failing' as const : 'ok' as const, answeringLastHour: { failed, drafted } }
}
