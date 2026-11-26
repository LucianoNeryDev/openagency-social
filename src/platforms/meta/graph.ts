import { createHmac } from 'node:crypto'
import { redactText } from '../../crypto/redact.js'

/** A read or a small write; uploads and the publishing request get longer. */
export const defaultTimeoutMs = 20_000
/** Photo uploads, and Instagram containers, for which Meta fetches the file from its URL before it answers. */
export const defaultUploadTimeoutMs = 180_000
/** The request that makes a post visible (the Page feed post, `media_publish`), which Meta can be slow to answer. */
export const defaultPublishTimeoutMs = 120_000

export interface GraphOptions {
  version: string
  /** `graph.facebook.com` by default; `graph.instagram.com` for Instagram's own login. */
  host?: string
  timeoutMs?: number
  uploadTimeoutMs?: number
  publishTimeoutMs?: number
  fetch?: typeof fetch
}

export interface GraphCall {
  token?: string
  appSecret?: string
  query?: Record<string, string>
  /** URL-encoded form, or multipart when it contains a Blob. */
  form?: Record<string, string | Blob>
  /** A JSON body instead of a form (the WhatsApp Cloud API); the app secret proof then goes in the query. */
  json?: unknown
  /** Instagram's token endpoints live outside the versioned path. */
  unversioned?: boolean
  /** Called just before the request is sent; the collectors count their calls with it. */
  onRequest?: () => void
  /** Called with Meta's usage figures whenever a response carries them, success or error. */
  onUsage?: (usage: GraphUsage) => void
  /** Overrides the client's timeout: uploads and `media_publish` take longer than a read. */
  timeoutMs?: number
}

/**
 * Meta's usage figures from the response headers, as percentages of the
 * limit (0 to 100; Meta throttles at 100). `X-App-Usage` covers the app over
 * a rolling hour; `X-Business-Use-Case-Usage` covers each business object
 * the call touched (a Page, an Instagram account), with an estimate in
 * minutes of when a throttled object is allowed again.
 * https://developers.facebook.com/docs/graph-api/overview/rate-limiting
 * `X-Ad-Account-Usage` is not read: it comes only with Marketing API calls,
 * which the engine never makes.
 */
export interface GraphUsage {
  app?: { callCount: number, totalTime: number, totalCputime: number }
  business: Array<{ objectId: string, type: string, callCount: number, totalTime: number, totalCputime: number, regainMinutes: number }>
}

/**
 * Counts a read's requests against the collectors' call budget: the first
 * is already paid for by the caller, each later one is passed to `spend`.
 */
export function spendAfterFirst(spend: (() => void) | undefined): Pick<GraphCall, 'onRequest'> {
  if (!spend) return {}
  let first = true
  return { onRequest: () => {
    if (first) first = false
    else spend()
  } }
}

/**
 * `unreachable`: the request never left this host (DNS, refused connection),
 * so nothing was created. `lost`: the request may have been delivered.
 */
export type GraphFailure =
  | { kind: 'unreachable' }
  | { kind: 'lost' }
  | { kind: 'http', status: number, code?: number, subcode?: number, transient: boolean, message: string }

export class GraphError extends Error {
  constructor(readonly failure: GraphFailure, message: string, readonly usage?: GraphUsage) {
    super(message)
    this.name = 'GraphError'
  }
}

const maxResponseBytes = 2_000_000
const unreachableCodes = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT'])

export function appSecretProof(token: string, appSecret: string) {
  return createHmac('sha256', appSecret).update(token).digest('hex')
}

export class GraphClient {
  readonly base: string
  private readonly origin: string
  private readonly fetcher: typeof fetch

  constructor(private readonly options: GraphOptions) {
    this.origin = `https://${options.host ?? 'graph.facebook.com'}`
    this.base = `${this.origin}/${options.version}`
    this.fetcher = options.fetch ?? fetch
  }

  /** Timeouts for an upload and for the publishing request. */
  get timeouts() {
    return { upload: this.options.uploadTimeoutMs ?? defaultUploadTimeoutMs, publish: this.options.publishTimeoutMs ?? defaultPublishTimeoutMs }
  }

  async request(method: 'GET' | 'POST' | 'DELETE', path: string, call: GraphCall = {}): Promise<unknown> {
    if (!/^\/[A-Za-z0-9_/.-]*$/.test(path)) throw new Error('Invalid Graph path')
    const url = new URL(`${call.unversioned ? this.origin : this.base}${path}`)
    for (const [key, value] of Object.entries(call.query ?? {})) url.searchParams.set(key, value)
    const headers: Record<string, string> = { Accept: 'application/json' }
    const secrets: string[] = []
    let body: FormData | URLSearchParams | string | undefined
    if (call.token) {
      headers.Authorization = `Bearer ${call.token}`
      secrets.push(call.token)
    }
    if (call.appSecret) secrets.push(call.appSecret)
    const proof = call.token && call.appSecret ? appSecretProof(call.token, call.appSecret) : undefined
    if (call.json !== undefined) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(call.json)
      if (proof) url.searchParams.set('appsecret_proof', proof)
    } else if (call.form || method !== 'GET') {
      const entries = Object.entries(call.form ?? {})
      if (entries.some(([, value]) => value instanceof Blob)) {
        const form = new FormData()
        for (const [key, value] of entries) form.append(key, value)
        if (proof) form.append('appsecret_proof', proof)
        body = form
      } else {
        const form = new URLSearchParams(entries as Array<[string, string]>)
        if (proof) form.set('appsecret_proof', proof)
        body = form
      }
    } else if (proof) {
      url.searchParams.set('appsecret_proof', proof)
    }

    let response: Response
    call.onRequest?.()
    try {
      response = await this.fetcher(url, { method, headers, body, redirect: 'error', signal: AbortSignal.timeout(call.timeoutMs ?? this.options.timeoutMs ?? defaultTimeoutMs) })
    } catch (error) {
      const code = errorCode(error)
      throw new GraphError(code && unreachableCodes.has(code) ? { kind: 'unreachable' } : { kind: 'lost' }, `Graph ${method} ${path} failed: ${code ?? 'network'}`)
    }
    const usage = readUsage(response.headers)
    if (usage) call.onUsage?.(usage)

    let payload: unknown
    try {
      payload = await readJson(response)
    } catch {
      // A response arrived but could not be read: its outcome is unknown.
      throw new GraphError({ kind: 'lost' }, `Graph ${method} ${path} returned an unreadable response`)
    }
    if (!response.ok) {
      const error = graphErrorBody(payload)
      throw new GraphError({
        kind: 'http', status: response.status, code: error?.code, subcode: error?.error_subcode,
        transient: error?.is_transient === true || response.status >= 500,
        message: redactText(error?.message ?? `HTTP ${response.status}`, secrets).slice(0, 500),
      }, `Graph ${method} ${path} returned ${response.status}${error?.code === undefined ? '' : ` (code ${error.code})`}`, usage)
    }
    return payload
  }
}

const percent = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0

function parseHeader(value: string | null): unknown {
  if (!value || value.length > 20_000) return undefined
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

/** The usage headers of a response, or undefined when it has none. Malformed headers are ignored. */
export function readUsage(headers: Headers): GraphUsage | undefined {
  const app = parseHeader(headers.get('x-app-usage'))
  const business = parseHeader(headers.get('x-business-use-case-usage'))
  if (app === undefined && business === undefined) return undefined
  const usage: GraphUsage = { business: [] }
  if (app && typeof app === 'object') {
    const value = app as Record<string, unknown>
    usage.app = { callCount: percent(value.call_count), totalTime: percent(value.total_time), totalCputime: percent(value.total_cputime) }
  }
  if (business && typeof business === 'object') {
    for (const [objectId, entries] of Object.entries(business as Record<string, unknown>).slice(0, 50)) {
      if (!Array.isArray(entries)) continue
      for (const entry of entries.slice(0, 32)) {
        if (!entry || typeof entry !== 'object') continue
        const value = entry as Record<string, unknown>
        usage.business.push({ objectId, type: typeof value.type === 'string' ? value.type.slice(0, 50) : 'unknown', callCount: percent(value.call_count),
          totalTime: percent(value.total_time), totalCputime: percent(value.total_cputime), regainMinutes: percent(value.estimated_time_to_regain_access) })
      }
    }
  }
  return usage
}

async function readJson(response: Response): Promise<unknown> {
  if (Number(response.headers.get('content-length') ?? 0) > maxResponseBytes) throw new Error('Response too large')
  const reader = response.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxResponseBytes) {
      await reader.cancel()
      throw new Error('Response too large')
    }
    chunks.push(value)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) as unknown : null
}

interface GraphErrorBody { message?: string, code?: number, error_subcode?: number, is_transient?: boolean }

function graphErrorBody(payload: unknown): GraphErrorBody | undefined {
  if (!payload || typeof payload !== 'object' || !('error' in payload)) return undefined
  const error = payload.error
  if (!error || typeof error !== 'object') return undefined
  const read = (key: string) => (key in error ? (error as Record<string, unknown>)[key] : undefined)
  const message = read('message')
  const code = read('code')
  const subcode = read('error_subcode')
  const transient = read('is_transient')
  return {
    message: typeof message === 'string' ? message : undefined,
    code: typeof code === 'number' ? code : undefined,
    error_subcode: typeof subcode === 'number' ? subcode : undefined,
    is_transient: typeof transient === 'boolean' ? transient : undefined,
  }
}

function errorCode(error: unknown): string | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    if ('code' in current && typeof current.code === 'string') return current.code
    if ('name' in current && (current.name === 'TimeoutError' || current.name === 'AbortError')) return 'TIMEOUT'
    current = 'cause' in current ? current.cause : undefined
  }
  return undefined
}

/** Graph times such as `2030-01-01T10:00:00+0000`, in milliseconds; null when unreadable. */
export function graphTime(value: string | undefined) {
  if (!value) return null
  const time = Date.parse(value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'))
  return Number.isFinite(time) ? time : null
}
