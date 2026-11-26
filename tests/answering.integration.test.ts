import { randomBytes, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { eq } from 'drizzle-orm'
import { toNodeListener } from 'h3'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { DecisionModel } from '../src/answering/decision.js'
import type { DraftInput, DraftModel, DraftOutput } from '../src/answering/drafting.js'
import { listDraftOutbox } from '../src/answering/drafts.js'
import { runAnswering } from '../src/answering/pipeline.js'
import { reviseDraft } from '../src/answering/revise.js'
import { getAnswering, putAnswering } from '../src/answering/settings.js'
import { disableChannel } from '../src/channels.js'
import type { EngineContext } from '../src/context.js'
import { controlEventKey, controlEventRetryDelaysMs, deliverControlEvents, enableControlEvents, queueControlEvent, signControlEvent, type ControlEventRequest } from '../src/control-events.js'
import type { Database } from '../src/db/client.js'
import {
  channels, controlEvents, conversations, directMessages, events, inboundDrafts, jobs, outgoingMessages, postResponses, providerApps, replies,
  type AnsweringSettings,
} from '../src/db/schema.js'
import { createEngineApp } from '../src/http/app.js'
import { messageDigest, messageRequestKey, submitMessage, type MessageSubmission } from '../src/messages.js'
import type { PlatformAdapter } from '../src/platforms/types.js'
import { replyDigest, replyRequestKey, submitReply, type ReplySubmission } from '../src/replies.js'
import { applyRetention } from '../src/retention.js'
import { answeringHealth } from '../src/jobs/health.js'
import { postgresFixture } from './fixtures/postgres.js'

const required = process.env.REQUIRE_DATABASE_TESTS === 'true'
const second = 1_000
const minute = 60 * second
const hour = 60 * minute
const day = 24 * hour
const serviceToken = 'example-service-token-0123456789abcdef'

/** A Page that can message and reply; nothing here is sent in these tests. */
class FakePage implements PlatformAdapter {
  readonly platform = 'meta' as const
  authorizeUrl() { return 'https://example.test/oauth' }
  async finishConnect() { return [] }
  limits() { return { maxLength: 100, maxMedia: 2 } }
  validateSettings() {}
  async publish() { return { kind: 'published' as const, externalId: 'post-1' } }
  async reconcile() { return { kind: 'not_found' as const } }
  replyRules() { return { permission: 'pages_manage_engagement', maxLength: 200 } }
  async reply() { return { kind: 'sent' as const, externalId: 'reply-1' } }
  messageRules(kind: string) { return kind === 'facebook_page' ? { platform: 'messenger' as const, permission: 'pages_messaging', maxLength: 200, unit: 'characters' as const } : null }
  async sendMessage() { return { kind: 'sent' as const, externalId: 'sent-1' } }
}

/** Decides by keyword: "auto" is full, "thanks" none, anything else draft; "risky" is high risk, anything else low. */
class FakeDecision implements DecisionModel {
  calls: string[] = []
  questions: string[][] = []
  async decide(input: Parameters<DecisionModel['decide']>[0]) {
    const text = (input.state.item as { text: string }).text
    this.calls.push(text)
    this.questions.push(Object.keys(input.questions))
    const probabilities = text.includes('auto') ? { full: 0.95, draft: 0.04, none: 0.01 }
      : text.includes('thanks') ? { full: 0.02, draft: 0.08, none: 0.9 } : { full: 0.2, draft: 0.7, none: 0.1 }
    const choice = (Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]![0]) as 'full' | 'draft' | 'none'
    const risk = text.includes('risky') ? { choice: 'high' as const, probabilities: { low: 0.05, medium: 0.15, high: 0.8 }, confidence: 0.7 }
      : { choice: 'low' as const, probabilities: { low: 0.88, medium: 0.1, high: 0.02 }, confidence: 0.81 }
    return { model: 'd1.1-test', ...input.questions.answer ? { answer: { choice, probabilities, confidence: 0.8 } } : {}, risk, cost: 0.0001 }
  }
}

/** Drafts "Reply: <what it answers>", or what a test asks for. */
class FakeDrafter implements DraftModel {
  inputs: DraftInput[] = []
  next?: Partial<DraftOutput>
  failing = false
  async draft(input: DraftInput) {
    this.inputs.push(input)
    if (this.failing) throw new Error('credit balance too low')
    const answered = input.kind === 'message' ? input.history?.at(-1)?.text : input.comment?.text
    const output: DraftOutput = { needsReply: true, reply: `Reply: ${answered ?? 'nothing'}`, language: 'en', summary: 'A question.', flags: [], ...this.next }
    return { model: 'claude-haiku-5-5', output }
  }
}

describe.skipIf(!required)('AI answers on PostgreSQL 17', { timeout: 60_000 }, () => {
  let fixture: Awaited<ReturnType<typeof postgresFixture>>
  let db: Database
  let context: EngineContext
  let decision: FakeDecision
  let drafter: FakeDrafter
  let now: Date
  let org: string
  let version = 0

  beforeAll(async () => {
    fixture = await postgresFixture()
    db = fixture.db
    await db.insert(providerApps).values({ id: 'meta-agency', platform: 'meta', externalAppId: '111', ownerKind: 'agency', secretRef: 'meta-agency' })
  }, 180_000)
  afterAll(async () => { await fixture?.cleanup() }, 30_000)

  beforeEach(async () => {
    await fixture.migrator.query('truncate inbound_drafts, control_events, answering_settings, outgoing_message_cancellations, outgoing_messages, direct_messages, conversations, conversation_checks, channel_activity, webhook_deliveries, webhooks, replies, reply_cancellations, post_metric_samples, channel_metric_samples, channel_metrics, post_responses, response_checks, post_metrics, attempts, jobs, events, media_chunks, media, oauth_states, channel_credentials, channels, publishing_controls, browser_accounts')
    now = new Date('2030-01-01T10:00:00Z')
    org = `org-${randomUUID()}`
    decision = new FakeDecision()
    drafter = new FakeDrafter()
    context = { db, adapters: new Map([['meta', new FakePage()]]), keyring: { activeKeyId: 'k1', keys: new Map([['k1', randomBytes(32)]]) },
      providerSecrets: new Map([['meta-agency', 'agency-secret']]), now: () => now, decisionModel: decision, draftModel: drafter }
    enableControlEvents(true)
  })

  const advance = (ms: number) => { now = new Date(now.getTime() + ms) }

  const baseSettings = (overrides: Partial<AnsweringSettings> = {}): AnsweringSettings => ({ enabled: true, drafts: true, kinds: { messages: true, comments: true },
    decisionModel: 'd1.1', decisionPrompt: 'Answer shipping questions.', decisionThreshold: 0.9, noneThreshold: 0.8, riskThreshold: 30, replyModel: 'haiku',
    voice: 'Friendly.', replyContext: '', delaySeconds: 120, cases: [], ...overrides })
  const put = (overrides: Partial<AnsweringSettings> = {}, organizationId = org) =>
    putAnswering(context, organizationId, { version: ++version, settings: baseSettings(overrides), context: [{ id: 'e1', topic: 'shipping', body: 'Three days.' }] })

  async function channel(organizationId = org) {
    const [row] = await db.insert(channels).values({ organizationId, providerAppId: 'meta-agency', platform: 'meta', kind: 'facebook_page',
      externalId: String(randomBytes(6).readUIntBE(0, 6)), name: 'Example Shop' }).returning()
    return row!
  }
  async function conversation(page: typeof channels.$inferSelect) {
    const [row] = await db.insert(conversations).values({ organizationId: page.organizationId, channelId: page.id, platform: 'messenger',
      externalId: `t_${randomUUID()}`, participantExternalId: '2400001', participantName: 'A Person', updatedTime: now, lastMessageAt: now }).returning()
    return row!
  }
  /** Stores a message as the conversation sync does: once, seen now. */
  async function message(chat: typeof conversations.$inferSelect, text: string, options: { direction?: 'in' | 'out', sentAt?: Date } = {}) {
    const sentAt = options.sentAt ?? now
    const [row] = await db.insert(directMessages).values({ organizationId: chat.organizationId, channelId: chat.channelId, conversationId: chat.id,
      externalId: `m_${randomUUID()}`, direction: options.direction ?? 'in', text, sentAt, firstSeenAt: now }).returning()
    if ((options.direction ?? 'in') === 'in') await db.update(conversations).set({ lastInboundAt: sentAt, lastMessageAt: sentAt }).where(eq(conversations.id, chat.id))
    return row!
  }
  async function post(page: typeof channels.$inferSelect, publishedAgoMs: number) {
    const [row] = await db.insert(jobs).values({ organizationId: page.organizationId, postId: randomUUID(), revision: 1, channelId: page.id,
      payload: { content: 'New collection out now', mediaIds: [], settings: {}, approvedByUserId: 'u1', approvedAt: now.toISOString() }, payloadHash: 'h',
      publishAt: new Date(now.getTime() - publishedAgoMs), notBefore: now, state: 'published', receipt: { externalId: `p_${randomUUID()}`, settledBy: 'worker' } }).returning()
    return row!
  }
  async function comment(job: typeof jobs.$inferSelect, text: string, options: { parent?: string, fromChannel?: boolean, externalId?: string } = {}) {
    const [row] = await db.insert(postResponses).values({ organizationId: job.organizationId, channelId: job.channelId, jobId: job.id,
      externalId: options.externalId ?? `c_${randomUUID()}`, parentExternalId: options.parent ?? null, authorName: 'A Person', authorHandle: 'a.person', text,
      publishedAt: now, firstSeenAt: now, updatedAt: now, fromChannel: options.fromChannel ?? false }).returning()
    return row!
  }
  const draftsOf = (conversationId: string) => db.select().from(inboundDrafts).where(eq(inboundDrafts.conversationId, conversationId))

  function automaticMessage(draft: typeof inboundDrafts.$inferSelect, overrides: Partial<{ text: string, revision: number, sendAt: Date, conversationId: string,
    messageId: string }> = {}): MessageSubmission {
    const conversationId = overrides.conversationId ?? draft.conversationId!
    const text = overrides.text ?? draft.draftText!
    const revision = overrides.revision ?? 1
    const messageId = overrides.messageId ?? randomUUID()
    const digest = messageDigest({ conversationId, text })
    return { requestKey: messageRequestKey(org, messageId, revision, digest), messageId, revision, digest, conversationId, text, approvedByUserId: 'u1',
      approvedAt: now.toISOString(), sendAt: (overrides.sendAt ?? new Date(draft.createdAt.getTime() + 2 * minute)).toISOString(),
      approvedVia: 'automation', draftId: draft.id }
  }

  it('grants the new tables to the runtime role and keeps settings versions moving forward', async () => {
    await expect(getAnswering(context, org)).rejects.toMatchObject({ status: 404 })
    const first = await put()
    expect(first).toMatchObject({ version, enabledAt: { messages: now.toISOString(), comments: now.toISOString() }, settings: { kinds: { messages: true } },
      context: [{ id: 'e1' }] })
    const same = await putAnswering(context, org, { version, settings: baseSettings(), context: [{ id: 'e1', topic: 'shipping', body: 'Three days.' }] })
    expect(same).toEqual(first)
    await expect(putAnswering(context, org, { version, settings: baseSettings({ voice: 'Other' }), context: [] })).rejects.toMatchObject({ code: 'version_conflict' })
    await expect(putAnswering(context, org, { version: version - 1, settings: baseSettings(), context: [] })).rejects.toMatchObject({ code: 'stale_version' })
    advance(hour)
    // Another change keeps the times; switching off clears them; on again starts from now, per kind.
    expect(await put({ voice: 'Warmer.' })).toMatchObject({ enabledAt: first.enabledAt })
    expect(await put({ drafts: false })).toMatchObject({ enabledAt: { messages: null, comments: null } })
    advance(hour)
    const again = await put({ kinds: { messages: true, comments: false } })
    expect(again).toMatchObject({ enabledAt: { messages: now.toISOString(), comments: null } })
    advance(hour)
    expect(await put()).toMatchObject({ enabledAt: { messages: again.enabledAt.messages, comments: now.toISOString() } })
    expect(await getAnswering(context, org)).toMatchObject({ version })
  })

  it('readiness says answering is failing after two failed drafts in an hour with none drafted', async () => {
    const page = await channel()
    await put()
    expect(await answeringHealth(context)).toMatchObject({ answering: 'ok', answeringLastHour: { failed: 0, drafted: 0 } })
    drafter.failing = true
    for (const text of ['Do you ship to Spain?', 'And to Portugal?']) {
      const chat = await conversation(page)
      await message(chat, text)
      await runAnswering(context)
    }
    expect(await answeringHealth(context)).toMatchObject({ answering: 'failing', answeringLastHour: { failed: 2, drafted: 0 } })
    advance(61 * minute)
    expect(await answeringHealth(context)).toMatchObject({ answering: 'ok' })
    expect(await answeringHealth({ ...context, draftModel: undefined })).toMatchObject({ answering: 'off' })
  })

  it('drafts new DMs once, from the switch-on, coalescing a burst and superseding older drafts', async () => {
    const page = await channel()
    const chat = await conversation(page)
    await message(chat, 'An old question from before')
    advance(minute)
    await put({ enabled: false })
    expect(await runAnswering(context)).toEqual({ drafted: 0, failed: 0 })

    advance(minute)
    await message(chat, 'Hello', { sentAt: new Date(now.getTime() - 2 * second) })
    await message(chat, 'Do you ship to Spain?')
    expect(await runAnswering(context)).toEqual({ drafted: 1, failed: 0 })
    expect(await runAnswering(context)).toEqual({ drafted: 0, failed: 0 })
    const [first] = await draftsOf(chat.id)
    expect(first).toMatchObject({ kind: 'message', outcome: 'review', reason: 'below_threshold', decisionModel: 'd1.1-test', draftText: 'Reply: Do you ship to Spain?',
      draftDigest: messageDigest({ conversationId: chat.id, text: 'Reply: Do you ship to Spain?' }), draftModel: 'claude-haiku-5-5', settingsVersion: version })
    // The drafting model saw the conversation, backlog included, oldest first.
    expect(drafter.inputs[0]!.history!.map(item => item.text)).toEqual(['An old question from before', 'Hello', 'Do you ship to Spain?'])
    expect(await db.select().from(controlEvents)).toMatchObject([{ type: 'drafts.available', organizationId: org }])

    // The outbox over HTTP, then acknowledged.
    const server: Server = createServer(toNodeListener(createEngineApp(context, serviceToken)))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const headers = { authorization: `Bearer ${serviceToken}`, 'content-type': 'application/json' }
    try {
      const outbox = await (await fetch(`${base}/v1/drafts/outbox?limit=10`, { headers })).json() as { items: Array<Record<string, unknown>> }
      expect(outbox.items).toEqual([{ id: first!.id, organizationId: org, kind: 'message', channelId: page.id, conversationId: chat.id, responseId: null, jobId: null,
        inboundExternalId: first!.inboundExternalId,
        decision: { outcome: 'review', reason: 'below_threshold', model: 'd1.1-test', probabilities: { full: 0.2, draft: 0.7, none: 0.1 }, confidence: 0.8,
          risk: { level: 'low', score: 7, probabilities: { low: 0.88, medium: 0.1, high: 0.02 }, confidence: 0.81 }, riskThreshold: 30,
          caseId: null, decisionThreshold: 0.9, noneThreshold: 0.8, cost: 0.0001, errorCode: null, settingsVersion: version },
        draft: { text: 'Reply: Do you ship to Spain?', digest: first!.draftDigest, model: 'claude-haiku-5-5', language: 'en', flags: [] },
        draftErrorCode: null, superseded: false, supersededBy: null, supersedes: [], createdAt: now.toISOString() }])
      const ack = await fetch(`${base}/v1/drafts/outbox/ack`, { method: 'POST', headers, body: JSON.stringify({ ids: [first!.id, randomUUID()] }) })
      expect(await ack.json()).toEqual({ acknowledged: 1 })
      expect((await listDraftOutbox(context, 10)).items).toEqual([])

      // A newer message: a new draft that supersedes the delivered one, which comes back once more.
      advance(5 * minute)
      await message(chat, 'Also, how much is shipping?')
      expect(await runAnswering(context)).toEqual({ drafted: 1, failed: 0 })
      const items = (await listDraftOutbox(context, 10)).items
      const newer = items.find(item => item.id !== first!.id)!
      expect(items.find(item => item.id === first!.id)).toMatchObject({ superseded: true, supersededBy: newer.id })
      expect(newer).toMatchObject({ superseded: false, supersedes: [first!.id] })
      await fetch(`${base}/v1/drafts/outbox/ack`, { method: 'POST', headers, body: JSON.stringify({ ids: items.map(item => item.id) }) })
      expect((await listDraftOutbox(context, 10)).items).toEqual([])
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }

    // Answered by the brand since, or with messages switched off: nothing new.
    const other = await conversation(page)
    await message(other, 'Is the shop open?')
    advance(second)
    await message(other, 'Yes, until six.', { direction: 'out' })
    const third = await conversation(page)
    await message(third, 'Another question')
    await put({ kinds: { messages: false, comments: true } })
    expect(await runAnswering(context)).toEqual({ drafted: 0, failed: 0 })
    await put()
    expect(await runAnswering(context)).toEqual({ drafted: 1, failed: 0 })
    expect(await draftsOf(other.id)).toHaveLength(0)
    expect(await draftsOf(third.id)).toHaveLength(1)
  })

  it('files none without a draft, and answers comments only under recent posts', async () => {
    const page = await channel()
    await put()
    advance(minute)
    const recent = await post(page, 3 * day)
    const old = await post(page, 8 * day)
    const parent = await comment(recent, 'Lovely colours')
    await comment(recent, 'Thank you!', { parent: parent.externalId, fromChannel: true })
    advance(second)
    const question = await comment(recent, 'Do you ship to Spain?', { parent: parent.externalId })
    const thanks = await comment(recent, 'thanks a lot')
    await comment(old, 'Do you ship to France?')
    expect(await runAnswering(context)).toEqual({ drafted: 3, failed: 0 })
    const rows = await db.select().from(inboundDrafts)
    expect(rows.map(row => row.responseId).sort()).toEqual([parent.id, question.id, thanks.id].sort())
    expect(rows.find(row => row.responseId === thanks.id)).toMatchObject({ outcome: 'none', reason: 'no_reply', draftText: null, draftDigest: null })
    const answered = rows.find(row => row.responseId === question.id)!
    expect(answered).toMatchObject({ kind: 'comment', inboundExternalId: question.externalId,
      draftDigest: replyDigest({ jobId: recent.id, parentExternalId: question.externalId, text: 'Reply: Do you ship to Spain?' }) })
    // No drafting call for the none item; the comment's context holds the post and its chain with the brand's reply.
    expect(drafter.inputs).toHaveLength(2)
    const input = drafter.inputs.find(value => value.comment?.text === 'Do you ship to Spain?')!
    expect(input).toMatchObject({ post: 'New collection out now', maxLength: { value: 200, unit: 'characters' } })
    expect(input.thread!.map(item => [item.fromChannel, item.text])).toEqual([[false, 'Lovely colours'], [true, 'Thank you!']])
    expect((await listDraftOutbox(context, 10)).items.find(item => item.responseId === question.id)).toMatchObject({ jobId: recent.id, conversationId: null })
  })

  it('sends an engine draft automatically only through every guard; a person\'s approval is unchanged', async () => {
    const page = await channel()
    await put()
    advance(minute)
    const chat = await conversation(page)
    await message(chat, 'Can you auto answer this?')
    const other = await conversation(page)
    await message(other, 'A question for a person')
    await runAnswering(context)
    const [auto] = await draftsOf(chat.id)
    const [review] = await draftsOf(other.id)
    expect(auto).toMatchObject({ outcome: 'auto', reason: 'above_threshold' })
    expect(review).toMatchObject({ outcome: 'review' })

    const refused = (input: MessageSubmission) => expect(submitMessage(context, org, input)).rejects
    await refused(automaticMessage(auto!, { conversationId: other.id })).toMatchObject({ status: 409, code: 'guard_draft' })
    await refused(automaticMessage(review!)).toMatchObject({ code: 'guard_decision' })
    await refused(automaticMessage(auto!, { text: 'An edited reply' })).toMatchObject({ code: 'guard_digest' })
    await refused(automaticMessage(auto!, { revision: 2 })).toMatchObject({ code: 'guard_revision' })
    await refused(automaticMessage(auto!, { sendAt: new Date(auto!.createdAt.getTime() + minute) })).toMatchObject({ code: 'guard_delay' })
    await put({ enabled: false })
    await refused(automaticMessage(auto!)).toMatchObject({ code: 'guard_settings' })
    await put({ kinds: { messages: false, comments: true } })
    await refused(automaticMessage(auto!)).toMatchObject({ code: 'guard_settings' })
    await put()
    await refused({ ...automaticMessage(auto!), draftId: randomUUID() }).toMatchObject({ code: 'guard_draft' })
    // The engine's stored risk decides, not the dashboard: a missing risk, or one at the stored threshold, is refused.
    const stored = { riskLevel: auto!.riskLevel, riskScore: auto!.riskScore, riskProbabilities: auto!.riskProbabilities, riskConfidence: auto!.riskConfidence }
    expect(auto).toMatchObject({ riskLevel: 'low', riskScore: 7, riskThreshold: 30 })
    await db.update(inboundDrafts).set({ riskLevel: null, riskScore: null, riskProbabilities: null, riskConfidence: null }).where(eq(inboundDrafts.id, auto!.id))
    await refused(automaticMessage(auto!)).toMatchObject({ code: 'guard_decision' })
    await db.update(inboundDrafts).set({ ...stored, riskThreshold: null }).where(eq(inboundDrafts.id, auto!.id))
    await refused(automaticMessage(auto!)).toMatchObject({ code: 'guard_decision' })
    await db.update(inboundDrafts).set({ riskThreshold: 7 }).where(eq(inboundDrafts.id, auto!.id))
    await refused(automaticMessage(auto!)).toMatchObject({ code: 'guard_decision' })
    // A higher threshold in today's settings does not lift the one stored with the decision; a lower one applies.
    await put({ riskThreshold: 100 })
    await refused(automaticMessage(auto!)).toMatchObject({ code: 'guard_decision' })
    await db.update(inboundDrafts).set({ riskThreshold: 30 }).where(eq(inboundDrafts.id, auto!.id))
    await put({ riskThreshold: 7 })
    await refused(automaticMessage(auto!)).toMatchObject({ code: 'guard_decision' })
    await put()

    const accepted = await submitMessage(context, org, automaticMessage(auto!))
    expect(accepted).toMatchObject({ created: true, message: { state: 'queued', approvedVia: 'automation', draftId: auto!.id } })
    await refused(automaticMessage(auto!)).toMatchObject({ code: 'guard_used' })
    // A draft taken by an automatic send is not superseded by a newer one.
    advance(minute)
    await message(chat, 'One more thing')
    await runAnswering(context)
    expect((await draftsOf(chat.id)).find(row => row.id === auto!.id)).toMatchObject({ supersededBy: null })
    // A superseded draft is refused.
    const third = await conversation(page)
    await message(third, 'Please auto answer')
    await runAnswering(context)
    const [older] = await draftsOf(third.id)
    advance(minute)
    await message(third, 'Please auto answer, again')
    await runAnswering(context)
    await refused(automaticMessage((await draftsOf(third.id)).find(row => row.id === older!.id)!, { sendAt: new Date(now.getTime() + minute) }))
      .toMatchObject({ code: 'guard_superseded' })

    // A person's approval: no draft, no guards, as before.
    const messageId = randomUUID()
    const text = 'Written by a person'
    const digest = messageDigest({ conversationId: other.id, text })
    const person = await submitMessage(context, org, { requestKey: messageRequestKey(org, messageId, 3, digest), messageId, revision: 3, digest, conversationId: other.id,
      text, approvedByUserId: 'u1', approvedAt: now.toISOString(), sendAt: new Date(now.getTime() + minute).toISOString() })
    expect(person).toMatchObject({ created: true, message: { approvedVia: 'person', draftId: null } })
    expect((await db.select().from(outgoingMessages)).map(row => row.approvedVia).sort()).toEqual(['automation', 'person'])
  })

  it('guards automatic comment replies the same way', async () => {
    const page = await channel()
    await put()
    advance(minute)
    const job = await post(page, day)
    const asked = await comment(job, 'Please auto answer: do you ship?')
    const sibling = await comment(job, 'Another comment')
    await runAnswering(context)
    const [draft] = await db.select().from(inboundDrafts).where(eq(inboundDrafts.responseId, asked.id))
    expect(draft).toMatchObject({ outcome: 'auto' })
    advance(minute)
    const submission = (parentExternalId: string, text = draft!.draftText!): ReplySubmission => {
      const replyId = randomUUID()
      const digest = replyDigest({ jobId: job.id, parentExternalId, text })
      return { requestKey: replyRequestKey(org, replyId, 1, digest), replyId, revision: 1, digest, jobId: job.id, parentExternalId, text, approvedByUserId: 'u1',
        approvedAt: now.toISOString(), sendAt: new Date(draft!.createdAt.getTime() + 2 * minute).toISOString(), approvedVia: 'automation', draftId: draft!.id }
    }
    await expect(submitReply(context, org, submission(sibling.externalId))).rejects.toMatchObject({ code: 'guard_draft' })
    await expect(submitReply(context, org, submission(asked.externalId, 'Edited'))).rejects.toMatchObject({ code: 'guard_digest' })
    await db.update(inboundDrafts).set({ riskScore: 30, riskLevel: 'medium' }).where(eq(inboundDrafts.id, draft!.id))
    await expect(submitReply(context, org, submission(asked.externalId))).rejects.toMatchObject({ code: 'guard_decision' })
    await db.update(inboundDrafts).set({ riskScore: draft!.riskScore, riskLevel: draft!.riskLevel }).where(eq(inboundDrafts.id, draft!.id))
    expect(await submitReply(context, org, submission(asked.externalId))).toMatchObject({ created: true, reply: { approvedVia: 'automation', draftId: draft!.id } })
    await expect(submitReply(context, org, submission(asked.externalId))).rejects.toMatchObject({ code: 'guard_used' })
    expect(await db.select().from(replies)).toHaveLength(1)
  })

  it('assesses the risk of every DM and comment it decides, and keeps the risky ones for a person', async () => {
    const page = await channel()
    await put({ cases: [{ id: 'hours', effect: 'always', label: '', authors: [], keywords: ['opening hours'], channelIds: [] },
      { id: 'press', effect: 'never', label: '', authors: [], keywords: ['journalist'], channelIds: [] }] })
    advance(minute)
    const risky = await conversation(page)
    await message(risky, 'Please auto answer, it is risky')
    const plain = await conversation(page)
    await message(plain, 'Please auto answer')
    const job = await post(page, day)
    const always = await comment(job, 'What are your opening hours? risky')
    const never = await comment(job, 'A journalist here')
    expect(await runAnswering(context)).toEqual({ drafted: 4, failed: 0 })
    // Both questions in one call where the answer is asked; the risk alone for the cases.
    expect(decision.questions.toSorted()).toEqual([['answer', 'risk'], ['answer', 'risk'], ['risk'], ['risk']])
    const [high] = await draftsOf(risky.id)
    expect(high).toMatchObject({ outcome: 'review', reason: 'risk_above_threshold', probabilities: { full: 0.95 }, riskLevel: 'high', riskScore: 88,
      riskProbabilities: { low: 0.05, medium: 0.15, high: 0.8 }, riskConfidence: 0.7, riskThreshold: 30, draftText: 'Reply: Please auto answer, it is risky' })
    expect((await draftsOf(plain.id))[0]).toMatchObject({ outcome: 'auto', reason: 'above_threshold', riskLevel: 'low', riskScore: 7 })
    const rows = await db.select().from(inboundDrafts)
    expect(rows.find(row => row.responseId === always.id)).toMatchObject({ outcome: 'review', reason: 'risk_above_threshold', caseId: 'hours', riskScore: 88,
      probabilities: null, decisionModel: 'd1.1-test' })
    expect(rows.find(row => row.responseId === never.id)).toMatchObject({ outcome: 'review', reason: 'case_never', riskLevel: 'low', probabilities: null })
    // The risk travels with the decision: in the event and in the outbox.
    const created = await db.select().from(events).where(eq(events.kind, 'draft.created'))
    expect(created.find(event => (event.detail as { draftId: string }).draftId === high!.id)!.detail).toMatchObject({ reason: 'risk_above_threshold',
      risk: { level: 'high', score: 88, probabilities: { low: 0.05, medium: 0.15, high: 0.8 }, confidence: 0.7 }, riskThreshold: 30 })
    expect((await listDraftOutbox(context, 10)).items.find(item => item.id === high!.id)!.decision).toMatchObject({ outcome: 'review',
      reason: 'risk_above_threshold', risk: { level: 'high', score: 88 }, riskThreshold: 30 })
    // A stricter threshold holds back the low-risk item too.
    await put({ riskThreshold: 7 })
    const next = await conversation(page)
    await message(next, 'Please auto answer')
    await runAnswering(context)
    expect((await draftsOf(next.id))[0]).toMatchObject({ outcome: 'review', reason: 'risk_above_threshold', riskScore: 7, riskThreshold: 7 })
  })

  it('reads settings stored before the risk threshold existed with its default', async () => {
    await put()
    await fixture.migrator.query(`update answering_settings set settings = settings - 'riskThreshold' where organization_id = $1`, [org])
    expect(await getAnswering(context, org)).toMatchObject({ version, settings: { riskThreshold: 30 } })
    // The same push again, now carrying the default, is still the same push.
    expect(await putAnswering(context, org, { version, settings: baseSettings(), context: [{ id: 'e1', topic: 'shipping', body: 'Three days.' }] }))
      .toMatchObject({ version })
    const page = await channel()
    advance(minute)
    const chat = await conversation(page)
    await message(chat, 'Please auto answer')
    await runAnswering(context)
    expect((await draftsOf(chat.id))[0]).toMatchObject({ outcome: 'auto', riskThreshold: 30 })
  })

  it('keeps for a person a cleared item whose draft objects: flags, no answer needed, no text, too long', async () => {
    const page = await channel()
    await put()
    advance(minute)
    const cases: Array<[Partial<DraftOutput>, string, string[]]> = [
      [{ flags: ['missing_facts'] }, 'flagged', ['missing_facts']],
      [{ flags: ['injection_suspected'] }, 'flagged', ['injection_suspected']],
      [{ needsReply: false }, 'flagged', []],
      [{ reply: null, flags: ['unanswerable'] }, 'no_draft', ['unanswerable']],
      [{ reply: 'y'.repeat(201) }, 'draft_too_long', ['too_long']],
      [{}, 'above_threshold', []],
    ]
    for (const [output, reason, flags] of cases) {
      const chat = await conversation(page)
      await message(chat, 'Please auto answer')
      drafter.next = output
      await runAnswering(context)
      const [row] = await draftsOf(chat.id)
      expect(row, reason).toMatchObject({ outcome: reason === 'above_threshold' ? 'auto' : 'review', reason, draftFlags: flags })
    }
  })

  it('does not take the engine\'s own automatic reply for a person\'s answer: a follow-up gets its own draft', async () => {
    const page = await channel()
    await put()
    advance(minute)
    const chat = await conversation(page)
    await message(chat, 'Please auto answer: do you ship?')
    await runAnswering(context)
    const [first] = await draftsOf(chat.id)
    expect(first).toMatchObject({ outcome: 'auto' })
    // The person writes again; the automatic reply then goes out and is read back after it, before the next pass.
    advance(10 * second)
    await message(chat, 'And to Portugal?')
    const accepted = await submitMessage(context, org, automaticMessage(first!, { sendAt: new Date(first!.createdAt.getTime() + 2 * minute) }))
    expect(accepted.created).toBe(true)
    advance(2 * minute)
    const sent = await message(chat, first!.draftText!, { direction: 'out' })
    await db.update(outgoingMessages).set({ state: 'sent', platformMessageId: sent.externalId }).where(eq(outgoingMessages.draftId, first!.id))
    expect(await runAnswering(context)).toEqual({ drafted: 1, failed: 0 })
    const followUp = (await draftsOf(chat.id)).find(row => row.id !== first!.id)!
    expect(followUp).toMatchObject({ draftText: 'Reply: And to Portugal?' })
    // The draft taken by the automatic send is not superseded.
    expect((await draftsOf(chat.id)).find(row => row.id === first!.id)).toMatchObject({ supersededBy: null })
    // A person's reply from the platform still counts as the answer.
    advance(minute)
    await message(chat, 'One more: and to Malta?')
    advance(second)
    await message(chat, 'Yes, Malta too.', { direction: 'out' })
    await runAnswering(context)
    expect((await draftsOf(chat.id)).map(row => row.draftText)).not.toContain('Reply: One more: and to Malta?')
  })

  it('does not process the comments seen while comments were off', async () => {
    const page = await channel()
    await put({ kinds: { messages: true, comments: false } })
    advance(minute)
    const job = await post(page, day)
    await comment(job, 'Seen while comments were off')
    advance(minute)
    await put()
    advance(minute)
    const fresh = await comment(job, 'Seen after')
    expect(await runAnswering(context)).toEqual({ drafted: 1, failed: 0 })
    expect((await db.select().from(inboundDrafts)).map(row => row.responseId)).toEqual([fresh.id])
  })

  it('tells the control plane after the commit, coalesced, signed, retried and finally dropped', async () => {
    const requests: ControlEventRequest[] = []
    let answer = true
    const target = { url: 'http://127.0.0.1:9/api/engines/social/events', key: controlEventKey(serviceToken),
      send: async (request: ControlEventRequest) => { requests.push(request); return answer } }
    await queueControlEvent(db, 'drafts.available', org, now)
    await queueControlEvent(db, 'drafts.available', org, now)
    await queueControlEvent(db, 'messages.changed', org, now)
    expect(await deliverControlEvents(context, target)).toEqual({ sent: 2, failed: 0 })
    expect(await db.select().from(controlEvents)).toEqual([])
    const request = requests.find(value => JSON.parse(value.body).type === 'drafts.available')!
    const body = JSON.parse(request.body) as { id: string, type: string, at: string, organizationId: string, data: object }
    expect(body).toEqual({ id: request.headers['x-openagency-event-id'], type: 'drafts.available', at: now.toISOString(), organizationId: org, data: {} })
    expect(request.headers['x-openagency-signature']).toBe(`v1=${signControlEvent(controlEventKey(serviceToken), Number(request.headers['x-openagency-timestamp']), request.body)}`)

    // A change that joins while the event is on its way is sent again, as a new event.
    const joining = { ...target, send: async (value: ControlEventRequest) => {
      requests.push(value)
      await queueControlEvent(db, 'replies.changed', org, now)
      return true
    } }
    await queueControlEvent(db, 'replies.changed', org, now)
    await deliverControlEvents(context, joining)
    const [again] = await db.select().from(controlEvents)
    expect(again).toMatchObject({ type: 'replies.changed', attemptCount: 0, generation: 2 })
    expect(again!.eventId).not.toBe(requests.at(-1)!.headers['x-openagency-event-id'])

    // Failures wait 1 s, 5 s, 30 s, 2 min and 10 min, then the event is dropped.
    answer = false
    const waits: number[] = []
    for (let attempt = 0; attempt <= controlEventRetryDelaysMs.length; attempt++) {
      expect(await deliverControlEvents(context, target)).toEqual({ sent: 0, failed: 1 })
      const [row] = await db.select().from(controlEvents)
      if (!row) break
      waits.push(row.nextAttemptAt.getTime() - now.getTime())
      now = row.nextAttemptAt
    }
    expect(waits).toEqual(controlEventRetryDelaysMs)
    expect(await db.select().from(controlEvents)).toEqual([])

    // A new change joining an event that waits out a failure goes out at once, from the first try.
    await queueControlEvent(db, 'drafts.available', org, now)
    await deliverControlEvents(context, target)
    expect(await db.select().from(controlEvents)).toMatchObject([{ attemptCount: 1, nextAttemptAt: new Date(now.getTime() + controlEventRetryDelaysMs[0]!) }])
    await queueControlEvent(db, 'drafts.available', org, now)
    expect(await db.select().from(controlEvents)).toMatchObject([{ attemptCount: 0, nextAttemptAt: now, generation: 2 }])
    // ...and so does one that joins while a send that fails is on its way.
    await deliverControlEvents(context, { ...target, send: async () => {
      await queueControlEvent(db, 'drafts.available', org, now)
      return false
    } })
    expect(await db.select().from(controlEvents)).toMatchObject([{ attemptCount: 0, nextAttemptAt: now, generation: 3, claimedUntil: null }])

    // Without a control plane URL nothing is written.
    await db.delete(controlEvents)
    enableControlEvents(false)
    await queueControlEvent(db, 'messages.changed', org, now)
    expect(await db.select().from(controlEvents)).toEqual([])
  })

  it('revises a draft for a person, storing only an event without text', async () => {
    const page = await channel()
    await put()
    const chat = await conversation(page)
    await message(chat, 'Do you ship to Spain?')
    const revised = await reviseDraft(context, org, { kind: 'message', conversationId: chat.id, current: 'Yes we do', instruction: 'Mention the three days' })
    expect(revised).toEqual({ text: 'Reply: Do you ship to Spain?', model: 'claude-haiku-5-5', flags: [] })
    expect(drafter.inputs[0]).toMatchObject({ requireDraft: true, voice: 'Friendly.', revise: { current: 'Yes we do', instruction: 'Mention the three days' } })
    const [event] = await db.select().from(events).where(eq(events.kind, 'draft.revised'))
    expect(JSON.stringify(event!.detail)).not.toMatch(/Spain|three days|Yes we do/)
    expect(await db.select().from(inboundDrafts)).toEqual([])

    drafter.next = { reply: null, flags: ['unanswerable'] }
    await expect(reviseDraft(context, org, { kind: 'message', conversationId: chat.id, current: null, instruction: 'Write one' }))
      .rejects.toMatchObject({ status: 422, code: 'no_draft', detail: { flags: ['unanswerable'] } })
    drafter.next = { reply: 'x'.repeat(201) }
    await expect(reviseDraft(context, org, { kind: 'message', conversationId: chat.id, current: null, instruction: 'Longer' }))
      .rejects.toMatchObject({ status: 422, code: 'draft_too_long', detail: { flags: ['too_long'], maxLength: 200 } })
    await expect(reviseDraft(context, org, { kind: 'message', conversationId: randomUUID(), current: null, instruction: 'x' })).rejects.toMatchObject({ status: 404 })
    // A tenant without answering settings never reaches the drafting model.
    const calls = drafter.inputs.length
    await expect(reviseDraft(context, `org-${randomUUID()}`, { kind: 'message', conversationId: chat.id, current: null, instruction: 'x' }))
      .rejects.toMatchObject({ status: 409, code: 'answering_not_configured' })
    expect(drafter.inputs).toHaveLength(calls)
    await expect(reviseDraft({ ...context, draftModel: undefined }, org, { kind: 'message', conversationId: chat.id, current: null, instruction: 'x' }))
      .rejects.toMatchObject({ status: 503, code: 'drafting_unavailable' })
  })

  it('fails closed without the models, and forgets drafts with the channel and after 180 days', async () => {
    const page = await channel()
    await put()
    advance(minute)
    const chat = await conversation(page)
    await message(chat, 'Please auto answer')
    const bare = { ...context, decisionModel: undefined, draftModel: undefined }
    expect(await runAnswering(bare)).toEqual({ drafted: 1, failed: 0 })
    expect((await draftsOf(chat.id))[0]).toMatchObject({ outcome: 'skipped', reason: 'no_decision_model', draftText: null, riskLevel: null, riskScore: null,
      riskThreshold: 30 })

    const keep = await conversation(page)
    await message(keep, 'Another one')
    await runAnswering(context)
    expect(await db.select().from(inboundDrafts)).toHaveLength(2)
    // A comment draft outlives nothing it answers either: the explicit sweep catches what the cascades leave.
    const job = await post(page, day)
    await comment(job, 'A comment')
    await runAnswering(context)
    expect(await db.select().from(inboundDrafts)).toHaveLength(3)
    advance(181 * day)
    // The post stays young enough to keep its comments; only the draft's own age removes it.
    await db.update(jobs).set({ publishAt: now }).where(eq(jobs.id, job.id))
    // The conversations go with their messages (the cascade takes their drafts); the comment's draft goes by age.
    expect(await applyRetention(context)).toMatchObject({ conversations: 2, drafts: 1 })
    expect(await db.select().from(inboundDrafts)).toEqual([])

    const gone = await channel()
    const goneChat = await conversation(gone)
    await message(goneChat, 'A question')
    await runAnswering(context)
    expect(await draftsOf(goneChat.id)).toHaveLength(1)
    await disableChannel(context, org, gone.id)
    expect(await db.select().from(inboundDrafts).where(eq(inboundDrafts.channelId, gone.id))).toEqual([])
  })
})
