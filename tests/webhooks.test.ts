import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createWebhookSender, isPublicAddress, newWebhookSecret, signWebhook, webhookUrlProblem } from '../src/webhook-sender.js'
import { metricChanges, webhookCreateSchema } from '../src/webhooks.js'

const command = promisify(execFile)

describe('webhook addresses', () => {
  it('reaches public addresses only', () => {
    for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) expect(isPublicAddress(address)).toBe(true)
    for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '100.64.1.4', '169.254.169.254', '0.0.0.0', '224.0.0.1',
      '::1', '::', 'fd7a:115c:a1e0::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8', '64:ff9b::a00:1', '2002:a00:1::1', 'not-an-ip']) {
      expect(isPublicAddress(address), address).toBe(false)
    }
  })

  it('takes plain HTTPS URLs on public host names', () => {
    expect(webhookUrlProblem('https://hooks.example.com/social?x=1')).toBeNull()
    expect(webhookUrlProblem('https://8.8.8.8/hook')).toBeNull()
    expect(webhookUrlProblem('http://hooks.example.com/')).toBe('must be HTTPS')
    expect(webhookUrlProblem('https://user:pass@hooks.example.com/')).toBe('must not carry credentials')
    expect(webhookUrlProblem('https://hooks.example.com/#x')).toBe('must not have a fragment')
    for (const url of ['https://127.0.0.1/', 'https://[::1]/', 'https://100.64.1.4:3430/', 'https://[::ffff:10.0.0.1]/']) {
      expect(webhookUrlProblem(url), url).toBe('must not point at a private address')
    }
    for (const url of ['https://localhost/', 'https://o1/', 'https://p1.tail.ts.net/', 'https://router.lan/', 'https://x.internal/']) {
      expect(webhookUrlProblem(url), url).toBe('must be a public host name')
    }
    expect(webhookCreateSchema.safeParse({ url: 'https://127.0.0.1/', eventTypes: ['comment.created'] }).success).toBe(false)
    expect(webhookCreateSchema.safeParse({ url: 'https://hooks.example.com/', eventTypes: [] }).success).toBe(false)
    expect(webhookCreateSchema.safeParse({ url: 'https://hooks.example.com/', eventTypes: ['job.queued'] }).success).toBe(false)
    expect(webhookCreateSchema.parse({ url: 'https://hooks.example.com/', eventTypes: ['comment.created', 'comment.created'] }))
      .toEqual({ url: 'https://hooks.example.com/', eventTypes: ['comment.created'], channelIds: null, description: null })
  })
})

describe('webhook signatures', () => {
  it('matches the Standard Webhooks test vector', () => {
    expect(signWebhook(['whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'], 'msg_p5jXN8AQM9LWM0D4loKWxJek', 1614265330, '{"test": 2432232314}'))
      .toBe('v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=')
  })

  it('signs with every secret given, and makes 32-byte secrets', () => {
    const [first, second] = [newWebhookSecret(), newWebhookSecret()]
    expect(first).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/)
    expect(Buffer.from(first.slice(6), 'base64')).toHaveLength(32)
    const both = signWebhook([first, second], 'id', 1, '{}').split(' ')
    expect(both).toEqual([signWebhook([first], 'id', 1, '{}'), signWebhook([second], 'id', 1, '{}')])
  })
})

describe('metric changes', () => {
  it('reports differences of numbers present in both reads', () => {
    expect(metricChanges(null, {})).toEqual({ changed: false, changes: {} })
    expect(metricChanges(null, { likes: 2 })).toEqual({ changed: true, changes: {} })
    expect(metricChanges({ likes: 2, views: 10 }, { likes: 2, views: 10 })).toEqual({ changed: false, changes: {} })
    expect(metricChanges({ likes: 2, views: 10 }, { likes: 5, views: 8 })).toEqual({ changed: true, changes: { likes: 3, views: -2 } })
    expect(metricChanges({ likes: 2 }, { likes: 2, reach: 7 })).toEqual({ changed: true, changes: {} })
  })
})

describe('webhook sender', () => {
  let directory: string
  let server: Server
  let port: number
  let ca: string
  const received: Array<{ headers: Record<string, string | string[] | undefined>, body: string }> = []
  let answer: (path: string) => { status: number, body?: string, delayMs?: number } = () => ({ status: 204 })

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'webhook-sender-'))
    const key = join(directory, 'key.pem')
    const cert = join(directory, 'cert.pem')
    await command('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-subj', '/CN=hooks.example.com',
      '-addext', 'subjectAltName=DNS:hooks.example.com', '-keyout', key, '-out', cert])
    ca = await readFile(cert, 'utf8')
    server = createServer({ key: await readFile(key), cert: ca }, (request, response) => {
      const chunks: Buffer[] = []
      request.on('data', chunk => chunks.push(chunk))
      request.on('end', () => {
        received.push({ headers: request.headers, body: Buffer.concat(chunks).toString('utf8') })
        const { status, body, delayMs } = answer(request.url ?? '/')
        setTimeout(() => {
          response.writeHead(status, status >= 300 && status < 400 ? { location: 'https://elsewhere.example.com/' } : {})
          response.end(body)
        }, delayMs ?? 0)
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as AddressInfo).port
  })
  afterAll(async () => {
    server?.closeAllConnections()
    await new Promise(resolve => server?.close(resolve))
    if (directory) await rm(directory, { recursive: true, force: true })
  })

  // The local server stands in for a public host: the test resolver leads hooks.example.com to it.
  const local = (overrides: Parameters<typeof createWebhookSender>[0] = {}) => createWebhookSender({ ca,
    resolver: async () => [{ address: '127.0.0.1', family: 4 }], allowAddress: () => true, ...overrides })
  const url = (path = '/hook') => `https://hooks.example.com:${port}${path}`

  it('posts the body with the given headers and reports a 2xx as delivered', async () => {
    received.length = 0
    answer = () => ({ status: 202 })
    const result = await local()({ url: url(), body: '{"type":"webhook.test"}', headers: { 'webhook-id': 'abc', 'webhook-timestamp': '1', 'webhook-signature': 'v1,x' } })
    expect(result).toEqual({ kind: 'delivered', status: 202 })
    expect(received[0]!.body).toBe('{"type":"webhook.test"}')
    expect(received[0]!.headers).toMatchObject({ 'content-type': 'application/json', 'webhook-id': 'abc', 'webhook-signature': 'v1,x',
      'user-agent': 'OpenAgency-Social-Webhooks/1' })
  })

  it('fails other answers with a clipped reason, and never follows a redirect', async () => {
    answer = path => path === '/redirect' ? { status: 302 } : { status: 500, body: `boom\n${'x'.repeat(5_000)}` }
    const failed = await local()({ url: url(), body: '{}', headers: {} })
    expect(failed).toMatchObject({ kind: 'failed', status: 500 })
    expect(failed.kind === 'failed' && failed.error.startsWith('HTTP 500: boom x')).toBe(true)
    expect(failed.kind === 'failed' && failed.error.length).toBeLessThanOrEqual(220)
    expect(await local()({ url: url('/redirect'), body: '{}', headers: {} })).toEqual({ kind: 'failed', status: 302, error: 'redirect not followed' })
  })

  it('gives up on a slow receiver', async () => {
    answer = () => ({ status: 200, delayMs: 2_000 })
    expect(await local({ timeoutMs: 300 })({ url: url(), body: '{}', headers: {} })).toEqual({ kind: 'failed', status: null, error: 'timeout' })
  })

  it('refuses a host that resolves to a private address, before connecting', async () => {
    received.length = 0
    answer = () => ({ status: 204 })
    const sender = createWebhookSender({ ca, resolver: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }] })
    expect(await sender({ url: url(), body: '{}', headers: {} })).toEqual({ kind: 'failed', status: null, error: 'hooks.example.com resolves to a private address' })
    expect(await createWebhookSender()({ url: `https://127.0.0.1:${port}/`, body: '{}', headers: {} }))
      .toEqual({ kind: 'failed', status: null, error: 'url must not point at a private address' })
    expect(received).toHaveLength(0)
  })
})
