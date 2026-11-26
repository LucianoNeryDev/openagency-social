import { RateLimited, ReauthRequired, type PublishOutcome } from '../types.js'
import { GraphError } from './graph.js'

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
  if (rateLimitCodes.has(code) || failure.status === 429) return { kind: 'failed', retryable: true, code: 'rate_limited', detail }
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

/** Runs a read, turning a Meta rate limit into `RateLimited` and an invalid token into `ReauthRequired`. */
export async function guardRateLimit<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  } catch (error) {
    if (tokenInvalid(error)) throw new ReauthRequired(error instanceof Error ? error.message : 'Invalid token')
    if (rateLimited(error)) {
      const appWide = error instanceof GraphError && error.failure.kind === 'http' && error.failure.code === 4
      throw new RateLimited(error instanceof Error ? error.message : 'Rate limited', appWide ? 'app' : 'channel')
    }
    throw error
  }
}
