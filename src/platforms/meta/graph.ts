import { createHmac } from 'node:crypto'
import { redactText } from '../../crypto/redact.js'

export interface GraphOptions {
  version: string
  /** `graph.facebook.com` by default; `graph.instagram.com` for Instagram's own login. */
  host?: string
  timeoutMs?: number
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
  constructor(readonly failure: GraphFailure, message: string) {
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
      response = await this.fetcher(url, { method, headers, body, redirect: 'error', signal: AbortSignal.timeout(this.options.timeoutMs ?? 20_000) })
    } catch (error) {
      const code = errorCode(error)
      throw new GraphError(code && unreachableCodes.has(code) ? { kind: 'unreachable' } : { kind: 'lost' }, `Graph ${method} ${path} failed: ${code ?? 'network'}`)
    }

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
      }, `Graph ${method} ${path} returned ${response.status}${error?.code === undefined ? '' : ` (code ${error.code})`}`)
    }
    return payload
  }
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
