import { describe, expect, it } from 'vitest'
import { retryAt, lastStartMs, retryDelayMs } from '../src/jobs/worker.js'
import { SlowDown } from '../src/pause.js'
import { regainMinutes, usagePauseMs, usagePressure } from '../src/platforms/meta/classify.js'
import { readUsage } from '../src/platforms/meta/graph.js'
import { RateLimited } from '../src/platforms/types.js'

const headers = (values: Record<string, unknown>) => new Headers(Object.fromEntries(Object.entries(values).map(([key, value]) => [key, JSON.stringify(value)])))
const now = new Date('2030-01-01T10:00:00Z')

describe('Meta usage headers', () => {
  it('reads the app figures and each business object\'s, with the minutes to regain access', () => {
    const usage = readUsage(headers({
      'x-app-usage': { call_count: 28, total_time: 25, total_cputime: 25 },
      'x-business-use-case-usage': { 1000000000000101: [{ type: 'pages', call_count: 91, total_cputime: 10, total_time: 12, estimated_time_to_regain_access: 0 }],
        17841400000000000: [{ type: 'instagram', call_count: 100, total_cputime: 40, total_time: 30, estimated_time_to_regain_access: 7 }] },
    }))
    expect(usage).toEqual({ app: { callCount: 28, totalTime: 25, totalCputime: 25 }, business: [
      { objectId: '1000000000000101', type: 'pages', callCount: 91, totalTime: 12, totalCputime: 10, regainMinutes: 0 },
      { objectId: '17841400000000000', type: 'instagram', callCount: 100, totalTime: 30, totalCputime: 40, regainMinutes: 7 },
    ] })
    expect(regainMinutes(usage)).toBe(7)
  })

  it('ignores missing or malformed headers', () => {
    expect(readUsage(new Headers())).toBeUndefined()
    expect(readUsage(new Headers({ 'x-app-usage': 'not json' }))).toBeUndefined()
    expect(readUsage(headers({ 'x-app-usage': { call_count: 'lots' }, 'x-business-use-case-usage': { 1: 'nope', 2: [null, { type: 7 }] } })))
      .toEqual({ app: { callCount: 0, totalTime: 0, totalCputime: 0 }, business: [{ objectId: '2', type: 'unknown', callCount: 0, totalTime: 0, totalCputime: 0, regainMinutes: 0 }] })
  })

  it('asks to slow down at 90% of any figure, app-wide for the app\'s own', () => {
    const business = (figures: Partial<{ callCount: number, totalTime: number, totalCputime: number, regainMinutes: number }>) =>
      ({ objectId: '1', type: 'pages', callCount: 0, totalTime: 0, totalCputime: 0, regainMinutes: 0, ...figures })
    expect(usagePressure({ app: { callCount: 89, totalTime: 50, totalCputime: 10 }, business: [business({ totalCputime: 89 })] }, now)).toBeNull()
    const app = usagePressure({ app: { callCount: 10, totalTime: 90, totalCputime: 10 }, business: [] }, now)!
    expect(app.scope).toBe('app')
    expect(app.until).toEqual(new Date(now.getTime() + usagePauseMs))
    const page = usagePressure({ business: [business({ callCount: 95 })] }, now)!
    expect(page.scope).toBe('channel')
    // Meta's own estimate wins, even when the figures look low.
    expect(usagePressure({ business: [business({ regainMinutes: 30 })] }, now)!.until).toEqual(new Date(now.getTime() + 30 * 60_000))
  })

  it('keeps the latest end and the wider scope across a read\'s calls', async () => {
    const slowDown = new SlowDown()
    slowDown.note(new RateLimited('page', 'channel', new Date(now.getTime() + 30 * 60_000)))
    slowDown.note(new RateLimited('app', 'app', new Date(now.getTime() + 15 * 60_000)))
    // Nothing noted: nothing to pause, and the database is not touched.
    expect(await new SlowDown().apply({} as never, { id: 'c1', organizationId: 'o', providerAppId: null }, now)).toBeNull()
    const merged = slowDown.limit!
    expect(merged.scope).toBe('app')
    expect(merged.until).toEqual(new Date(now.getTime() + 30 * 60_000))
  })
})

describe('retries after a rate limit', () => {
  const job = { publishAt: new Date(now.getTime() - 10 * 60_000), attemptCount: 2 }

  it('waits for the limit\'s window, or the backoff without one', () => {
    expect(retryAt(job, { retryAt: new Date(now.getTime() + 20 * 60_000) }, now)).toEqual(new Date(now.getTime() + 20 * 60_000))
    expect(retryAt(job, {}, now)).toEqual(new Date(now.getTime() + retryDelayMs(2)))
  })

  it('never waits past the last start inside the lateness limit', () => {
    expect(retryAt(job, { retryAt: new Date(now.getTime() + 3 * 3_600_000) }, now)).toEqual(new Date(job.publishAt.getTime() + lastStartMs))
    const late = { publishAt: new Date(now.getTime() - 2 * 3_600_000), attemptCount: 1 }
    expect(retryAt(late, {}, now)).toEqual(now)
  })
})
