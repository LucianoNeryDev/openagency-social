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
import { putAnswering } from '../src/answering/settings.js'
import type { EngineContext } from '../src/context.js'
import type { Database } from '../src/db/client.js'
import {
  channels, conversations, directMessages, inboundDrafts, jobs, learnedAnswers, outgoingMessages, postResponses, providerApps, type AnsweringSettings,
} from '../src/db/schema.js'
import { createEngineApp } from '../src/http/app.js'
import { claimNextMessage, messageDigest, messageRequestKey, resolveMessage, settleMessage, submitMessage, type MessageSubmission } from '../src/messages.js'
import type { PlatformAdapter } from '../src/platforms/types.js'
import { claimNextReply, replyDigest, replyRequestKey, settleReply, submitReply, type ReplySubmission } from '../src/replies.js'
import { applyRetention } from '../src/retention.js'
import { postgresFixture } from './fixtures/postgres.js'

const required = process.env.REQUIRE_DATABASE_TESTS === 'true'
const minute = 60_000
const day = 24 * 60 * minute
const serviceToken = 'example-service-token-0123456789abcdef'

/** A Page that can message and reply; the tests settle its sends themselves. */
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

/** Every item is a draft for a person to the model; "risky" is high risk, anything else low. */
class FakeDecision implements DecisionModel {
  questions: string[][] = []
  async decide(input: Parameters<DecisionModel['decide']>[0]) {
    const text = (input.state.item as { text: string }).text
    this.questions.push(Object.keys(input.questions))
    const risk = text.includes('risky') ? { choice: 'high' as const, probabilities: { low: 0.05, medium: 0.15, high: 0.8 }, confidence: 0.7 }
      : { choice: 'low' as const, probabilities: { low: 0.88, medium: 0.1, high: 0.02 }, confidence: 0.81 }
    return { model: 'd1.1-test', ...input.questions.answer ? { answer: { choice: 'draft' as const, probabilities: { full: 0.2, draft: 0.7, none: 0.1 }, confidence: 0.8 } } : {},
      risk }
  }
}

/** Adapts the learned reply when it has one ("Adapted: …"), else drafts "Reply: <what it answers>". */
class FakeDrafter implements DraftModel {
  inputs: DraftInput[] = []
  async draft(input: DraftInput) {
    this.inputs.push(input)
    const answered = input.kind === 'message' ? input.history?.at(-1)?.text : input.comment?.text
    const reply = input.learned ? `Adapted: ${input.learned.reply}` : `Reply: ${answered ?? 'nothing'}`
    const output: DraftOutput = { needsReply: true, reply, language: 'en', summary: 'A question.', flags: [] }
    return { model: 'claude-haiku-5-5', output }
  }
}

describe.skipIf(!required)('learned answers on PostgreSQL 17', { timeout: 60_000 }, () => {
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
    await fixture.migrator.query('truncate learned_answers, inbound_drafts, control_events, answering_settings, outgoing_message_cancellations, outgoing_messages, direct_messages, conversations, conversation_checks, channel_activity, webhook_deliveries, webhooks, replies, reply_cancellations, post_metric_samples, channel_metric_samples, channel_metrics, post_responses, response_checks, post_metrics, attempts, jobs, events, media_chunks, media, oauth_states, channel_credentials, channels, publishing_controls, browser_accounts')
    now = new Date('2030-01-01T10:00:00Z')
    org = `org-${randomUUID()}`
    decision = new FakeDecision()
    drafter = new FakeDrafter()
    context = { db, adapters: new Map([['meta', new FakePage()]]), keyring: { activeKeyId: 'k1', keys: new Map([['k1', randomBytes(32)]]) },
      providerSecrets: new Map([['meta-agency', 'agency-secret']]), now: () => now, decisionModel: decision, draftModel: drafter }
  })

  const advance = (ms: number) => { now = new Date(now.getTime() + ms) }
  const put = (overrides: Partial<AnsweringSettings> = {}) => putAnswering(context, org, { version: ++version, context: [], settings: {
    enabled: true, drafts: true, kinds: { messages: true, comments: true }, decisionModel: 'd1.1', decisionPrompt: 'Answer shipping questions.', decisionThreshold: 0.9,
    noneThreshold: 0.8, riskThreshold: 30, replyModel: 'haiku', voice: '', replyContext: '', delaySeconds: 120, cases: [], learning: true, learningSimilarity: 0.85,
    ...overrides } })

  async function channel() {
    const [row] = await db.insert(channels).values({ organizationId: org, providerAppId: 'meta-agency', platform: 'meta', kind: 'facebook_page',
      externalId: String(randomBytes(6).readUIntBE(0, 6)), name: 'Example Shop' }).returning()
    return row!
  }
  /** A conversation in which the person has just written `text`. */
  async function inbound(page: typeof channels.$inferSelect, text: string, name = 'Anna Bianchi') {
    const [chat] = await db.insert(conversations).values({ organizationId: org, channelId: page.id, platform: 'messenger', externalId: `t_${randomUUID()}`,
      participantExternalId: '2400001', participantName: name, updatedTime: now, lastMessageAt: now, lastInboundAt: now }).returning()
    await db.insert(directMessages).values({ organizationId: org, channelId: page.id, conversationId: chat!.id, externalId: `m_${randomUUID()}`, direction: 'in', text,
      sentAt: now, firstSeenAt: now })
    return chat!
  }
  const draftOf = async (conversationId: string) => (await db.select().from(inboundDrafts).where(eq(inboundDrafts.conversationId, conversationId)))[0]!
  const learned = () => db.select().from(learnedAnswers)

  function messageFor(conversationId: string, text: string, automatic?: typeof inboundDrafts.$inferSelect): MessageSubmission {
    const messageId = randomUUID()
    const digest = messageDigest({ conversationId, text })
    return { requestKey: messageRequestKey(org, messageId, 1, digest), messageId, revision: 1, digest, conversationId, text, approvedByUserId: 'user-1',
      approvedAt: now.toISOString(), sendAt: new Date(now.getTime() + (automatic ? 2 * minute : minute)).toISOString(),
      ...(automatic ? { approvedVia: 'automation' as const, draftId: automatic.id, approvedByUserId: 'automation' } : {}) }
  }
  /** Submits a message, lets its send time come, and settles it as the platform confirming it. */
  async function send(input: MessageSubmission) {
    await submitMessage(context, org, input)
    now = new Date(Math.max(now.getTime(), Date.parse(input.sendAt)))
    const claimed = (await claimNextMessage(context))!
    await settleMessage(context, claimed, { kind: 'sent', externalId: `out_${randomUUID()}` })
    return claimed.id
  }

  it('learns what a person approved, and answers the same or a similar message automatically when the risk is low', async () => {
    const page = await channel()
    await put()
    const first = await inbound(page, 'Do you ship to Spain and Portugal?')
    expect(await runAnswering(context)).toEqual({ drafted: 1, failed: 0 })
    const draft = await draftOf(first.id)
    expect(draft).toMatchObject({ outcome: 'review', reason: 'below_threshold', learnedAnswerId: null, draftText: 'Reply: Do you ship to Spain and Portugal?' })

    // A person edits the draft and sends it: once the platform confirms it, it is learned.
    await send(messageFor(first.id, 'Yes, in three days, at no extra cost.'))
    const [stored] = await learned()
    expect(stored).toMatchObject({ organizationId: org, channelId: page.id, kind: 'message', inboundText: 'Do you ship to Spain and Portugal?',
      normalizedText: 'do you ship to spain and portugal', replyText: 'Yes, in three days, at no extra cost.', language: 'en', sourceDraftId: draft.id, edited: true,
      addressesPerson: false, approvedByUserId: 'user-1', uses: 0, lastUsedAt: null, inboundAt: first.lastInboundAt })
    expect(stored!.fingerprint).toMatch(/^[0-9a-f]{32}$/)

    // A similar message: decided `learned_answer` without the answer question, and the drafting model adapts the learned reply.
    advance(minute)
    decision.questions = []
    const similar = await inbound(page, 'Hi! Do you ship to Spain and Portugal?')
    await runAnswering(context)
    const adapted = await draftOf(similar.id)
    expect(adapted).toMatchObject({ outcome: 'auto', reason: 'learned_answer', learnedAnswerId: stored!.id, riskScore: 7, draftModel: 'claude-haiku-5-5',
      draftText: 'Adapted: Yes, in three days, at no extra cost.' })
    expect(adapted.learnedSimilarity).toBeGreaterThanOrEqual(0.85)
    expect(adapted.learnedSimilarity).toBeLessThan(1)
    expect(decision.questions).toEqual([['risk']])
    expect(drafter.inputs.at(-1)!.learned).toEqual({ inbound: 'Do you ship to Spain and Portugal?', reply: 'Yes, in three days, at no extra cost.' })

    // The same text: the approved reply word for word, without the drafting model.
    advance(minute)
    const drafted = drafter.inputs.length
    const same = await inbound(page, 'do you ship to spain and portugal')
    await runAnswering(context)
    const reused = await draftOf(same.id)
    expect(reused).toMatchObject({ outcome: 'auto', reason: 'learned_answer', learnedAnswerId: stored!.id, learnedSimilarity: 1, draftModel: 'learned_answer',
      draftText: 'Yes, in three days, at no extra cost.', draftLanguage: 'en', draftDigest: messageDigest({ conversationId: same.id, text: 'Yes, in three days, at no extra cost.' }) })
    expect(drafter.inputs).toHaveLength(drafted)
    expect((await learned())[0]).toMatchObject({ uses: 2, lastUsedAt: now, updatedAt: stored!.updatedAt })

    // The outbox carries the learned answer.
    const { items } = await listDraftOutbox(context, 10)
    expect(items.find(item => item.id === reused.id)!.decision).toMatchObject({ reason: 'learned_answer', learnedAnswerId: stored!.id, learnedSimilarity: 1 })

    // An automatic send of it passes the guards and teaches nothing.
    advance(minute)
    await send(messageFor(same.id, reused.draftText!, reused))
    expect(await db.select({ state: outgoingMessages.state }).from(outgoingMessages).where(eq(outgoingMessages.draftId, reused.id))).toEqual([{ state: 'sent' }])
    expect(await learned()).toMatchObject([{ id: stored!.id, approvedAt: stored!.approvedAt, uses: 2 }])
  })

  it('keeps a high-risk match for a person, with the learned answer recorded', async () => {
    const page = await channel()
    await put()
    const first = await inbound(page, 'Is this risky to ship to Spain and Portugal?')
    await runAnswering(context)
    await send(messageFor(first.id, 'It ships insured, so no.'))
    expect(await learned()).toHaveLength(1)
    advance(minute)
    const again = await inbound(page, 'Hi, is this risky to ship to Spain and Portugal?')
    await runAnswering(context)
    expect(await draftOf(again.id)).toMatchObject({ outcome: 'review', reason: 'risk_above_threshold', learnedAnswerId: (await learned())[0]!.id, riskScore: 88,
      draftText: 'Adapted: It ships insured, so no.' })
    // Without a decision model the risk is unknown, and unknown never clears.
    advance(minute)
    const unknown = await inbound(page, 'is this risky to ship to spain and portugal')
    await runAnswering({ ...context, decisionModel: undefined })
    expect(await draftOf(unknown.id)).toMatchObject({ outcome: 'review', reason: 'risk_above_threshold', riskScore: null, learnedSimilarity: 1,
      draftModel: 'learned_answer' })
  })

  it('learns one answer per text, the newest approval winning, and neither follow-ups nor automatic sends', async () => {
    const page = await channel()
    await put()
    const first = await inbound(page, 'Do you ship to Spain and Portugal?')
    await runAnswering(context)
    await send(messageFor(first.id, 'Yes, in three days.'))
    // A second message of the brand to the same question is a follow-up: not learned.
    advance(minute)
    await send(messageFor(first.id, 'And shipping is free.'))
    expect(await learned()).toMatchObject([{ replyText: 'Yes, in three days.' }])
    // A newer approval for the same text replaces the reply; an answer written without an engine draft counts as edited.
    advance(minute)
    const second = await inbound(page, 'Do you ship to Spain and Portugal??')
    const newer = messageFor(second.id, 'Yes, in two days now.')
    await send(newer)
    const rows = await learned()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ replyText: 'Yes, in two days now.', sourceDraftId: null, edited: true, approvedAt: new Date(newer.approvedAt) })
    // An unedited draft sent by a person is learned as not edited.
    advance(minute)
    const third = await inbound(page, 'Can I pay by bank transfer please?')
    await runAnswering(context)
    await send(messageFor(third.id, (await draftOf(third.id)).draftText!))
    expect((await learned()).find(row => row.inboundText === 'Can I pay by bank transfer please?')).toMatchObject({ edited: false })
    // A person saying an uncertain message did go out teaches too.
    advance(minute)
    const fourth = await inbound(page, 'Do you have gift cards for sale?')
    const input = messageFor(fourth.id, 'Yes, from 10 euros.')
    await submitMessage(context, org, input)
    advance(minute)
    const claimed = (await claimNextMessage(context))!
    await settleMessage(context, claimed, { kind: 'uncertain', code: 'timeout', detail: 'timed out' })
    expect(await learned()).toHaveLength(2)
    await resolveMessage(context, org, input.requestKey, 'sent')
    expect(await learned()).toHaveLength(3)
  })

  it('never reuses word for word a reply that names the person it answered', async () => {
    const page = await channel()
    await put()
    const first = await inbound(page, 'Are you open on Sunday morning?', 'Marco Rossi')
    await runAnswering(context)
    await send(messageFor(first.id, 'Hi Marco, yes, from 9 to 13.'))
    expect(await learned()).toMatchObject([{ addressesPerson: true }])
    advance(minute)
    const same = await inbound(page, 'Are you open on Sunday morning?')
    await runAnswering(context)
    expect(await draftOf(same.id)).toMatchObject({ reason: 'learned_answer', learnedSimilarity: 1, draftModel: 'claude-haiku-5-5',
      draftText: 'Adapted: Hi Marco, yes, from 9 to 13.' })
    expect(drafter.inputs.at(-1)!.learned).toBeDefined()
  })

  it('refuses an automatic send once the learned answer changed, was forgotten or learning went off', async () => {
    const page = await channel()
    await put()
    const first = await inbound(page, 'Do you ship to Spain and Portugal?')
    await runAnswering(context)
    await send(messageFor(first.id, 'Yes, in three days.'))
    const [stored] = await learned()
    const drafts: Array<typeof inboundDrafts.$inferSelect> = []
    for (let index = 0; index < 3; index++) {
      advance(minute)
      const chat = await inbound(page, 'do you ship to spain and portugal')
      await runAnswering(context)
      drafts.push(await draftOf(chat.id))
    }
    expect(drafts.map(draft => draft.reason)).toEqual(['learned_answer', 'learned_answer', 'learned_answer'])
    advance(minute)
    await db.update(learnedAnswers).set({ replyText: 'Yes, in four days.', updatedAt: now }).where(eq(learnedAnswers.id, stored!.id))
    await expect(submitMessage(context, org, messageFor(drafts[0]!.conversationId!, drafts[0]!.draftText!, drafts[0]))).rejects.toMatchObject({ code: 'guard_decision' })
    await put({ learning: false })
    await db.update(learnedAnswers).set({ updatedAt: drafts[1]!.createdAt }).where(eq(learnedAnswers.id, stored!.id))
    await expect(submitMessage(context, org, messageFor(drafts[1]!.conversationId!, drafts[1]!.draftText!, drafts[1]))).rejects.toMatchObject({ code: 'guard_decision' })
    await put({ learning: true })
    await db.delete(learnedAnswers)
    await expect(submitMessage(context, org, messageFor(drafts[2]!.conversationId!, drafts[2]!.draftText!, drafts[2]))).rejects.toMatchObject({ code: 'guard_decision' })
  })

  it('with learning off matches nothing and learns nothing', async () => {
    const page = await channel()
    await put()
    const first = await inbound(page, 'Do you ship to Spain and Portugal?')
    await runAnswering(context)
    await send(messageFor(first.id, 'Yes, in three days.'))
    await put({ learning: false })
    advance(minute)
    const same = await inbound(page, 'Do you ship to Spain and Portugal?')
    await runAnswering(context)
    expect(await draftOf(same.id)).toMatchObject({ reason: 'below_threshold', learnedAnswerId: null })
    const other = await inbound(page, 'Can I pay by bank transfer please?')
    await runAnswering(context)
    await send(messageFor(other.id, 'Yes.'))
    expect(await learned()).toHaveLength(1)
  })

  it('learns comment replies per channel and kind, and answers the same comment from them', async () => {
    const page = await channel()
    const other = await channel()
    await put()
    const post = async (on: typeof page) => (await db.insert(jobs).values({ organizationId: org, postId: randomUUID(), revision: 1, channelId: on.id,
      payload: { content: 'New collection out now', mediaIds: [], settings: {}, approvedByUserId: 'u1', approvedAt: now.toISOString() }, payloadHash: 'h',
      publishAt: new Date(now.getTime() - day), notBefore: now, state: 'published', receipt: { externalId: `p_${randomUUID()}`, settledBy: 'worker' } }).returning())[0]!
    const comment = async (job: typeof jobs.$inferSelect, text: string) => (await db.insert(postResponses).values({ organizationId: org, channelId: job.channelId,
      jobId: job.id, externalId: `c_${randomUUID()}`, authorName: 'Anna Bianchi', authorHandle: 'anna.b', text, publishedAt: now, firstSeenAt: now, updatedAt: now,
      fromChannel: false }).returning())[0]!
    const job = await post(page)
    const asked = await comment(job, 'What sizes do you have for this jacket?')
    await runAnswering(context)
    const replyId = randomUUID()
    const text = 'From XS to XL, all in stock.'
    const digest = replyDigest({ jobId: job.id, parentExternalId: asked.externalId, text })
    const input: ReplySubmission = { requestKey: replyRequestKey(org, replyId, 1, digest), replyId, revision: 1, digest, jobId: job.id, parentExternalId: asked.externalId,
      text, approvedByUserId: 'user-2', approvedAt: now.toISOString(), sendAt: new Date(now.getTime() + minute).toISOString() }
    await submitReply(context, org, input)
    advance(minute)
    await settleReply(context, (await claimNextReply(context))!, { kind: 'sent', externalId: `r_${randomUUID()}` })
    expect(await learned()).toMatchObject([{ kind: 'comment', channelId: page.id, inboundText: 'What sizes do you have for this jacket?', replyText: text,
      approvedByUserId: 'user-2', inboundAt: job.publishAt, edited: true }])
    // The same comment again on the channel: answered from it; on another channel, or as a DM, it is not.
    advance(minute)
    const again = await comment(await post(page), 'what sizes do you have for this jacket')
    const elsewhere = await comment(await post(other), 'What sizes do you have for this jacket?')
    const dm = await inbound(page, 'What sizes do you have for this jacket?')
    await runAnswering(context)
    const byResponse = async (id: string) => (await db.select().from(inboundDrafts).where(eq(inboundDrafts.responseId, id)))[0]!
    expect(await byResponse(again.id)).toMatchObject({ outcome: 'auto', reason: 'learned_answer', draftText: text, learnedSimilarity: 1 })
    expect(await byResponse(elsewhere.id)).toMatchObject({ reason: 'below_threshold', learnedAnswerId: null })
    expect(await draftOf(dm.id)).toMatchObject({ reason: 'below_threshold', learnedAnswerId: null })
  })

  it('serves the dashboard: list newest first in pages, edit, forget one or a scope, tenant by tenant', async () => {
    const page = await channel()
    await put()
    for (const [index, question] of ['Do you ship to Spain?', 'Can I pay by bank transfer?', 'Are you open on Sunday?'].entries()) {
      advance(minute)
      const chat = await inbound(page, question)
      await send(messageFor(chat.id, `Answer ${index + 1}`))
    }
    const server: Server = createServer(toNodeListener(createEngineApp(context, serviceToken)))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/tenants/${org}/learned-answers`
    const headers = { authorization: `Bearer ${serviceToken}`, 'content-type': 'application/json' }
    const call = async (path: string, init: RequestInit = {}) => {
      const response = await fetch(`${base}${path}`, { ...init, headers })
      return { status: response.status, body: await response.json() as Record<string, unknown> }
    }
    try {
      expect((await fetch(base)).status).toBe(401)
      const firstPage = await call('?limit=2')
      const items = firstPage.body.learnedAnswers as Array<Record<string, unknown>>
      expect(items.map(item => item.replyText)).toEqual(['Answer 3', 'Answer 2'])
      expect(items[0]).toEqual({ id: expect.any(String), organizationId: org, channelId: page.id, kind: 'message', inboundText: 'Are you open on Sunday?',
        replyText: 'Answer 3', language: null, edited: true, addressesPerson: false, sourceDraftId: null, approvedByUserId: 'user-1', approvedAt: expect.any(String),
        uses: 0, lastUsedAt: null, createdAt: expect.any(String), updatedAt: expect.any(String), expiresAt: new Date(Date.parse(items[0]!.approvedAt as string) + 180 * day).toISOString() })
      const rest = await call(`?limit=2&after=${firstPage.body.next as string}`)
      expect((rest.body.learnedAnswers as Array<Record<string, unknown>>).map(item => item.replyText)).toEqual(['Answer 1'])
      expect(rest.body.next).toBeNull()
      expect((await call('?after=nope!')).status).toBe(400)

      const edited = await call(`/${items[0]!.id as string}`, { method: 'PATCH', body: JSON.stringify({ replyText: ' Yes, from 9. ' }) })
      expect(edited).toMatchObject({ status: 200, body: { learnedAnswer: { replyText: 'Yes, from 9.', addressesPerson: false } } })
      expect((await call(`/${items[0]!.id as string}`, { method: 'PATCH', body: JSON.stringify({ replyText: '' }) })).status).toBe(400)
      const foreign = await fetch(`${base.replace(org, 'other-org')}/${items[0]!.id as string}`, { method: 'DELETE', headers })
      expect(foreign.status).toBe(404)
      expect(await call(`/${items[0]!.id as string}`, { method: 'DELETE' })).toEqual({ status: 200, body: { deleted: 1 } })
      expect((await call(`/${items[0]!.id as string}`, { method: 'DELETE' })).status).toBe(404)
      expect((await call('', { method: 'DELETE' })).status).toBe(400)
      expect(await call(`?channelId=${page.id}&kind=comment`, { method: 'DELETE' })).toEqual({ status: 200, body: { deleted: 0 } })
      expect(await call(`?channelId=${page.id}`, { method: 'DELETE' })).toEqual({ status: 200, body: { deleted: 2 } })
      expect(await learned()).toEqual([])
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  })

  it('keeps the inbound text no longer than the item it came from', async () => {
    const page = await channel()
    await put()
    const chat = await inbound(page, 'Write to me at anna@example.it or +39 327 610 4460, do you ship to Spain?')
    await send(messageFor(chat.id, 'Yes.'))
    expect(await learned()).toMatchObject([{ inboundText: 'Write to me at [email] or [number], do you ship to Spain?' }])
    advance(179 * day)
    expect(await applyRetention(context)).toMatchObject({ learnedAnswers: 0 })
    advance(2 * day)
    expect(await applyRetention(context)).toMatchObject({ learnedAnswers: 1 })
    expect(await learned()).toEqual([])
  })
})
