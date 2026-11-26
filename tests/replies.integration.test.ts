import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { eq } from 'drizzle-orm'
import { toNodeListener } from 'h3'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { disableChannel, finishConnect, listChannels, setPublishing, startConnect } from '../src/channels.js'
import type { EngineContext } from '../src/context.js'
import { runnerKeyPair } from '../src/crypto/sealed.js'
import type { Database } from '../src/db/client.js'
import { CallBudget } from '../src/budget.js'
import { channels, events, jobs, postResponses, providerApps, replies, replyCancellations, responseChecks } from '../src/db/schema.js'
import { createEngineApp } from '../src/http/app.js'
import { listJobs, submitJobs } from '../src/jobs/service.js'
import { claimNext, executeClaimed } from '../src/jobs/worker.js'
import { pickOwnReply } from '../src/platforms/reply-match.js'
import { replyAvailability } from '../src/reply-availability.js'
import type {
  ConnectedAccount, FindReplyInput, PlatformAdapter, PlatformResponse, PublishInput, ReplyInput, ReplyOutcome, ReplyTargetInput,
} from '../src/platforms/types.js'
import { pinProviderScopes, providerScopes } from '../src/provider-scopes.js'
import {
  cancelReply, claimNextReply, executeReply, listReplies, reconcileDueReplies, replyDigest, replyReconcileDelaysMs, replyRequestKey, resolveReply,
  runReplies, settleReply, submitReply, sweepReplies, type ReplySubmission,
} from '../src/replies.js'
import { collectDueResponses, readResponses } from '../src/responses.js'
import { applyRetention } from '../src/retention.js'
import { linkBrowserChannel, putBrowserAccount } from '../src/vault.js'
import { postgresFixture } from './fixtures/postgres.js'
import { createWebhook } from '../src/webhooks.js'
import { webhookDeliveries } from '../src/db/schema.js'

const required = process.env.REQUIRE_DATABASE_TESTS === 'true'
const minute = 60_000
const hour = 60 * minute
const youtubeScope = 'https://www.googleapis.com/auth/youtube.force-ssl'

/** A fake platform: it publishes, holds the post's comments, creates replies and finds them again. */
class FakeReplyPlatform implements PlatformAdapter {
  accounts: ConnectedAccount[] = []
  comments: PlatformResponse[] = []
  created: Array<{ id: string, target: string, text: string, createdAt: number }> = []
  replyCalls: ReplyInput[] = []
  findCalls: FindReplyInput[] = []
  replyWith?: (input: ReplyInput) => Promise<ReplyOutcome>
  /** Pages each look reads; every page after the first is charged to the caller. */
  findPages = 1
  /** Parents of comments older than the stored responses, as the platform knows them. */
  threadParents: Record<string, string> = {}
  targetCalls: ReplyTargetInput[] = []

  constructor(readonly platform: 'meta' | 'youtube', private readonly now: () => Date, private readonly permission: string) {}
  authorizeUrl(_app: unknown, state: string) { return `https://example.test/oauth?state=${state}` }
  async finishConnect() { return this.accounts }
  limits() { return { maxLength: 100, maxMedia: 2 } }
  validateSettings() {}
  async publish(_app: unknown, input: PublishInput) { return { kind: 'published' as const, externalId: `post-${input.attemptId}` } }
  async reconcile() { return { kind: 'not_found' as const } }
  async responses() { return { kind: 'ok' as const, responses: this.comments } }
  // Facebook threads nest deeper than one level; YouTube's one.
  replyRules() { return { permission: this.permission, maxLength: 50, ...(this.platform === 'meta' ? { deepThreads: true } : {}) } }
  /** The platform creates the reply; the answer may still be lost on the way back. */
  create(input: Pick<ReplyInput, 'targetExternalId' | 'text'>) {
    const created = { id: `reply-${this.created.length + 1}`, target: input.targetExternalId, text: input.text, createdAt: this.now().getTime() }
    this.created.push(created)
    return created
  }
  async reply(_app: unknown, input: ReplyInput): Promise<ReplyOutcome> {
    this.replyCalls.push(input)
    if (this.replyWith) return this.replyWith(input)
    return { kind: 'sent', externalId: this.create(input).id }
  }
  async findReply(_app: unknown, input: FindReplyInput) {
    this.findCalls.push(input)
    for (let page = 1; page < this.findPages; page++) input.spendCall?.()
    return pickOwnReply(this.created.filter(value => value.target === input.targetExternalId).map(value => ({ ...value, own: true })), input)
  }
  async replyTarget(_app: unknown, input: ReplyTargetInput) {
    this.targetCalls.push(input)
    let current = input.commentExternalId
    while (this.threadParents[current]) current = this.threadParents[current]!
    return { kind: 'top' as const, externalId: current }
  }
}

// Concurrent submissions and the full reconcile schedule take seconds on a busy machine.
describe.skipIf(!required)('comment replies on PostgreSQL 17', { timeout: 30_000 }, () => {
  let fixture: Awaited<ReturnType<typeof postgresFixture>>
  let db: Database
  let meta: FakeReplyPlatform
  let youtube: FakeReplyPlatform
  let context: EngineContext
  let now: Date
  let org: string

  beforeAll(async () => {
    fixture = await postgresFixture()
    db = fixture.db
    await db.insert(providerApps).values([
      { id: 'meta-agency', platform: 'meta', externalAppId: '111', ownerKind: 'agency', secretRef: 'meta-agency' },
      { id: 'google-agency', platform: 'youtube', externalAppId: '333', ownerKind: 'agency', secretRef: 'google-agency' },
    ])
  }, 120_000)
  afterAll(async () => { await fixture?.cleanup() }, 30_000)

  beforeEach(async () => {
    await fixture.migrator.query('truncate learned_answers, inbound_drafts, control_events, answering_settings, outgoing_message_cancellations, outgoing_messages, direct_messages, conversations, conversation_checks, webhook_deliveries, webhooks, channel_activity, replies, reply_cancellations, post_metric_samples, channel_metric_samples, channel_metrics, post_responses, response_checks, post_metrics, attempts, jobs, events, media_chunks, media, oauth_states, channel_credentials, channels, publishing_controls, browser_accounts')
    now = new Date('2030-01-01T10:00:00Z')
    org = `org-${randomUUID()}`
    meta = new FakeReplyPlatform('meta', () => now, 'pages_manage_engagement')
    youtube = new FakeReplyPlatform('youtube', () => now, youtubeScope)
    context = { db, adapters: new Map<'meta' | 'youtube', PlatformAdapter>([['meta', meta], ['youtube', youtube]]), keyring: { activeKeyId: 'k1', keys: new Map([['k1', randomBytes(32)]]) },
      providerSecrets: new Map([['meta-agency', 'agency-secret'], ['google-agency', 'google-secret']]), now: () => now }
  })

  const advance = (ms: number) => { now = new Date(now.getTime() + ms) }
  // As the platforms' readers return them: each tells whether the brand wrote it.
  const comment = (id: string, extra: Partial<PlatformResponse> = {}): PlatformResponse => ({ externalId: id, parentExternalId: null, authorName: 'Mario Rossi',
    authorHandle: null, text: `text ${id}`, likeCount: 0, replyCount: 0, publishedAt: now, url: null, fromChannel: false, ...extra })

  async function connect(platform = meta, options: { organizationId?: string, grantedScopes?: string[], externalId?: string } = {}) {
    platform.accounts = [{ kind: platform === youtube ? 'youtube_channel' : 'facebook_page', externalId: options.externalId ?? `acct-${randomUUID()}`, name: 'Bottega',
      token: 'token-secret', tokenExpiresAt: null, ...(options.grantedScopes ? { grantedScopes: options.grantedScopes } : {}) }]
    const organizationId = options.organizationId ?? org
    const { state } = await startConnect(context, organizationId, platform === youtube ? 'google-agency' : 'meta-agency')
    return (await finishConnect(context, organizationId, state, 'code')).channels[0]!
  }

  /** A published post with a comment and a reply to it, as the collector stored them. */
  async function publishedPost(platform = meta, options: Parameters<typeof connect>[1] = {}) {
    const organizationId = options.organizationId ?? org
    const channel = await connect(platform, options)
    const postId = randomUUID()
    await submitJobs(context, { organizationId, postId, revision: 1, approvedByUserId: 'user-1', approvedAt: now.toISOString(),
      publishAt: new Date(now.getTime() + hour).toISOString(), content: 'Ciao Brescia', mediaIds: [], channels: [{ channelId: channel.id, settings: {} }] })
    advance(hour)
    await executeClaimed(context, (await claimNext(context))!)
    const [job] = (await listJobs(context, organizationId, postId)).jobs
    platform.comments = [comment('c1'), comment('c1-r1', { parentExternalId: 'c1' })]
    await collectDueResponses(context)
    return { channel, job: job! }
  }

  function replyFor(jobId: string, parentExternalId: string, options: { replyId?: string, revision?: number, text?: string, organizationId?: string } = {}): ReplySubmission {
    const replyId = options.replyId ?? randomUUID()
    const revision = options.revision ?? 1
    const text = options.text ?? 'Grazie mille!'
    const digest = replyDigest({ jobId, parentExternalId, text })
    return { requestKey: replyRequestKey(options.organizationId ?? org, replyId, revision, digest), replyId, revision, digest, jobId, parentExternalId, text,
      approvedByUserId: 'user-1', approvedAt: now.toISOString(), sendAt: new Date(now.getTime() + minute).toISOString() }
  }

  const view = async (requestKey: string, organizationId = org) => (await listReplies(context, organizationId, [requestKey]))[0]

  /** Runs every look at the platform an uncertain reply gets, moving the clock to each. */
  async function reconcileAll(id: string) {
    for (let round = 0; round < 20; round++) {
      await reconcileDueReplies(context)
      const [row] = await db.select().from(replies).where(eq(replies.id, id))
      if (!row!.reconciling) return row!
      if (row!.notBefore.getTime() > now.getTime()) now = row!.notBefore
    }
    throw new Error('still reconciling')
  }

  it('computes the request key the dashboard computes', () => {
    // The same vector is checked in the dashboard's tests.
    const digest = replyDigest({ jobId: '0d9c8b7a-6f5e-4d3c-8b2a-1f0e9d8c7b6a', parentExternalId: '1_2_3', text: 'Grazie mille!' })
    expect(digest).toBe(createHash('sha256').update('["social-reply-v1","0d9c8b7a-6f5e-4d3c-8b2a-1f0e9d8c7b6a","1_2_3","Grazie mille!"]').digest('hex'))
    expect(replyRequestKey('org-a', '123e4567-e89b-42d3-a456-426614174000', 2, digest))
      .toBe(createHash('sha256').update(`["social-reply-send-v1","org-a","123e4567-e89b-42d3-a456-426614174000",2,"${digest}"]`).digest('hex'))
  })

  it('accepts each request key once, even when two arrive together, and sends each reply once', async () => {
    const { job } = await publishedPost()
    const input = replyFor(job.id, 'c1')
    const first = await submitReply(context, org, input)
    expect(first).toMatchObject({ created: true, reply: { state: 'queued', parentExternalId: 'c1', targetExternalId: 'c1', replyId: input.replyId, revision: 1 } })
    expect(await submitReply(context, org, input)).toEqual({ created: false, reply: first.reply })
    await expect(submitReply(context, org, { ...input, sendAt: new Date(now.getTime() + 2 * minute).toISOString() })).rejects.toMatchObject({ code: 'revision_conflict' })
    // Another text for the same revision has another digest and key.
    await expect(submitReply(context, org, replyFor(job.id, 'c1', { replyId: input.replyId, text: 'Altro testo' }))).rejects.toMatchObject({ code: 'revision_conflict' })
    const twice = replyFor(job.id, 'c1')
    const results = await Promise.all([submitReply(context, org, twice), submitReply(context, org, twice)])
    expect(results.filter(result => result.created)).toHaveLength(1)
    expect(await db.select().from(replies)).toHaveLength(2)

    advance(minute)
    expect(await runReplies(context)).toMatchObject({ sent: 2 })
    expect(await runReplies(context)).toMatchObject({ sent: 0 })
    expect(meta.replyCalls).toHaveLength(2)
    // A sent reply's key still returns it, never a new send.
    expect(await submitReply(context, org, input)).toMatchObject({ created: false, reply: { state: 'sent' } })
  })

  it('refuses what it can check: digest, key, job, comment, text, pause, channel state and browser channels', async () => {
    const { job, channel } = await publishedPost()
    const input = replyFor(job.id, 'c1')
    await expect(submitReply(context, org, { ...input, digest: '0'.repeat(64) })).rejects.toMatchObject({ status: 400, code: 'digest_mismatch' })
    await expect(submitReply(context, org, { ...input, requestKey: 'f'.repeat(64) })).rejects.toMatchObject({ status: 400, code: 'request_key_mismatch' })
    await expect(submitReply(context, 'other-org', replyFor(job.id, 'c1', { organizationId: 'other-org' }))).rejects.toMatchObject({ status: 404 })
    await expect(submitReply(context, org, replyFor(job.id, 'unknown-comment'))).rejects.toMatchObject({ code: 'comment_gone' })
    await expect(submitReply(context, org, replyFor(job.id, 'c1', { text: 'x'.repeat(51) }))).rejects.toMatchObject({ status: 400, code: 'text_too_long' })
    await setPublishing(context, org, false, [channel.id])
    await expect(submitReply(context, org, input)).rejects.toMatchObject({ code: 'paused' })
    await setPublishing(context, org, false, [])
    await db.update(channels).set({ status: 'needs_reauth' }).where(eq(channels.id, channel.id))
    await expect(submitReply(context, org, input)).rejects.toMatchObject({ code: 'channel_inactive' })

    const account = await putBrowserAccount(db, runnerKeyPair().publicKey, { organizationId: org, platform: 'reddit', handle: 'bottega' }, { username: 'u', password: 'p' })
    const browserId = (await linkBrowserChannel(db, org, account.id)).channelId
    const [row] = await db.select().from(jobs).where(eq(jobs.id, job.id))
    const browserJob = randomUUID()
    await db.insert(jobs).values({ ...row!, id: browserJob, channelId: browserId })
    await expect(submitReply(context, org, replyFor(browserJob, 'c1'))).rejects.toMatchObject({ code: 'not_supported' })
    const [browser] = await db.select().from(channels).where(eq(channels.id, browserId))
    expect(replyAvailability(context, browser!)).toEqual({ available: false, reason: 'not_supported' })
    expect(await db.select().from(replies)).toEqual([])
  })

  it('sends at sendAt under the thread\'s top-level comment, and links the reply the collector reads back', async () => {
    const { job } = await publishedPost()
    const { reply } = await submitReply(context, org, replyFor(job.id, 'c1-r1'))
    expect(reply).toMatchObject({ parentExternalId: 'c1-r1', targetExternalId: 'c1' })
    expect(await claimNextReply(context)).toBeNull()
    advance(minute)
    expect(await runReplies(context)).toMatchObject({ sent: 1 })
    expect(meta.replyCalls).toEqual([expect.objectContaining({ targetExternalId: 'c1', text: 'Grazie mille!', postExternalId: job.receipt?.externalId ?? expect.any(String) })])
    expect(await view(reply.requestKey)).toMatchObject({ state: 'sent', platformReplyId: 'reply-1', settledBy: 'worker', attemptCount: 1, responseId: null })
    const [check] = await db.select().from(responseChecks).where(eq(responseChecks.jobId, job.id))
    expect(check!.nextCheckAt.getTime()).toBeLessThanOrEqual(now.getTime() + 30_000)

    meta.comments = [...meta.comments, comment('reply-1', { parentExternalId: 'c1', fromChannel: true, authorName: 'Bottega' })]
    advance(30_000)
    await collectDueResponses(context)
    const { responses } = await readResponses(context, org, { jobIds: [job.id], limit: 50 })
    expect(responses.find(value => value.externalId === 'reply-1')).toMatchObject({ fromChannel: true, replyId: reply.replyId })
    expect(responses.find(value => value.externalId === 'c1')).toMatchObject({ fromChannel: false, replyId: null })
    expect((await view(reply.requestKey))!.responseId).toEqual(responses.find(value => value.externalId === 'reply-1')!.id)
  })

  it('makes a crash after the claim and before the platform call uncertain, looks for a day, never resends, and lets a person resolve it', async () => {
    const { job } = await publishedPost()
    const { reply } = await submitReply(context, org, replyFor(job.id, 'c1'))
    advance(minute)
    // The worker commits the claim, then dies before calling the platform.
    const claimed = (await claimNextReply(context))!
    expect(await view(reply.requestKey)).toMatchObject({ state: 'sending', attemptCount: 1 })
    expect(await sweepReplies(context)).toEqual([])
    advance(6 * minute)
    expect(await sweepReplies(context)).toEqual([claimed.id])
    expect(await view(reply.requestKey)).toMatchObject({ state: 'uncertain', errorCode: 'abandoned', reconciling: true })
    expect(await claimNextReply(context)).toBeNull()

    const settled = await reconcileAll(claimed.id)
    expect(settled).toMatchObject({ state: 'uncertain', reconciling: false })
    expect(meta.findCalls).toHaveLength(replyReconcileDelaysMs.length)
    expect(now.getTime() - claimed.attemptedAt.getTime()).toBeGreaterThanOrEqual(24 * hour)
    expect(meta.findCalls[0]).toMatchObject({ targetExternalId: 'c1', text: 'Grazie mille!', since: new Date(claimed.attemptedAt.getTime() - 5 * minute) })
    expect(meta.replyCalls).toEqual([])

    expect((await resolveReply(context, org, reply.requestKey, 'not_sent')).reply).toMatchObject({ state: 'failed', errorCode: 'resolved_not_sent', settledBy: 'operator' })
    await expect(resolveReply(context, org, reply.requestKey, 'sent')).rejects.toMatchObject({ code: 'not_uncertain' })
    await expect(resolveReply(context, 'other-org', reply.requestKey, 'sent')).rejects.toMatchObject({ status: 404 })
  })

  it('makes a crash after the platform created the reply uncertain, then finds it and settles it as sent', async () => {
    const { job } = await publishedPost()
    const { reply } = await submitReply(context, org, replyFor(job.id, 'c1'))
    advance(minute)
    const claimed = (await claimNextReply(context))!
    // The platform creates the reply; the worker dies before recording it.
    meta.create({ targetExternalId: 'c1', text: 'Grazie mille!' })
    advance(6 * minute)
    await sweepReplies(context)
    expect(await view(reply.requestKey)).toMatchObject({ state: 'uncertain', errorCode: 'abandoned' })
    expect(await reconcileAll(claimed.id)).toMatchObject({ state: 'sent', platformReplyId: 'reply-1', settledBy: 'reconcile', reconciling: false })
    expect(meta.replyCalls).toEqual([])

    // A lost answer is uncertain too, and is never sent again.
    const lostInput = replyFor(job.id, 'c1', { text: 'Alla prossima!' })
    const lost = await submitReply(context, org, lostInput)
    meta.replyWith = async input => {
      meta.create(input)
      return { kind: 'uncertain', code: 'response_lost', detail: 'timeout' }
    }
    advance(minute)
    expect(await runReplies(context)).toMatchObject({ sent: 1 })
    expect(await view(lost.reply.requestKey)).toMatchObject({ state: 'uncertain', errorCode: 'response_lost', reconciling: true })
    expect(await submitReply(context, org, lostInput)).toMatchObject({ created: false, reply: { state: 'uncertain' } })
    advance(minute)
    await runReplies(context)
    expect(meta.replyCalls).toHaveLength(1)
    // The reply already held by the first one is left out of the match.
    expect(meta.findCalls.at(-1)!.excludeExternalIds).toEqual(['reply-1'])
    expect(await view(lost.reply.requestKey)).toMatchObject({ state: 'sent', platformReplyId: 'reply-2', settledBy: 'reconcile' })
  })

  it('still settles a reply as sent when the platform answers after the sweeper gave up on it', async () => {
    const { job } = await publishedPost()
    const { reply } = await submitReply(context, org, replyFor(job.id, 'c1'))
    advance(minute)
    const claimed = (await claimNextReply(context))!
    // The request leaves while the claim holds; the answer takes longer than the lease.
    meta.replyWith = async (input) => {
      advance(6 * minute)
      expect(await sweepReplies(context)).toEqual([claimed.id])
      return { kind: 'sent', externalId: meta.create(input).id }
    }
    await executeReply(context, claimed)
    expect(await view(reply.requestKey)).toMatchObject({ state: 'sent', platformReplyId: 'reply-1', settledBy: 'worker', reconciling: false })
  })

  // Review E5.
  it('sends nothing from a worker whose claim ran out before the platform request', async () => {
    const { job } = await publishedPost()
    const input = replyFor(job.id, 'c1')
    await submitReply(context, org, input)
    advance(minute)
    const claimed = (await claimNextReply(context))!
    // The worker stalls past its lease; the sweeper makes the reply uncertain, and a person may already be looking at it.
    advance(6 * minute)
    expect(await sweepReplies(context)).toHaveLength(1)
    expect(await executeReply(context, claimed)).toMatchObject({ kind: 'failed', code: 'claim_lost' })
    expect(meta.replyCalls).toHaveLength(0)
    expect(await view(input.requestKey)).toMatchObject({ state: 'uncertain', errorCode: 'abandoned', reconciling: true, attemptCount: 1 })
    expect((await db.select().from(events).where(eq(events.kind, 'reply.claim_lost')))).toHaveLength(1)
  })

  it('lets exactly one of a cancel and a claim win', async () => {
    const { job } = await publishedPost()
    let cancelled = 0
    let sent = 0
    for (let round = 0; round < 8; round++) {
      const { reply } = await submitReply(context, org, replyFor(job.id, 'c1', { text: `Grazie ${round}` }))
      advance(minute)
      const [cancel, claim] = await Promise.allSettled([cancelReply(context, org, reply.requestKey), claimNextReply(context)])
      const claimed = claim.status === 'fulfilled' ? claim.value : null
      if (cancel.status === 'fulfilled') {
        expect(cancel.value.reply).toMatchObject({ state: 'cancelled', errorCode: 'cancelled' })
        expect(claimed).toBeNull()
        cancelled++
      } else {
        expect(cancel.reason).toMatchObject({ code: 'too_late', detail: { state: 'sending' } })
        expect(claimed).not.toBeNull()
        await executeReply(context, claimed!)
        sent++
      }
    }
    expect(cancelled + sent).toBe(8)
    expect(meta.replyCalls).toHaveLength(sent)
    const states = (await db.select().from(replies)).map(row => row.state).sort()
    expect(states.filter(state => state === 'sent')).toHaveLength(sent)
  })

  it('refuses a submission that arrives after its key was cancelled', async () => {
    const { job } = await publishedPost()
    const input = replyFor(job.id, 'c1')
    expect((await cancelReply(context, org, input.requestKey)).reply).toMatchObject({ id: null, state: 'cancelled', errorCode: 'cancelled_before_submit' })
    expect(await submitReply(context, org, input)).toMatchObject({ created: false, reply: { state: 'cancelled', replyId: input.replyId } })
    expect(await db.select().from(replies)).toEqual([])
    expect(await view(input.requestKey)).toMatchObject({ state: 'cancelled', errorCode: 'cancelled_before_submit' })
    await expect(cancelReply(context, 'other-org', input.requestKey)).rejects.toMatchObject({ status: 404 })
    advance(31 * 86_400_000)
    await applyRetention(context)
    expect(await db.select().from(replyCancellations)).toEqual([])
  })

  it('never sends for a paused organization or channel', async () => {
    const { job, channel } = await publishedPost()
    const first = await submitReply(context, org, replyFor(job.id, 'c1'))
    await setPublishing(context, org, true, [])
    advance(minute)
    expect(await claimNextReply(context)).toBeNull()
    expect(await view(first.reply.requestKey)).toMatchObject({ state: 'cancelled', errorCode: 'paused' })
    await expect(submitReply(context, org, replyFor(job.id, 'c1'))).rejects.toMatchObject({ code: 'paused' })
    await setPublishing(context, org, false, [])
    const second = await submitReply(context, org, replyFor(job.id, 'c1'))
    await setPublishing(context, org, false, [channel.id])
    advance(minute)
    await runReplies(context)
    expect(await view(second.reply.requestKey)).toMatchObject({ state: 'cancelled', errorCode: 'paused' })
    expect(meta.replyCalls).toEqual([])
  })

  it('reports a missing permission it knows from the grant, until the channel connects again with it', async () => {
    const externalId = `page-${randomUUID()}`
    const { job, channel } = await publishedPost(meta, { grantedScopes: ['pages_manage_posts'], externalId })
    expect((await listChannels(context, org))[0]!.replies).toEqual({ available: false, reason: 'missing_permission', permission: 'pages_manage_engagement' })
    await expect(submitReply(context, org, replyFor(job.id, 'c1'))).rejects.toMatchObject({ code: 'missing_permission', detail: { permission: 'pages_manage_engagement' } })
    const again = await connect(meta, { grantedScopes: ['pages_manage_posts', 'pages_manage_engagement'], externalId })
    expect(again.id).toBe(channel.id)
    expect(again.replies).toEqual({ available: true, maxLength: 50 })

    const youtubeChannel = await connect(youtube, { grantedScopes: ['https://www.googleapis.com/auth/youtube.upload'] })
    expect(youtubeChannel.replies).toEqual({ available: false, reason: 'missing_permission', permission: 'youtube.force-ssl' })
  })

  it('learns a missing permission from a refused send, and forgets it when the channel connects again', async () => {
    const externalId = `page-${randomUUID()}`
    const { job } = await publishedPost(meta, { externalId })
    expect((await listChannels(context, org))[0]!.replies).toEqual({ available: true, maxLength: 50 })
    meta.replyWith = async () => ({ kind: 'failed', retryable: false, code: 'missing_permission', detail: 'HTTP 403 code 10', permission: 'pages_manage_engagement' })
    const { reply } = await submitReply(context, org, replyFor(job.id, 'c1'))
    advance(minute)
    await runReplies(context)
    expect(await view(reply.requestKey)).toMatchObject({ state: 'failed', errorCode: 'missing_permission', permission: 'pages_manage_engagement' })
    expect((await listChannels(context, org))[0]!.replies).toEqual({ available: false, reason: 'missing_permission', permission: 'pages_manage_engagement' })
    await expect(submitReply(context, org, replyFor(job.id, 'c1'))).rejects.toMatchObject({ code: 'missing_permission' })
    await connect(meta, { externalId })
    expect((await listChannels(context, org))[0]!.replies).toEqual({ available: true, maxLength: 50 })
  })

  it('marks the channel for a new login when the platform no longer accepts the grant', async () => {
    const { job } = await publishedPost()
    meta.replyWith = async () => ({ kind: 'failed', retryable: false, code: 'channel_inactive', detail: 'code 190', reauth: true })
    const { reply } = await submitReply(context, org, replyFor(job.id, 'c1'))
    advance(minute)
    await runReplies(context)
    expect(await view(reply.requestKey)).toMatchObject({ state: 'failed', errorCode: 'channel_inactive' })
    expect((await listChannels(context, org))[0]).toMatchObject({ status: 'needs_reauth', replies: { available: false, reason: 'channel_inactive' } })
  })

  it('retries a request that never left, at most three times and never past the hour', async () => {
    const { job } = await publishedPost()
    meta.replyWith = async () => ({ kind: 'failed', retryable: true, code: 'unreachable', detail: 'ECONNREFUSED' })
    const { reply } = await submitReply(context, org, replyFor(job.id, 'c1'))
    advance(minute)
    await runReplies(context)
    expect(await view(reply.requestKey)).toMatchObject({ state: 'queued', attemptCount: 1, errorCode: 'unreachable' })
    advance(minute)
    await runReplies(context)
    advance(2 * minute)
    await runReplies(context)
    expect(await view(reply.requestKey)).toMatchObject({ state: 'failed', attemptCount: 3, errorCode: 'unreachable' })
    expect(meta.replyCalls).toHaveLength(3)

    const late = await submitReply(context, org, replyFor(job.id, 'c1'))
    advance(2 * hour)
    await runReplies(context)
    expect(await view(late.reply.requestKey)).toMatchObject({ state: 'failed', errorCode: 'too_late', attemptCount: 0 })
    expect(meta.replyCalls).toHaveLength(3)
  })

  it('keeps each channel to 30 replies an hour and 200 a day', async () => {
    const { job, channel } = await publishedPost()
    for (let index = 0; index < 30; index++) await submitReply(context, org, replyFor(job.id, 'c1'))
    await expect(submitReply(context, org, replyFor(job.id, 'c1'))).rejects.toMatchObject({ code: 'rate_limited' })
    // A cancelled reply does not count.
    const [one] = await db.select().from(replies).limit(1)
    await cancelReply(context, org, one!.requestKey)
    await submitReply(context, org, replyFor(job.id, 'c1'))
    await expect(submitReply(context, org, replyFor(job.id, 'c1'))).rejects.toMatchObject({ code: 'rate_limited' })

    // Earlier: 170 more spread over the 17 hours before make 200 within a day.
    await db.insert(replies).values(Array.from({ length: 170 }, (_, index) => {
      const sendAt = new Date(now.getTime() - (2 + index * 0.1) * hour)
      return { organizationId: org, channelId: channel.id, jobId: job.id, requestKey: randomBytes(32).toString('hex'), replyId: randomUUID(), revision: 1,
        digest: randomBytes(32).toString('hex'), parentExternalId: 'c1', targetExternalId: 'c1', text: 'Grazie', approvedByUserId: 'user-1', approvedAt: sendAt,
        sendAt, notBefore: sendAt, state: 'sent' as const, attemptCount: 1 }
    }))
    advance(2 * hour)
    await expect(submitReply(context, org, replyFor(job.id, 'c1'))).rejects.toMatchObject({ code: 'daily_limit' })
  })

  it('keeps YouTube to 20 replies a Pacific day per Google project, across channels and tenants', async () => {
    const own = await publishedPost(youtube)
    const otherOrg = `org-${randomUUID()}`
    const other = await publishedPost(youtube, { organizationId: otherOrg })
    // Nineteen earlier today (Pacific) on the first channel.
    await db.insert(replies).values(Array.from({ length: 19 }, () => {
      const sendAt = new Date(now.getTime() - 3 * hour)
      return { organizationId: org, channelId: own.channel.id, jobId: own.job.id, requestKey: randomBytes(32).toString('hex'), replyId: randomUUID(), revision: 1,
        digest: randomBytes(32).toString('hex'), parentExternalId: 'c1', targetExternalId: 'c1', text: 'Grazie', approvedByUserId: 'user-1', approvedAt: sendAt,
        sendAt, notBefore: sendAt, state: 'sent' as const, attemptCount: 1 }
    }))
    await submitReply(context, otherOrg, replyFor(other.job.id, 'c1', { organizationId: otherOrg }))
    await expect(submitReply(context, org, replyFor(own.job.id, 'c1'))).rejects.toMatchObject({ code: 'daily_limit', detail: { limit: 20 } })
    await expect(submitReply(context, otherOrg, replyFor(other.job.id, 'c1', { organizationId: otherOrg }))).rejects.toMatchObject({ code: 'daily_limit' })
    // The count is in the database: a new day in Pacific time starts over, whatever the process did.
    advance(24 * hour)
    expect(await submitReply(context, org, replyFor(own.job.id, 'c1'))).toMatchObject({ created: true })
  })

  it('deletes replies with the post\'s responses after 180 days and with a disabled channel, which waits for unsettled replies', async () => {
    const first = await publishedPost()
    const second = await publishedPost()
    await submitReply(context, org, replyFor(first.job.id, 'c1'))
    const queued = await submitReply(context, org, replyFor(second.job.id, 'c1'))
    advance(minute)
    await claimNextReply(context).then(claimed => claimed && executeReply(context, claimed))
    await expect(disableChannel(context, org, second.channel.id)).rejects.toMatchObject({ code: 'channel_busy' })
    await cancelReply(context, org, queued.reply.requestKey).catch(() => undefined)
    await runReplies(context)
    expect((await db.select().from(replies)).every(row => !['queued', 'sending', 'uncertain'].includes(row.state))).toBe(true)
    await disableChannel(context, org, second.channel.id)
    expect((await db.select().from(replies)).map(row => row.channelId)).toEqual([first.channel.id])

    await db.update(jobs).set({ publishAt: new Date(now.getTime() - 181 * 86_400_000) }).where(eq(jobs.id, first.job.id))
    // A reply settled within the last day stays until the dashboard can have read it.
    expect(await applyRetention(context)).toMatchObject({ replies: 0 })
    advance(25 * hour)
    await db.update(jobs).set({ publishAt: new Date(now.getTime() - 181 * 86_400_000) }).where(eq(jobs.id, first.job.id))
    expect(await applyRetention(context)).toMatchObject({ replies: 1 })
    expect(await db.select().from(replies)).toEqual([])
  })

  // Review N3.
  it('settles the replies still open when their post expires, says so, and deletes them a day later', async () => {
    const { job } = await publishedPost()
    const queued = await submitReply(context, org, replyFor(job.id, 'c1'))
    const lost = await submitReply(context, org, replyFor(job.id, 'c1-r1', { text: 'Alla prossima!' }))
    await db.update(replies).set({ state: 'uncertain', attemptCount: 1, attemptedAt: now, reconciling: true, errorCode: 'response_lost' })
      .where(eq(replies.requestKey, lost.reply.requestKey))
    await db.update(jobs).set({ publishAt: new Date(now.getTime() - 181 * 86_400_000) }).where(eq(jobs.id, job.id))
    expect(await applyRetention(context)).toMatchObject({ replies: 0 })
    expect(await view(queued.reply.requestKey)).toMatchObject({ state: 'failed', errorCode: 'expired' })
    expect(await view(lost.reply.requestKey)).toMatchObject({ state: 'uncertain', errorCode: 'expired', reconciling: false })
    expect(await db.select().from(events).where(eq(events.kind, 'reply.expired'))).toHaveLength(2)
    // Nothing goes out for an expired post, and nothing is looked for.
    advance(minute)
    expect(await runReplies(context)).toMatchObject({ sent: 0, reconciled: { checked: 0 } })
    advance(25 * hour)
    await db.update(jobs).set({ publishAt: new Date(now.getTime() - 181 * 86_400_000) }).where(eq(jobs.id, job.id))
    expect(await applyRetention(context)).toMatchObject({ replies: 2 })
    expect(meta.replyCalls).toEqual([])
  })

  // Review E1.
  it('refuses a submission that arrives more than five minutes after its send time, and still answers a key it has', async () => {
    const { job } = await publishedPost()
    const late = (minutes: number, input = replyFor(job.id, 'c1')) => ({ ...input, approvedAt: new Date(now.getTime() - (minutes + 1) * minute).toISOString(),
      sendAt: new Date(now.getTime() - minutes * minute).toISOString() })
    await expect(submitReply(context, org, late(50))).rejects.toMatchObject({ status: 409, code: 'too_late', detail: { maxLatenessMs: 5 * minute } })
    expect(await claimNextReply(context)).toBeNull()
    expect(await db.select().from(replies)).toEqual([])
    // Four minutes late is still taken.
    const recent = late(4)
    expect(await submitReply(context, org, recent)).toMatchObject({ created: true, reply: { state: 'queued' } })
    // A key the engine has, or cancelled first, is answered whatever the time: a lost answer must not become a refusal.
    advance(10 * minute)
    expect(await submitReply(context, org, recent)).toMatchObject({ created: false, reply: { state: 'queued' } })
    const cancelled = late(20)
    await cancelReply(context, org, cancelled.requestKey)
    expect(await submitReply(context, org, cancelled)).toMatchObject({ created: false, reply: { state: 'cancelled' } })
  })

  // Review E2.
  it('never settles a reply with the platform ID of another same-text reply in the thread: both wait for a person', async () => {
    const { job } = await publishedPost()
    const neverSent = replyFor(job.id, 'c1')
    await submitReply(context, org, neverSent)
    advance(10_000)
    // To a reply in the same thread: posted under c1 as well.
    const created = replyFor(job.id, 'c1-r1')
    await submitReply(context, org, created)
    let calls = 0
    meta.replyWith = async (input) => {
      calls++
      // First request: lost before Meta created anything. Second: created, but the answer is lost.
      if (calls === 2) meta.create(input)
      return { kind: 'uncertain', code: 'response_lost', detail: 'timeout' }
    }
    advance(minute - 10_000)
    await executeReply(context, (await claimNextReply(context))!)
    advance(10_000)
    await executeReply(context, (await claimNextReply(context))!)
    expect(meta.created).toHaveLength(1)
    advance(2 * minute)
    await reconcileDueReplies(context)
    const byKey = async (key: string) => (await db.select().from(replies).where(eq(replies.requestKey, key)))[0]!
    // Either may own the one reply Meta has: neither takes its ID, and the looks stop for a person.
    for (const key of [neverSent.requestKey, created.requestKey]) {
      expect(await byKey(key)).toMatchObject({ state: 'uncertain', platformReplyId: null, errorCode: 'ambiguous', reconciling: false })
      expect(await view(key)).toMatchObject({ notSentAllowed: true })
    }
    expect(await db.select().from(events).where(eq(events.kind, 'reply.reconciled.rival'))).toHaveLength(2)

    // One platform ID belongs to one reply on a channel: the database refuses a second holder.
    const second = await byKey(created.requestKey)
    await resolveReply(context, org, created.requestKey, 'sent')
    await db.update(replies).set({ platformReplyId: meta.created[0]!.id }).where(eq(replies.id, second.id))
    await expect(db.update(replies).set({ platformReplyId: meta.created[0]!.id }).where(eq(replies.requestKey, neverSent.requestKey))).rejects.toThrow()
    // A worker's answer naming an ID another reply holds is a conflict for a person, not a second holder.
    const third = await submitReply(context, org, replyFor(job.id, 'c1', { text: 'Terza' }))
    advance(minute)
    const claimed = (await claimNextReply(context))!
    await settleReply(context, claimed, { kind: 'sent', externalId: meta.created[0]!.id })
    expect(await view(third.reply.requestKey)).toMatchObject({ state: 'uncertain', errorCode: 'platform_id_conflict', platformReplyId: null, reconciling: false })
  })

  // Review E3.
  it('lets a person say a reply did not go out only after the 15-minute look, keeps looking, and lets a found reply override them', async () => {
    const { job } = await publishedPost()
    const input = replyFor(job.id, 'c1')
    await submitReply(context, org, input)
    advance(minute)
    const claimed = (await claimNextReply(context))!
    advance(6 * minute)
    await sweepReplies(context)
    expect(await view(input.requestKey)).toMatchObject({ state: 'uncertain', notSentAllowed: false, resolution: null })
    await expect(resolveReply(context, org, input.requestKey, 'not_sent')).rejects.toMatchObject({ status: 409, code: 'still_checking' })
    // The looks at 1 and 5 minutes find nothing; the 15-minute one is still to come.
    await reconcileDueReplies(context)
    await reconcileDueReplies(context)
    expect(meta.findCalls).toHaveLength(2)
    await expect(resolveReply(context, org, input.requestKey, 'not_sent')).rejects.toMatchObject({ code: 'still_checking' })
    now = new Date(claimed.attemptedAt.getTime() + 15 * minute)
    await reconcileDueReplies(context)
    expect(await view(input.requestKey)).toMatchObject({ state: 'uncertain', notSentAllowed: true, reconciling: true })
    expect((await resolveReply(context, org, input.requestKey, 'not_sent')).reply)
      .toMatchObject({ state: 'failed', errorCode: 'resolved_not_sent', resolution: 'not_sent', reconciling: true, notSentAllowed: false })
    // The stalled worker's request completes: the platform created the reply and said so. The proof wins, and the conflict stays on record.
    await settleReply(context, claimed, { kind: 'sent', externalId: 'reply-late' })
    expect(await view(input.requestKey)).toMatchObject({ state: 'sent', platformReplyId: 'reply-late', resolution: 'not_sent', settledBy: 'worker', reconciling: false })
    expect(await db.select().from(events).where(eq(events.kind, 'reply.resolution_overridden'))).toHaveLength(1)

    // Said not sent, then found by a later look: settled as sent, the person's answer kept.
    const other = replyFor(job.id, 'c1-r1', { text: 'Alla prossima!' })
    await submitReply(context, org, other)
    advance(minute)
    const lost = (await claimNextReply(context))!
    advance(6 * minute)
    await sweepReplies(context)
    for (const at of [6, 6, 15]) {
      now = new Date(lost.attemptedAt.getTime() + at * minute)
      await reconcileDueReplies(context)
    }
    await resolveReply(context, org, other.requestKey, 'not_sent')
    // The reply shows up under the comment only now (the platform was slow to list it).
    meta.create({ targetExternalId: 'c1', text: 'Alla prossima!' })
    now = new Date(lost.attemptedAt.getTime() + hour)
    await reconcileDueReplies(context)
    expect(await view(other.requestKey)).toMatchObject({ state: 'sent', settledBy: 'reconcile', resolution: 'not_sent', platformReplyId: meta.created.at(-1)!.id })
  })

  // Review E4 (a control: it held before the review, and must still hold with retries counted).
  it('holds the YouTube app cap and the channel hour cap under concurrent submissions', async () => {
    const otherOrg = `org-${randomUUID()}`
    const first = await publishedPost(youtube, { grantedScopes: [youtubeScope] })
    const second = await publishedPost(youtube, { grantedScopes: [youtubeScope], organizationId: otherOrg })
    const submissions = Array.from({ length: 30 }, (_, index) => index % 2
      ? submitReply(context, org, replyFor(first.job.id, 'c1', { text: `Grazie ${index}` }))
      : submitReply(context, otherOrg, replyFor(second.job.id, 'c1', { text: `Grazie ${index}`, organizationId: otherOrg })))
    expect((await Promise.allSettled(submissions)).filter(result => result.status === 'fulfilled')).toHaveLength(20)
    const metaPost = await publishedPost(meta)
    const burst = await Promise.allSettled(Array.from({ length: 40 }, (_, index) => submitReply(context, org, replyFor(metaPost.job.id, 'c1', { text: `Ciao ${index}` }))))
    expect(burst.filter(result => result.status === 'fulfilled')).toHaveLength(30)
  })

  // Review N5.
  it('counts every YouTube insert that may reach Google against the day\'s 20, retries included', async () => {
    const own = await publishedPost(youtube)
    await db.insert(replies).values(Array.from({ length: 18 }, () => {
      const sendAt = new Date(now.getTime() - 3 * hour)
      return { organizationId: org, channelId: own.channel.id, jobId: own.job.id, requestKey: randomBytes(32).toString('hex'), replyId: randomUUID(), revision: 1,
        digest: randomBytes(32).toString('hex'), parentExternalId: 'c1', targetExternalId: 'c1', text: 'Grazie', approvedByUserId: 'user-1', approvedAt: sendAt,
        sendAt, notBefore: sendAt, state: 'sent' as const, attemptCount: 1 }
    }))
    youtube.replyWith = async () => ({ kind: 'failed', retryable: true, code: 'rate_limited', detail: 'HTTP 429' })
    const nineteenth = await submitReply(context, org, replyFor(own.job.id, 'c1', { text: 'Diciannove' }))
    const twentieth = await submitReply(context, org, replyFor(own.job.id, 'c1', { text: 'Venti' }))
    await expect(submitReply(context, org, replyFor(own.job.id, 'c1'))).rejects.toMatchObject({ code: 'daily_limit' })
    advance(minute)
    await runReplies(context)
    expect(youtube.replyCalls).toHaveLength(2)
    // Each retry would be a 21st insert today: neither is tried again.
    advance(2 * minute)
    await runReplies(context)
    expect(youtube.replyCalls).toHaveLength(2)
    for (const reply of [nineteenth, twentieth]) {
      expect(await view(reply.reply.requestKey)).toMatchObject({ state: 'failed', errorCode: 'daily_limit', attemptCount: 1 })
    }
  })

  // Review N4.
  it('charges every page a look reads, and leaves a platform out of its daily share without holding up the others', async () => {
    const tube = await publishedPost(youtube)
    const page = await publishedPost(meta)
    const uncertain = async (jobId: string, text: string) => {
      const { reply } = await submitReply(context, org, replyFor(jobId, 'c1', { text }))
      await db.update(replies).set({ state: 'uncertain', attemptCount: 1, attemptedAt: now, reconciling: true, notBefore: now, errorCode: 'response_lost' })
        .where(eq(replies.requestKey, reply.requestKey))
    }
    // Six YouTube replies are due before the Facebook one.
    for (let index = 0; index < 6; index++) await uncertain(tube.job.id, `Video ${index}`)
    advance(minute)
    await uncertain(page.job.id, 'Pagina')
    advance(minute)
    meta.findPages = 3
    const budget = new CallBudget(1, 3, () => now.getTime(), { youtube: 0 })
    await reconcileDueReplies(context, budget)
    expect(youtube.findCalls).toHaveLength(0)
    expect(meta.findCalls).toHaveLength(1)
    // One token for the look and one for each further page: the minute's three are spent.
    expect(budget.take('meta')).toBe(false)
  })

  // Review N10.
  it('reads a Facebook thread older than the stored responses up to its top-level comment before sending', async () => {
    const { job, channel } = await publishedPost()
    // The collector kept a reply whose parent is older than the newest few hundred responses.
    await db.insert(postResponses).values({ organizationId: org, channelId: channel.id, jobId: job.id, externalId: 'c9-r2', parentExternalId: 'c9-r1',
      authorName: 'Anna', authorHandle: null, text: 'Anche io!', likeCount: 0, replyCount: null, publishedAt: now, firstSeenAt: now, updatedAt: now, url: null, fromChannel: false })
    meta.threadParents = { 'c9-r1': 'c9' }
    const { reply } = await submitReply(context, org, replyFor(job.id, 'c9-r2'))
    expect(reply).toMatchObject({ parentExternalId: 'c9-r2', targetExternalId: 'c9-r1' })
    advance(minute)
    await runReplies(context)
    expect(meta.targetCalls).toEqual([expect.objectContaining({ commentExternalId: 'c9-r1' })])
    expect(meta.replyCalls).toEqual([expect.objectContaining({ targetExternalId: 'c9' })])
    expect(await view(reply.requestKey)).toMatchObject({ state: 'sent', targetExternalId: 'c9' })
    // Where replies nest one level (YouTube), a parent older than the stored responses is the top: nothing to read.
    const tube = await publishedPost(youtube)
    await db.insert(postResponses).values({ organizationId: org, channelId: tube.channel.id, jobId: tube.job.id, externalId: 'v9.r2', parentExternalId: 'v9',
      authorName: 'Anna', authorHandle: null, text: 'Anche io!', likeCount: 0, replyCount: null, publishedAt: now, firstSeenAt: now, updatedAt: now, url: null, fromChannel: false })
    const { reply: video } = await submitReply(context, org, replyFor(tube.job.id, 'v9.r2'))
    advance(minute)
    await runReplies(context)
    expect(youtube.targetCalls).toEqual([])
    expect(await view(video.requestKey)).toMatchObject({ state: 'sent', targetExternalId: 'v9' })
  })

  // Review N13.
  it('leaves unknown whether the brand wrote a response its reader did not say, until it is read again', async () => {
    const { job } = await publishedPost()
    const { responses } = await readResponses(context, org, { jobIds: [job.id], limit: 50 })
    expect(responses.find(value => value.externalId === 'c1')).toMatchObject({ fromChannel: false })
    // As stored before the engine told the brand's comments apart.
    await db.update(postResponses).set({ fromChannel: null }).where(eq(postResponses.externalId, 'c1'))
    expect((await readResponses(context, org, { jobIds: [job.id], limit: 50 })).responses.find(value => value.externalId === 'c1')).toMatchObject({ fromChannel: null })
    meta.comments = [...meta.comments, { ...comment('c2'), fromChannel: undefined }]
    advance(3 * minute)
    await collectDueResponses(context)
    const read = (await readResponses(context, org, { jobIds: [job.id], limit: 50 })).responses
    expect(read.find(value => value.externalId === 'c1')).toMatchObject({ fromChannel: false })
    expect(read.find(value => value.externalId === 'c2')).toMatchObject({ fromChannel: null })
  })

  // Review N14.
  it('pins a provider app\'s scopes without the reply-only ones until its consent screen grants them, and unpins them', async () => {
    expect(await providerScopes(db, 'google-agency')).toMatchObject({ platform: 'youtube', pinned: false, scopes: expect.arrayContaining([youtubeScope]) })
    expect(await pinProviderScopes(db, 'google-agency', ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly']))
      .toEqual({ platform: 'youtube', pinned: true, scopes: ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly'] })
    const [pinned] = await db.select().from(providerApps).where(eq(providerApps.id, 'google-agency'))
    expect(pinned!.settings.scopes).not.toContain(youtubeScope)
    expect(await pinProviderScopes(db, 'google-agency', null)).toMatchObject({ pinned: false, scopes: expect.arrayContaining([youtubeScope]) })
    expect((await db.select().from(providerApps).where(eq(providerApps.id, 'google-agency')))[0]!.settings).not.toHaveProperty('scopes')
    await expect(providerScopes(db, 'nope')).rejects.toMatchObject({ status: 404 })
  })

  it('serves the contract over HTTP and keeps tenants apart', async () => {
    const { job, channel } = await publishedPost()
    const token = 's'.repeat(48)
    const server = createServer(toNodeListener(createEngineApp(context, token)))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const call = async (path: string, init: RequestInit = {}) => {
      const result = await fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } })
      return { status: result.status, body: await result.json() as Record<string, unknown> }
    }
    try {
      expect((await call(`/v1/tenants/${org}/channels`)).body).toMatchObject({ channels: [{ id: channel.id, replies: { available: true, maxLength: 50 } }] })
      const input = replyFor(job.id, 'c1')
      const created = await call(`/v1/tenants/${org}/replies`, { method: 'POST', body: JSON.stringify(input) })
      expect(created).toMatchObject({ status: 201, body: { reply: { requestKey: input.requestKey, state: 'queued' } } })
      expect(await call(`/v1/tenants/${org}/replies`, { method: 'POST', body: JSON.stringify(input) })).toMatchObject({ status: 200 })
      expect(await call(`/v1/tenants/${org}/replies?requestKeys=${input.requestKey}`)).toMatchObject({ status: 200, body: { replies: [{ requestKey: input.requestKey }] } })
      expect(await call(`/v1/tenants/other-org/replies?requestKeys=${input.requestKey}`)).toEqual({ status: 200, body: { replies: [] } })
      expect((await call(`/v1/tenants/other-org/replies/${input.requestKey}/cancel`, { method: 'POST' })).status).toBe(404)
      expect(await call(`/v1/tenants/${org}/replies/${input.requestKey}/resolve`, { method: 'POST', body: JSON.stringify({ outcome: 'sent' }) }))
        .toMatchObject({ status: 409, body: { error: 'not_uncertain' } })
      expect(await call(`/v1/tenants/${org}/replies/${input.requestKey}/cancel`, { method: 'POST' })).toMatchObject({ status: 200, body: { reply: { state: 'cancelled' } } })
      expect((await call(`/v1/tenants/${org}/replies?requestKeys=nope`)).status).toBe(400)
      expect((await call(`/v1/tenants/${org}/replies`, { method: 'POST', body: JSON.stringify({ ...input, extra: true }) })).status).toBe(400)
      await setPublishing(context, org, false, [channel.id])
      expect(await call(`/v1/tenants/${org}/replies`, { method: 'POST', body: JSON.stringify(replyFor(job.id, 'c1')) })).toMatchObject({ status: 409, body: { error: 'paused' } })
      await db.update(channels).set({ grantedScopes: [] }).where(eq(channels.id, channel.id))
      await setPublishing(context, org, false, [])
      expect(await call(`/v1/tenants/${org}/replies`, { method: 'POST', body: JSON.stringify(replyFor(job.id, 'c1')) }))
        .toMatchObject({ status: 409, body: { error: 'missing_permission', detail: { permission: 'pages_manage_engagement' } } })
      const responses = await call(`/v1/tenants/${org}/responses?jobIds=${job.id}`)
      expect(responses.body.responses).toEqual(expect.arrayContaining([expect.objectContaining({ externalId: 'c1', fromChannel: false, replyId: null })]))
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('tells webhooks of sent and failed replies, and of a channel that needs a new login and comes back', async () => {
    const { job, channel } = await publishedPost()
    await createWebhook(context, org, { url: 'https://hooks.example.com/x', eventTypes: ['reply.sent', 'reply.failed', 'channel.status.changed'], channelIds: null, description: null })
    const events = async () => (await db.select().from(webhookDeliveries)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.eventType.localeCompare(b.eventType))
      .map(row => row.payload)
    const sent = await submitReply(context, org, replyFor(job.id, 'c1'))
    advance(minute)
    await runReplies(context)
    expect(await events()).toEqual([{ type: 'reply.sent', timestamp: now.toISOString(), data: { organizationId: org, replyId: sent.reply.replyId, revision: 1,
      requestKey: sent.reply.requestKey, jobId: job.id, postId: job.postId, channelId: channel.id, parentExternalId: 'c1', platformReplyId: 'reply-1', url: null,
      errorCode: null, settledBy: 'worker' } }])

    meta.replyWith = async () => ({ kind: 'failed', retryable: false, code: 'channel_inactive', detail: 'code 190', reauth: true })
    await submitReply(context, org, replyFor(job.id, 'c1', { text: 'Ancora grazie' }))
    advance(minute)
    await runReplies(context)
    expect((await events()).slice(1).map(event => [event.type, event.data.errorCode ?? event.data.status])).toEqual([
      ['channel.status.changed', 'needs_reauth'], ['reply.failed', 'channel_inactive']])
    expect((await events())[1]!.data).toMatchObject({ channelId: channel.id, status: 'needs_reauth', previousStatus: 'active', reason: 'reply_refused' })

    advance(minute)
    await connect(meta, { externalId: channel.externalId })
    expect((await events()).at(-1)).toMatchObject({ type: 'channel.status.changed', data: { status: 'active', previousStatus: 'needs_reauth', reason: 'reconnected' } })
  })
})
