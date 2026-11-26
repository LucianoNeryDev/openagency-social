import { z } from 'zod'

const loopbackHosts = ['127.0.0.1', '::1', 'localhost']
/**
 * The control plane's events URL: HTTPS to any host, or plain HTTP to a
 * loopback address only (the dashboard on the same machine). Unlike tenant
 * webhooks, private hosts are allowed: the operator sets this, not a tenant.
 */
export function controlPlaneUrlProblem(value: string): string | null {
  let url: URL
  try { url = new URL(value) } catch { return 'not a URL' }
  if (url.username || url.password) return 'must not carry credentials'
  if (url.hash) return 'must not have a fragment'
  if (url.protocol === 'https:') return null
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (url.protocol === 'http:' && (loopbackHosts.includes(host) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host))) return null
  return 'must be https, or http on a loopback address'
}

const singleLine = z.string().min(1).refine(value => !/[\r\n]/.test(value), 'must be a single line')

const keyringSchema = z.record(z.string().regex(/^[a-z0-9-]{1,32}$/), z.string())
  .transform((value, context) => {
    const keys = new Map<string, Buffer>()
    for (const [id, encoded] of Object.entries(value)) {
      const key = Buffer.from(encoded, 'base64')
      if (key.length !== 32) context.addIssue({ code: 'custom', message: `token key ${id} must be 32 bytes, base64` })
      keys.set(id, key)
    }
    return keys
  })

const environmentSchema = z.object({
  HOST: z.string().default('127.0.0.1').refine(value => loopbackHosts.includes(value), 'the engine binds to loopback only'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3410),
  DATABASE_URL: singleLine,
  SERVICE_TOKEN: singleLine.refine(value => value.length >= 32, 'service token must be at least 32 characters'),
  TOKEN_KEYS: z.string().transform((value, context) => {
    try { return JSON.parse(value) as unknown } catch {
      context.addIssue({ code: 'custom', message: 'TOKEN_KEYS must be JSON' })
      return z.NEVER
    }
  }).pipe(keyringSchema),
  TOKEN_KEY_ACTIVE: z.string().min(1),
  // JSON object: provider app secret reference → secret.
  PROVIDER_APP_SECRETS: z.string().default('{}').transform((value, context) => {
    try { return JSON.parse(value) as unknown } catch {
      context.addIssue({ code: 'custom', message: 'PROVIDER_APP_SECRETS must be JSON' })
      return z.NEVER
    }
  }).pipe(z.record(z.string(), singleLine)),
  META_REDIRECT_URI: z.url().refine(value => new URL(value).protocol === 'https:', 'redirect URI must be HTTPS'),
  META_GRAPH_VERSION: z.string().regex(/^v\d+\.\d+$/).default('v26.0'),
  // OAuth callbacks on the dashboard API. Without them those platforms take
  // imported channels only (`pnpm channel import`).
  GOOGLE_REDIRECT_URI: z.preprocess(value => value === '' ? undefined : value, z.url().refine(value => new URL(value).protocol === 'https:', 'redirect URI must be HTTPS').optional()),
  INSTAGRAM_REDIRECT_URI: z.preprocess(value => value === '' ? undefined : value, z.url().refine(value => new URL(value).protocol === 'https:', 'redirect URI must be HTTPS').optional()),
  // Dashboard API route that serves signed media URLs, e.g. https://dash-api.example.com/api/social/media
  PUBLIC_MEDIA_URL: z.url().refine(value => {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.search && !url.hash && !url.username && !url.password
  }, 'public media URL must be plain HTTPS').optional(),
  // Optional browser runner. Browser channels (TikTok, X, LinkedIn, Threads, Pinterest, Reddit) are unavailable without it.
  RUNNER_URL: z.url().refine(value => ['http:', 'https:'].includes(new URL(value).protocol)).optional(),
  RUNNER_TOKEN: singleLine.refine(value => value.length >= 32, 'runner token must be at least 32 characters').optional(),
  // AI answers (ADR 0004). Without Anthropic no drafts are written; without Liquid every decision is `skipped` (a person decides).
  ANTHROPIC_API_KEY: z.preprocess(value => value === '' ? undefined : value, singleLine.optional()),
  LIQUID_API_KEY: z.preprocess(value => value === '' ? undefined : value, singleLine.optional()),
  // Where the control plane hears that a pull is due (ADR 0005). Unset: no events, the control plane polls.
  CONTROL_PLANE_EVENTS_URL: z.preprocess(value => value === '' ? undefined : value, z.url().refine(value => controlPlaneUrlProblem(value) === null,
    'must be https, or http on a loopback address, without credentials or fragment').optional()),
  WORKER_ENABLED: z.enum(['true', 'false']).default('true').transform(value => value === 'true'),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  // Their own slots, beside WORKER_CONCURRENCY's standard ones (docs/deploy.md).
  WORKER_VIDEO_SLOTS: z.coerce.number().int().min(1).max(8).default(1),
  WORKER_BROWSER_SLOTS: z.coerce.number().int().min(1).max(8).default(1),
  WORKER_POLL_MS: z.coerce.number().int().min(250).max(60_000).default(5_000),
  // How long a stopping engine lets publishes in flight finish (docs/deploy.md); keep it under the orchestrator's kill timeout.
  SHUTDOWN_GRACE_MS: z.coerce.number().int().min(1_000).max(30 * 60_000).default(25_000),
})

export type Config = ReturnType<typeof loadConfig>

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const parsed = environmentSchema.safeParse(environment)
  if (!parsed.success) {
    // Name the variables only; values may be secrets.
    const fields = [...new Set(parsed.error.issues.map(issue => String(issue.path[0] ?? 'environment')))]
    throw new Error(`Invalid configuration: ${fields.join(', ')}`)
  }
  const value = parsed.data
  if (!value.TOKEN_KEYS.has(value.TOKEN_KEY_ACTIVE)) throw new Error('Invalid configuration: TOKEN_KEY_ACTIVE')
  return {
    host: value.HOST,
    port: value.PORT,
    databaseUrl: value.DATABASE_URL,
    serviceToken: value.SERVICE_TOKEN,
    keyring: { activeKeyId: value.TOKEN_KEY_ACTIVE, keys: value.TOKEN_KEYS },
    providerSecrets: new Map(Object.entries(value.PROVIDER_APP_SECRETS)),
    meta: { redirectUri: value.META_REDIRECT_URI, graphVersion: value.META_GRAPH_VERSION },
    google: { redirectUri: value.GOOGLE_REDIRECT_URI },
    instagram: { redirectUri: value.INSTAGRAM_REDIRECT_URI },
    publicMediaUrl: value.PUBLIC_MEDIA_URL,
    runner: value.RUNNER_URL && value.RUNNER_TOKEN ? { url: value.RUNNER_URL, token: value.RUNNER_TOKEN } : undefined,
    anthropicApiKey: value.ANTHROPIC_API_KEY,
    liquidApiKey: value.LIQUID_API_KEY,
    controlPlaneEventsUrl: value.CONTROL_PLANE_EVENTS_URL,
    worker: { enabled: value.WORKER_ENABLED, concurrency: value.WORKER_CONCURRENCY, slots: { video: value.WORKER_VIDEO_SLOTS, browser: value.WORKER_BROWSER_SLOTS }, pollMs: value.WORKER_POLL_MS, shutdownGraceMs: value.SHUTDOWN_GRACE_MS },
  }
}
