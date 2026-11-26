import { z } from 'zod'
import type { ChannelKind } from '../../db/schema.js'
import { EngineError, invalid } from '../../errors.js'
import { guardRateLimit, rateLimited } from '../meta/classify.js'
import { GraphClient, GraphError, type GraphCall, type GraphOptions } from '../meta/graph.js'
import type {
  ChannelLimits, ChannelTarget, ConnectedAccount, FindReplyOutcome, MediaDownloadInput, MediaDownloadResult, MessageRules, PlatformAdapter,
  PublishOutcome, ReconcileOutcome, ResolvedProviderApp, SendMessageInput, SendMessageOutcome,
} from '../types.js'
import { bsuidPattern, waIdPattern, whatsappErrorCode } from './webhook.js'

// WhatsApp Business Platform (Cloud API). A channel is one business phone
// number (`whatsapp_number`, its phone number ID), in a WhatsApp Business
// Account (WABA) kept as the channel's parent. Numbers take direct messages
// only: inbound messages and the statuses of sent ones arrive by webhook
// (src/whatsapp.ts); nothing is published to them.

export const whatsappMessagingScope = 'whatsapp_business_messaging'
export const defaultWhatsAppScopes = ['whatsapp_business_management', whatsappMessagingScope]

/** WhatsApp's longest text message. */
export const whatsappTextLimit = 4_096

const whatsappMessageRules: MessageRules = {
  platform: 'whatsapp', permission: whatsappMessagingScope, maxLength: whatsappTextLimit, unit: 'characters', inbound: 'webhook',
}

/** Business accounts and numbers read per connect. */
const maxBusinessAccounts = 20
const maxNumbersPerAccount = 100

const tokenSchema = z.object({ access_token: z.string().min(1), expires_in: z.number().optional() })
const debugTokenSchema = z.object({ data: z.object({
  scopes: z.array(z.string().max(100)).max(200).optional(),
  granular_scopes: z.array(z.object({ scope: z.string(), target_ids: z.array(z.string().regex(/^\d+$/)).max(1000).optional() })).max(100).optional(),
}) })
const numberSchema = z.object({
  id: z.string().regex(/^\d{1,30}$/),
  display_phone_number: z.string().max(40).optional(),
  verified_name: z.string().max(500).optional(),
})
const numbersSchema = z.object({ data: z.array(numberSchema).max(maxNumbersPerAccount) })
const sentSchema = z.object({ messages: z.array(z.object({ id: z.string().min(1).max(400) })).min(1) })
const mediaInfoSchema = z.object({ url: z.url(), mime_type: z.string().max(200).optional(), file_size: z.union([z.number(), z.string()]).optional() })

/** Meta serves media from its CDN; the token goes to nothing else. */
const mediaHosts = /(^|\.)(fbsbx\.com|facebook\.com|whatsapp\.net|fbcdn\.net)$/

/** A number's channel name: its verified business name and number, as WhatsApp shows them. */
export function numberName(value: z.infer<typeof numberSchema>) {
  const name = value.verified_name?.trim()
  const phone = value.display_phone_number?.trim()
  if (name && phone) return `${name} (${phone})`.slice(0, 200)
  return (name || phone || `WhatsApp ${value.id}`).slice(0, 200)
}

/**
 * Classifies a failed send. Only a request that may have reached Meta
 * without a readable answer is uncertain; a refusal is definite. 131047 is
 * the closed 24-hour window (a template is needed), 131026 a person who
 * cannot be reached, 130429 and 131056 throughput and pair rate limits
 * (tried again), 131048 the spam rate limit (not tried again).
 */
export function classifyWhatsAppSend(error: unknown): SendMessageOutcome {
  if (!(error instanceof GraphError)) return { kind: 'uncertain', code: 'unexpected_response', detail: 'Unreadable success response' }
  const failure = error.failure
  if (failure.kind === 'unreachable') return { kind: 'failed', retryable: true, code: 'unreachable', detail: error.message }
  if (failure.kind === 'lost') return { kind: 'uncertain', code: 'response_lost', detail: error.message }
  const code = failure.code ?? 0
  // Meta's codes first: they are what its documentation and support go by.
  const detail = `Meta ${code}${failure.subcode ? `/${failure.subcode}` : ''} (HTTP ${failure.status}): ${failure.message}`
  if (code === 190 || code === 102) return { kind: 'failed', retryable: false, code: 'channel_inactive', detail, reauth: true }
  if (code === 131005 || ((code === 10 || (code >= 200 && code <= 299)) && failure.message.includes(whatsappMessagingScope))) {
    return { kind: 'failed', retryable: false, code: 'missing_permission', detail, permission: whatsappMessagingScope }
  }
  if (code === 130429 || code === 131056 || rateLimited(error)) return { kind: 'failed', retryable: true, code: 'rate_limited', detail }
  if ([131047, 131026, 131021, 131049, 131050, 130472, 131048, 133010, 131031, 368, 131042].includes(code)) {
    return { kind: 'failed', retryable: false, code: whatsappErrorCode(code), detail }
  }
  if (code === 131000 || failure.transient || failure.status >= 500) return { kind: 'uncertain', code: 'platform_error', detail }
  return { kind: 'failed', retryable: false, code: 'rejected', detail }
}

/** Who a message goes to: the phone number when the engine knows it (it takes precedence at Meta), else the business-scoped user ID. */
export function recipientField(recipient: string): { to: string } | { recipient: string } | null {
  if (waIdPattern.test(recipient)) return { to: recipient }
  if (bsuidPattern.test(recipient)) return { recipient }
  return null
}

export class WhatsAppAdapter implements PlatformAdapter {
  readonly platform = 'whatsapp' as const
  private readonly graph: GraphClient
  private readonly fetcher: typeof fetch

  constructor(private readonly options: GraphOptions & { redirectUri: string }) {
    this.graph = new GraphClient(options)
    this.fetcher = options.fetch ?? fetch
  }

  /** Facebook Login for Business, with the provider app's configuration (a system-user token that does not expire) or the WhatsApp scopes. */
  authorizeUrl(app: ResolvedProviderApp, state: string) {
    const url = new URL(`https://www.facebook.com/${this.options.version}/dialog/oauth`)
    url.searchParams.set('client_id', app.externalAppId)
    url.searchParams.set('redirect_uri', this.options.redirectUri)
    url.searchParams.set('state', state)
    url.searchParams.set('response_type', 'code')
    if (app.settings.configId) url.searchParams.set('config_id', app.settings.configId)
    else url.searchParams.set('scope', (app.settings.scopes ?? defaultWhatsAppScopes).join(','))
    return url.href
  }

  /**
   * Exchanges the code, reads which business accounts the grant covers
   * (`whatsapp_business_management` targets), and makes each of their phone
   * numbers a channel, after subscribing the app to each account. The Login
   * for Business configuration must issue a user access token: one that
   * issues a system-user token offers no WhatsApp account to pick, and the
   * targets come back empty. A short-lived user token is exchanged for a
   * long-lived one (about 60 days). No account granted, an account without
   * numbers, or a refused subscription fails the connect with a code that
   * says which (no message would ever arrive otherwise).
   */
  async finishConnect(app: ResolvedProviderApp, code: string): Promise<ConnectedAccount[]> {
    const appCall: GraphCall = { appSecret: app.secret }
    let token = tokenSchema.parse(await this.graph.request('GET', '/oauth/access_token', { ...appCall, query: {
      client_id: app.externalAppId, client_secret: app.secret, redirect_uri: this.options.redirectUri, code,
    } }))
    if (token.expires_in !== undefined && token.expires_in < 86_400) {
      token = tokenSchema.parse(await this.graph.request('GET', '/oauth/access_token', { ...appCall, query: {
        grant_type: 'fb_exchange_token', client_id: app.externalAppId, client_secret: app.secret, fb_exchange_token: token.access_token,
      } }))
    }
    const debug = await this.debugToken(app, token.access_token)
    const businessAccounts = debug?.granular_scopes?.find(scope => scope.scope === 'whatsapp_business_management')?.target_ids ?? []
    if (!businessAccounts.length) {
      throw new EngineError(400, 'no_whatsapp_account', 'The grant covers no WhatsApp Business Account: the Login for Business configuration must issue a user access '
        + 'token with whatsapp_business_management and whatsapp_business_messaging, and the person must pick a WhatsApp account and number in the dialog')
    }
    const expiresAt = token.expires_in ? new Date(Date.now() + token.expires_in * 1_000) : null
    const accounts: ConnectedAccount[] = []
    for (const businessAccountId of [...new Set(businessAccounts)].slice(0, maxBusinessAccounts)) {
      const numbers = numbersSchema.parse(await this.graph.request('GET', `/${businessAccountId}/phone_numbers`, { token: token.access_token, appSecret: app.secret,
        query: { fields: 'id,display_phone_number,verified_name', limit: String(maxNumbersPerAccount) } }))
      if (!numbers.data.length) continue
      await this.subscribe(app, token.access_token, businessAccountId).catch((error: unknown) => {
        throw new EngineError(409, 'whatsapp_subscription_failed', 'Meta refused to subscribe the app to the WhatsApp Business Account\'s webhooks; no message would arrive',
          { businessAccountId, ...graphCodes(error) })
      })
      for (const value of numbers.data) {
        accounts.push({ kind: 'whatsapp_number', externalId: value.id, name: numberName(value), token: token.access_token, tokenExpiresAt: expiresAt,
          parentExternalId: businessAccountId, ...(debug?.scopes ? { grantedScopes: debug.scopes } : {}) })
      }
    }
    if (!accounts.length) throw new EngineError(400, 'no_whatsapp_number', 'The granted WhatsApp Business Accounts have no phone number')
    return accounts
  }

  /**
   * The operator's path: a token they hold (a system user's, with the
   * WhatsApp permissions on the business account), the business account and
   * the phone number. The number must belong to that account; the app is
   * subscribed to the account's webhooks, and a refusal fails the connect,
   * since no message would ever arrive.
   */
  async connectNumber(app: ResolvedProviderApp, input: { token: string, businessAccountId: string, phoneNumberId: string }): Promise<ConnectedAccount> {
    const call = { token: input.token, appSecret: app.secret }
    const numbers = numbersSchema.parse(await this.graph.request('GET', `/${input.businessAccountId}/phone_numbers`, { ...call,
      query: { fields: 'id,display_phone_number,verified_name', limit: String(maxNumbersPerAccount) } }))
    const number = numbers.data.find(value => value.id === input.phoneNumberId)
    if (!number) throw invalid('number_not_in_account', 'The phone number is not in this WhatsApp Business Account, or the token cannot see it')
    await this.subscribe(app, input.token, input.businessAccountId).catch((error: unknown) => {
      throw new EngineError(409, 'whatsapp_subscription_failed', 'Meta refused to subscribe the app to the WhatsApp Business Account\'s webhooks; no message would arrive',
        { businessAccountId: input.businessAccountId, ...graphCodes(error) })
    })
    const debug = await this.debugToken(app, input.token)
    return { kind: 'whatsapp_number', externalId: number.id, name: numberName(number), token: input.token, tokenExpiresAt: null,
      parentExternalId: input.businessAccountId, ...(debug?.scopes ? { grantedScopes: debug.scopes } : {}) }
  }

  /** Subscribes the app to the business account's webhooks (`messages`), so its numbers' messages and statuses reach the control plane. */
  private async subscribe(app: ResolvedProviderApp, token: string, businessAccountId: string) {
    await this.graph.request('POST', `/${businessAccountId}/subscribed_apps`, { token, appSecret: app.secret })
  }

  /** The grant's scopes and targets; null when Meta does not say. */
  private async debugToken(app: ResolvedProviderApp, token: string) {
    try {
      return debugTokenSchema.parse(await this.graph.request('GET', '/debug_token', { token: `${app.externalAppId}|${app.secret}`, query: { input_token: token } })).data
    } catch {
      return null
    }
  }

  limits(): ChannelLimits {
    return { maxLength: whatsappTextLimit, maxMedia: 0 }
  }

  validateSettings() {
    throw invalid('unsupported_channel', 'WhatsApp numbers take direct messages only; nothing is published to them')
  }

  async publish(): Promise<PublishOutcome> {
    return { kind: 'failed', retryable: false, code: 'unsupported_channel', detail: 'WhatsApp numbers take direct messages only' }
  }

  async checkCredential(app: ResolvedProviderApp | null, input: { channel: ChannelTarget, token: string }) {
    if (!app) throw new Error('WhatsApp numbers need their provider app')
    await guardRateLimit(() => this.graph.request('GET', `/${input.channel.externalId}`, { token: input.token, appSecret: app.secret, query: { fields: 'id' } }))
  }

  async reconcile(): Promise<ReconcileOutcome> {
    return { kind: 'not_found' }
  }

  messageRules(kind: ChannelKind) {
    return kind === 'whatsapp_number' ? whatsappMessageRules : null
  }

  /**
   * One text message inside the person's 24-hour window: `POST
   * /{phone-number-id}/messages`, tagged with the engine's outgoing ID
   * (`biz_opaque_callback_data`), which every status report of it echoes.
   * Once Meta accepted it, the person's last message is marked as read; that
   * second request never changes the outcome.
   */
  async sendMessage(app: ResolvedProviderApp | null, input: SendMessageInput): Promise<SendMessageOutcome> {
    if (!app || input.channel.kind !== 'whatsapp_number') return { kind: 'failed', retryable: false, code: 'not_supported', detail: input.channel.kind }
    const recipient = recipientField(input.recipientExternalId)
    if (!recipient) return { kind: 'failed', retryable: false, code: 'recipient_unknown', detail: 'Not a WhatsApp user ID' }
    const path = `/${input.channel.externalId}/messages`
    const call = { token: input.token, appSecret: app.secret }
    let sent: z.infer<typeof sentSchema>
    try {
      sent = sentSchema.parse(await this.graph.request('POST', path, { ...call, json: {
        messaging_product: 'whatsapp', recipient_type: 'individual', ...recipient, type: 'text', text: { body: input.text, preview_url: false },
        ...(input.outgoingId ? { biz_opaque_callback_data: input.outgoingId } : {}),
      } }))
    } catch (error) {
      return classifyWhatsAppSend(error)
    }
    if (input.readExternalId) {
      await this.graph.request('POST', path, { ...call, json: { messaging_product: 'whatsapp', status: 'read', message_id: input.readExternalId } }).catch(() => undefined)
    }
    return { kind: 'sent', externalId: sent.messages[0]!.id }
  }

  /**
   * WhatsApp has no API to read a conversation back. An uncertain send is
   * settled by its status reports instead (they carry the engine's outgoing
   * ID); until one arrives, every look finds nothing.
   */
  async findMessage(): Promise<FindReplyOutcome> {
    return { kind: 'not_found' }
  }

  /** `GET /{media-id}` for a short-lived URL, then the bytes from Meta's CDN with the same token. */
  async downloadMedia(app: ResolvedProviderApp | null, input: MediaDownloadInput): Promise<MediaDownloadResult> {
    if (!app || !/^\d{1,40}$/.test(input.mediaId)) return { kind: 'unavailable', reason: 'gone' }
    let info: z.infer<typeof mediaInfoSchema>
    try {
      info = mediaInfoSchema.parse(await this.graph.request('GET', `/${input.mediaId}`, { token: input.token, appSecret: app.secret,
        query: { phone_number_id: input.channel.externalId } }))
    } catch (error) {
      if (error instanceof GraphError && error.failure.kind === 'http') {
        const code = error.failure.code ?? 0
        if (code === 10 || code === 190 || code === 131005 || (code >= 200 && code <= 299)) return { kind: 'unavailable', reason: 'refused' }
        if (error.failure.status === 404 || code === 100) return { kind: 'unavailable', reason: 'gone' }
      }
      throw error
    }
    const declared = info.file_size === undefined ? null : Number(info.file_size)
    if (declared !== null && Number.isFinite(declared) && declared > input.maxBytes) return { kind: 'unavailable', reason: 'too_large' }
    const url = new URL(info.url)
    if (url.protocol !== 'https:' || !mediaHosts.test(url.hostname)) throw new Error('Unexpected media host')
    const response = await this.fetcher(url, { headers: { Authorization: `Bearer ${input.token}` }, redirect: 'error', signal: AbortSignal.timeout(60_000) })
    if (response.status === 404 || response.status === 410) return { kind: 'unavailable', reason: 'gone' }
    if (!response.ok || !response.body) throw new Error(`Media download returned ${response.status}`)
    const length = Number(response.headers.get('content-length') ?? NaN)
    if (Number.isFinite(length) && length > input.maxBytes) {
      await response.body.cancel()
      return { kind: 'unavailable', reason: 'too_large' }
    }
    const mimeType = (info.mime_type ?? response.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]!.trim()
    return { kind: 'ok', mimeType, sizeBytes: Number.isFinite(length) ? length : declared, body: response.body.pipeThrough(byteLimit(input.maxBytes)) }
  }
}

/** Meta's error code and subcode of a failed Graph request, for an error detail; nothing else of it. */
function graphCodes(error: unknown): { metaCode?: number, metaSubcode?: number } {
  if (!(error instanceof GraphError) || error.failure.kind !== 'http') return {}
  return { ...(error.failure.code !== undefined ? { metaCode: error.failure.code } : {}), ...(error.failure.subcode !== undefined ? { metaSubcode: error.failure.subcode } : {}) }
}

/** Errors the stream once more than `max` bytes went through, whatever the headers said. */
function byteLimit(max: number) {
  let seen = 0
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength
      if (seen > max) controller.error(new Error('Media larger than allowed'))
      else controller.enqueue(chunk)
    },
  })
}
