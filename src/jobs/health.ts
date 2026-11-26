import { and, eq, lte, min } from 'drizzle-orm'
import { clock, type EngineContext } from '../context.js'
import { jobs } from '../db/schema.js'
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
