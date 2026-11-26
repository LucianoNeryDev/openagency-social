import { RateLimited, ReauthRequired, type PublishOutcome } from '../types.js'
import { GraphError, type GraphCall, type GraphUsage } from './graph.js'

/** Meta error codes that mean the token no longer works: a new login is needed. */
const authCodes = new Set([102, 190])
/** A permission this action needs is missing (10, 200-299): the token still works for everything else. */
const permissionCode = (code: number) => code === 10 || (code >= 200 && code <= 299)
/** Rate limits: the request was rejected before anything was created. */
const rateLimitCodes = new Set([4, 17, 32, 341, 613, 80001])

/**
 * `sent` is true for the call that creates the visible post. Only that call
 * can leave the outcome unknown.
 */
export function classify(error: unknown, sent: boolean): PublishOutcome {
  if (!(error instanceof GraphError)) {
    // A parse failure after a 2xx means the post may exist.
    return sent ? { kind: 'uncertain', code: 'unexpected_response', detail: 'Unreadable success response' }
      : { kind: 'failed', retryable: true, code: 'unexpected_response', detail: 'Unreadable response before publish' }
  }
  const failure = error.failure
  if (failure.kind === 'unreachable') return { kind: 'failed', retryable: true, code: 'unreachable', detail: error.message }
  if (failure.kind === 'lost') {
    return sent ? { kind: 'uncertain', code: 'response_lost', detail: error.message }
      : { kind: 'failed', retryable: true, code: 'response_lost', detail: error.message }
  }
  const code = failure.code ?? 0
  const detail = `HTTP ${failure.status} code ${code}${failure.subcode ? `/${failure.subcode}` : ''}: ${failure.message}`
  if (authCodes.has(code)) return { kind: 'failed', retryable: false, code: 'auth', detail, reauth: true }
  if (permissionCode(code)) return { kind: 'failed', retryable: false, code: 'permission_missing', detail }
  if (rateLimitCodes.has(code) || failure.status === 429) {
    // Retried when Meta expects to allow the object again, when it says.
    const regain = regainMinutes(error.usage)
    return { kind: 'failed', retryable: true, code: 'rate_limited', detail, ...(regain ? { retryAt: new Date(Date.now() + regain * 60_000) } : {}) }
  }
  if (failure.transient || failure.status >= 500) {
    return sent ? { kind: 'uncertain', code: 'platform_error', detail } : { kind: 'failed', retryable: true, code: 'platform_error', detail }
  }
  return { kind: 'failed', retryable: false, code: 'rejected', detail }
}

/** Rate limits that pause reads on a channel: app (4), user (17), Page (32), action (613) and business use case (80001-80014). */
export function rateLimited(error: unknown) {
  if (!(error instanceof GraphError) || error.failure.kind !== 'http') return false
  const code = error.failure.code ?? 0
  return code === 4 || code === 17 || code === 32 || code === 613 || (code >= 80001 && code <= 80014) || error.failure.status === 429
}

/** The token is invalid, expired or revoked (OAuthException 190, or 102 for a session): a new login is needed. Missing permissions are not this. */
export function tokenInvalid(error: unknown) {
  return error instanceof GraphError && error.failure.kind === 'http' && (error.failure.code === 190 || error.failure.code === 102)
}

/** Usage at or above this share of any Meta limit pauses reads, before Meta starts refusing them at 100. */
export const usageHighPercent = 90
/**
 * How long reads wait after high usage when Meta gives no estimate of its
 * own: `X-App-Usage` is a rolling hour, so a quarter of it lets it fall.
 */
export const usagePauseMs = 15 * 60_000

/** The longest `estimated_time_to_regain_access` in the usage, in minutes; 0 when none is throttled. */
export function regainMinutes(usage: GraphUsage | undefined) {
  return Math.max(0, ...(usage?.business ?? []).map(entry => entry.regainMinutes))
}

/**
 * Whether Meta's usage figures say to slow down: any figure at 90% or more,
 * or a business object with time left before it is allowed again. The app's
 * own figures pause every channel on the app; a business object's pause its
 * channel. Pauses until Meta's estimate, or for `usagePauseMs`.
 */
export function usagePressure(usage: GraphUsage, now = new Date()): RateLimited | null {
  const highest = (figures: { callCount: number, totalTime: number, totalCputime: number }) => Math.max(figures.callCount, figures.totalTime, figures.totalCputime)
  const app = usage.app ? highest(usage.app) : 0
  const business = Math.max(0, ...usage.business.map(highest))
  const regain = regainMinutes(usage)
  if (app < usageHighPercent && business < usageHighPercent && regain <= 0) return null
  const until = new Date(now.getTime() + (regain > 0 ? regain * 60_000 : usagePauseMs))
  return new RateLimited(`Meta usage is high (app ${app}%, business ${business}%${regain > 0 ? `, ${regain} min to regain access` : ''})`,
    app >= usageHighPercent ? 'app' : 'channel', until)
}

/**
 * For a read's calls: hands `slowDown` the pause Meta's usage headers call
 * for, while the read itself goes on and keeps its result.
 */
export function watchUsage(slowDown: ((limit: RateLimited) => void) | undefined): Pick<GraphCall, 'onUsage'> {
  if (!slowDown) return {}
  return { onUsage: usage => {
    const limit = usagePressure(usage)
    if (limit) slowDown(limit)
  } }
}

/**
 * Runs a read, turning a Meta rate limit into `RateLimited` (until Meta's
 * estimate of when access returns, when the headers give one) and an invalid
 * token into `ReauthRequired`.
 */
export async function guardRateLimit<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  } catch (error) {
    if (tokenInvalid(error)) throw new ReauthRequired(error instanceof Error ? error.message : 'Invalid token')
    if (rateLimited(error)) {
      const usage = error instanceof GraphError ? error.usage : undefined
      const appWide = (error instanceof GraphError && error.failure.kind === 'http' && error.failure.code === 4)
        || (usage?.app !== undefined && Math.max(usage.app.callCount, usage.app.totalTime, usage.app.totalCputime) >= 100)
      const regain = regainMinutes(usage)
      throw new RateLimited(error instanceof Error ? error.message : 'Rate limited', appWide ? 'app' : 'channel',
        regain > 0 ? new Date(Date.now() + regain * 60_000) : undefined)
    }
    throw error
  }
}
