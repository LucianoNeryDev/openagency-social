import { createHmac, hkdfSync, randomUUID } from 'node:crypto'
import { and, asc, eq, lte, sql } from 'drizzle-orm'
import { clock, type EngineContext } from './context.js'
import type { Executor } from './db/client.js'
import { controlEvents, type ControlEventType } from './db/schema.js'
import { errorFields, log } from './log.js'

// Nudges for the control plane (ADR 0005): "something changed for this
// organization, pull now". They carry no content; the control plane pulls
// over the authenticated routes, and its scheduled pull stays the backstop.

export const controlEventsSalt = 'openagency-engine-events-v1'
export const controlEventsInfo = 'social'
/** Tries after the first one fails: then the event is dropped and the scheduled pull covers it. */
export const controlEventRetryDelaysMs = [1_000, 5_000, 30_000, 120_000, 600_000]
export const controlEventTimeoutMs = 5_000
/** A claimed event whose sender died is tried again after this. */
const claimLeaseMs = 30_000
const batchSize = 20

/** HKDF-SHA256 of the service token, salt `openagency-engine-events-v1`, info `social`, 32 bytes. Both sides derive it; nothing new to configure. */
export function controlEventKey(serviceToken: string) {
  return Buffer.from(hkdfSync('sha256', serviceToken, controlEventsSalt, controlEventsInfo, 32))
}

/** Hex HMAC-SHA256 of `<timestamp>.<raw body>`; sent as `x-openagency-signature: v1=<hex>`. */
export function signControlEvent(key: Buffer, timestamp: number, body: string) {
  return createHmac('sha256', key).update(`${timestamp}.${body}`).digest('hex')
}

let enabled = false

/** Events are queued only while a control plane listens (`CONTROL_PLANE_EVENTS_URL`); without one nothing is written. Set once at start. */
export function enableControlEvents(value: boolean) {
  enabled = value
}

/**
 * Queues an event in the caller's transaction, so it exists exactly when its
 * change commits; it is sent after the commit. One row per (type,
 * organization): a pending one absorbs the new change, under a new event ID
 * and generation. A row waiting out a failure starts again from the first
 * try, at once; one on its way is sent again when that send settles.
 */
export async function queueControlEvent(executor: Executor, type: ControlEventType, organizationId: string, now: Date) {
  if (!enabled) return
  const inFlight = sql`coalesce(${controlEvents.claimedUntil} > ${now}::timestamptz, false)`
  await executor.insert(controlEvents).values({ type, organizationId, eventId: randomUUID(), generation: 1, attemptCount: 0, nextAttemptAt: now,
    createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: [controlEvents.type, controlEvents.organizationId], set: {
      eventId: sql`gen_random_uuid()`, generation: sql`${controlEvents.generation} + 1`, updatedAt: now,
      attemptCount: sql`case when ${inFlight} then ${controlEvents.attemptCount} else 0 end`,
      nextAttemptAt: sql`case when ${inFlight} then ${controlEvents.nextAttemptAt} else least(${controlEvents.nextAttemptAt}, ${now}::timestamptz) end`,
    } })
}

export interface ControlEventRequest {
  url: string
  headers: Record<string, string>
  body: string
}
/** True when the control plane took it (a 2xx). */
export type ControlEventSend = (request: ControlEventRequest) => Promise<boolean>

/** POSTs an event: no redirects, five seconds at most; the answer's body is not read. */
export const fetchControlEvent: ControlEventSend = async request => {
  try {
    const response = await fetch(request.url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(controlEventTimeoutMs),
      headers: request.headers, body: request.body })
    await response.body?.cancel().catch(() => undefined)
    return response.ok
  } catch {
    return false
  }
}

type Row = typeof controlEvents.$inferSelect

/** The request for one event: body `{id, type, at, organizationId, data}` and the signed headers. */
export function controlEventRequest(url: string, key: Buffer, event: { id: string, type: string, organizationId: string | null }, now: Date): ControlEventRequest {
  const body = JSON.stringify({ id: event.id, type: event.type, at: now.toISOString(), organizationId: event.organizationId, data: {} })
  const timestamp = Math.floor(now.getTime() / 1000)
  return { url, body, headers: { 'content-type': 'application/json', 'x-openagency-event-id': event.id, 'x-openagency-timestamp': String(timestamp),
    'x-openagency-signature': `v1=${signControlEvent(key, timestamp, body)}` } }
}

/**
 * Sends due events. Each is claimed (attempt counted, next try a lease ahead)
 * and committed before the request. A success removes the row unless a newer
 * change joined it meanwhile (then it is sent again at once); a failure waits
 * 1 s, 5 s, 30 s, 2 min, 10 min, and after that the event is dropped.
 */
export async function deliverControlEvents(context: EngineContext, target: { url: string, key: Buffer, send?: ControlEventSend }) {
  const now = clock(context)
  const claimed = await context.db.transaction(async transaction => {
    const due = await transaction.select().from(controlEvents).where(lte(controlEvents.nextAttemptAt, now))
      .orderBy(asc(controlEvents.nextAttemptAt)).limit(batchSize).for('update', { skipLocked: true })
    for (const row of due) {
      const leaseEnd = new Date(now.getTime() + claimLeaseMs)
      await transaction.update(controlEvents).set({ attemptCount: row.attemptCount + 1, nextAttemptAt: leaseEnd, claimedUntil: leaseEnd, updatedAt: now })
        .where(and(eq(controlEvents.type, row.type), eq(controlEvents.organizationId, row.organizationId)))
    }
    return due.map(row => ({ ...row, attemptCount: row.attemptCount + 1 }))
  })
  const send = target.send ?? fetchControlEvent
  const results = await Promise.all(claimed.map(async row => {
    let ok = false
    try {
      ok = await send(controlEventRequest(target.url, target.key, { id: row.eventId, type: row.type, organizationId: row.organizationId }, clock(context)))
    } catch (error) {
      log('warn', 'control event send threw', errorFields(error))
    }
    await settleControlEvent(context, row, ok)
    return ok
  }))
  return { sent: results.filter(Boolean).length, failed: results.filter(ok => !ok).length }
}

async function settleControlEvent(context: EngineContext, row: Row, ok: boolean) {
  const now = clock(context)
  const key = and(eq(controlEvents.type, row.type), eq(controlEvents.organizationId, row.organizationId))
  const unchanged = and(key, eq(controlEvents.generation, row.generation))
  if (ok || row.attemptCount > controlEventRetryDelaysMs.length) {
    const [deleted] = await context.db.delete(controlEvents).where(unchanged).returning({ type: controlEvents.type })
    if (!deleted) {
      // A change joined while this one was sent: it goes out again, as a fresh event.
      await context.db.update(controlEvents).set({ attemptCount: 0, nextAttemptAt: now, claimedUntil: null, updatedAt: now }).where(key)
    } else if (!ok) {
      log('warn', 'control event dropped', { type: row.type, organizationId: row.organizationId, attempts: row.attemptCount })
    }
    return
  }
  // A change that joined while this failed send was on its way is a new fact: it goes out at once, from the first try.
  await context.db.update(controlEvents).set({ claimedUntil: null, updatedAt: now,
    attemptCount: sql`case when ${controlEvents.generation} = ${row.generation} then ${controlEvents.attemptCount} else 0 end`,
    nextAttemptAt: sql`case when ${controlEvents.generation} = ${row.generation} then ${new Date(now.getTime() + controlEventRetryDelaysMs[row.attemptCount - 1]!)}::timestamptz
      else ${now}::timestamptz end` }).where(key)
}

/** Polls for due events every second; one pass at a time. */
export class ControlEventSender {
  private timer: NodeJS.Timeout | undefined
  private pass: Promise<void> | undefined
  private stopping = false

  constructor(private readonly context: EngineContext, private readonly target: { url: string, key: Buffer, send?: ControlEventSend }, private readonly intervalMs = 1_000) {}

  start() {
    this.timer = setInterval(() => this.tick(), this.intervalMs)
    this.tick()
  }

  async stop() {
    this.stopping = true
    clearInterval(this.timer)
    await this.pass
  }

  private tick() {
    if (this.pass || this.stopping) return
    this.pass = deliverControlEvents(this.context, this.target)
      .then(result => { if (result.failed) log('info', 'control events sent', result) })
      .catch(error => log('error', 'control events pass failed', errorFields(error)))
      .finally(() => { this.pass = undefined })
  }
}
