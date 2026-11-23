import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { conversationBackoffMs, windowOpenUntil } from '../src/conversations.js'
import { messageDigest, messageFits, messageRequestKey, windowOpenAt } from '../src/messages.js'
import { InstagramLoginAdapter } from '../src/platforms/instagram/adapter.js'
import { MetaAdapter } from '../src/platforms/meta/adapter.js'
import { attachmentOf } from '../src/platforms/meta/messages.js'
import { RateLimited, type FindMessageInput, type ResolvedProviderApp, type SendMessageInput } from '../src/platforms/types.js'

// Every platform call goes to a recorded fake; nothing here reaches a real platform.
interface Call { method: string, url: URL, body: unknown }
type Reply = (call: Call) => Response | Promise<Response>

function recorder(replies: Reply[]) {
  const calls: Call[] = []
  const fetcher = (async (input: URL | string | Request, init?: RequestInit) => {
    const call: Call = { method: init?.method ?? 'GET', url: new URL(String(input)), body: init?.body }
    calls.push(call)
    const reply = replies.shift()
    if (!reply) throw new Error(`Unexpected call ${call.method} ${call.url}`)
    return reply(call)
  }) as typeof fetch
  return { calls, fetcher }
}

const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const graphError = (status: number, code: number, extra: Record<string, unknown> = {}) => json({ error: { message: 'boom', code, ...extra } }, status)
const timeout = () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }) }
const refused = () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }) }
const unreadable = () => new Response('not json', { status: 200 })

const metaApp: ResolvedProviderApp = { id: 'meta-test', platform: 'meta', externalAppId: '111', secret: 'app-secret-123', settings: {} }
const instagramApp: ResolvedProviderApp = { id: 'instagram-test', platform: 'instagram', externalAppId: '158', secret: 'ig-secret-123', settings: {} }
const meta = (replies: Reply[]) => {
  const { calls, fetcher } = recorder(replies)
  return { calls, adapter: new MetaAdapter({ version: 'v26.0', redirectUri: 'https://dash-api.example.com/cb', fetch: fetcher }) }
}
const instagramLogin = (replies: Reply[]) => {
  const { calls, fetcher } = recorder(replies)
  return { calls, adapter: new InstagramLoginAdapter({ version: 'v26.0', redirectUri: 'https://dash-api.example.com/ig', fetch: fetcher }) }
}

const page = { id: 'c1', kind: 'facebook_page' as const, externalId: '1000000000000101' }
const igAccount = { id: 'c2', kind: 'instagram_account' as const, externalId: '17841400000000000', handle: 'bottega' }
const sendInput = (channel: SendMessageInput['channel']): SendMessageInput => ({ channel, token: 'token-abc', recipientExternalId: '24000000000000001', text: 'Ciao Mario!' })
const since = new Date('2030-01-01T10:00:00Z')
const findInput = (channel: FindMessageInput['channel'], overrides: Partial<FindMessageInput> = {}): FindMessageInput => ({
  channel, token: 'token-abc', conversationExternalId: 't_100', text: 'Ciao  Mario!', since, excludeExternalIds: [], ...overrides })

describe('direct message keys, window and length', () => {
  it('computes the digest and request key the dashboard computes', () => {
    const digest = messageDigest({ conversationId: '0d9c8b7a-6f5e-4d3c-8b2a-1f0e9d8c7b6a', text: 'Ciao Mario!' })
    expect(digest).toBe(createHash('sha256').update('["social-message-v1","0d9c8b7a-6f5e-4d3c-8b2a-1f0e9d8c7b6a","Ciao Mario!"]').digest('hex'))
    expect(messageRequestKey('org-a', 'msg-1', 3, digest))
      .toBe(createHash('sha256').update(`["social-message-send-v1","org-a","msg-1",3,"${digest}"]`).digest('hex'))
  })

  it('keeps the window open 24 hours from the person\'s last message, closed when they never wrote', () => {
    const last = new Date('2030-01-01T10:00:00Z')
    expect(windowOpenUntil(last)).toEqual(new Date('2030-01-02T10:00:00Z'))
    expect(windowOpenUntil(null)).toBeNull()
    expect(windowOpenAt(last, new Date('2030-01-02T10:00:00Z'))).toBe(true)
    expect(windowOpenAt(last, new Date('2030-01-02T10:00:01Z'))).toBe(false)
    expect(windowOpenAt(null, last)).toBe(false)
  })

  it('counts characters on Messenger and UTF-8 bytes on Instagram', () => {
    expect(messageFits({ maxLength: 2_000, unit: 'characters' }, 'è'.repeat(2_000))).toBe(true)
    expect(messageFits({ maxLength: 2_000, unit: 'characters' }, 'x'.repeat(2_001))).toBe(false)
    expect(messageFits({ maxLength: 1_000, unit: 'bytes' }, 'x'.repeat(1_000))).toBe(true)
    // Two bytes each: 501 of them are 1,002 bytes.
    expect(messageFits({ maxLength: 1_000, unit: 'bytes' }, 'è'.repeat(501))).toBe(false)
  })

  it('backs a rate-limited channel off 15 minutes, doubling to 4 hours', () => {
    expect([1, 2, 3, 4, 5, 9].map(conversationBackoffMs).map(ms => ms / 60_000)).toEqual([15, 30, 60, 120, 240, 240])
  })

  it('keeps an attachment\'s kind and name, never its URL', () => {
    expect(attachmentOf({ mime_type: 'image/jpeg', name: 'foto.jpg', image_data: { url: 'https://cdn.example/x' } })).toEqual({ type: 'image', name: 'foto.jpg' })
    expect(attachmentOf({ video_data: { url: 'https://cdn.example/v' } })).toEqual({ type: 'video' })
    expect(attachmentOf({ mime_type: 'application/pdf', name: 'menu.pdf', file_url: 'https://cdn.example/f' })).toEqual({ type: 'file', name: 'menu.pdf' })
    expect(attachmentOf({})).toEqual({ type: 'other' })
  })
})

describe('Meta direct messages', () => {
  it('names what each kind needs', () => {
    const { adapter } = meta([])
    expect(adapter.messageRules('facebook_page')).toEqual({ platform: 'messenger', permission: 'pages_messaging', maxLength: 2_000, unit: 'characters' })
    expect(adapter.messageRules('instagram_account')).toEqual({ platform: 'instagram', permission: 'instagram_manage_messages', maxLength: 1_000, unit: 'bytes' })
    expect(instagramLogin([]).adapter.messageRules('instagram_account'))
      .toEqual({ platform: 'instagram', permission: 'instagram_business_manage_messages', maxLength: 1_000, unit: 'bytes' })
  })

  it('lists a Page\'s Messenger conversations with the other participant', async () => {
    const { adapter, calls } = meta([json({ data: [
      { id: 't_100', updated_time: '2030-01-01T10:05:00+0000', participants: { data: [{ id: page.externalId, name: 'Bottega' },
        { id: '24000000000000001', name: 'Mario Rossi', email: 'x@facebook.com' }] } },
      { id: 't_bad=', updated_time: '2030-01-01T10:00:00+0000' },
      { id: 't_101', updated_time: 'not a time' },
    ], paging: { cursors: { after: 'n1' } } })])
    expect(await adapter.conversations(metaApp, { channel: page, token: 'token-abc' })).toEqual({ kind: 'ok', conversations: [
      { externalId: 't_100', updatedAt: new Date('2030-01-01T10:05:00Z'), participant: { externalId: '24000000000000001', name: 'Mario Rossi', username: null } }] })
    expect(calls[0]!.url.pathname).toBe(`/v26.0/${page.externalId}/conversations`)
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toMatchObject({ platform: 'messenger', fields: 'id,updated_time,participants', limit: '25' })
    expect(calls[0]!.url.searchParams.get('appsecret_proof')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('lists a Page-linked Instagram account\'s conversations through the Page token', async () => {
    const { adapter, calls } = meta([json({ data: [{ id: 'aWdfZAG06', updated_time: '2030-01-01T10:05:00+0000',
      participants: { data: [{ id: igAccount.externalId, username: 'bottega' }, { id: '5500', username: 'mario.rossi' }] } }] })])
    expect(await adapter.conversations(metaApp, { channel: igAccount, token: 'token-abc' })).toMatchObject({ kind: 'ok', conversations: [
      { externalId: 'aWdfZAG06', participant: { externalId: '5500', name: null, username: 'mario.rossi' } }] })
    expect(calls[0]!.url.pathname).toBe('/v26.0/me/conversations')
    expect(calls[0]!.url.searchParams.get('platform')).toBe('instagram')
  })

  it('reports a refused read as unavailable and a rate limit as RateLimited', async () => {
    expect(await meta([graphError(403, 230, { message: 'Requires pages_messaging permission' })]).adapter.conversations(metaApp, { channel: page, token: 't' }))
      .toMatchObject({ kind: 'unavailable', reason: expect.stringContaining('pages_messaging') })
    expect(await meta([graphError(400, 100, { message: 'Unsupported get request' })]).adapter.conversations(metaApp, { channel: igAccount, token: 't' }))
      .toMatchObject({ kind: 'unavailable', reason: expect.stringContaining('Unsupported get request') })
    for (const code of [4, 17, 32, 613, 80006]) {
      await expect(meta([graphError(400, code)]).adapter.conversations(metaApp, { channel: page, token: 't' })).rejects.toBeInstanceOf(RateLimited)
    }
    await expect(meta([json({ data: 'nope' })]).adapter.conversations(metaApp, { channel: page, token: 't' })).rejects.toThrow()
  })

  it('reads a conversation\'s newest 20 messages, telling the brand\'s own and dropping attachment URLs', async () => {
    const { adapter, calls } = meta([json({ id: 't_100', messages: { data: [
      { id: 'm_2', created_time: '2030-01-01T10:05:00+0000', from: { id: page.externalId, name: 'Bottega' }, message: 'Ciao Mario!' },
      { id: 'm_1', created_time: '2030-01-01T10:04:00+0000', from: { id: '24000000000000001', name: 'Mario' }, message: 'Siete aperti?',
        attachments: { data: [{ mime_type: 'image/png', name: 'menu.png', image_data: { url: 'https://scontent.example/menu.png' } }] } },
    ] } })])
    const messages = await adapter.conversationMessages(metaApp, { channel: page, token: 'token-abc', conversationExternalId: 't_100' })
    expect(messages).toEqual([
      { externalId: 'm_2', fromChannel: true, text: 'Ciao Mario!', attachments: [], sentAt: new Date('2030-01-01T10:05:00Z') },
      { externalId: 'm_1', fromChannel: false, text: 'Siete aperti?', attachments: [{ type: 'image', name: 'menu.png' }], sentAt: new Date('2030-01-01T10:04:00Z') },
    ])
    expect(JSON.stringify(messages)).not.toContain('scontent')
    expect(calls[0]!.url.pathname).toBe('/v26.0/t_100')
    expect(calls[0]!.url.searchParams.get('fields')).toBe('messages.limit(20){id,created_time,from,to,message,attachments}')
    // An Instagram message from the account's own username is the brand's even without its ID.
    const instagram = meta([json({ messages: { data: [{ id: 'aWdf1', created_time: '2030-01-01T10:05:00+0000', from: { username: 'Bottega', id: '999' }, message: 'Ciao' }] } })])
    expect((await instagram.adapter.conversationMessages(metaApp, { channel: igAccount, token: 't', conversationExternalId: 'aWdfZAG06' }))[0]!.fromChannel).toBe(true)
  })

  it('sends one RESPONSE message from the Page, or through /me for Instagram', async () => {
    const { adapter, calls } = meta([json({ recipient_id: '24000000000000001', message_id: 'm_9' }), json({ recipient_id: '5500', message_id: 'aWdf9' })])
    expect(await adapter.sendMessage(metaApp, sendInput(page))).toEqual({ kind: 'sent', externalId: 'm_9' })
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.url.pathname).toBe(`/v26.0/${page.externalId}/messages`)
    const body = calls[0]!.body as URLSearchParams
    expect(JSON.parse(body.get('recipient')!)).toEqual({ id: '24000000000000001' })
    expect(JSON.parse(body.get('message')!)).toEqual({ text: 'Ciao Mario!' })
    expect(body.get('messaging_type')).toBe('RESPONSE')
    expect(body.get('appsecret_proof')).toMatch(/^[0-9a-f]{64}$/)
    expect(await adapter.sendMessage(metaApp, sendInput(igAccount))).toEqual({ kind: 'sent', externalId: 'aWdf9' })
    expect(calls[1]!.url.pathname).toBe('/v26.0/me/messages')
  })

  it('is uncertain only when the message may exist, and tells the window, permissions and rate limits apart', async () => {
    const requires = (permission: string) => ({ message: `(#200) Requires ${permission} permission` })
    const cases: Array<[Reply, Record<string, unknown>]> = [
      [timeout, { kind: 'uncertain', code: 'response_lost' }],
      [unreadable, { kind: 'uncertain', code: 'response_lost' }],
      [json({ unexpected: true }), { kind: 'uncertain', code: 'unexpected_response' }],
      [graphError(500, 2, { is_transient: true }), { kind: 'uncertain', code: 'platform_error' }],
      [refused, { kind: 'failed', retryable: true, code: 'unreachable' }],
      [graphError(400, 10, { error_subcode: 2018278 }), { kind: 'failed', retryable: false, code: 'outside_window' }],
      [graphError(400, 10, { error_subcode: 2534022 }), { kind: 'failed', retryable: false, code: 'outside_window' }],
      [graphError(403, 200, requires('pages_messaging')), { kind: 'failed', retryable: false, code: 'missing_permission', permission: 'pages_messaging' }],
      [graphError(403, 10), { kind: 'failed', retryable: false, code: 'message_not_allowed' }],
      [graphError(400, 551), { kind: 'failed', retryable: false, code: 'recipient_unavailable' }],
      [graphError(400, 100, { error_subcode: 2018001 }), { kind: 'failed', retryable: false, code: 'recipient_unavailable' }],
      [graphError(401, 190), { kind: 'failed', retryable: false, code: 'channel_inactive', reauth: true }],
      [graphError(400, 368), { kind: 'failed', retryable: false, code: 'rejected' }],
    ]
    for (const code of [4, 17, 32, 613, 80006]) cases.push([graphError(400, code), { kind: 'failed', retryable: true, code: 'rate_limited' }])
    for (const [reply, expected] of cases) {
      expect(await meta([reply]).adapter.sendMessage(metaApp, sendInput(page))).toMatchObject(expected)
    }
    expect(await meta([graphError(403, 10, { message: 'Requires instagram_manage_messages permission' })]).adapter.sendMessage(metaApp, sendInput(igAccount)))
      .toMatchObject({ code: 'missing_permission', permission: 'instagram_manage_messages' })
  })

  it('finds the brand\'s own message with the same text since the attempt, for an uncertain send', async () => {
    const thread = (data: unknown[]) => json({ messages: { data } })
    const mine = { id: 'm_9', created_time: '2030-01-01T10:01:00+0000', from: { id: page.externalId }, message: 'Ciao Mario!\n' }
    expect(await meta([thread([mine, { ...mine, id: 'm_8', from: { id: '2400' } }])]).adapter.findMessage(metaApp, findInput(page)))
      .toEqual({ kind: 'found', externalId: 'm_9' })
    expect(await meta([thread([mine])]).adapter.findMessage(metaApp, findInput(page, { excludeExternalIds: ['m_9'] }))).toEqual({ kind: 'not_found' })
    expect(await meta([thread([{ ...mine, created_time: '2030-01-01T09:59:00+0000' }])]).adapter.findMessage(metaApp, findInput(page))).toEqual({ kind: 'not_found' })
    expect(await meta([thread([mine, { ...mine, id: 'm_10' }])]).adapter.findMessage(metaApp, findInput(page))).toMatchObject({ kind: 'ambiguous' })
    await expect(meta([graphError(400, 613)]).adapter.findMessage(metaApp, findInput(page))).rejects.toBeInstanceOf(RateLimited)
  })
})

describe('Instagram login direct messages', () => {
  it('reads and sends on graph.instagram.com with the account token and names its own permission', async () => {
    const { adapter, calls } = instagramLogin([
      json({ data: [{ id: 'aWdfZAG06', updated_time: '2030-01-01T10:05:00+0000', participants: { data: [{ id: igAccount.externalId, username: 'bottega' },
        { id: '5500', username: 'mario.rossi' }] } }] }),
      json({ message_id: 'aWdf9' }),
      graphError(403, 10, { message: 'Requires instagram_business_manage_messages permission' }),
    ])
    expect(await adapter.conversations(instagramApp, { channel: igAccount, token: 'ig-token' })).toMatchObject({ kind: 'ok', conversations: [{ externalId: 'aWdfZAG06' }] })
    expect(calls[0]!.url.href.startsWith('https://graph.instagram.com/v26.0/me/conversations')).toBe(true)
    expect(calls[0]!.url.searchParams.get('platform')).toBe('instagram')
    expect(await adapter.sendMessage(instagramApp, sendInput(igAccount))).toEqual({ kind: 'sent', externalId: 'aWdf9' })
    expect(calls[1]!.url.href).toBe('https://graph.instagram.com/v26.0/me/messages')
    expect((calls[1]!.body as URLSearchParams).has('appsecret_proof')).toBe(false)
    expect(await adapter.sendMessage(instagramApp, sendInput(igAccount))).toMatchObject({ code: 'missing_permission', permission: 'instagram_business_manage_messages' })
  })
})
