import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { eq } from 'drizzle-orm'
import { toNodeListener } from 'h3'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { disableChannel, finishConnect, listChannels, setPublishing, startConnect } from '../src/channels.js'
import type { EngineContext } from '../src/context.js'
import {
  collectDueConversations, listConversationMessages, listConversations, notifyMeta, requestConversationSync,
} from '../src/conversations.js'
import type { Database } from '../src/db/client.js'
import {
  channels, conversationChecks, conversations, directMessages, events, outgoingMessageCancellations, outgoingMessages, providerApps, webhookDeliveries,
} from '../src/db/schema.js'
import { createEngineApp } from '../src/http/app.js'
import {
  cancelMessage, claimNextMessage, executeMessage, listOutgoingMessages, messageDigest, messageReconcileDelaysMs, messageRequestKey, reconcileDueMessages,
  resolveMessage, runMessages, submitMessage, sweepMessages, type MessageSubmission,
} from '../src/messages.js'
import { pickOwnReply } from '../src/platforms/reply-match.js'
import {
  RateLimited, type ConnectedAccount, type ConversationMessagesInput, type ConversationsResult, type FindMessageInput, type PlatformAdapter,
  type PlatformConversation, type PlatformMessage, type SendMessageInput, type SendMessageOutcome,
} from '../src/platforms/types.js'
import { applyRetention } from '../src/retention.js'
import { createWebhook } from '../src/webhooks.js'
import { postgresFixture } from './fixtures/postgres.js'

const required = process.env.REQUIRE_DATABASE_TESTS === 'true'
const minute = 60_000
const hour = 60 * minute
const day = 24 * hour
const person = '24000000000000001'

/** A fake Messenger: it holds conversations, takes messages and lists them back, like the Graph API does. */
class FakeMessenger implements PlatformAdapter {
  readonly platform = 'meta' as const
  accounts: ConnectedAccount[] = []
  threads: Array<{ conversation: PlatformConversation, messages: PlatformMessage[] }> = []
  sendCalls: SendMessageInput[] = []
  findCalls: FindMessageInput[] = []
  readCalls: ConversationMessagesInput[] = []
  listCalls = 0
  sendWith?: (input: SendMessageInput) => Promise<SendMessageOutcome>
  listWith?: () => Promise<ConversationsResult>
  private next = 0

  constructor(private readonly now: () => Date) {}
  authorizeUrl(_app: unknown, state: string) { return `https://example.test/oauth?state=${state}` }
  async finishConnect() { return this.accounts }
  limits() { return { maxLength: 100, maxMedia: 2 } }
  validateSettings() {}
  async publish() { return { kind: 'published' as const, externalId: 'post-1' } }
  async reconcile() { return { kind: 'not_found' as const } }
  // Replies are here only so a refused reply permission can be told apart from a messaging one.
  replyRules() { return { permission: 'pages_manage_engagement', maxLength: 50 } }
  async reply() { return { kind: 'sent' as const, externalId: 'reply-1' } }
  messageRules(kind: string) { return kind === 'facebook_page' ? { platform: 'messenger' as const, permission: 'pages_messaging', maxLength: 50, unit: 'characters' as const } : null }

  /** The person writes in their conversation (the first one by default). */
  inbound(text: string, conversation = 't_1') {
    const at = this.now()
    let thread = this.threads.find(value => value.conversation.externalId === conversation)
    if (!thread) {
      thread = { conversation: { externalId: conversation, updatedAt: at, participant: { externalId: person, name: 'Mario Rossi', username: null } }, messages: [] }
      this.threads.push(thread)
    }
    thread.messages.push({ externalId: `m_${++this.next}`, fromChannel: false, text, attachments: [], sentAt: at })
    thread.conversation.updatedAt = at
  }
  /** Meta stores the brand's message; its answer may still be lost on the way back. */
  create(text: string, conversation = 't_1') {
    const thread = this.threads.find(value => value.conversation.externalId === conversation)!
    const message = { externalId: `m_${++this.next}`, fromChannel: true, text, attachments: [], sentAt: this.now() }
    thread.messages.push(message)
    thread.conversation.updatedAt = this.now()
    return message
  }
  async conversations(): Promise<ConversationsResult> {
    this.listCalls++
    if (this.listWith) return this.listWith()
    return { kind: 'ok', conversations: this.threads.map(thread => ({ ...thread.conversation })) }
  }
  async conversationMessages(_app: unknown, input: ConversationMessagesInput) {
    this.readCalls.push(input)
    const thread = this.threads.find(value => value.conversation.externalId === input.conversationExternalId)
    return [...thread?.messages ?? []].reverse().slice(0, 20)
  }
  async sendMessage(_app: unknown, input: SendMessageInput): Promise<SendMessageOutcome> {
    this.sendCalls.push(input)
    if (this.sendWith) return this.sendWith(input)
    return { kind: 'sent', externalId: this.create(input.text).externalId }
  }
  async findMessage(_app: unknown, input: FindMessageInput) {
    this.findCalls.push(input)
    const messages = await this.conversationMessages(null, input)
    return pickOwnReply(messages.map(message => ({ id: message.externalId, text: message.text, createdAt: message.sentAt.getTime(), own: message.fromChannel })), input)
  }
}

describe.skipIf(!required)('direct messages on PostgreSQL 17', { timeout: 60_000 }, () => {
  let fixture: Awaited<ReturnType<typeof postgresFixture>>
  let db: Database
  let meta: FakeMessenger
  let context: EngineContext
  let now: Date
  let org: string

  beforeAll(async () => {
    fixture = await postgresFixture()
    db = fixture.db
    await db.insert(providerApps).values({ id: 'meta-agency', platform: 'meta', externalAppId: '111', ownerKind: 'agency', secretRef: 'meta-agency' })
  }, 180_000)
  afterAll(async () => { await fixture?.cleanup() }, 30_000)

  beforeEach(async () => {
    await fixture.migrator.query('truncate learned_answers, inbound_drafts, control_events, answering_settings, outgoing_message_cancellations, outgoing_messages, direct_messages, conversations, conversation_checks, channel_activity, webhook_deliveries, webhooks, replies, reply_cancellations, post_metric_samples, channel_metric_samples, channel_metrics, post_responses, response_checks, post_metrics, attempts, jobs, events, media_chunks, media, oauth_states, channel_credentials, channels, publishing_controls, browser_accounts')
    now = new Date('2030-01-01T10:00:00Z')
    org = `org-${randomUUID()}`
    meta = new FakeMessenger(() => now)
    context = { db, adapters: new Map([['meta', meta]]), keyring: { activeKeyId: 'k1', keys: new Map([['k1', randomBytes(32)]]) },
      providerSecrets: new Map([['meta-agency', 'agency-secret']]), now: () => now }
  })

  const advance = (ms: number) => { now = new Date(now.getTime() + ms) }

  async function connect(options: { organizationId?: string, grantedScopes?: string[], externalId?: string } = {}) {
    meta.accounts = [{ kind: 'facebook_page', externalId: options.externalId ?? String(Date.now()) + String(Math.floor(Math.random() * 1e6)), name: 'Bottega',
      token: 'token-secret', tokenExpiresAt: null, ...(options.grantedScopes ? { grantedScopes: options.grantedScopes } : {}) }]
    const organizationId = options.organizationId ?? org
    const { state } = await startConnect(context, organizationId, 'meta-agency')
    return (await finishConnect(context, organizationId, state, 'code')).channels[0]!
  }

  /** A connected Page with one conversation in which Mario has just written, synced. */
  async function conversationWithInbound(options: Parameters<typeof connect>[0] = {}) {
    const channel = await connect(options)
    meta.inbound('Siete aperti domenica?')
    advance(10_000)
    await collectDueConversations(context)
    const { conversations: [conversation] } = await listConversations(context, options.organizationId ?? org, { limit: 10 })
    return { channel, conversation: conversation! }
  }

  function messageFor(conversationId: string, options: { messageId?: string, revision?: number, text?: string, organizationId?: string, sendAt?: Date } = {}): MessageSubmission {
    const messageId = options.messageId ?? randomUUID()
    const revision = options.revision ?? 1
    const text = options.text ?? 'Sì, dalle 10 alle 13!'
    const digest = messageDigest({ conversationId, text })
    return { requestKey: messageRequestKey(options.organizationId ?? org, messageId, revision, digest), messageId, revision, digest, conversationId, text,
      approvedByUserId: 'user-1', approvedAt: now.toISOString(), sendAt: (options.sendAt ?? new Date(now.getTime() + minute)).toISOString() }
  }

  const outgoing = async (requestKey: string) => (await db.select().from(outgoingMessages).where(eq(outgoingMessages.requestKey, requestKey)))[0]
  const deliveries = async () => (await db.select().from(webhookDeliveries)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map(row => row.payload)

  /** Runs every look an uncertain message gets, moving the clock to each. */
  async function reconcileAll(id: string) {
    for (let round = 0; round < 20; round++) {
      await reconcileDueMessages(context)
      const [row] = await db.select().from(outgoingMessages).where(eq(outgoingMessages.id, id))
      if (!row!.reconciling) return row!
      if (row!.notBefore.getTime() > now.getTime()) now = row!.notBefore
    }
    throw new Error('still reconciling')
  }

  it('stores the history a channel already had without telling webhooks', async () => {
    meta.inbound('Messaggio di ieri')
    advance(minute)
    const channel = await connect()
    await createWebhook(context, org, { url: 'https://hooks.example.com/x', eventTypes: ['message.received'], channelIds: null, description: null })
    advance(10_000)
    await collectDueConversations(context)
    expect((await db.select().from(directMessages)).map(row => row.text)).toEqual(['Messaggio di ieri'])
    expect(await deliveries()).toEqual([])

    advance(minute)
    meta.inbound('Siete aperti domenica?')
    await requestConversationSync(context, org, channel.id)
    await collectDueConversations(context)
    expect((await deliveries()).map(payload => payload.data.text)).toEqual(['Siete aperti domenica?'])
  })

  it('stores a new message once, tells webhooks once, and reads a conversation again only when it moved', async () => {
    const channel = await connect()
    expect(await db.select().from(conversationChecks)).toMatchObject([{ channelId: channel.id, nextCheckAt: now }])
    await createWebhook(context, org, { url: 'https://hooks.example.com/x', eventTypes: ['message.received'], channelIds: null, description: null })
    meta.inbound('Siete aperti domenica?')
    advance(10_000)
    expect(await collectDueConversations(context)).toEqual({ synced: 1, failed: 0 })
    const [conversation] = await db.select().from(conversations)
    expect(conversation).toMatchObject({ channelId: channel.id, platform: 'messenger', externalId: 't_1', participantExternalId: person, participantName: 'Mario Rossi',
      lastInboundAt: new Date('2030-01-01T10:00:00Z'), lastMessageAt: new Date('2030-01-01T10:00:00Z') })
    const [message] = await db.select().from(directMessages)
    expect(message).toMatchObject({ conversationId: conversation!.id, externalId: 'm_1', direction: 'in', text: 'Siete aperti domenica?', attachments: [] })
    expect(await deliveries()).toEqual([{ type: 'message.received', timestamp: now.toISOString(), data: { organizationId: org, channelId: channel.id,
      conversationId: conversation!.id, messageId: message!.id, platform: 'messenger', participant: { name: 'Mario Rossi', username: null },
      text: 'Siete aperti domenica?', attachments: [], sentAt: '2030-01-01T10:00:00.000Z' } }])

    // Asked for again at once: at most one sync a minute.
    expect(await requestConversationSync(context, org)).toEqual({ channelIds: [channel.id] })
    expect(await collectDueConversations(context)).toEqual({ synced: 0, failed: 0 })
    advance(minute)
    expect(await collectDueConversations(context)).toEqual({ synced: 1, failed: 0 })
    // Nothing moved: the conversation's messages are not read again.
    expect(meta.readCalls).toHaveLength(1)
    expect(meta.listCalls).toBe(2)

    meta.inbound('E a che ora?')
    advance(minute)
    // A Meta notification makes the Page due, whatever tenant it belongs to.
    expect(await notifyMeta(context, [{ object: 'page', id: channel.externalId }, { object: 'instagram', id: '999' }])).toEqual({ channelIds: [channel.id] })
    await collectDueConversations(context)
    expect(meta.readCalls).toHaveLength(2)
    expect((await db.select().from(directMessages)).map(row => row.externalId).sort()).toEqual(['m_1', 'm_2'])
    expect((await deliveries()).map(event => event.data.text)).toEqual(['Siete aperti domenica?', 'E a che ora?'])
    // The fallback cadence is 30 minutes.
    const [check] = await db.select().from(conversationChecks)
    expect(check!.nextCheckAt.getTime() - now.getTime()).toBe(30 * minute)
  })

  it('backs a rate-limited channel off 15 minutes, doubling, and holds the backoff against requests', async () => {
    const channel = await connect()
    meta.listWith = async () => { throw new RateLimited('limited') }
    expect(await collectDueConversations(context)).toEqual({ synced: 0, failed: 1 })
    let [check] = await db.select().from(conversationChecks)
    expect(check).toMatchObject({ rateLimitCount: 1, backoffUntil: new Date(now.getTime() + 15 * minute) })
    advance(2 * minute)
    await requestConversationSync(context, org, channel.id)
    expect(await collectDueConversations(context)).toEqual({ synced: 0, failed: 0 })
    advance(13 * minute)
    await collectDueConversations(context)
    ;[check] = await db.select().from(conversationChecks)
    expect(check).toMatchObject({ rateLimitCount: 2, backoffUntil: new Date(now.getTime() + 30 * minute) })
    meta.listWith = undefined
    advance(30 * minute)
    expect(await collectDueConversations(context)).toEqual({ synced: 1, failed: 0 })
    ;[check] = await db.select().from(conversationChecks)
    expect(check).toMatchObject({ rateLimitCount: 0, backoffUntil: null, failureCount: 0 })
    await expect(requestConversationSync(context, 'other-org', channel.id)).rejects.toMatchObject({ status: 404 })
  })

  it('sends a message once at sendAt, tells webhooks, and links it when the sync reads it back', async () => {
    const { channel, conversation } = await conversationWithInbound()
    await createWebhook(context, org, { url: 'https://hooks.example.com/x', eventTypes: ['message.sent', 'message.failed'], channelIds: null, description: null })
    const input = messageFor(conversation.id)
    const first = await submitMessage(context, org, input)
    expect(first).toMatchObject({ created: true, message: { state: 'queued', conversationId: conversation.id, channelId: channel.id, messageId: input.messageId } })
    expect(await claimNextMessage(context)).toBeNull()
    advance(minute)
    expect(await runMessages(context)).toMatchObject({ sent: 1 })
    expect(await runMessages(context)).toMatchObject({ sent: 0 })
    expect(meta.sendCalls).toEqual([expect.objectContaining({ recipientExternalId: person, text: 'Sì, dalle 10 alle 13!' })])
    expect(await outgoing(input.requestKey)).toMatchObject({ state: 'sent', platformMessageId: 'm_2', settledBy: 'worker', attemptCount: 1 })
    expect(await deliveries()).toEqual([{ type: 'message.sent', timestamp: now.toISOString(), data: { organizationId: org, messageId: input.messageId,
      revision: 1, requestKey: input.requestKey, conversationId: conversation.id, channelId: channel.id, platform: 'messenger', platformMessageId: 'm_2',
      errorCode: null, settledBy: 'worker' } }])
    // The conversation is read again within a minute, and the sent message links back.
    const [check] = await db.select().from(conversationChecks)
    expect(check!.nextCheckAt.getTime()).toBeLessThanOrEqual(now.getTime() + minute)
    advance(minute)
    await collectDueConversations(context)
    const { messages } = await listConversationMessages(context, org, conversation.id, { limit: 20 })
    expect(messages).toEqual([
      expect.objectContaining({ direction: 'out', text: 'Sì, dalle 10 alle 13!', outgoingKey: input.requestKey }),
      expect.not.objectContaining({ outgoingKey: expect.anything() }),
    ])
    const [listed] = await listOutgoingMessages(context, org, { conversationId: conversation.id, limit: 10 })
    expect(listed).toMatchObject({ state: 'sent', directMessageId: messages[0]!.id })
    const { conversations: [inbox] } = await listConversations(context, org, { limit: 10 })
    expect(inbox).toMatchObject({ lastMessage: { direction: 'out', text: 'Sì, dalle 10 alle 13!' }, lastInboundAt: '2030-01-01T10:00:00.000Z',
      windowOpenUntil: '2030-01-02T10:00:00.000Z' })
    // A sent message's key returns it, never a new send.
    expect(await submitMessage(context, org, input)).toMatchObject({ created: false, message: { state: 'sent' } })
    expect(meta.sendCalls).toHaveLength(1)
  })

  it('refuses a message outside the 24-hour window, at submission and at the claim', async () => {
    const { conversation } = await conversationWithInbound()
    advance(25 * hour)
    await expect(submitMessage(context, org, messageFor(conversation.id))).rejects.toMatchObject({ status: 409, code: 'outside_window',
      detail: { windowOpenUntil: '2030-01-02T10:00:00.000Z' } })
    // The window still covers sendAt, but closes before the worker gets to it.
    await db.update(conversations).set({ lastInboundAt: new Date(now.getTime() - day + 90_000) }).where(eq(conversations.id, conversation.id))
    const input = messageFor(conversation.id)
    await submitMessage(context, org, input)
    advance(2 * minute)
    await runMessages(context)
    expect(await outgoing(input.requestKey)).toMatchObject({ state: 'failed', errorCode: 'outside_window', attemptCount: 0 })
    expect(meta.sendCalls).toEqual([])
  })

  it('accepts each request key once, refuses other fields for it and another key for the revision, and honours tombstones', async () => {
    const { conversation } = await conversationWithInbound()
    const input = messageFor(conversation.id)
    const first = await submitMessage(context, org, input)
    expect(await submitMessage(context, org, input)).toEqual({ created: false, message: first.message })
    await expect(submitMessage(context, org, { ...input, sendAt: new Date(now.getTime() + 2 * minute).toISOString() })).rejects.toMatchObject({ code: 'revision_conflict' })
    await expect(submitMessage(context, org, messageFor(conversation.id, { messageId: input.messageId, text: 'Altro testo' }))).rejects.toMatchObject({ code: 'revision_conflict' })
    await expect(submitMessage(context, org, { ...input, digest: '0'.repeat(64) })).rejects.toMatchObject({ status: 400, code: 'digest_mismatch' })
    await expect(submitMessage(context, org, { ...input, requestKey: 'f'.repeat(64) })).rejects.toMatchObject({ status: 400, code: 'request_key_mismatch' })
    const twice = messageFor(conversation.id)
    const results = await Promise.all([submitMessage(context, org, twice), submitMessage(context, org, twice)])
    expect(results.filter(result => result.created)).toHaveLength(1)

    const cancelled = messageFor(conversation.id)
    expect((await cancelMessage(context, org, cancelled.requestKey)).message).toMatchObject({ id: null, state: 'cancelled', errorCode: 'cancelled_before_submit' })
    expect(await submitMessage(context, org, cancelled)).toMatchObject({ created: false, message: { state: 'cancelled', messageId: cancelled.messageId } })
    await expect(cancelMessage(context, 'other-org', cancelled.requestKey)).rejects.toMatchObject({ status: 404 })
    expect(await outgoing(cancelled.requestKey)).toBeUndefined()

    await expect(submitMessage(context, org, messageFor(conversation.id, { text: 'x'.repeat(51) }))).rejects.toMatchObject({ status: 400, code: 'text_too_long' })
    await expect(submitMessage(context, org, messageFor(randomUUID()))).rejects.toMatchObject({ status: 404 })
    await expect(submitMessage(context, 'other-org', messageFor(conversation.id, { organizationId: 'other-org' }))).rejects.toMatchObject({ status: 404 })
    await expect(submitMessage(context, org, messageFor(conversation.id, { sendAt: new Date(now.getTime() + 2 * hour) }))).rejects.toMatchObject({ code: 'invalid_send_at' })
    const late = messageFor(conversation.id, { sendAt: new Date(now.getTime() - 10 * minute) })
    await expect(submitMessage(context, org, { ...late, approvedAt: new Date(now.getTime() - 11 * minute).toISOString() })).rejects.toMatchObject({ code: 'too_late' })
  })

  it('makes a lost answer uncertain, never resends it, and settles it when a look finds it', async () => {
    const { conversation } = await conversationWithInbound()
    meta.sendWith = async input => {
      meta.create(input.text)
      return { kind: 'uncertain', code: 'response_lost', detail: 'timeout' }
    }
    const input = messageFor(conversation.id)
    await submitMessage(context, org, input)
    advance(minute)
    await runMessages(context)
    expect(await outgoing(input.requestKey)).toMatchObject({ state: 'uncertain', errorCode: 'response_lost', reconciling: true })
    expect(await submitMessage(context, org, input)).toMatchObject({ created: false, message: { state: 'uncertain' } })
    await expect(resolveMessage(context, org, input.requestKey, 'not_sent')).rejects.toMatchObject({ code: 'still_checking' })
    advance(minute)
    await runMessages(context)
    expect(meta.sendCalls).toHaveLength(1)
    expect(meta.findCalls[0]).toMatchObject({ conversationExternalId: 't_1', text: input.text })
    expect(await outgoing(input.requestKey)).toMatchObject({ state: 'sent', platformMessageId: 'm_2', settledBy: 'reconcile', reconciling: false })

    // A worker that died after the claim: uncertain after the lease, looked for a day, never resent, then a person decides.
    meta.sendWith = undefined
    const lost = messageFor(conversation.id, { text: 'A presto!' })
    await submitMessage(context, org, lost)
    advance(minute)
    const claimed = (await claimNextMessage(context))!
    advance(6 * minute)
    expect(await sweepMessages(context)).toEqual([claimed.id])
    expect(await executeMessage(context, claimed)).toMatchObject({ kind: 'failed', code: 'claim_lost' })
    const settled = await reconcileAll(claimed.id)
    expect(settled).toMatchObject({ state: 'uncertain', errorCode: 'abandoned', reconciling: false })
    expect(meta.findCalls).toHaveLength(1 + messageReconcileDelaysMs.length)
    expect(meta.sendCalls).toHaveLength(1)
    expect((await resolveMessage(context, org, lost.requestKey, 'not_sent')).message).toMatchObject({ state: 'failed', errorCode: 'resolved_not_sent' })
    await expect(resolveMessage(context, org, lost.requestKey, 'sent')).rejects.toMatchObject({ code: 'not_uncertain' })
  })

  it('lets exactly one of a cancel and a claim win', async () => {
    const { conversation } = await conversationWithInbound()
    let cancelled = 0
    let sent = 0
    for (let round = 0; round < 8; round++) {
      const { message } = await submitMessage(context, org, messageFor(conversation.id, { text: `Grazie ${round}` }))
      advance(minute)
      const [cancel, claim] = await Promise.allSettled([cancelMessage(context, org, message.requestKey), claimNextMessage(context)])
      const claimed = claim.status === 'fulfilled' ? claim.value : null
      if (cancel.status === 'fulfilled') {
        expect(cancel.value.message).toMatchObject({ state: 'cancelled', errorCode: 'cancelled' })
        expect(claimed).toBeNull()
        cancelled++
      } else {
        expect(cancel.reason).toMatchObject({ code: 'too_late', detail: { state: 'sending' } })
        expect(claimed).not.toBeNull()
        await executeMessage(context, claimed!)
        sent++
      }
    }
    expect(cancelled + sent).toBe(8)
    expect(meta.sendCalls).toHaveLength(sent)
  })

  it('never sends for a paused tenant or channel, and keeps each channel to 60 an hour', async () => {
    const { channel, conversation } = await conversationWithInbound()
    const queued = await submitMessage(context, org, messageFor(conversation.id))
    await setPublishing(context, org, false, [channel.id])
    await expect(submitMessage(context, org, messageFor(conversation.id))).rejects.toMatchObject({ code: 'paused' })
    advance(minute)
    await runMessages(context)
    expect(await outgoing(queued.message.requestKey)).toMatchObject({ state: 'cancelled', errorCode: 'paused' })
    await setPublishing(context, org, false, [])
    for (let index = 0; index < 59; index++) await submitMessage(context, org, messageFor(conversation.id, { text: `Ciao ${index}` }))
    // The cancelled one does not count: 59 more fill the hour.
    await submitMessage(context, org, messageFor(conversation.id))
    await expect(submitMessage(context, org, messageFor(conversation.id))).rejects.toMatchObject({ code: 'rate_limited', detail: { limit: 60 } })
    expect(meta.sendCalls).toEqual([])
  })

  it('tells messages availability from the grant and from refused sends, apart from replies', async () => {
    const externalId = `page-${randomUUID()}`
    const { conversation } = await conversationWithInbound({ grantedScopes: ['pages_manage_posts', 'pages_manage_engagement'], externalId })
    expect((await listChannels(context, org))[0]).toMatchObject({ replies: { available: true }, messages: { available: false, reason: 'missing_permission',
      permission: 'pages_messaging' } })
    await expect(submitMessage(context, org, messageFor(conversation.id))).rejects.toMatchObject({ code: 'missing_permission', detail: { permission: 'pages_messaging' } })
    await connect({ externalId })
    expect((await listChannels(context, org))[0]).toMatchObject({ messages: { available: true, maxLength: 50 } })
    meta.sendWith = async () => ({ kind: 'failed', retryable: false, code: 'missing_permission', detail: 'code 10', permission: 'pages_messaging' })
    const input = messageFor(conversation.id)
    await submitMessage(context, org, input)
    advance(minute)
    await runMessages(context)
    expect(await outgoing(input.requestKey)).toMatchObject({ state: 'failed', errorCode: 'missing_permission', permission: 'pages_messaging' })
    // A refused messaging permission does not take replies away.
    expect((await listChannels(context, org))[0]).toMatchObject({ replies: { available: true }, messages: { available: false, permission: 'pages_messaging' } })
  })

  it('deletes conversations after 180 days and with a disabled channel, which waits for unsettled messages', async () => {
    const { channel, conversation } = await conversationWithInbound()
    const queued = await submitMessage(context, org, messageFor(conversation.id))
    await expect(disableChannel(context, org, channel.id)).rejects.toMatchObject({ code: 'channel_busy' })
    await cancelMessage(context, org, queued.message.requestKey)
    await cancelMessage(context, org, messageFor(conversation.id).requestKey)
    // The fake keeps one thread for both Pages: the second reads Mario's two messages.
    const other = await conversationWithInbound()
    advance(181 * day)
    expect(await applyRetention(context)).toMatchObject({ conversations: 2, directMessages: 3, outgoingMessages: 1 })
    expect(await db.select().from(outgoingMessageCancellations)).toEqual([])
    expect(await db.select().from(conversations)).toEqual([])

    meta.inbound('Ciao di nuovo')
    await requestConversationSync(context, org)
    await collectDueConversations(context)
    expect(await db.select().from(conversations)).toHaveLength(2)
    await disableChannel(context, org, other.channel.id)
    expect((await db.select().from(conversations)).map(row => row.channelId)).toEqual([channel.id])
    expect((await db.select().from(channels).where(eq(channels.id, other.channel.id)))[0]!.status).toBe('disabled')
  })

  it('serves the contract over HTTP and keeps tenants apart', async () => {
    const { channel, conversation } = await conversationWithInbound()
    const token = 's'.repeat(48)
    const server = createServer(toNodeListener(createEngineApp(context, token)))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const call = async (path: string, init: RequestInit = {}) => {
      const result = await fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } })
      return { status: result.status, body: await result.json() as Record<string, unknown> }
    }
    try {
      expect((await call(`/v1/tenants/${org}/channels`)).body).toMatchObject({ channels: [{ id: channel.id, messages: { available: true, maxLength: 50 } }] })
      expect(await call(`/v1/tenants/${org}/conversations?limit=1`)).toMatchObject({ status: 200, body: { conversations: [{ id: conversation.id,
        participant: { name: 'Mario Rossi', username: null }, lastMessage: { direction: 'in' } }], next: expect.any(String) } })
      const page = await call(`/v1/tenants/${org}/conversations?limit=1&after=${(await call(`/v1/tenants/${org}/conversations?limit=1`)).body.next as string}`)
      expect(page).toEqual({ status: 200, body: { conversations: [], next: null } })
      expect(await call(`/v1/tenants/other-org/conversations`)).toEqual({ status: 200, body: { conversations: [], next: null } })
      expect(await call(`/v1/tenants/${org}/conversations/${conversation.id}/messages`)).toMatchObject({ status: 200, body: { messages: [{ direction: 'in' }], next: null } })
      expect((await call(`/v1/tenants/other-org/conversations/${conversation.id}/messages`)).status).toBe(404)
      advance(minute)
      expect(await call(`/v1/tenants/${org}/conversations/sync`, { method: 'POST', body: JSON.stringify({ channelId: channel.id }) }))
        .toEqual({ status: 200, body: { channelIds: [channel.id] } })
      expect(await call('/v1/meta/notifications', { method: 'POST', body: JSON.stringify({ objects: [{ object: 'page', id: channel.externalId }] }) }))
        .toMatchObject({ status: 200 })
      expect((await call('/v1/meta/notifications', { method: 'POST', body: JSON.stringify({ objects: [{ object: 'page', id: 'x', text: 'hi' }] }) })).status).toBe(400)

      const input = messageFor(conversation.id)
      expect(await call(`/v1/tenants/${org}/messages`, { method: 'POST', body: JSON.stringify(input) }))
        .toMatchObject({ status: 201, body: { message: { requestKey: input.requestKey, state: 'queued' } } })
      expect((await call(`/v1/tenants/${org}/messages`, { method: 'POST', body: JSON.stringify(input) })).status).toBe(200)
      expect(await call(`/v1/tenants/${org}/messages?conversationId=${conversation.id}&state=queued`))
        .toMatchObject({ status: 200, body: { messages: [{ requestKey: input.requestKey }] } })
      expect(await call(`/v1/tenants/other-org/messages`)).toEqual({ status: 200, body: { messages: [] } })
      // By request key, comma-separated or repeated; a key cancelled before it arrived comes back as cancelled.
      const early = messageFor(conversation.id)
      await cancelMessage(context, org, early.requestKey)
      const byKey = await call(`/v1/tenants/${org}/messages?requestKeys=${input.requestKey}&requestKeys=${early.requestKey}`)
      expect((byKey.body.messages as Array<Record<string, unknown>>).map(row => [row.requestKey, row.state, row.url]).sort())
        .toEqual([[input.requestKey, 'queued', null], [early.requestKey, 'cancelled', null]].sort())
      expect(await call(`/v1/tenants/${org}/messages?requestKeys=${early.requestKey},${input.requestKey}`)).toMatchObject({ body: { messages: [{}, {}] } })
      expect((await call(`/v1/tenants/${org}/messages?requestKeys=nope`)).status).toBe(400)
      expect(await call(`/v1/tenants/${org}/conversations/${conversation.id}`)).toEqual({ status: 200, body: { conversation } })
      expect((await call(`/v1/tenants/other-org/conversations/${conversation.id}`)).status).toBe(404)
      expect((await call(`/v1/tenants/other-org/messages/${input.requestKey}/cancel`, { method: 'POST' })).status).toBe(404)
      expect(await call(`/v1/tenants/${org}/messages/${input.requestKey}/resolve`, { method: 'POST', body: JSON.stringify({ outcome: 'sent' }) }))
        .toMatchObject({ status: 409, body: { error: 'not_uncertain' } })
      expect(await call(`/v1/tenants/${org}/messages/${input.requestKey}/cancel`, { method: 'POST' })).toMatchObject({ status: 200, body: { message: { state: 'cancelled' } } })
      expect((await call(`/v1/tenants/${org}/messages`, { method: 'POST', body: JSON.stringify({ ...input, extra: true }) })).status).toBe(400)
      expect(await db.select().from(events).where(eq(events.kind, 'message.cancelled'))).toHaveLength(1)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})
