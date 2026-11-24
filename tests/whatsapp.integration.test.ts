import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { eq } from 'drizzle-orm'
import { toNodeListener } from 'h3'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { DecisionModel } from '../src/answering/decision.js'
import type { DraftInput, DraftModel } from '../src/answering/drafting.js'
import { runAnswering } from '../src/answering/pipeline.js'
import { putAnswering } from '../src/answering/settings.js'
import { finishConnect, listChannels, startConnect } from '../src/channels.js'
import type { EngineContext } from '../src/context.js'
import { enableControlEvents } from '../src/control-events.js'
import { collectDueConversations, getConversation, listConversationMessages, listConversations } from '../src/conversations.js'
import type { Database } from '../src/db/client.js'
import {
  channels, controlEvents, conversationChecks, conversations, directMessages, inboundDrafts, outgoingMessages, providerApps, webhookDeliveries,
} from '../src/db/schema.js'
import { createEngineApp } from '../src/http/app.js'
import { listOutgoingMessages, messageDigest, messageRequestKey, runMessages, submitMessage, type MessageSubmission } from '../src/messages.js'
import { WhatsAppAdapter } from '../src/platforms/whatsapp/adapter.js'
import { createWebhook } from '../src/webhooks.js'
import { connectWhatsAppNumber, readAttachment, receiveWhatsAppNotification } from '../src/whatsapp.js'
import { postgresFixture } from './fixtures/postgres.js'

const required = process.env.REQUIRE_DATABASE_TESTS === 'true'
const minute = 60_000
const hour = 60 * minute
const wabaId = '102290129340398'
const numberId = '106540352242922'
const appSecret = 'whatsapp-app-secret'
const phone = '393401234567'
const userId = 'IT.13491208655302741918'

/**
 * A fake WhatsApp Cloud API behind the real adapter: it answers the
 * connect, takes messages (or fails them as a test asks), and serves media.
 */
class FakeCloudApi {
  sent: Array<Record<string, unknown>> = []
  reads: string[] = []
  next = 0
  /** What the next message send does instead of succeeding. */
  sendFails?: 'timeout' | { status: number, code: number }
  media = new Map<string, Buffer>()

  readonly fetch = (async (input: URL | string | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const path = url.pathname.replace(/^\/v\d+\.\d+/, '')
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (url.hostname === 'lookaside.fbsbx.com') {
      const bytes = this.media.get(url.searchParams.get('mid') ?? '')
      return bytes ? new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-length': String(bytes.length) } }) : new Response('', { status: 404 })
    }
    if (path === '/oauth/access_token') return reply({ access_token: 'system-user-token' })
    if (path === '/debug_token') {
      return reply({ data: { scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'],
        granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: [wabaId] }] } })
    }
    if (path === `/${wabaId}/phone_numbers`) return reply({ data: [{ id: numberId, display_phone_number: '+39 02 1234 5678', verified_name: 'Bottega' }] })
    if (path === `/${wabaId}/subscribed_apps`) return reply({ success: true })
    if (path === `/${numberId}/messages`) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      if (body.status === 'read') {
        this.reads.push(String(body.message_id))
        return reply({ success: true })
      }
      this.sent.push(body)
      const failure = this.sendFails
      this.sendFails = undefined
      if (failure === 'timeout') throw Object.assign(new Error('timed out'), { name: 'TimeoutError' })
      if (failure) return reply({ error: { message: 'refused', code: failure.code } }, failure.status)
      return reply({ messaging_product: 'whatsapp', messages: [{ id: `wamid.OUT${++this.next}` }] })
    }
    const media = /^\/(\d+)$/.exec(path)
    if (media && this.media.has(media[1]!)) {
      return reply({ url: `https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=${media[1]}`, mime_type: 'image/jpeg', file_size: this.media.get(media[1]!)!.length })
    }
    return reply({ error: { message: `Unknown path ${path}`, code: 100 } }, 404)
  }) as typeof fetch
}

/** Meta's notification for this number, as raw bytes, and its signature with the given secret. */
function signed(value: Record<string, unknown>, secret = appSecret, options: { waba?: string, number?: string } = {}) {
  const body = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: options.waba ?? wabaId, changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { display_phone_number: '390212345678', phone_number_id: options.number ?? numberId }, ...value } }] }] }))
  return { body, signature: `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` }
}

const unix = (date: Date) => String(Math.floor(date.getTime() / 1000))

describe.skipIf(!required)('WhatsApp on PostgreSQL 17', { timeout: 60_000 }, () => {
  let fixture: Awaited<ReturnType<typeof postgresFixture>>
  let db: Database
  let api: FakeCloudApi
  let context: EngineContext
  let now: Date
  let org: string
  let wamid = 0

  beforeAll(async () => {
    fixture = await postgresFixture()
    db = fixture.db
    await db.insert(providerApps).values({ id: 'whatsapp-agency', platform: 'whatsapp', externalAppId: '111', ownerKind: 'agency', secretRef: 'whatsapp-agency',
      settings: { configId: '987' } })
  }, 180_000)
  afterAll(async () => { await fixture?.cleanup() }, 30_000)

  beforeEach(async () => {
    await fixture.migrator.query('truncate inbound_drafts, control_events, answering_settings, outgoing_message_cancellations, outgoing_messages, direct_messages, conversations, conversation_checks, channel_activity, webhook_deliveries, webhooks, replies, reply_cancellations, post_metric_samples, channel_metric_samples, channel_metrics, post_responses, response_checks, post_metrics, attempts, jobs, events, media_chunks, media, oauth_states, channel_credentials, channels, publishing_controls, browser_accounts')
    now = new Date('2030-01-01T10:00:00Z')
    org = `org-${randomUUID()}`
    api = new FakeCloudApi()
    context = { db, adapters: new Map([['whatsapp', new WhatsAppAdapter({ version: 'v26.0', redirectUri: 'https://dash-api.example.com/cb', fetch: api.fetch })]]),
      keyring: { activeKeyId: 'k1', keys: new Map([['k1', randomBytes(32)]]) }, providerSecrets: new Map([['whatsapp-agency', appSecret]]), now: () => now }
    enableControlEvents(true)
  })

  const advance = (ms: number) => { now = new Date(now.getTime() + ms) }

  async function connect(organizationId = org) {
    const { state } = await startConnect(context, organizationId, 'whatsapp-agency')
    return (await finishConnect(context, organizationId, state, 'code')).channels[0]!
  }

  /** The person writes now: one text message, signed by the channel's app. */
  function inbound(text: string, options: { from?: string | null, user?: string | null, name?: string, at?: Date, id?: string } = {}) {
    const from = options.from === undefined ? phone : options.from
    const user = options.user === undefined ? userId : options.user
    return signed({
      contacts: [{ profile: { name: options.name ?? 'Mario Rossi' }, ...(from ? { wa_id: from } : {}), ...(user ? { user_id: user } : {}) }],
      messages: [{ ...(from ? { from } : {}), ...(user ? { from_user_id: user } : {}), id: options.id ?? `wamid.IN${++wamid}`, timestamp: unix(options.at ?? now),
        type: 'text', text: { body: text } }],
    })
  }
  const receive = (notification: { body: Buffer, signature: string }) => receiveWhatsAppNotification(context, notification.body, notification.signature)

  function messageFor(conversationId: string, text = 'Sì, fino alle 19.'): MessageSubmission {
    const messageId = randomUUID()
    const digest = messageDigest({ conversationId, text })
    return { requestKey: messageRequestKey(org, messageId, 1, digest), messageId, revision: 1, digest, conversationId, text,
      approvedByUserId: 'user-1', approvedAt: now.toISOString(), sendAt: now.toISOString() }
  }
  const outgoing = async (id: string) => (await db.select().from(outgoingMessages).where(eq(outgoingMessages.id, id)))[0]!

  it('connects each number of the granted business account as a message-only channel, never synced', async () => {
    const channel = await connect()
    expect(channel).toMatchObject({ platform: 'whatsapp', kind: 'whatsapp_number', externalId: numberId, name: 'Bottega (+39 02 1234 5678)', status: 'active',
      maxLength: 4_096, maxMedia: 0, messages: { available: true, maxLength: 4_096 }, replies: { available: false, reason: 'not_supported' } })
    expect((await db.select().from(channels))[0]).toMatchObject({ parentExternalId: wabaId,
      grantedScopes: ['whatsapp_business_management', 'whatsapp_business_messaging'] })
    expect(await db.select().from(conversationChecks)).toEqual([])
    expect(await collectDueConversations(context)).toEqual({ synced: 0, failed: 0 })
  })

  it('stores a signed message once, opens the window, and tells webhooks once', async () => {
    const channel = await connect()
    await createWebhook(context, org, { url: 'https://hooks.example.com/x', eventTypes: ['message.received'], channelIds: null, description: null })
    const notification = inbound('Siete aperti domenica?')
    expect(await receive(notification)).toEqual({ stored: 1, statuses: 0, ignored: 0 })
    // Meta delivers it again (a retry): nothing changes.
    expect(await receive(notification)).toEqual({ stored: 0, statuses: 0, ignored: 0 })
    const { conversations: [conversation] } = await listConversations(context, org, { limit: 10 })
    expect(conversation).toEqual({ id: expect.any(String), channelId: channel.id, platform: 'whatsapp',
      participant: { name: 'Mario Rossi', username: null, phone: `+${phone}` }, lastMessageAt: now.toISOString(), lastInboundAt: now.toISOString(),
      windowOpenUntil: new Date(now.getTime() + 24 * hour).toISOString(), lastMessage: { direction: 'in', text: 'Siete aperti domenica?', sentAt: now.toISOString() } })
    expect((await db.select().from(conversations))[0]).toMatchObject({ externalId: userId, participantExternalId: phone })
    expect((await db.select().from(webhookDeliveries)).map(row => row.payload)).toEqual([{ type: 'message.received', timestamp: now.toISOString(),
      data: { organizationId: org, channelId: channel.id, conversationId: conversation!.id, messageId: expect.any(String), platform: 'whatsapp',
        participant: { name: 'Mario Rossi', username: null }, text: 'Siete aperti domenica?', attachments: [], sentAt: now.toISOString() } }])
  })

  it('ignores a wrong signature, an unknown number and another business account', async () => {
    await connect()
    const forged = inbound('Pagami qui', {})
    expect(await receiveWhatsAppNotification(context, forged.body, signed({}, 'another-secret').signature)).toEqual({ stored: 0, statuses: 0, ignored: 1 })
    expect(await receiveWhatsAppNotification(context, forged.body, undefined)).toEqual({ stored: 0, statuses: 0, ignored: 1 })
    const unknown = signed({ messages: [{ from: phone, id: 'wamid.X1', timestamp: unix(now), type: 'text', text: { body: 'x' } }] }, appSecret, { number: '1999' })
    expect(await receive(unknown)).toEqual({ stored: 0, statuses: 0, ignored: 1 })
    const otherAccount = signed({ messages: [{ from: phone, id: 'wamid.X2', timestamp: unix(now), type: 'text', text: { body: 'x' } }] }, appSecret, { waba: '555' })
    expect(await receive(otherAccount)).toEqual({ stored: 0, statuses: 0, ignored: 1 })
    expect(await receiveWhatsAppNotification(context, Buffer.from('not json'), undefined)).toEqual({ stored: 0, statuses: 0, ignored: 1 })
    expect(await db.select().from(directMessages)).toEqual([])
  })

  it('keeps one conversation per person, by user ID or by the phone number Meta gave first', async () => {
    await connect()
    await receive(inbound('Prima', { user: null }))
    advance(minute)
    // Later Meta names the same person by business-scoped user ID too; the phone-keyed conversation stays theirs.
    await receive(inbound('Seconda', { name: 'Mario R.' }))
    advance(minute)
    // A person with a username and no phone number.
    await receive(inbound('Ciao', { from: null, user: 'IT.99', name: 'Anna' }))
    const rows = await db.select().from(conversations)
    expect(rows.map(row => [row.externalId, row.participantExternalId, row.participantName]).sort()).toEqual([
      [phone, phone, 'Mario R.'], ['IT.99', 'IT.99', 'Anna']].sort())
    const anna = rows.find(row => row.externalId === 'IT.99')!
    expect((await getConversation(context, org, anna.id)).conversation.participant).toEqual({ name: 'Anna', username: null })
  })

  it('does not store messages past retention, and an older retry does not move the window back', async () => {
    await connect()
    await receive(inbound('Recente'))
    await receive(inbound('Vecchio', { at: new Date(now.getTime() - 2 * hour) }))
    await receive(inbound('Antichissimo', { at: new Date(now.getTime() - 200 * 24 * hour) }))
    const [conversation] = await db.select().from(conversations)
    expect(conversation!.lastInboundAt).toEqual(now)
    expect((await db.select().from(directMessages)).map(row => row.text).sort()).toEqual(['Recente', 'Vecchio'])
  })

  it('sends inside the window, tagged, records it in the thread, marks the person\'s message read and follows its statuses', async () => {
    await connect()
    await createWebhook(context, org, { url: 'https://hooks.example.com/x', eventTypes: ['message.sent'], channelIds: null, description: null })
    await receive(inbound('Siete aperti domenica?', { id: 'wamid.ASK' }))
    const [conversation] = await db.select().from(conversations)
    advance(minute)
    const { message } = await submitMessage(context, org, messageFor(conversation!.id))
    expect(await runMessages(context)).toMatchObject({ sent: 1 })
    expect(api.sent).toEqual([{ messaging_product: 'whatsapp', recipient_type: 'individual', to: phone, type: 'text',
      text: { body: 'Sì, fino alle 19.', preview_url: false }, biz_opaque_callback_data: message.id }])
    expect(api.reads).toEqual(['wamid.ASK'])
    expect(await outgoing(message.id!)).toMatchObject({ state: 'sent', platformMessageId: 'wamid.OUT1', deliveryStatus: null })
    const thread = await listConversationMessages(context, org, conversation!.id, { limit: 10 })
    expect(thread.messages.map(item => [item.direction, item.text, item.outgoingKey ?? null])).toEqual([
      ['out', 'Sì, fino alle 19.', message.requestKey], ['in', 'Siete aperti domenica?', null]])
    expect((await db.select().from(webhookDeliveries)).map(row => row.payload.type)).toEqual(['message.sent'])

    const status = (state: string, at: Date, extra: Record<string, unknown> = {}) => signed({ statuses: [{ id: 'wamid.OUT1', status: state,
      timestamp: unix(at), recipient_id: phone, ...extra }] })
    await db.delete(controlEvents)
    expect(await receive(status('delivered', now))).toEqual({ stored: 0, statuses: 1, ignored: 0 })
    expect(await receive(status('read', new Date(now.getTime() + 1_000)))).toEqual({ stored: 0, statuses: 1, ignored: 0 })
    // Statuses only move forward: a late `sent` changes nothing.
    expect(await receive(status('sent', new Date(now.getTime() - 1_000), { biz_opaque_callback_data: message.id }))).toEqual({ stored: 0, statuses: 0, ignored: 0 })
    const [view] = await listOutgoingMessages(context, org, { conversationId: conversation!.id, limit: 10 })
    expect(view).toMatchObject({ state: 'sent', deliveryStatus: 'read', deliveryErrorCode: null, deliveryUpdatedAt: new Date(now.getTime() + 1_000).toISOString() })
    expect(await db.select().from(controlEvents)).toMatchObject([{ type: 'messages.changed', organizationId: org }])
  })

  it('reports a delivery that failed after Meta accepted the message', async () => {
    await connect()
    await receive(inbound('Ciao'))
    const [conversation] = await db.select().from(conversations)
    const { message } = await submitMessage(context, org, messageFor(conversation!.id))
    await runMessages(context)
    await receive(signed({ statuses: [{ id: 'wamid.OUT1', status: 'failed', timestamp: unix(now), recipient_id: phone, biz_opaque_callback_data: message.id,
      errors: [{ code: 131026, title: 'Message undeliverable' }] }] }))
    expect(await outgoing(message.id!)).toMatchObject({ state: 'sent', deliveryStatus: 'failed', deliveryErrorCode: 'recipient_unavailable' })
  })

  it('refuses a send outside the 24-hour window and says a template is needed', async () => {
    await connect()
    await receive(inbound('Ciao'))
    const [conversation] = await db.select().from(conversations)
    advance(25 * hour)
    await expect(submitMessage(context, org, messageFor(conversation!.id))).rejects.toMatchObject({ status: 409, code: 'outside_window',
      detail: { windowOpenUntil: new Date(now.getTime() - hour).toISOString(), templateRequired: true } })
  })

  it('fails a send Meta refuses for the closed window, without retrying', async () => {
    await connect()
    await receive(inbound('Ciao'))
    const [conversation] = await db.select().from(conversations)
    const { message } = await submitMessage(context, org, messageFor(conversation!.id))
    api.sendFails = { status: 400, code: 131047 }
    await runMessages(context)
    expect(await outgoing(message.id!)).toMatchObject({ state: 'failed', errorCode: 'outside_window', errorDetail: 'Meta 131047 (HTTP 400): refused', attemptCount: 1 })
    const [view] = await listOutgoingMessages(context, org, { conversationId: conversation!.id, limit: 10 })
    expect(view).toMatchObject({ errorCode: 'outside_window', errorDetail: 'Meta 131047 (HTTP 400): refused' })
    expect(api.sent).toHaveLength(1)
  })

  it('settles an uncertain send from its status report, without reading the platform', async () => {
    await connect()
    await receive(inbound('Ciao'))
    const [conversation] = await db.select().from(conversations)
    const { message } = await submitMessage(context, org, messageFor(conversation!.id))
    api.sendFails = 'timeout'
    await runMessages(context)
    expect(await outgoing(message.id!)).toMatchObject({ state: 'uncertain', errorCode: 'response_lost', reconciling: true })
    // Without a report, a look finds nothing.
    advance(minute)
    await runMessages(context)
    expect(await outgoing(message.id!)).toMatchObject({ state: 'uncertain', reconcileMisses: 1 })
    // Meta's `sent` status names the engine's outgoing ID: the next look settles it at once.
    await receive(signed({ statuses: [{ id: 'wamid.LOST', status: 'sent', timestamp: unix(now), recipient_id: phone, biz_opaque_callback_data: message.id }] }))
    expect(await outgoing(message.id!)).toMatchObject({ state: 'uncertain', reportedMessageId: 'wamid.LOST', deliveryStatus: 'sent' })
    await runMessages(context)
    expect(await outgoing(message.id!)).toMatchObject({ state: 'sent', platformMessageId: 'wamid.LOST', settledBy: 'reconcile', reconciling: false })
    expect((await db.select().from(directMessages).where(eq(directMessages.direction, 'out'))).map(row => row.externalId)).toEqual(['wamid.LOST'])
    expect(api.sent).toHaveLength(1)
  })

  it('reads a received attachment from Meta on request, for its own tenant only', async () => {
    await connect()
    api.media.set('1003383421387256', Buffer.from('jpeg-bytes'))
    await receive(signed({ contacts: [{ profile: { name: 'Mario' }, wa_id: phone }], messages: [{ from: phone, id: 'wamid.IMG', timestamp: unix(now), type: 'image',
      image: { id: '1003383421387256', mime_type: 'image/jpeg', caption: 'Questo?' } }] }))
    const [stored] = await db.select().from(directMessages)
    expect(stored).toMatchObject({ text: 'Questo?', attachments: [{ type: 'image', mediaId: '1003383421387256', mimeType: 'image/jpeg' }] })
    const file = await readAttachment(context, org, stored!.conversationId, stored!.id, 0)
    expect(file).toMatchObject({ mimeType: 'image/jpeg', sizeBytes: 10 })
    expect(Buffer.from(await new Response(file.body).arrayBuffer()).toString()).toBe('jpeg-bytes')
    await expect(readAttachment(context, 'other-org', stored!.conversationId, stored!.id, 0)).rejects.toMatchObject({ code: 'not_found' })
    await expect(readAttachment(context, org, stored!.conversationId, stored!.id, 1)).rejects.toMatchObject({ code: 'not_found' })
    api.media.clear()
    await expect(readAttachment(context, org, stored!.conversationId, stored!.id, 0)).rejects.toMatchObject({ code: 'media_gone' })
  })

  it('connects a number by hand with an operator\'s token', async () => {
    const { channels: [channel] } = await connectWhatsAppNumber(context, org, { providerAppId: 'whatsapp-agency', businessAccountId: wabaId, phoneNumberId: numberId,
      token: 'operator-system-user-token-0123456789' })
    expect(channel).toMatchObject({ platform: 'whatsapp', kind: 'whatsapp_number', externalId: numberId, messages: { available: true } })
    await expect(connectWhatsAppNumber(context, org, { providerAppId: 'whatsapp-agency', businessAccountId: wabaId, phoneNumberId: '999',
      token: 'operator-system-user-token-0123456789' })).rejects.toMatchObject({ code: 'number_not_in_account' })
    expect(await listChannels(context, org)).toHaveLength(1)
  })

  it('decides and drafts WhatsApp messages like any direct message, within 4,096 characters', async () => {
    await connect()
    const inputs: DraftInput[] = []
    const decisionModel: DecisionModel = { async decide() { return { model: 'd1.1-test', choice: 'draft', probabilities: { full: 0.1, draft: 0.8, none: 0.1 }, confidence: 0.8, cost: 0 } } }
    const draftModel: DraftModel = { async draft(input) {
      inputs.push(input)
      return { model: 'claude-haiku-5-5', output: { needsReply: true, reply: 'Sì, fino alle 19.', language: 'it', summary: 'Orari.', flags: [] } }
    } }
    context = { ...context, decisionModel, draftModel }
    await putAnswering(context, org, { version: 1, settings: { enabled: false, drafts: true, kinds: { messages: true, comments: false }, decisionModel: 'd1.1',
      decisionPrompt: 'Answer opening hours.', decisionThreshold: 0.9, noneThreshold: 0.8, replyModel: 'haiku', voice: '', replyContext: '', delaySeconds: 120, cases: [] },
    context: [] })
    advance(1_000)
    await receive(inbound('Siete aperti domenica?'))
    expect(await runAnswering(context)).toEqual({ drafted: 1, failed: 0 })
    expect(inputs[0]).toMatchObject({ kind: 'message', channel: { platform: 'whatsapp' }, maxLength: { value: 4_096, unit: 'characters' } })
    expect(await db.select().from(inboundDrafts)).toMatchObject([{ kind: 'message', outcome: 'review', draftText: 'Sì, fino alle 19.' }])
  })

  it('takes notifications over HTTP with Meta\'s signature header', async () => {
    await connect()
    const token = 's'.repeat(48)
    const server = createServer(toNodeListener(createEngineApp(context, token)))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      const notification = inbound('Ciao')
      const post = (headers: Record<string, string>) => fetch(`${base}/v1/whatsapp/notifications`, { method: 'POST', body: notification.body,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers } })
      const accepted = await post({ 'x-hub-signature-256': notification.signature })
      expect({ status: accepted.status, body: await accepted.json() }).toEqual({ status: 200, body: { stored: 1, statuses: 0, ignored: 0 } })
      const forged = await post({ 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) })
      expect(await forged.json()).toEqual({ stored: 0, statuses: 0, ignored: 1 })
      expect((await fetch(`${base}/v1/whatsapp/notifications`, { method: 'POST', body: notification.body, headers: { 'content-type': 'application/json' } })).status).toBe(401)
      const [message] = await db.select().from(directMessages)
      const attachment = await fetch(`${base}/v1/tenants/${org}/conversations/${message!.conversationId}/messages/${message!.id}/attachments/0`,
        { headers: { authorization: `Bearer ${token}` } })
      expect(attachment.status).toBe(404)
    } finally {
      server.close()
    }
  })
})
