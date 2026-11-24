import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { GraphError } from '../src/platforms/meta/graph.js'
import { classifyWhatsAppSend, numberName, recipientField, WhatsAppAdapter } from '../src/platforms/whatsapp/adapter.js'
import { parseWhatsAppNotification, verifyWhatsAppSignature, whatsappErrorCode } from '../src/platforms/whatsapp/webhook.js'
import type { PlatformAdapter, ResolvedProviderApp, SendMessageInput } from '../src/platforms/types.js'

// Every platform call goes to a recorded fake Cloud API; nothing here reaches Meta.
interface Call { method: string, url: URL, body: unknown, headers: Record<string, string> }
type Reply = (call: Call) => Response | Promise<Response>

function recorder(replies: Reply[]) {
  const calls: Call[] = []
  const fetcher = (async (input: URL | string | Request, init?: RequestInit) => {
    const call: Call = { method: init?.method ?? 'GET', url: new URL(String(input)), body: init?.body, headers: { ...(init?.headers as Record<string, string> | undefined) } }
    calls.push(call)
    const reply = replies.shift()
    if (!reply) throw new Error(`Unexpected call ${call.method} ${call.url}`)
    return reply(call)
  }) as typeof fetch
  return { calls, fetcher }
}

const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const graphError = (status: number, code: number, message = 'boom') => json({ error: { message, code, type: 'OAuthException' } }, status)
const timeout = () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }) }
const refused = () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }) }

const app: ResolvedProviderApp = { id: 'whatsapp-agency', platform: 'whatsapp', externalAppId: '111', secret: 'app-secret-123', settings: {} }
const whatsapp = (replies: Reply[]) => {
  const { calls, fetcher } = recorder(replies)
  return { calls, adapter: new WhatsAppAdapter({ version: 'v26.0', redirectUri: 'https://dash-api.example.com/cb', fetch: fetcher }) }
}
const number = { id: 'c1', kind: 'whatsapp_number' as const, externalId: '106540352242922' }
const sendInput = (overrides: Partial<SendMessageInput> = {}): SendMessageInput => ({ channel: number, token: 'token-abc', recipientExternalId: '393401234567',
  text: 'Sì, siamo aperti fino alle 19.', outgoingId: '0d9c8b7a-6f5e-4d3c-8b2a-1f0e9d8c7b6a', ...overrides })
const bodyOf = (call: Call) => JSON.parse(String(call.body)) as Record<string, unknown>

/** Meta's envelope around one `messages` change of one number. */
function notification(value: Record<string, unknown>, options: { wabaId?: string, phoneNumberId?: string } = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: options.wabaId ?? '102290129340398', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp', metadata: { display_phone_number: '15550783881', phone_number_id: options.phoneNumberId ?? '106540352242922' }, ...value,
    } }] }],
  }
}
const contacts = [{ profile: { name: 'Sheena Nelson' }, wa_id: '16505551234', user_id: 'US.13491208655302741918' }]
const inbound = (message: Record<string, unknown>) => notification({ contacts, messages: [{ from: '16505551234', from_user_id: 'US.13491208655302741918',
  id: 'wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQUFERjg0NDEzNDdFODU3MUMxMAA=', timestamp: '1749416383', ...message }] })

describe('WhatsApp webhook signature', () => {
  const body = Buffer.from(JSON.stringify(inbound({ type: 'text', text: { body: 'Ciao' } })))
  const sign = (secret: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`

  it('accepts the app secret\'s HMAC of the raw body, and nothing else', () => {
    expect(verifyWhatsAppSignature('app-secret-123', body, sign('app-secret-123'))).toBe(true)
    expect(verifyWhatsAppSignature('app-secret-123', body, ` ${sign('app-secret-123').toUpperCase().replace('SHA256=', 'sha256=')} `)).toBe(true)
    expect(verifyWhatsAppSignature('app-secret-123', body, sign('another-secret'))).toBe(false)
    expect(verifyWhatsAppSignature('app-secret-123', Buffer.concat([body, Buffer.from(' ')]), sign('app-secret-123'))).toBe(false)
    expect(verifyWhatsAppSignature('app-secret-123', body, undefined)).toBe(false)
    expect(verifyWhatsAppSignature('app-secret-123', body, 'sha1=abc')).toBe(false)
    expect(verifyWhatsAppSignature('', body, sign(''))).toBe(false)
  })
})

describe('WhatsApp webhook payloads', () => {
  it('reads a text message with the person\'s phone number, business-scoped user ID and profile name', () => {
    const [change] = parseWhatsAppNotification(inbound({ type: 'text', text: { body: 'Siete aperti domenica?' } }))
    expect(change).toMatchObject({ businessAccountId: '102290129340398', phoneNumberId: '106540352242922', statuses: [] })
    expect(change!.messages).toEqual([{ externalId: 'wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQUFERjg0NDEzNDdFODU3MUMxMAA=',
      customer: { userId: 'US.13491208655302741918', phone: '16505551234', name: 'Sheena Nelson', username: null },
      sentAt: new Date(1749416383_000), text: 'Siete aperti domenica?', attachments: [] }])
  })

  it('keeps a person with a username and no phone number by their business-scoped user ID', () => {
    const [change] = parseWhatsAppNotification(notification({ contacts: [{ profile: { name: 'Ana', username: 'ana.p' }, user_id: 'BR.987654321' }],
      messages: [{ from_user_id: 'BR.987654321', id: 'wamid.A1', timestamp: 1749416383, type: 'text', text: { body: 'Oi' } }] }))
    expect(change!.messages[0]!.customer).toEqual({ userId: 'BR.987654321', phone: null, name: 'Ana', username: 'ana.p' })
  })

  it('stores media as references with their caption, never a URL', () => {
    const image = parseWhatsAppNotification(inbound({ type: 'image', image: { caption: 'Questo è disponibile?', mime_type: 'image/jpeg',
      sha256: 'abc', id: '1003383421387256', url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1' } }))[0]!.messages[0]!
    expect(image).toMatchObject({ text: 'Questo è disponibile?', attachments: [{ type: 'image', mediaId: '1003383421387256', mimeType: 'image/jpeg' }] })
    expect(JSON.stringify(image)).not.toContain('lookaside')
    const document = parseWhatsAppNotification(inbound({ type: 'document', document: { filename: 'ordine.pdf', mime_type: 'application/pdf',
      id: '2003383421387256' } }))[0]!.messages[0]!
    expect(document).toMatchObject({ text: '', attachments: [{ type: 'file', name: 'ordine.pdf', mediaId: '2003383421387256', mimeType: 'application/pdf' }] })
    const voice = parseWhatsAppNotification(inbound({ type: 'audio', audio: { mime_type: 'audio/ogg; codecs=opus', id: '3003383421387256', voice: true } }))[0]!.messages[0]!
    expect(voice.attachments).toEqual([{ type: 'audio', mediaId: '3003383421387256', mimeType: 'audio/ogg' }])
    const video = parseWhatsAppNotification(inbound({ type: 'video', video: { mime_type: 'video/mp4', id: '4003383421387256' } }))[0]!.messages[0]!
    expect(video.attachments).toEqual([{ type: 'video', mediaId: '4003383421387256', mimeType: 'video/mp4' }])
  })

  it('stores the kinds it does not answer with a readable placeholder, flagged by an attachment', () => {
    const read = (message: Record<string, unknown>) => parseWhatsAppNotification(inbound(message))[0]!.messages[0]!
    expect(read({ type: 'location', location: { latitude: 45.4642, longitude: 9.19, name: 'Duomo', address: 'Piazza del Duomo, Milano' } }))
      .toMatchObject({ text: '', attachments: [{ type: 'location', name: 'Duomo, Piazza del Duomo, Milano' }] })
    expect(read({ type: 'location', location: { latitude: 45.4642, longitude: 9.19 } }).attachments).toEqual([{ type: 'location', name: '45.4642, 9.19' }])
    expect(read({ type: 'contacts', contacts: [{ name: { formatted_name: 'Mario Rossi', first_name: 'Mario' }, phones: [{ phone: '+39 340 000' }] }] }))
      .toMatchObject({ text: '', attachments: [{ type: 'contacts', name: 'Mario Rossi' }] })
    expect(read({ type: 'reaction', reaction: { message_id: 'wamid.X', emoji: '👍' } })).toMatchObject({ text: '', attachments: [{ type: 'reaction', name: '👍' }] })
    expect(read({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'b1', title: 'Sì, confermo' } } }))
      .toMatchObject({ text: 'Sì, confermo', attachments: [{ type: 'interactive', name: 'button_reply' }] })
    expect(read({ type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'l1', title: 'Martedì', description: 'ore 10' } } }))
      .toMatchObject({ text: 'Martedì', attachments: [{ type: 'interactive', name: 'list_reply' }] })
    expect(read({ type: 'button', button: { payload: 'STOP', text: 'Non mi interessa' } })).toMatchObject({ text: 'Non mi interessa', attachments: [{ type: 'button' }] })
    expect(read({ type: 'sticker', sticker: { mime_type: 'image/webp', id: '5003383421387256', animated: false } }))
      .toMatchObject({ text: '', attachments: [{ type: 'sticker', mediaId: '5003383421387256', mimeType: 'image/webp' }] })
    expect(read({ type: 'order', order: { catalog_id: '1', product_items: [] } })).toMatchObject({ attachments: [{ type: 'order' }] })
    expect(read({ type: 'system', system: { body: 'User changed number', type: 'user_changed_number' } })).toMatchObject({ attachments: [{ type: 'system' }] })
    expect(read({ type: 'unsupported', errors: [{ code: 131051, title: 'Message type unknown' }] })).toMatchObject({ text: '', attachments: [{ type: 'unsupported' }] })
    expect(read({ type: 'something_new' })).toMatchObject({ attachments: [{ type: 'unsupported' }] })
  })

  it('reads statuses, with the engine\'s outgoing ID echoed back and the first error\'s code', () => {
    const [change] = parseWhatsAppNotification(notification({ statuses: [
      { id: 'wamid.S1', status: 'sent', timestamp: '1749416400', recipient_id: '16505551234', biz_opaque_callback_data: '0d9c8b7a-6f5e-4d3c-8b2a-1f0e9d8c7b6a',
        conversation: { id: 'c', origin: { type: 'service' } }, pricing: { billable: false, pricing_model: 'PMP', category: 'service' } },
      { id: 'wamid.S1', status: 'delivered', timestamp: '1749416401', recipient_id: '16505551234', recipient_user_id: 'US.13491208655302741918' },
      { id: 'wamid.S2', status: 'failed', timestamp: '1749416402', recipient_id: '16505551234', biz_opaque_callback_data: 'not-ours',
        errors: [{ code: 131047, title: 'Re-engagement message', message: 'Re-engagement message', error_data: { details: 'More than 24 hours' } }] },
      { id: 'wamid.S3', status: 'read', timestamp: '1749416403' },
      { id: 'wamid.S4', status: 'deleted', timestamp: '1749416404' },
    ] }))
    expect(change!.statuses).toEqual([
      { externalId: 'wamid.S1', status: 'sent', at: new Date(1749416400_000), outgoingId: '0d9c8b7a-6f5e-4d3c-8b2a-1f0e9d8c7b6a', errorCode: null },
      { externalId: 'wamid.S1', status: 'delivered', at: new Date(1749416401_000), outgoingId: null, errorCode: null },
      { externalId: 'wamid.S2', status: 'failed', at: new Date(1749416402_000), outgoingId: null, errorCode: 'outside_window' },
      { externalId: 'wamid.S3', status: 'read', at: new Date(1749416403_000), outgoingId: null, errorCode: null },
    ])
  })

  it('leaves out other objects, other fields and malformed items without dropping the rest', () => {
    expect(parseWhatsAppNotification({ object: 'page', entry: [{ id: '1', changes: [] }] })).toEqual([])
    expect(parseWhatsAppNotification('nonsense')).toEqual([])
    const mixed = notification({ contacts, messages: [
      { from: '16505551234', id: 'wamid.ok', timestamp: '1749416383', type: 'text', text: { body: 'one' } },
      { from: 'not a number', id: 'wamid.bad-sender', timestamp: '1749416383', type: 'text', text: { body: 'two' } },
      { from: '16505551234', id: 'wamid.bad-time', timestamp: 'later', type: 'text', text: { body: 'three' } },
      { from: '16505551234', id: 'wamid with spaces', timestamp: '1749416383', type: 'text', text: { body: 'four' } },
    ] })
    mixed.entry[0]!.changes.push({ field: 'message_template_status_update', value: { event: 'APPROVED' } } as never)
    const changes = parseWhatsAppNotification(mixed)
    expect(changes).toHaveLength(1)
    expect(changes[0]!.messages.map(message => message.externalId)).toEqual(['wamid.ok'])
    expect(parseWhatsAppNotification(notification({ messages: [] }, { phoneNumberId: '../me' }))).toEqual([])
  })

  it('clips text to what the engine stores', () => {
    const long = parseWhatsAppNotification(inbound({ type: 'text', text: { body: 'x'.repeat(6_000) } }))[0]!.messages[0]!
    expect(long.text).toHaveLength(5_000)
  })
})

describe('WhatsApp sends', () => {
  it('posts one tagged text message as JSON, then marks the person\'s message as read', async () => {
    const { calls, adapter } = whatsapp([json({ messaging_product: 'whatsapp', contacts: [{ input: '393401234567', wa_id: '393401234567' }],
      messages: [{ id: 'wamid.OUT1', message_status: 'accepted' }] }), json({ success: true })])
    expect(await adapter.sendMessage(app, sendInput({ readExternalId: 'wamid.IN1' }))).toEqual({ kind: 'sent', externalId: 'wamid.OUT1' })
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.url.pathname).toBe('/v26.0/106540352242922/messages')
    expect(calls[0]!.url.searchParams.get('appsecret_proof')).toMatch(/^[0-9a-f]{64}$/)
    expect(calls[0]!.headers['Content-Type']).toBe('application/json')
    expect(calls[0]!.headers.Authorization).toBe('Bearer token-abc')
    expect(bodyOf(calls[0]!)).toEqual({ messaging_product: 'whatsapp', recipient_type: 'individual', to: '393401234567', type: 'text',
      text: { body: 'Sì, siamo aperti fino alle 19.', preview_url: false }, biz_opaque_callback_data: '0d9c8b7a-6f5e-4d3c-8b2a-1f0e9d8c7b6a' })
    expect(bodyOf(calls[1]!)).toEqual({ messaging_product: 'whatsapp', status: 'read', message_id: 'wamid.IN1' })
  })

  it('addresses a person known only by business-scoped user ID through `recipient`', async () => {
    const { calls, adapter } = whatsapp([json({ messages: [{ id: 'wamid.OUT2' }] })])
    expect(await adapter.sendMessage(app, sendInput({ recipientExternalId: 'US.13491208655302741918' }))).toEqual({ kind: 'sent', externalId: 'wamid.OUT2' })
    expect(bodyOf(calls[0]!)).toMatchObject({ recipient: 'US.13491208655302741918' })
    expect(bodyOf(calls[0]!)).not.toHaveProperty('to')
    expect(recipientField('../../me')).toBeNull()
    expect(await whatsapp([]).adapter.sendMessage(app, sendInput({ recipientExternalId: 'nobody' }))).toMatchObject({ kind: 'failed', code: 'recipient_unknown' })
  })

  it('never lets a failed read receipt change a sent message', async () => {
    const { adapter } = whatsapp([json({ messages: [{ id: 'wamid.OUT3' }] }), graphError(500, 131000)])
    expect(await adapter.sendMessage(app, sendInput({ readExternalId: 'wamid.IN1' }))).toEqual({ kind: 'sent', externalId: 'wamid.OUT3' })
  })

  it('classifies the Cloud API\'s refusals', async () => {
    const outcome = async (reply: Reply) => whatsapp([reply]).adapter.sendMessage(app, sendInput())
    expect(await outcome(graphError(400, 131047, 'Re-engagement message'))).toMatchObject({ kind: 'failed', retryable: false, code: 'outside_window' })
    expect(await outcome(graphError(400, 131026, 'Message undeliverable'))).toMatchObject({ kind: 'failed', retryable: false, code: 'recipient_unavailable' })
    expect(await outcome(graphError(400, 130429, 'Rate limit hit'))).toMatchObject({ kind: 'failed', retryable: true, code: 'rate_limited' })
    expect(await outcome(graphError(400, 131056, 'Pair rate limit hit'))).toMatchObject({ kind: 'failed', retryable: true, code: 'rate_limited' })
    expect(await outcome(graphError(400, 80007, 'Rate limit issues'))).toMatchObject({ kind: 'failed', retryable: true, code: 'rate_limited' })
    expect(await outcome(graphError(400, 131048, 'Spam rate limit hit'))).toMatchObject({ kind: 'failed', retryable: false, code: 'rate_limited' })
    expect(await outcome(graphError(400, 131049, 'Meta chose not to deliver'))).toMatchObject({ kind: 'failed', retryable: false, code: 'message_not_allowed' })
    expect(await outcome(graphError(401, 190, 'Error validating access token'))).toMatchObject({ kind: 'failed', code: 'channel_inactive', reauth: true })
    expect(await outcome(graphError(403, 131005, 'Access denied'))).toMatchObject({ kind: 'failed', code: 'missing_permission', permission: 'whatsapp_business_messaging' })
    expect(await outcome(graphError(403, 200, 'Requires whatsapp_business_messaging permission')))
      .toMatchObject({ kind: 'failed', code: 'missing_permission', permission: 'whatsapp_business_messaging' })
    expect(await outcome(graphError(400, 100, 'Invalid parameter'))).toMatchObject({ kind: 'failed', retryable: false, code: 'rejected' })
    expect(await outcome(graphError(500, 131000, 'Something went wrong'))).toMatchObject({ kind: 'uncertain', code: 'platform_error' })
    expect(await outcome(timeout)).toMatchObject({ kind: 'uncertain', code: 'response_lost' })
    expect(await outcome(refused)).toMatchObject({ kind: 'failed', retryable: true, code: 'unreachable' })
    expect(await outcome(() => new Response('not json', { status: 200 }))).toMatchObject({ kind: 'uncertain', code: 'response_lost' })
    expect(await outcome(json({ messages: [] }))).toMatchObject({ kind: 'uncertain', code: 'unexpected_response' })
    expect(classifyWhatsAppSend(new Error('x'))).toMatchObject({ kind: 'uncertain' })
    expect(classifyWhatsAppSend(new GraphError({ kind: 'lost' }, 'lost'))).toMatchObject({ kind: 'uncertain', code: 'response_lost' })
  })

  it('names the failure codes a status report carries', () => {
    expect(whatsappErrorCode(131047)).toBe('outside_window')
    expect(whatsappErrorCode(131026)).toBe('recipient_unavailable')
    expect(whatsappErrorCode(131050)).toBe('message_not_allowed')
    expect(whatsappErrorCode(130429)).toBe('rate_limited')
    expect(whatsappErrorCode(undefined)).toBe('rejected')
    expect(whatsappErrorCode(132001)).toBe('rejected')
  })

  it('cannot read a conversation back, so a look finds nothing; nothing is published to a number', async () => {
    const { calls, adapter } = whatsapp([])
    const generic: PlatformAdapter = adapter
    expect(await generic.findMessage!(app, { channel: number, token: 't', conversationExternalId: 'x', text: 'y', since: new Date(), excludeExternalIds: [] }))
      .toEqual({ kind: 'not_found' })
    expect(() => adapter.validateSettings()).toThrow(/direct messages only/)
    expect(adapter.messageRules('whatsapp_number')).toEqual({ platform: 'whatsapp', permission: 'whatsapp_business_messaging', maxLength: 4_096,
      unit: 'characters', inbound: 'webhook' })
    expect(adapter.messageRules('facebook_page')).toBeNull()
    expect(calls).toHaveLength(0)
  })
})

describe('WhatsApp connect', () => {
  it('asks Login for Business with the app\'s configuration, or the WhatsApp scopes', () => {
    const { adapter } = whatsapp([])
    const withConfig = new URL(adapter.authorizeUrl({ ...app, settings: { configId: '987' } }, 'state-1'))
    expect(withConfig.searchParams.get('config_id')).toBe('987')
    expect(withConfig.searchParams.get('redirect_uri')).toBe('https://dash-api.example.com/cb')
    expect(new URL(adapter.authorizeUrl(app, 'state-1')).searchParams.get('scope')).toBe('whatsapp_business_management,whatsapp_business_messaging')
  })

  it('makes each number of each granted business account a channel and subscribes the app', async () => {
    const { calls, adapter } = whatsapp([
      json({ access_token: 'system-user-token' }),
      json({ data: { scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'], granular_scopes: [
        { scope: 'whatsapp_business_management', target_ids: ['102290129340398'] }, { scope: 'whatsapp_business_messaging', target_ids: ['102290129340398'] }] } }),
      json({ data: [{ id: '106540352242922', display_phone_number: '+39 02 1234 5678', verified_name: 'Bottega' }, { id: '106540352242923' }] }),
      json({ success: true }),
    ])
    const accounts = await adapter.finishConnect(app, 'code-1')
    expect(accounts).toEqual([
      { kind: 'whatsapp_number', externalId: '106540352242922', name: 'Bottega (+39 02 1234 5678)', token: 'system-user-token', tokenExpiresAt: null,
        parentExternalId: '102290129340398', grantedScopes: ['whatsapp_business_management', 'whatsapp_business_messaging'] },
      { kind: 'whatsapp_number', externalId: '106540352242923', name: 'WhatsApp 106540352242923', token: 'system-user-token', tokenExpiresAt: null,
        parentExternalId: '102290129340398', grantedScopes: ['whatsapp_business_management', 'whatsapp_business_messaging'] },
    ])
    expect(calls.map(call => `${call.method} ${call.url.pathname}`)).toEqual(['GET /v26.0/oauth/access_token', 'GET /v26.0/debug_token',
      'GET /v26.0/102290129340398/phone_numbers', 'POST /v26.0/102290129340398/subscribed_apps'])
  })

  it('exchanges a short-lived user token for a long-lived one', async () => {
    const { calls, adapter } = whatsapp([json({ access_token: 'short', expires_in: 3_600 }), json({ access_token: 'long', expires_in: 5_184_000 }),
      json({ data: { scopes: [] } })])
    expect(await adapter.finishConnect(app, 'code-1')).toEqual([])
    expect(calls[1]!.url.searchParams.get('grant_type')).toBe('fb_exchange_token')
  })

  it('connects a number by hand only when it is in the business account, and fails when the subscription is refused', async () => {
    const numbers = json({ data: [{ id: '106540352242922', display_phone_number: '+39 02 1234 5678', verified_name: 'Bottega' }] })
    const ok = whatsapp([numbers, json({ success: true }), json({ data: { scopes: ['whatsapp_business_messaging'] } })])
    expect(await ok.adapter.connectNumber(app, { token: 'operator-token-0123456789', businessAccountId: '102290129340398', phoneNumberId: '106540352242922' }))
      .toEqual({ kind: 'whatsapp_number', externalId: '106540352242922', name: 'Bottega (+39 02 1234 5678)', token: 'operator-token-0123456789',
        tokenExpiresAt: null, parentExternalId: '102290129340398', grantedScopes: ['whatsapp_business_messaging'] })
    await expect(whatsapp([numbers]).adapter.connectNumber(app, { token: 't'.repeat(20), businessAccountId: '102290129340398', phoneNumberId: '999' }))
      .rejects.toMatchObject({ code: 'number_not_in_account' })
    await expect(whatsapp([numbers, graphError(403, 200, 'Permissions error')]).adapter.connectNumber(app, { token: 't'.repeat(20),
      businessAccountId: '102290129340398', phoneNumberId: '106540352242922' })).rejects.toBeInstanceOf(GraphError)
    expect(numberName({ id: '1', verified_name: 'x'.repeat(300) })).toHaveLength(200)
  })
})

describe('WhatsApp media', () => {
  const info = (url: string, size = 1234) => json({ url, mime_type: 'image/jpeg', sha256: 'abc', file_size: size, id: '1003383421387256', messaging_product: 'whatsapp' })
  const input = { channel: number, token: 'token-abc', mediaId: '1003383421387256', maxBytes: 10 }
  const read = async (body: ReadableStream<Uint8Array>) => Buffer.from(await new Response(body).arrayBuffer())

  it('reads the short-lived URL, then the bytes from Meta\'s CDN with the token', async () => {
    const { calls, adapter } = whatsapp([info('https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1', 5),
      () => new Response('hello', { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': '5' } })])
    const result = await adapter.downloadMedia(app, input)
    expect(result).toMatchObject({ kind: 'ok', mimeType: 'image/jpeg', sizeBytes: 5 })
    if (result.kind === 'ok') expect((await read(result.body)).toString()).toBe('hello')
    expect(calls[0]!.url.pathname).toBe('/v26.0/1003383421387256')
    expect(calls[1]!.url.hostname).toBe('lookaside.fbsbx.com')
    expect(calls[1]!.headers.Authorization).toBe('Bearer token-abc')
  })

  it('refuses files over the limit, gone media, refusals and hosts that are not Meta\'s', async () => {
    expect(await whatsapp([info('https://lookaside.fbsbx.com/a', 11)]).adapter.downloadMedia(app, input)).toEqual({ kind: 'unavailable', reason: 'too_large' })
    expect(await whatsapp([graphError(404, 100, 'Unsupported get request')]).adapter.downloadMedia(app, input)).toEqual({ kind: 'unavailable', reason: 'gone' })
    expect(await whatsapp([graphError(403, 10, 'Permission denied')]).adapter.downloadMedia(app, input)).toEqual({ kind: 'unavailable', reason: 'refused' })
    expect(await whatsapp([]).adapter.downloadMedia(app, { ...input, mediaId: '../x' })).toEqual({ kind: 'unavailable', reason: 'gone' })
    await expect(whatsapp([info('https://attacker.example/steal', 1)]).adapter.downloadMedia(app, input)).rejects.toThrow(/media host/)
    // A body longer than declared is cut off at the limit.
    const { adapter } = whatsapp([info('https://lookaside.fbsbx.com/a', 1), () => new Response('0123456789abc', { status: 200 })])
    const result = await adapter.downloadMedia(app, input)
    if (result.kind !== 'ok') throw new Error('expected a stream')
    await expect(read(result.body)).rejects.toThrow()
  })
})
