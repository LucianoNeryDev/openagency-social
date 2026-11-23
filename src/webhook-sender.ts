import { createHmac, randomBytes } from 'node:crypto'
import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import { request } from 'node:https'
import { BlockList, isIP, type LookupFunction } from 'node:net'

/** A webhook request is given this long, connection to last byte read. */
export const webhookTimeoutMs = 10_000
/** At most this much of a receiver's answer is read; the rest is dropped. */
const maxResponseBytes = 1_024

export interface WebhookRequest {
  url: string
  headers: Record<string, string>
  body: string
}

export type WebhookResult =
  | { kind: 'delivered', status: number }
  | { kind: 'failed', status: number | null, error: string }

export type WebhookSender = (request: WebhookRequest) => Promise<WebhookResult>

/**
 * Addresses a webhook may never reach: loopback, private and link-local
 * networks, the shared CGNAT range, documentation and benchmark ranges,
 * multicast, and IPv6 forms that embed an IPv4 address (mapped, NAT64, 6to4),
 * so none of them can lead back inside. Two lists, because a BlockList also
 * matches IPv4 addresses against IPv6 rules, and ::ffff:0:0/96 holds them all.
 */
const blockedV4 = new BlockList()
for (const [network, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) blockedV4.addSubnet(network, prefix, 'ipv4')
const blockedV6 = new BlockList()
for (const [network, prefix] of [['::', 127], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 32], ['2001:db8::', 32],
  ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]] as const) blockedV6.addSubnet(network, prefix, 'ipv6')

export function isPublicAddress(address: string) {
  const family = isIP(address)
  if (family === 4) return !blockedV4.check(address, 'ipv4')
  if (family === 6) return !blockedV6.check(address, 'ipv6')
  return false
}

/**
 * A URL a webhook may be registered with: HTTPS, a host name or public
 * address, no credentials or fragment. Where a host name resolves is checked
 * on every delivery.
 */
export function webhookUrlProblem(value: string): string | null {
  let url: URL
  try { url = new URL(value) } catch { return 'not a URL' }
  if (url.protocol !== 'https:') return 'must be HTTPS'
  if (url.username || url.password) return 'must not carry credentials'
  if (url.hash) return 'must not have a fragment'
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host) && !isPublicAddress(host)) return 'must not point at a private address'
  if (!isIP(host) && (!host.includes('.') || /\.(localhost|local|internal|lan|home|arpa|ts\.net)$/i.test(host) || host.toLowerCase() === 'localhost')) {
    return 'must be a public host name'
  }
  return null
}

/** `whsec_` and 32 random bytes, base64: the Standard Webhooks secret form. */
export function newWebhookSecret() {
  return `whsec_${randomBytes(32).toString('base64')}`
}

/**
 * Standard Webhooks signature: base64 HMAC-SHA256 over `<id>.<timestamp>.<body>`,
 * keyed with the decoded secret. One `v1,<signature>` per secret, space separated.
 */
export function signWebhook(secrets: string[], id: string, timestamp: number, body: string) {
  return secrets.map(secret => {
    const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64')
    return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`
  }).join(' ')
}

class BlockedAddress extends Error {}

type Resolver = (hostname: string) => Promise<LookupAddress[]>

const systemResolver: Resolver = hostname => new Promise((resolve, reject) => {
  dnsLookup(hostname, { all: true }, (error, addresses) => error ? reject(error) : resolve(addresses))
})

/** Resolves the host, then refuses the connection when any of its addresses is not public. */
function publicOnlyLookup(resolver: Resolver, allowed: (address: string) => boolean): LookupFunction {
  return (hostname, options, callback) => {
    resolver(hostname).then(found => {
      const addresses = options.family ? found.filter(entry => entry.family === options.family) : found
      if (!addresses.length || addresses.some(entry => !allowed(entry.address))) {
        return callback(new BlockedAddress(`${hostname} resolves to a private address`), '', 0)
      }
      if (options.all) return (callback as unknown as (error: null, addresses: LookupAddress[]) => void)(null, addresses)
      callback(null, addresses[0]!.address, addresses[0]!.family)
    }, (error: NodeJS.ErrnoException) => callback(error, '', 0))
  }
}

/**
 * POSTs a webhook over HTTPS. Redirects are not followed; a 2xx is
 * delivered, anything else (or no answer within the timeout) failed. Only
 * the status and a short, clipped part of the answer are kept.
 */
export function createWebhookSender(options: { timeoutMs?: number,
  /** Tests only: where host names lead, which addresses may be reached, and the CA of a local server. */
  resolver?: Resolver, allowAddress?: (address: string) => boolean, ca?: string } = {}): WebhookSender {
  const timeoutMs = options.timeoutMs ?? webhookTimeoutMs
  const lookup = publicOnlyLookup(options.resolver ?? systemResolver, options.allowAddress ?? isPublicAddress)
  return target => new Promise(resolve => {
    const problem = webhookUrlProblem(target.url)
    if (problem) return resolve({ kind: 'failed', status: null, error: `url ${problem}` })
    const url = new URL(target.url)
    let settled = false
    const finish = (result: WebhookResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const outgoing = request(url, {
      method: 'POST', lookup, timeout: timeoutMs, agent: false, ...(options.ca ? { ca: options.ca } : {}),
      headers: { ...target.headers, 'content-type': 'application/json', 'content-length': Buffer.byteLength(target.body), 'user-agent': 'OpenAgency-Social-Webhooks/1' },
    }, response => {
      const status = response.statusCode ?? 0
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        if (size < maxResponseBytes) chunks.push(chunk)
        size += chunk.length
        if (size >= maxResponseBytes) response.destroy()
      })
      const done = () => {
        if (status >= 200 && status < 300) return finish({ kind: 'delivered', status })
        const answer = Buffer.concat(chunks).toString('utf8').slice(0, 200).replace(/[\r\n\t]+/g, ' ').trim()
        finish({ kind: 'failed', status, error: status >= 300 && status < 400 ? 'redirect not followed' : answer ? `HTTP ${status}: ${answer}` : `HTTP ${status}` })
      }
      response.on('end', done)
      response.on('close', done)
      response.on('error', done)
    })
    const timer = setTimeout(() => {
      outgoing.destroy()
      finish({ kind: 'failed', status: null, error: 'timeout' })
    }, timeoutMs)
    outgoing.on('timeout', () => outgoing.destroy(new Error('timeout')))
    outgoing.on('error', error => finish({ kind: 'failed', status: null,
      error: error instanceof BlockedAddress ? error.message : `request failed: ${(error as NodeJS.ErrnoException).code ?? error.message}`.slice(0, 200) }))
    outgoing.end(target.body)
  })
}
