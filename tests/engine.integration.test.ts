import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { eq, inArray } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { disableChannel, finishConnect, importChannel, listChannels, setPublishing, startConnect } from '../src/channels.js'
import { readCredential, refreshIdleCredentials } from '../src/credentials.js'
import type { EngineContext } from '../src/context.js'
import type { Database } from '../src/db/client.js'
import { channelActivity, webhookDeliveries, webhooks, type WebhookEventType, attempts, browserAccounts, channelCredentials, channelMetrics, channelMetricSamples, channels, events, jobs, media, postMetrics, postMetricSamples,
  postResponses, providerApps, responseChecks } from '../src/db/schema.js'
import * as schema from '../src/db/schema.js'
import { cancelJobs, listJobs, reconcileJob, resolveJob, restoreJobs, submitJobs, type SubmitInput } from '../src/jobs/service.js'
import { claimNext, executeClaimed, interrupted, lastStartMs, markSent, maxAttempts, requeueUnsent, settleAttempt, sweep, Worker } from '../src/jobs/worker.js'
import { pauseForRateLimit } from '../src/pause.js'
import { publishingHealth } from '../src/jobs/health.js'
import { AttemptClosedError } from '../src/platforms/types.js'
import { maxImageBytes, mediaChunkBytes, mediaFileBytes, mediaSignature, publicMediaKey, readMedia, storeMedia } from '../src/media.js'
import { collectDueMetrics, readMetricHistory, readMetrics } from '../src/metrics.js'
import {
  RateLimited, ReauthRequired, type AccountActivityInput, type AccountActivityResult, type AccountMetricsInput, type AccountMetricsResult, type ChannelCredential, type ConnectedAccount, type MediaInfo, type MetricsInput,
  type MetricsResult, type PlatformAdapter, type PlatformResponse, type PublishInput, type PublishOutcome, type ReconcileOutcome, type ResponsesInput, type ResponsesResult,
} from '../src/platforms/types.js'
import { CallBudget } from '../src/budget.js'
import { collectDueChannelMetrics, readChannelMetrics } from '../src/channel-metrics.js'
import { createEngineApp } from '../src/http/app.js'
import { collectDueResponses, readResponses, watchResponses } from '../src/responses.js'
import { checkDueTokens } from '../src/token-check.js'
import { applyRetention } from '../src/retention.js'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { toNodeListener } from 'h3'
import { openSecret, runnerKeyPair } from '../src/crypto/sealed.js'
import { checkBrowserLogin, linkBrowserChannel, listBrowserAccounts, putBrowserAccount } from '../src/vault.js'
import type { RunnerClient } from '../src/platforms/browser/runner-client.js'
import { postgresFixture } from './fixtures/postgres.js'
import { mp4 } from './fixtures/mp4.js'
import { createWebhook, deleteWebhook, deliverDueWebhooks, deliveryRetryDelaysMs, listDeliveries, listWebhooks, maxDeliveryAttempts, redeliver,
  rotateWebhookSecret, testWebhook, updateWebhook } from '../src/webhooks.js'
import { signWebhook, type WebhookRequest, type WebhookResult } from '../src/webhook-sender.js'
import { createHmac } from 'node:crypto'

const required = process.env.REQUIRE_DATABASE_TESTS === 'true'
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(32)])

class FakeAdapter implements PlatformAdapter {
  readonly platform = 'meta' as const
  accounts: ConnectedAccount[] = []
  outcomes: PublishOutcome[] = []
  published: PublishInput[] = []
  reconcileOutcome: ReconcileOutcome = { kind: 'not_found' }
  validated: MediaInfo[][] = []
  authorizeUrl(_app: unknown, state: string) { return `https://example.test/oauth?state=${state}` }
  async finishConnect() { return this.accounts }
  limits() { return { maxLength: 100, maxMedia: 2 } }
  validateSettings(_kind: unknown, settings: Record<string, unknown>, media: MediaInfo[]) {
    if ('bad' in settings) throw new Error('bad settings')
    this.validated.push(media)
  }
  /** Runs before the visible request, e.g. to hold the publish while a test stops the worker. */
  beforeVisible: (input: PublishInput) => Promise<void> = async () => undefined
  async publish(_app: unknown, input: PublishInput) {
    this.published.push(input)
    await this.beforeVisible(input)
    await input.beforeVisible?.()
    return this.outcomes.shift() ?? { kind: 'published' as const, externalId: `post-${this.published.length}` }
  }
  async reconcile() { return this.reconcileOutcome }
  metricsCalls: MetricsInput[] = []
  metricsWith: (input: MetricsInput) => Promise<MetricsResult> = async () => ({ values: { likes: 3, comments: 1, views: 40 }, unavailable: ['reach'] })
  async metrics(_app: unknown, input: MetricsInput) {
    this.metricsCalls.push(input)
    return this.metricsWith(input)
  }
  accountCalls: AccountMetricsInput[] = []
  accountWith: (input: AccountMetricsInput) => Promise<AccountMetricsResult> = async () => ({ values: { followers: 120, views: 40 }, unavailable: ['reach'] })
  async accountMetrics(_app: unknown, input: AccountMetricsInput) {
    this.accountCalls.push(input)
    return this.accountWith(input)
  }
  responseCalls: ResponsesInput[] = []
  responsesWith: (input: ResponsesInput) => Promise<ResponsesResult> = async () => ({ kind: 'ok', responses: [] })
  async responses(_app: unknown, input: ResponsesInput) {
    this.responseCalls.push(input)
    return this.responsesWith(input)
  }
  activityCalls: AccountActivityInput[] = []
  activityWith: (input: AccountActivityInput) => Promise<AccountActivityResult> = async () => ({ profile: { name: 'Bottega', username: 'bottega', description: null,
    website: null, category: null, pictureUrl: null }, posts: [] })
  async accountActivity(_app: unknown, input: AccountActivityInput) {
    this.activityCalls.push(input)
    return this.activityWith(input)
  }
  checks: string[] = []
  checkWith: () => Promise<void> = async () => undefined
  async checkCredential(_app: unknown, input: { channel: { id: string }, token: string }) {
    this.checks.push(input.channel.id)
    return this.checkWith()
  }
  keepAlive = false
  refreshes: ChannelCredential[] = []
  refreshWith: () => Promise<ChannelCredential> = async () => ({ accessToken: `renewed-${this.refreshes.length}`, expiresAt: new Date('2030-01-01T12:00:00Z') })
  async refreshCredential(_app: unknown, credential: ChannelCredential) {
    this.refreshes.push(credential)
    return this.refreshWith()
  }
}

describe.skipIf(!required)('engine on PostgreSQL 17', () => {
  let fixture: Awaited<ReturnType<typeof postgresFixture>>
  let db: Database
  let adapter: FakeAdapter
  let context: EngineContext
  let now: Date
  let org: string

  beforeAll(async () => {
    fixture = await postgresFixture()
    db = fixture.db
    await db.insert(providerApps).values([
      { id: 'meta-agency', platform: 'meta', externalAppId: '111', ownerKind: 'agency', secretRef: 'meta-agency' },
      { id: 'meta-tenant', platform: 'meta', externalAppId: '222', ownerKind: 'tenant', ownerOrganizationId: 'tenant-owner', secretRef: 'meta-tenant' },
    ])
  }, 120_000)
  afterAll(async () => { await fixture?.cleanup() }, 30_000)

  beforeEach(async () => {
    // Every test starts with no jobs, so the clock can restart each time.
    await fixture.migrator.query('truncate learned_answers, inbound_drafts, control_events, answering_settings, outgoing_message_cancellations, outgoing_messages, direct_messages, conversations, conversation_checks, channel_activity, webhook_deliveries, webhooks, replies, reply_cancellations, post_metric_samples, channel_metric_samples, channel_metrics, post_responses, response_checks, post_metrics, attempts, jobs, events, media_chunks, media, oauth_states, channel_credentials, channels, publishing_controls, browser_accounts')
    adapter = new FakeAdapter()
    now = new Date('2030-01-01T10:00:00Z')
    org = `org-${randomUUID()}`
    context = { db, adapters: new Map([['meta', adapter]]), keyring: { activeKeyId: 'k1', keys: new Map([['k1', randomBytes(32)]]) },
      providerSecrets: new Map([['meta-agency', 'agency-secret'], ['meta-tenant', 'tenant-secret']]), now: () => now }
  })

  async function connect(names = ['Bottega']) {
    adapter.accounts = names.map(name => ({ kind: 'facebook_page', externalId: `${name}-${randomUUID()}`, name, token: `token-${name}-secret`, tokenExpiresAt: null }))
    const { state } = await startConnect(context, org, 'meta-agency')
    return (await finishConnect(context, org, state, 'code')).channels
  }

  function submission(channelIds: string[], overrides: Partial<SubmitInput> = {}): SubmitInput {
    return { organizationId: org, postId: randomUUID(), revision: 1, approvedByUserId: 'user-1', approvedAt: now.toISOString(),
      publishAt: new Date(now.getTime() + 60 * 60_000).toISOString(), content: 'Ciao Brescia', mediaIds: [],
      channels: channelIds.map(channelId => ({ channelId, settings: {} })), ...overrides }
  }

  async function runDue() {
    const claimed = await claimNext(context)
    return claimed ? executeClaimed(context, claimed) : null
  }

  const advance = (ms: number) => { now = new Date(now.getTime() + ms) }

  it('applies migrations with separate roles and keeps the event log append-only', async () => {
    await expect(fixture.runtime.query('update events set kind = kind')).rejects.toThrow(/permission denied/)
    await expect(fixture.runtime.query('delete from events')).rejects.toThrow(/permission denied/)
    await expect(fixture.runtime.query('create table intruder (id int)')).rejects.toThrow(/permission denied/)
  })

  describe('connect', () => {
    it('stores channels with encrypted tokens and never returns them', async () => {
      const connected = await connect()
      expect(connected).toHaveLength(1)
      expect(JSON.stringify(connected)).not.toContain('secret')
      const [credential] = await db.select().from(channelCredentials).where(eq(channelCredentials.channelId, connected[0]!.id))
      expect(credential!.ciphertext.includes(Buffer.from('token-Bottega-secret'))).toBe(false)
    })

    it('uses each state once, only for its tenant and before expiry', async () => {
      adapter.accounts = []
      const first = await startConnect(context, org, 'meta-agency')
      await expect(finishConnect(context, 'other-org', first.state, 'code')).rejects.toMatchObject({ code: 'invalid_state' })
      await finishConnect(context, org, first.state, 'code')
      await expect(finishConnect(context, org, first.state, 'code')).rejects.toMatchObject({ code: 'invalid_state' })
      const second = await startConnect(context, org, 'meta-agency')
      advance(11 * 60_000)
      await expect(finishConnect(context, org, second.state, 'code')).rejects.toMatchObject({ code: 'invalid_state' })
    })

    it('hides tenant-owned apps from other tenants', async () => {
      await expect(startConnect(context, org, 'meta-tenant')).rejects.toMatchObject({ code: 'not_found' })
    })

    it('reactivates and updates a channel on reconnect', async () => {
      const [channel] = await connect()
      await db.update(channels).set({ status: 'needs_reauth' }).where(eq(channels.id, channel!.id))
      adapter.accounts = [{ ...adapter.accounts[0]!, name: 'Bottega Digitale', token: 'fresh-token' }]
      const { state } = await startConnect(context, org, 'meta-agency')
      const [again] = (await finishConnect(context, org, state, 'code')).channels
      expect(again).toMatchObject({ id: channel!.id, name: 'Bottega Digitale', status: 'active' })
    })
  })

  describe('submit', () => {
    it('creates one queued job per channel and is idempotent', async () => {
      const ids = (await connect(['A', 'B'])).map(channel => channel.id)
      const input = submission(ids)
      const first = await submitJobs(context, input)
      expect(first.created).toBe(true)
      expect(first.jobs.map(job => job.state)).toEqual(['queued', 'queued'])
      const again = await submitJobs(context, input)
      expect(again.created).toBe(false)
      expect(again.jobs.map(job => job.id).sort()).toEqual(first.jobs.map(job => job.id).sort())
      await expect(submitJobs(context, { ...input, content: 'Changed' })).rejects.toMatchObject({ code: 'revision_conflict' })
      await expect(submitJobs(context, { ...input, channels: input.channels.slice(0, 1) })).rejects.toMatchObject({ code: 'revision_conflict' })
    })

    it('returns the existing jobs for a resubmission even after publishAt has passed', async () => {
      const [channel] = await connect()
      const input = submission([channel!.id])
      await submitJobs(context, input)
      advance(2 * 60 * 60_000)
      expect((await submitJobs(context, input)).created).toBe(false)
    })

    it('rejects foreign channels, paused tenants, short lead times and invalid content', async () => {
      const [channel] = await connect()
      const foreign = await submitJobs(context, submission([channel!.id], { organizationId: 'someone-else' })).catch(error => error)
      expect(foreign).toMatchObject({ code: 'not_found' })
      await expect(submitJobs(context, submission([channel!.id], { publishAt: new Date(now.getTime() + 60_000).toISOString() }))).rejects.toMatchObject({ code: 'publish_at_too_soon' })
      await expect(submitJobs(context, submission([channel!.id], { content: 'x'.repeat(101) }))).rejects.toMatchObject({ code: 'content_too_long' })
      await expect(submitJobs(context, submission([channel!.id], { mediaIds: [randomUUID()] }))).rejects.toMatchObject({ code: 'not_found' })
      await setPublishing(context, org, false, [channel!.id])
      await expect(submitJobs(context, submission([channel!.id]))).rejects.toMatchObject({ code: 'paused' })
      await setPublishing(context, org, true, [])
      await expect(submitJobs(context, submission([channel!.id]))).rejects.toMatchObject({ code: 'paused' })
    })

    it('enforces the daily limit per channel, ignoring cancelled jobs', async () => {
      const [channel] = await connect()
      await setPublishing(context, org, false, [], 2)
      const first = submission([channel!.id])
      await submitJobs(context, first)
      await submitJobs(context, submission([channel!.id]))
      await expect(submitJobs(context, submission([channel!.id]))).rejects.toMatchObject({ code: 'daily_limit' })
      await cancelJobs(context, org, first.postId, 1)
      await submitJobs(context, submission([channel!.id]))
      // Another day has its own budget.
      await submitJobs(context, submission([channel!.id], { publishAt: new Date(now.getTime() + 26 * 60 * 60_000).toISOString() }))
    })

    it('refuses media owned by another tenant', async () => {
      const [channel] = await connect()
      const foreign = await storeMedia(context, 'another-org', 'a.png', 'image/png', png)
      await expect(submitJobs(context, submission([channel!.id], { mediaIds: [foreign.id] }))).rejects.toMatchObject({ code: 'not_found' })
    })
  })

  describe('media', () => {
    const mp4Head = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom')])
    async function* pieces(...values: Buffer[]) { yield* values }

    it('stores a video larger than a chunk and reads the same bytes back, in chunks', async () => {
      const whole = Buffer.concat([mp4Head, randomBytes(mediaChunkBytes * 2 + 5)])
      const stored = await storeMedia(context, org, 'long.mp4', 'video/mp4', pieces(whole.subarray(0, 100), whole.subarray(100, mediaChunkBytes + 7), whole.subarray(mediaChunkBytes + 7)))
      expect(stored).toMatchObject({ mimeType: 'video/mp4', sizeBytes: whole.length })
      const file = await readMedia(db, org, stored.id)
      const sizes: number[] = []
      for await (const chunk of file.chunks()) sizes.push(chunk.length)
      expect(sizes).toEqual([mediaChunkBytes, mediaChunkBytes, whole.length - mediaChunkBytes * 2])
      expect((await mediaFileBytes(file)).equals(whole)).toBe(true)
      const [row] = await db.select({ data: media.data, sha256: media.sha256 }).from(media).where(eq(media.id, stored.id))
      expect(row).toEqual({ data: null, sha256: createHash('sha256').update(whole).digest('hex') })
    })

    it('reads a video\'s length and codecs at upload, even with moov after a chunk of media data, and hands them to submit checks', async () => {
      const whole = mp4({ moovLast: true, mdatBytes: mediaChunkBytes + 1_000, durationMs: 95_000, width: 1920, height: 1080, rotate: true, videoCodec: 'hvc1' })
      const stored = await storeMedia(context, org, 'reel.mp4', 'video/mp4', pieces(whole.subarray(0, 100), whole.subarray(100, mediaChunkBytes + 7), whole.subarray(mediaChunkBytes + 7)))
      expect(stored).toMatchObject({ width: 1080, height: 1920, durationMs: 95_000, videoCodec: 'hvc1', audioCodec: 'mp4a' })
      const [channel] = await connect()
      await submitJobs(context, submission([channel!.id], { mediaIds: [stored.id] }))
      expect(adapter.validated[0]).toEqual([{ id: stored.id, mimeType: 'video/mp4', sizeBytes: whole.length, width: 1080, height: 1920,
        durationMs: 95_000, videoCodec: 'hvc1', audioCodec: 'mp4a' }])
      // A file that does not say keeps nulls, and is let through.
      const unknown = await storeMedia(context, org, 'odd.mp4', 'video/mp4', Buffer.concat([mp4Head, randomBytes(64)]))
      expect(unknown).toMatchObject({ durationMs: null, videoCodec: null, audioCodec: null })
    })

    it('keeps nothing of an upload that is refused or breaks part way', async () => {
      const before = (await db.select({ id: media.id }).from(media)).length
      await expect(storeMedia(context, org, 'a.mp4', 'video/mp4', Buffer.from('not a video at all'))).rejects.toMatchObject({ code: 'invalid_media' })
      await expect(storeMedia(context, org, 'a.png', 'image/png', Buffer.concat([mp4Head, Buffer.alloc(10)]))).rejects.toMatchObject({ code: 'invalid_media' })
      await expect(storeMedia(context, org, 'a.mp4', 'video/mp4', Buffer.alloc(0))).rejects.toMatchObject({ code: 'invalid_media' })
      const big = Buffer.alloc(maxImageBytes + 1)
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(big)
      await expect(storeMedia(context, org, 'a.png', 'image/png', big)).rejects.toMatchObject({ code: 'invalid_media' })
      await expect(storeMedia(context, org, 'a.mp4', 'video/mp4', (async function* () {
        yield Buffer.concat([mp4Head, randomBytes(mediaChunkBytes)])
        throw new Error('connection lost')
      })())).rejects.toThrow('connection lost')
      expect((await db.select({ id: media.id }).from(media)).length).toBe(before)
    })

    it('still reads a file stored before chunking', async () => {
      const whole = Buffer.concat([mp4Head, randomBytes(64)])
      const [row] = await db.insert(media).values({ organizationId: org, name: 'old.mp4', mimeType: 'video/mp4', sizeBytes: whole.length, sha256: 'x', data: whole }).returning({ id: media.id })
      expect((await mediaFileBytes(await readMedia(db, org, row!.id))).equals(whole)).toBe(true)
    })
  })

  describe('worker', () => {
    it('publishes at publishAt, records the attempt and the receipt', async () => {
      const [channel] = await connect()
      const image = await storeMedia(context, org, 'a.png', 'image/png', png)
      const input = submission([channel!.id], { mediaIds: [image.id] })
      await submitJobs(context, input)
      expect(await claimNext(context)).toBeNull()
      advance(60 * 60_000)
      expect(await runDue()).toMatchObject({ kind: 'published' })
      expect(adapter.published[0]).toMatchObject({ token: 'token-Bottega-secret', content: 'Ciao Brescia' })
      expect((await mediaFileBytes(adapter.published[0]!.media[0]!)).equals(png)).toBe(true)
      const [job] = (await listJobs(context, org, input.postId)).jobs
      expect(job).toMatchObject({ state: 'published', attemptCount: 1, receipt: { externalId: 'post-1', settledBy: 'worker' } })
      const [attempt] = await db.select().from(attempts).where(eq(attempts.jobId, job!.id))
      expect(attempt).toMatchObject({ outcome: 'succeeded' })
    })

    it('checks media sizes on submit and hands the adapter signed public URLs', async () => {
      const [channel] = await connect()
      const sized = Buffer.alloc(40)
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(sized)
      sized.write('IHDR', 12, 'latin1')
      sized.writeUInt32BE(1080, 16)
      sized.writeUInt32BE(1350, 20)
      const image = await storeMedia(context, org, 'a.png', 'image/png', sized)
      expect(image).toMatchObject({ width: 1080, height: 1350 })
      expect((await mediaFileBytes(await readMedia(db, org, image.id))).equals(sized)).toBe(true)
      await expect(readMedia(db, 'another-org', image.id)).rejects.toMatchObject({ code: 'not_found' })

      const key = publicMediaKey('s'.repeat(48))
      context.publicMedia = { baseUrl: 'https://dash-api.example.com/api/social/media', key, lifetimeMs: 3_600_000 }
      const input = submission([channel!.id], { mediaIds: [image.id] })
      await submitJobs(context, input)
      expect(adapter.validated).toEqual([[{ id: image.id, mimeType: 'image/png', sizeBytes: 40, width: 1080, height: 1350, durationMs: null, videoCodec: null, audioCodec: null }]])
      advance(60 * 60_000)
      expect(await runDue()).toMatchObject({ kind: 'published' })
      const url = new URL(adapter.published[0]!.media[0]!.publicUrl!)
      expect(url.pathname).toBe(`/api/social/media/${org}/${image.id}`)
      const expires = Number(url.searchParams.get('expires'))
      expect(expires).toBe(Math.floor(now.getTime() / 1000) + 3_600)
      expect(url.searchParams.get('signature')).toBe(mediaSignature(key, org, image.id, expires))
    })

    it('never lets two workers claim the same job', async () => {
      const [channel] = await connect()
      const input = submission([channel!.id])
      await submitJobs(context, input)
      advance(60 * 60_000)
      const claims = (await Promise.all(Array.from({ length: 6 }, () => claimNext(context)))).filter(Boolean)
      expect(claims).toHaveLength(1)
      await executeClaimed(context, claims[0]!)
    })

    it('cancels queued jobs and reports running ones as too late', async () => {
      const [a, b] = await connect(['A', 'B'])
      const input = submission([a!.id])
      await submitJobs(context, input)
      expect((await cancelJobs(context, org, input.postId, 1)).jobs).toMatchObject([{ result: 'cancelled', state: 'cancelled' }])
      advance(60 * 60_000)
      expect(await claimNext(context)).toBeNull()

      const late = submission([b!.id])
      await submitJobs(context, late)
      advance(60 * 60_000)
      const claimed = await claimNext(context)
      expect((await cancelJobs(context, org, late.postId, 1)).jobs).toMatchObject([{ result: 'too_late', state: 'running' }])
      await executeClaimed(context, claimed!)
    })

    it('cancels a due job when the tenant or channel was paused after submit', async () => {
      const [channel] = await connect()
      const input = submission([channel!.id])
      await submitJobs(context, input)
      await setPublishing(context, org, false, [channel!.id])
      advance(60 * 60_000)
      expect(await claimNext(context)).toBeNull()
      expect((await listJobs(context, org, input.postId)).jobs[0]).toMatchObject({ state: 'cancelled', lastError: 'paused' })
      expect(adapter.published).toHaveLength(0)
    })

    it('brings back jobs a pause cancelled once it is lifted, while they can still start in time', async () => {
      const [first, second] = await connect(['Bottega', 'Forno'])
      const input = submission([first!.id, second!.id])
      const other = submission([first!.id])
      await submitJobs(context, input)
      await submitJobs(context, other)
      await cancelJobs(context, org, other.postId, 1)
      await setPublishing(context, org, true, [])
      advance(60 * 60_000)
      expect(await claimNext(context)).toBeNull()
      expect((await listJobs(context, org, input.postId)).jobs.map(job => job.lastError)).toEqual(['paused', 'paused'])

      // Still paused: nothing comes back; then only the channel that is no longer paused does.
      expect((await restoreJobs(context, org, input.postId, 1)).jobs.map(job => job.result)).toEqual(['paused', 'paused'])
      await setPublishing(context, org, false, [second!.id])
      advance(10 * 60_000)
      const restored = await restoreJobs(context, org, input.postId, 1)
      expect(restored.jobs).toEqual(expect.arrayContaining([
        expect.objectContaining({ channelId: first!.id, state: 'queued', result: 'restored' }),
        expect.objectContaining({ channelId: second!.id, state: 'cancelled', result: 'paused' }),
      ]))
      expect((await db.select().from(events).where(eq(events.kind, 'job.restored')))).toHaveLength(1)
      expect(await runDue()).toMatchObject({ kind: 'published' })
      expect(adapter.published.map(published => published.channel.id)).toEqual([first!.id])

      // A person's cancel stays; past the last start the job is too late.
      expect((await restoreJobs(context, org, other.postId, 1)).jobs).toEqual([expect.objectContaining({ state: 'cancelled', result: 'not_cancelled_by_pause' })])
      await setPublishing(context, org, false, [])
      advance(50 * 60_000)
      expect((await restoreJobs(context, org, input.postId, 1)).jobs).toEqual(expect.arrayContaining([
        expect.objectContaining({ channelId: second!.id, result: 'too_late' }),
        expect.objectContaining({ channelId: first!.id, state: 'published', result: 'not_cancelled_by_pause' }),
      ]))
      await expect(restoreJobs(context, org, 'unknown-post', 1)).rejects.toMatchObject({ code: 'not_found' })
    })

    it('restores a job only while its channel\'s daily limit has room', async () => {
      const [channel] = await connect()
      await setPublishing(context, org, false, [], 1)
      const input = submission([channel!.id])
      await submitJobs(context, input)
      await setPublishing(context, org, true, [], 1)
      advance(60 * 60_000)
      expect(await claimNext(context)).toBeNull()
      await setPublishing(context, org, false, [], 1)
      // Another post took the day's only slot meanwhile.
      await submitJobs(context, submission([channel!.id], { publishAt: new Date(now.getTime() + 60 * 60_000).toISOString() }))
      expect((await restoreJobs(context, org, input.postId, 1)).jobs).toEqual([expect.objectContaining({ result: 'daily_limit', state: 'cancelled' })])
    })

    it('retries definite failures with backoff and stops after the limit', async () => {
      const [channel] = await connect()
      const input = submission([channel!.id])
      await submitJobs(context, input)
      advance(60 * 60_000)
      adapter.outcomes = Array.from({ length: maxAttempts }, () => ({ kind: 'failed' as const, retryable: true, code: 'rate_limited', detail: '429' }))
      await runDue()
      expect((await listJobs(context, org, input.postId)).jobs[0]).toMatchObject({ state: 'queued', lastError: 'rate_limited' })
      expect(await claimNext(context)).toBeNull()
      for (let attempt = 2; attempt <= maxAttempts; attempt++) {
        advance(15 * 60_000)
        await runDue()
        // Retries stop once the post is more than an hour late.
        if ((await listJobs(context, org, input.postId)).jobs[0]!.state !== 'queued') break
      }
      expect((await listJobs(context, org, input.postId)).jobs[0]!.state).toBe('failed')
    })

    it('hands a retry the uploads earlier attempts kept, the newest per file', async () => {
      const [channel] = await connect()
      const input = submission([channel!.id])
      await submitJobs(context, input)
      advance(60 * 60_000)
      let round = 0
      adapter.beforeVisible = async publish => {
        round++
        if (round === 1) {
          await publish.recordUpload!({ mediaId: 'm1', externalId: '501', uploadedAt: now.toISOString() })
          await publish.recordUpload!({ mediaId: 'm2', externalId: '502', uploadedAt: now.toISOString() })
        }
        if (round === 2) await publish.recordUpload!({ mediaId: 'm2', externalId: '602', uploadedAt: now.toISOString() })
      }
      adapter.outcomes = [{ kind: 'failed', retryable: true, code: 'unreachable', detail: 'down' }, { kind: 'failed', retryable: true, code: 'unreachable', detail: 'down' }]
      await runDue()
      expect(adapter.published[0]!.uploads).toBeUndefined()
      advance(60_000)
      await runDue()
      expect(adapter.published[1]!.uploads).toEqual(expect.arrayContaining([expect.objectContaining({ mediaId: 'm1', externalId: '501' }),
        expect.objectContaining({ mediaId: 'm2', externalId: '502' })]))
      expect(adapter.published[1]!.uploads).toHaveLength(2)
      advance(2 * 60_000)
      expect(await runDue()).toMatchObject({ kind: 'published' })
      expect(adapter.published[2]!.uploads).toEqual(expect.arrayContaining([expect.objectContaining({ mediaId: 'm1', externalId: '501' }),
        expect.objectContaining({ mediaId: 'm2', externalId: '602' })]))
      expect(adapter.published[2]!.uploads).toHaveLength(2)
    })

    it('fails a job that is more than an hour late without calling the platform', async () => {
      const [channel] = await connect()
      const input = submission([channel!.id])
      await submitJobs(context, input)
      advance(3 * 60 * 60_000)
      expect(await claimNext(context)).toBeNull()
      expect((await listJobs(context, org, input.postId)).jobs[0]).toMatchObject({ state: 'failed', lastError: 'too_late' })
      expect(adapter.published).toHaveLength(0)
    })

    it('holds a job back while a rate limit pauses its channel, and tries it when waiting would make it too late', async () => {
      const [first, second] = await connect(['Bottega', 'Forno'])
      const held = submission([first!.id])
      const tried = submission([second!.id])
      await submitJobs(context, held)
      await submitJobs(context, tried)
      advance(60 * 60_000)
      const [row] = await db.select().from(channels).where(eq(channels.id, first!.id))
      const [other] = await db.select().from(channels).where(eq(channels.id, second!.id))
      // The readers paused one channel for 20 minutes and the other for two hours.
      await pauseForRateLimit(db, row!, new RateLimited('usage', 'channel', new Date(now.getTime() + 20 * 60_000)), now)
      await pauseForRateLimit(db, other!, new RateLimited('usage', 'channel', new Date(now.getTime() + 2 * 3_600_000)), now)

      expect(await runDue()).toMatchObject({ kind: 'published' })
      expect(adapter.published.map(input => input.channel.id)).toEqual([second!.id])
      expect(await claimNext(context)).toBeNull()
      const [job] = (await listJobs(context, org, held.postId)).jobs
      expect(job).toMatchObject({ state: 'queued', attemptCount: 0 })
      const [stored] = await db.select().from(jobs).where(eq(jobs.id, job!.id))
      expect(stored!.notBefore).toEqual(new Date(now.getTime() + 20 * 60_000))
      const deferred = await db.select().from(events).where(eq(events.jobId, job!.id))
      expect(deferred.map(event => event.kind)).toContain('job.deferred')

      advance(20 * 60_000)
      expect(await runDue()).toMatchObject({ kind: 'published' })
      expect(adapter.published.map(input => input.channel.id)).toEqual([second!.id, first!.id])
    })

    it('retries a rate-limited publish when the limit lifts, never past the lateness limit', async () => {
      const [channel] = await connect()
      const input = submission([channel!.id])
      await submitJobs(context, input)
      advance(60 * 60_000)
      const publishAt = new Date(now)
      adapter.outcomes = [
        { kind: 'failed', retryable: true, code: 'rate_limited', detail: '80001', retryAt: new Date(now.getTime() + 25 * 60_000) },
        { kind: 'failed', retryable: true, code: 'rate_limited', detail: '80001', retryAt: new Date(now.getTime() + 5 * 3_600_000) },
      ]
      await runDue()
      const [first] = await db.select().from(jobs)
      expect(first).toMatchObject({ state: 'queued', lastError: 'rate_limited' })
      expect(first!.notBefore).toEqual(new Date(now.getTime() + 25 * 60_000))
      advance(25 * 60_000)
      await runDue()
      const [second] = await db.select().from(jobs)
      // The limit outlasts the hour: one last try a minute inside it.
      expect(second!.notBefore).toEqual(new Date(publishAt.getTime() + lastStartMs))
      advance(publishAt.getTime() + lastStartMs - now.getTime())
      expect(await runDue()).toMatchObject({ kind: 'published' })
    })

    it('marks the channel for reauthorization on auth failures', async () => {
      const [channel] = await connect()
      await submitJobs(context, submission([channel!.id]))
      advance(60 * 60_000)
      adapter.outcomes = [{ kind: 'failed', retryable: false, code: 'auth', detail: '190', reauth: true }]
      await runDue()
      expect((await listChannels(context, org))[0]).toMatchObject({ status: 'needs_reauth' })
      await expect(submitJobs(context, submission([channel!.id]))).rejects.toMatchObject({ code: 'channel_inactive' })
    })

    it('leaves uncertain jobs alone until reconcile settles them', async () => {
      const [channel] = await connect()
      const input = submission([channel!.id])
      await submitJobs(context, input)
      advance(60 * 60_000)
      adapter.outcomes = [{ kind: 'uncertain', code: 'response_lost', detail: 'timeout' }]
      await runDue()
      const [job] = (await listJobs(context, org, input.postId)).jobs
      expect(job!.state).toBe('uncertain')
      advance(60 * 60_000)
      expect(await claimNext(context)).toBeNull()

      adapter.reconcileOutcome = { kind: 'ambiguous', detail: '2 posts' }
      expect(await reconcileJob(context, org, job!.id)).toMatchObject({ result: 'ambiguous' })
      adapter.reconcileOutcome = { kind: 'published', externalId: 'found-1' }
      expect(await reconcileJob(context, org, job!.id)).toMatchObject({ result: 'published', job: { receipt: { externalId: 'found-1', settledBy: 'reconcile' } } })
      await expect(reconcileJob(context, org, job!.id)).rejects.toMatchObject({ code: 'not_uncertain' })
    })

    it('concludes "not published" only after the propagation window', async () => {
      const [channel] = await connect()
      const input = submission([channel!.id])
      await submitJobs(context, input)
      advance(60 * 60_000)
      adapter.outcomes = [{ kind: 'uncertain', code: 'response_lost', detail: 'timeout' }]
      await runDue()
      const [job] = (await listJobs(context, org, input.postId)).jobs
      expect(await reconcileJob(context, org, job!.id)).toMatchObject({ result: 'too_early' })
      advance(16 * 60_000)
      expect(await reconcileJob(context, org, job!.id)).toMatchObject({ result: 'failed', job: { lastError: 'not_found_on_platform' } })
    })

    it('turns attempts abandoned by a crash after sending into uncertain jobs', async () => {
      const [channel] = await connect()
      const input = submission([channel!.id])
      await submitJobs(context, input)
      advance(60 * 60_000)
      const claimed = await claimNext(context)
      expect(claimed).not.toBeNull()
      await markSent(context, claimed!.attemptId)
      advance(11 * 60_000)
      expect(await sweep(context)).toEqual([claimed!.jobId])
      expect((await listJobs(context, org, input.postId)).jobs[0]).toMatchObject({ state: 'uncertain', lastError: 'abandoned' })
      // A confirmed result that arrives late (its request was sent before the sweep) still settles the job.
      await settleAttempt(context, claimed!, { kind: 'published', externalId: 'late-1' })
      expect((await listJobs(context, org, input.postId)).jobs[0]).toMatchObject({ state: 'published' })
    })
  })

  describe('deploy-safe publishing', () => {
    it('queues an attempt abandoned before sending again, without counting it', async () => {
      const [channel] = await connect()
      const input = submission([channel!.id])
      await submitJobs(context, input)
      advance(60 * 60_000)
      const claimed = await claimNext(context)
      advance(11 * 60_000)
      expect(await sweep(context)).toEqual([])
      expect((await listJobs(context, org, input.postId)).jobs[0]).toMatchObject({ state: 'queued', lastError: 'abandoned', attemptCount: 0 })
      const [attempt] = await db.select().from(attempts).where(eq(attempts.id, claimed!.attemptId))
      expect(attempt).toMatchObject({ outcome: 'failed_retryable', errorCode: 'abandoned', sentAt: null })
      // The dead engine's late result cannot send any more: its attempt is closed.
      await expect(markSent(context, claimed!.attemptId)).rejects.toBeInstanceOf(AttemptClosedError)
      expect(await runDue()).toMatchObject({ kind: 'published' })
      expect((await listJobs(context, org, input.postId)).jobs[0]).toMatchObject({ state: 'published', attemptCount: 1 })
    })

    it('an attempt closed by a stopping engine sends nothing and leaves its job queued', async () => {
      const [channel] = await connect()
      const input = submission([channel!.id])
      await submitJobs(context, input)
      advance(60 * 60_000)
      const claimed = await claimNext(context)
      adapter.beforeVisible = async () => { expect(await requeueUnsent(context, [claimed!.attemptId], 'interrupted')).toHaveLength(1) }
      expect(await executeClaimed(context, claimed!)).toBe(interrupted)
      expect(adapter.outcomes).toEqual([])
      expect((await listJobs(context, org, input.postId)).jobs[0]).toMatchObject({ state: 'queued', lastError: 'interrupted', attemptCount: 0 })
      const kinds = (await db.select().from(events).where(eq(events.organizationId, org)).orderBy(events.id)).map(row => row.kind)
      expect(kinds).toEqual(['channel.connected', 'job.queued', 'job.running', 'job.requeued'])
    })

    it('never requeues an attempt that already sent its visible request', async () => {
      const [channel] = await connect()
      await submitJobs(context, submission([channel!.id]))
      advance(60 * 60_000)
      const claimed = await claimNext(context)
      await markSent(context, claimed!.attemptId)
      expect(await requeueUnsent(context, [claimed!.attemptId], 'interrupted')).toEqual([])
    })

    it('a stopping worker requeues a publish held before sending, within its grace', async () => {
      const [channel] = await connect()
      const input = submission([channel!.id])
      await submitJobs(context, input)
      advance(60 * 60_000)
      let release!: () => void
      let held!: () => void
      const reached = new Promise<void>(resolve => { held = resolve })
      adapter.beforeVisible = () => new Promise<void>(resolve => { release = resolve; held() })
      const worker = new Worker(context, { concurrency: 1, pollMs: 60_000 })
      worker.start()
      await reached
      const started = Date.now()
      await worker.stop(2_000)
      expect(Date.now() - started).toBeLessThan(3_500)
      release()
      await new Promise(resolve => setTimeout(resolve, 200))
      expect((await listJobs(context, org, input.postId)).jobs[0]).toMatchObject({ state: 'queued', lastError: 'interrupted' })
    }, 20_000)

    it('readiness reports a stalled worker and a due job waiting 15 minutes', async () => {
      const [channel] = await connect()
      await submitJobs(context, submission([channel!.id]))
      expect(await publishingHealth(context, undefined)).toMatchObject({ publishing: 'off', oldestDueJob: null })
      const fresh = { enabled: true, lastTickAt: now, pollMs: 5_000 }
      advance(60 * 60_000)
      expect(await publishingHealth(context, { ...fresh, lastTickAt: now })).toMatchObject({ publishing: 'ok', oldestDueJob: { waitingSeconds: 0 } })
      advance(15 * 60_000)
      expect(await publishingHealth(context, { ...fresh, lastTickAt: now })).toMatchObject({ publishing: 'late', oldestDueJob: { waitingSeconds: 900 } })
      expect(await publishingHealth(context, { ...fresh, lastTickAt: new Date(now.getTime() - 61_000) })).toMatchObject({ publishing: 'stalled' })
    })
  })

  describe('resolving uncertain jobs', () => {
    async function uncertainJob() {
      const [channel] = await connect()
      const input = submission([channel!.id])
      await submitJobs(context, input)
      advance(60 * 60_000)
      adapter.outcomes = [{ kind: 'uncertain', code: 'response_lost', detail: 'timeout' }]
      await runDue()
      return { channel: channel!, input, job: (await listJobs(context, org, input.postId)).jobs[0]! }
    }

    it('a person settles it as published with the platform ID, or as not published', async () => {
      const { job } = await uncertainJob()
      await expect(resolveJob(context, job.id, { organizationId: 'other-org', outcome: 'not_published', resolvedByUserId: 'u1' })).rejects.toMatchObject({ code: 'not_found' })
      expect(await resolveJob(context, job.id, { organizationId: org, outcome: 'published', externalId: '123_456', url: 'https://www.facebook.com/123_456', resolvedByUserId: 'u1' }))
        .toMatchObject({ job: { state: 'published', receipt: { externalId: '123_456', settledBy: 'operator' } } })
      await expect(resolveJob(context, job.id, { organizationId: org, outcome: 'not_published', resolvedByUserId: 'u1' })).rejects.toMatchObject({ code: 'not_uncertain' })
      const [event] = await db.select().from(events).where(eq(events.kind, 'job.resolved'))
      expect(event).toMatchObject({ jobId: job.id, detail: { outcome: 'published', resolvedByUserId: 'u1' } })

      const second = await uncertainJob()
      expect(await resolveJob(context, second.job.id, { organizationId: org, outcome: 'not_published', resolvedByUserId: 'u1' }))
        .toMatchObject({ job: { state: 'failed', lastError: 'resolved_not_published' } })
    })

    it('refuses a platform ID another post of the channel already has', async () => {
      const first = await uncertainJob()
      await resolveJob(context, first.job.id, { organizationId: org, outcome: 'published', externalId: 'same', resolvedByUserId: 'u1' })
      const input = submission([first.channel.id])
      await submitJobs(context, input)
      advance(60 * 60_000)
      adapter.outcomes = [{ kind: 'uncertain', code: 'response_lost', detail: 'timeout' }]
      await runDue()
      const [job] = (await listJobs(context, org, input.postId)).jobs
      await expect(resolveJob(context, job!.id, { organizationId: org, outcome: 'published', externalId: 'same', resolvedByUserId: 'u1' })).rejects.toMatchObject({ code: 'receipt_taken' })
    })
  })

  describe('platforms and media this engine cannot serve', () => {
    it('fails a job definitely when its platform is not configured, instead of turning it uncertain', async () => {
      const [channel] = await connect()
      await submitJobs(context, submission([channel!.id]))
      advance(60 * 60_000)
      const claimed = await claimNext(context)
      context.adapters.delete('meta')
      expect(await executeClaimed(context, claimed!)).toMatchObject({ kind: 'failed', retryable: false, code: 'platform_unavailable' })
      const [job] = await db.select().from(jobs).where(eq(jobs.id, claimed!.jobId))
      expect(job).toMatchObject({ state: 'failed', lastError: 'platform_unavailable' })
    })
  })

  describe('worker lanes', () => {
    it('gives video and browser jobs their own slots, so they cannot hold standard posts back', async () => {
      const [page] = await connect()
      const stored = await storeMedia(context, org, 'clip.mp4', 'video/mp4', Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom'), randomBytes(64)]))
      const reel = submission([page!.id], { mediaIds: [stored.id] })
      const photo = submission([page!.id], { publishAt: new Date(now.getTime() + 61 * 60_000).toISOString() })
      await submitJobs(context, reel)
      await submitJobs(context, photo)
      expect((await listJobs(context, org, reel.postId)).jobs[0]).toBeDefined()
      const [reelJob] = await db.select().from(jobs).where(eq(jobs.postId, reel.postId))
      const [photoJob] = await db.select().from(jobs).where(eq(jobs.postId, photo.postId))
      expect([reelJob!.lane, photoJob!.lane]).toEqual(['video', 'standard'])
      advance(62 * 60_000)
      // The video slot is full: only a standard job can be claimed, though the reel is older.
      expect(await claimNext(context, ['standard'])).toMatchObject({ jobId: photoJob!.id, lane: 'standard' })
      expect(await claimNext(context, ['standard'])).toBeNull()
      expect(await claimNext(context, ['video'])).toMatchObject({ jobId: reelJob!.id, lane: 'video' })
    })
  })

  describe('token check', () => {
    it('proves each token once a day and marks a refused one needs_reauth before a post is due', async () => {
      const [first, second] = await connect(['Bottega', 'Forno'])
      expect(await checkDueTokens(context)).toMatchObject({ checked: 2, valid: 2, refused: 0 })
      expect(await checkDueTokens(context)).toMatchObject({ checked: 0 })
      advance(25 * 60 * 60_000)
      adapter.checkWith = async () => { throw new ReauthRequired('Error validating access token: The user has not authorized application.') }
      expect(await checkDueTokens(context)).toMatchObject({ checked: 2, refused: 2 })
      const listed = await listChannels(context, org)
      expect(listed.map(channel => channel.status)).toEqual(['needs_reauth', 'needs_reauth'])
      const kinds = (await db.select().from(events).where(eq(events.channelId, first!.id))).map(row => row.kind)
      expect(kinds).toContain('channel.needs_reauth')
      // Inactive channels are not checked again.
      advance(25 * 60 * 60_000)
      expect(await checkDueTokens(context)).toMatchObject({ checked: 0 })
      expect(second).toBeDefined()
    })

    it('a transient error leaves the channel active and due again', async () => {
      await connect()
      adapter.checkWith = async () => { throw new Error('socket hang up') }
      expect(await checkDueTokens(context)).toMatchObject({ checked: 0, failed: 1 })
      adapter.checkWith = async () => undefined
      expect(await checkDueTokens(context)).toMatchObject({ checked: 1, valid: 1 })
      expect((await listChannels(context, org))[0]).toMatchObject({ status: 'active' })
    })

    it('a background read refused for the token marks the channel needs_reauth', async () => {
      const [channel] = await connect()
      const input = submission([channel!.id])
      await submitJobs(context, input)
      advance(60 * 60_000)
      await runDue()
      adapter.metricsWith = async () => { throw new ReauthRequired('Error validating access token') }
      advance(2 * 60 * 60_000)
      await collectDueMetrics(context)
      expect((await listChannels(context, org))[0]).toMatchObject({ status: 'needs_reauth' })
    })
  })

  describe('channels', () => {
    it('refuses to disable a channel with unsettled jobs, then removes its credential', async () => {
      const [channel] = await connect()
      const input = submission([channel!.id])
      await submitJobs(context, input)
      await expect(disableChannel(context, org, channel!.id)).rejects.toMatchObject({ code: 'channel_busy' })
      await cancelJobs(context, org, input.postId, 1)
      await disableChannel(context, org, channel!.id)
      expect(await db.select().from(channelCredentials).where(eq(channelCredentials.channelId, channel!.id))).toHaveLength(0)
      expect((await listChannels(context, org))[0]).toMatchObject({ status: 'disabled' })
    })

    it('records events for each state change', async () => {
      const [channel] = await connect()
      const input = submission([channel!.id])
      await submitJobs(context, input)
      advance(60 * 60_000)
      await runDue()
      const kinds = (await db.select().from(events).where(eq(events.organizationId, org)).orderBy(events.id)).map(row => row.kind)
      expect(kinds).toEqual(['channel.connected', 'job.queued', 'job.running', 'job.published'])
    })
  })

  describe('token refresh', () => {
    async function imported(expiresAt: Date | null) {
      return (await importChannel(context, { organizationId: org, providerAppId: 'meta-agency', kind: 'facebook_page', externalId: `page-${randomUUID()}`,
        name: 'Imported', credential: { accessToken: 'old-access', refreshToken: 'refresh-secret', expiresAt } })).channelId
    }

    it('renews an expiring token before publishing and keeps the refresh token', async () => {
      const channelId = await imported(new Date(now.getTime() + 61 * 60_000))
      const input = submission([channelId])
      await submitJobs(context, input)
      advance(60 * 60_000)
      expect(await runDue()).toMatchObject({ kind: 'published' })
      expect(adapter.refreshes).toEqual([{ accessToken: 'old-access', refreshToken: 'refresh-secret', expiresAt: new Date(now.getTime() + 60_000) }])
      expect(adapter.published[0]!.token).toBe('renewed-1')
      expect(await readCredential(context, db, channelId)).toEqual({ accessToken: 'renewed-1', refreshToken: 'refresh-secret', expiresAt: new Date('2030-01-01T12:00:00Z') })
      const kinds = (await db.select().from(events).where(eq(events.channelId, channelId)).orderBy(events.id)).map(row => row.kind)
      expect(kinds).toContain('channel.token_refreshed')
    })

    it('leaves a token with time to spare alone', async () => {
      const channelId = await imported(new Date(now.getTime() + 2 * 60 * 60_000))
      await submitJobs(context, submission([channelId]))
      advance(60 * 60_000)
      await runDue()
      expect(adapter.refreshes).toHaveLength(0)
      expect(adapter.published[0]!.token).toBe('old-access')
    })

    it('retries a job whose refresh failed in transit', async () => {
      const channelId = await imported(new Date(now.getTime() + 60 * 60_000))
      const input = submission([channelId])
      await submitJobs(context, input)
      advance(60 * 60_000)
      adapter.refreshWith = async () => { throw new Error('ECONNRESET') }
      expect(await runDue()).toMatchObject({ kind: 'failed', retryable: true, code: 'token_refresh_failed' })
      expect((await listJobs(context, org, input.postId)).jobs[0]).toMatchObject({ state: 'queued' })
      expect((await listChannels(context, org))[0]).toMatchObject({ status: 'active' })
    })

    it('marks the channel for reconnection when the platform refuses the grant', async () => {
      const channelId = await imported(new Date(now.getTime() + 60 * 60_000))
      const input = submission([channelId])
      await submitJobs(context, input)
      advance(60 * 60_000)
      adapter.refreshWith = async () => { throw new ReauthRequired('revoked') }
      expect(await runDue()).toMatchObject({ kind: 'failed', retryable: false })
      expect((await listJobs(context, org, input.postId)).jobs[0]).toMatchObject({ state: 'failed' })
      expect((await listChannels(context, org))[0]).toMatchObject({ status: 'needs_reauth' })
    })

    it('renews idle keep-alive grants that are about to lapse', async () => {
      const soon = await imported(new Date(now.getTime() + 60_000))
      await imported(new Date(now.getTime() + 24 * 60 * 60_000))
      expect(await refreshIdleCredentials(context)).toBe(0)
      adapter.keepAlive = true
      expect(await refreshIdleCredentials(context)).toBe(1)
      expect((await readCredential(context, db, soon)).accessToken).toBe('renewed-1')
    })

    it('imports only channel kinds the provider app can hold, for tenants it may serve', async () => {
      await expect(importChannel(context, { organizationId: org, providerAppId: 'meta-agency', kind: 'youtube_channel', externalId: 'UCx', name: 'x',
        credential: { accessToken: 'a', expiresAt: null } })).rejects.toMatchObject({ code: 'unsupported_channel' })
      await expect(importChannel(context, { organizationId: org, providerAppId: 'meta-tenant', kind: 'facebook_page', externalId: '1', name: 'x',
        credential: { accessToken: 'a', expiresAt: null } })).rejects.toMatchObject({ code: 'not_found' })
    })
  })

  describe('vault', () => {
    it('seals logins to the runner, replaces them in place and lists no secrets', async () => {
      const runner = runnerKeyPair()
      const input = { organizationId: org, platform: 'tiktok' as const, handle: 'bottega.digitale' }
      const first = await putBrowserAccount(db, runner.publicKey, input, { username: 'bottega.digitale', password: 'first-password' })
      expect(first.created).toBe(true)
      await db.update(browserAccounts).set({ status: 'active' }).where(eq(browserAccounts.id, first.id))
      const second = await putBrowserAccount(db, runner.publicKey, input, { username: 'bottega.digitale', password: 'second-password', totp: 'JBSWY3DPEHPK3PXP' })
      expect(second).toEqual({ id: first.id, created: false })

      const [row] = await db.select().from(browserAccounts).where(eq(browserAccounts.id, first.id))
      expect(row!.status).toBe('needs_login')
      expect(row!.ciphertext.includes(Buffer.from('second-password'))).toBe(false)
      expect(JSON.parse(openSecret(runner.privateKey, first.id, row!))).toEqual({ username: 'bottega.digitale', password: 'second-password', totp: 'JBSWY3DPEHPK3PXP' })

      const listed = await listBrowserAccounts(db, org)
      expect(listed).toEqual([expect.objectContaining({ id: first.id, platform: 'tiktok', handle: 'bottega.digitale', status: 'needs_login' })])
      expect(Object.keys(listed[0]!)).not.toContain('ciphertext')
      expect(await listBrowserAccounts(db, 'another-org')).toEqual([])
      const kinds = (await db.select({ kind: events.kind }).from(events).where(eq(events.organizationId, org))).map(event => event.kind)
      expect(kinds).toEqual(['browser_account.created', 'browser_account.replaced'])
    })
  })


  describe('browser channels', () => {
    it('links LinkedIn logins to a profile or a Page, and other platforms to the account', async () => {
      const runner = runnerKeyPair()
      const member = await putBrowserAccount(db, runner.publicKey, { organizationId: org, platform: 'linkedin', handle: 'luciano-nery' }, { username: 'u', password: 'p' })
      const pageLogin = await putBrowserAccount(db, runner.publicKey, { organizationId: org, platform: 'linkedin', handle: 'bottega-digitale' }, { username: 'u', password: 'p' })
      const reddit = await putBrowserAccount(db, runner.publicKey, { organizationId: org, platform: 'reddit', handle: 'bottegadigitale' }, { username: 'u', password: 'p' })
      const profile = await linkBrowserChannel(db, org, member.id)
      const page = await linkBrowserChannel(db, org, pageLogin.id, { page: '12345678', name: 'Bottega Digitale' })
      const subreddit = await linkBrowserChannel(db, org, reddit.id)
      const rows = await db.select().from(channels).where(inArray(channels.id, [profile.channelId, page.channelId, subreddit.channelId]))
      expect(rows.map(row => [row.platform, row.kind, row.externalId, row.name]).sort()).toEqual([
        ['linkedin', 'linkedin_page', '12345678', 'Bottega Digitale'],
        ['linkedin', 'linkedin_profile', 'luciano-nery', '@luciano-nery'],
        ['reddit', 'reddit_account', 'bottegadigitale', '@bottegadigitale'],
      ])
      await expect(linkBrowserChannel(db, org, reddit.id, { page: '1' })).rejects.toMatchObject({ code: 'unsupported_channel' })
    })

    it('link, log in through the runner, publish an MP4 with heartbeats the sweeper respects', async () => {
      const runner = runnerKeyPair()
      const tiktok = new FakeAdapter()
      ;(tiktok as unknown as { platform: string }).platform = 'tiktok'
      context.adapters.set('tiktok', tiktok)
      const account = await putBrowserAccount(db, runner.publicKey, { organizationId: org, platform: 'tiktok', handle: 'bottega.digitale' }, { username: 'u', password: 'p' })
      const linked = await linkBrowserChannel(db, org, account.id)
      expect(await linkBrowserChannel(db, org, account.id)).toEqual({ channelId: linked.channelId, created: false })
      expect((await listChannels(context, org)).find(channel => channel.id === linked.channelId)).toMatchObject({ kind: 'tiktok_account', status: 'needs_reauth', name: '@bottega.digitale' })

      const loginAction = '0d9c8b7a-6f5e-4d3c-8b2a-1f0e9d8c7b6a'
      context.runner = { get: async () => ({ id: loginAction, actionId: 'login', kind: 'login', accountId: account.id, state: 'succeeded', visible: false }) } as unknown as RunnerClient
      expect(await checkBrowserLogin(context, org, account.id, loginAction)).toMatchObject({ state: 'succeeded' })
      expect((await listBrowserAccounts(db, org))[0]!.status).toBe('active')
      expect((await listChannels(context, org)).find(channel => channel.id === linked.channelId)!.status).toBe('active')

      const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom'), randomBytes(64)])
      const video = await storeMedia(context, org, 'clip.mp4', 'video/mp4', mp4)
      context.publicMedia = { baseUrl: 'https://dash-api.example.com/api/social/media', key: publicMediaKey('s'.repeat(40)), lifetimeMs: 60 * 60_000 }
      expect(video).toMatchObject({ mimeType: 'video/mp4', width: null })
      const input = submission([linked.channelId], { mediaIds: [video.id] })
      await submitJobs(context, input)
      advance(60 * 60_000)

      // The fake waits like the runner does: it beats, the clock passes the sweep window, then it finishes.
      tiktok.publish = async (_app: unknown, publishInput: PublishInput) => {
        tiktok.published.push(publishInput)
        advance(11 * 60_000)
        await publishInput.heartbeat!()
        expect(await sweep(context)).toEqual([])
        return { kind: 'published' as const, externalId: '7400000000000000000' }
      }
      expect(await runDue()).toMatchObject({ kind: 'published' })
      expect(tiktok.published[0]).toMatchObject({ token: '', browserAccount: { id: account.id, handle: 'bottega.digitale' } })
      expect(tiktok.published[0]!.browserAccount!.sealed.ciphertext.length).toBeGreaterThan(16)
      const [attempt] = await db.select().from(attempts)
      expect(attempt!.heartbeatAt).not.toBeNull()
    })
  })

  describe('post metrics', () => {
    async function published() {
      const [channel] = await connect()
      const input = submission([channel!.id])
      const { jobs: [job] } = await submitJobs(context, input)
      advance(60 * 60_000)
      expect(await runDue()).toMatchObject({ kind: 'published' })
      return { channel: channel!, job: job! }
    }

    it('reads published posts, stores their numbers and schedules the next read', async () => {
      const { channel, job } = await published()
      expect(await collectDueMetrics(context)).toEqual({ collected: 1, failed: 0 })
      expect(adapter.metricsCalls[0]).toMatchObject({ externalId: 'post-1', token: `token-Bottega-secret`, channel: { id: channel.id, kind: 'facebook_page' } })
      const [row] = await db.select().from(postMetrics)
      expect(row).toMatchObject({ jobId: job.id, values: { likes: 3, comments: 1, views: 40 }, unavailable: ['reach'], failureCount: 0 })
      expect(row!.nextCollectAt.getTime() - now.getTime()).toBe(60 * 60_000)

      // Not due again until the next read.
      expect(await collectDueMetrics(context)).toEqual({ collected: 0, failed: 0 })
      expect(await readMetrics(context, org, [job.id])).toEqual([{ jobId: job.id, channelId: channel.id, values: { likes: 3, comments: 1, views: 40 },
        unavailable: ['reach'], collectedAt: now.toISOString() }])
      expect(await readMetrics(context, 'other-org', [job.id])).toEqual([])

      // Two weeks on, reads are daily.
      advance(15 * 86_400_000)
      expect(await collectDueMetrics(context)).toEqual({ collected: 1, failed: 0 })
      const [later] = await db.select().from(postMetrics)
      expect(later!.nextCollectAt.getTime() - now.getTime()).toBe(24 * 60 * 60_000)
    })

    it('keeps the last numbers and backs off when a read fails', async () => {
      const { job } = await published()
      await collectDueMetrics(context)
      adapter.metricsWith = async () => { throw new Error('Graph GET /x returned 500') }
      advance(61 * 60_000)
      expect(await collectDueMetrics(context)).toEqual({ collected: 0, failed: 1 })
      const [row] = await db.select().from(postMetrics)
      expect(row).toMatchObject({ values: { likes: 3 }, failureCount: 1, lastError: 'Graph GET /x returned 500' })
      expect(row!.nextCollectAt.getTime() - now.getTime()).toBe(60 * 60_000)
      advance(61 * 60_000)
      await collectDueMetrics(context)
      const [second] = await db.select().from(postMetrics)
      expect(second!.failureCount).toBe(2)
      expect(second!.nextCollectAt.getTime() - now.getTime()).toBe(2 * 60 * 60_000)
      // The job and channel are untouched.
      expect((await listJobs(context, org, job.postId)).jobs[0]).toMatchObject({ state: 'published' })
    })

    it('leaves out a post never read successfully, inactive channels and posts past the window', async () => {
      adapter.metricsWith = async () => { throw new Error('down') }
      const { job, channel } = await published()
      await collectDueMetrics(context)
      expect(await readMetrics(context, org, [job.id])).toEqual([])

      adapter.metricsWith = async () => ({ values: { likes: 1 }, unavailable: [] })
      await disableChannel(context, org, channel.id)
      advance(2 * 60 * 60_000)
      expect(await collectDueMetrics(context)).toEqual({ collected: 0, failed: 0 })

      await db.update(channels).set({ status: 'active' }).where(eq(channels.id, channel.id))
      advance(91 * 86_400_000)
      expect(await collectDueMetrics(context)).toEqual({ collected: 0, failed: 0 })
    })
  })

  describe('analytics and responses', () => {
    const minute = 60_000
    async function published(names = ['Bottega']) {
      const connected = await connect(names)
      const { jobs: created } = await submitJobs(context, submission(connected.map(channel => channel.id)))
      advance(60 * minute)
      for (let index = 0; index < created.length; index++) expect(await runDue()).toMatchObject({ kind: 'published' })
      return { channels: connected, jobs: created }
    }
    const response = (id: string, overrides: Partial<PlatformResponse> = {}): PlatformResponse => ({ externalId: id, parentExternalId: null,
      authorName: 'Mario Rossi', authorHandle: null, text: `text ${id}`, likeCount: 0, replyCount: 0, publishedAt: now, url: null, ...overrides })
    async function browserChannel() {
      const runner = runnerKeyPair()
      const account = await putBrowserAccount(db, runner.publicKey, { organizationId: org, platform: 'reddit', handle: `bottega-${randomUUID().slice(0, 8)}` }, { username: 'u', password: 'p' })
      return (await linkBrowserChannel(db, org, account.id)).channelId
    }

    it('appends a metric sample on each successful read and serves the history oldest first, per tenant', async () => {
      const { jobs: [job] } = await published()
      await collectDueMetrics(context)
      const first = now
      advance(61 * minute)
      adapter.metricsWith = async () => { throw new Error('down') }
      await collectDueMetrics(context)
      advance(61 * minute)
      adapter.metricsWith = async () => ({ values: { likes: 5 }, unavailable: [] })
      await collectDueMetrics(context)
      expect(await readMetricHistory(context, org, [job!.id])).toEqual([{ jobId: job!.id, samples: [
        { collectedAt: first.toISOString(), values: { likes: 3, comments: 1, views: 40 } },
        { collectedAt: now.toISOString(), values: { likes: 5 } },
      ] }])
      expect(await readMetricHistory(context, 'other-org', [job!.id])).toEqual([])
    })

    it('reads account numbers every six hours, keeps samples and backs off on failure', async () => {
      const [channel] = await connect()
      expect(await collectDueChannelMetrics(context)).toEqual({ collected: 1, failed: 0 })
      expect(adapter.accountCalls[0]).toMatchObject({ token: 'token-Bottega-secret', channel: { id: channel!.id, kind: 'facebook_page' } })
      const [row] = await db.select().from(channelMetrics)
      expect(row!.nextCollectAt.getTime() - now.getTime()).toBe(6 * 60 * minute)
      expect(await collectDueChannelMetrics(context)).toEqual({ collected: 0, failed: 0 })

      const first = now
      advance(6 * 60 * minute)
      adapter.accountWith = async () => { throw new Error('Graph GET /x returned 500') }
      expect(await collectDueChannelMetrics(context)).toEqual({ collected: 0, failed: 1 })
      const [failed] = await db.select().from(channelMetrics)
      expect(failed).toMatchObject({ values: { followers: 120 }, failureCount: 1, lastError: 'Graph GET /x returned 500' })
      expect(failed!.nextCollectAt.getTime() - now.getTime()).toBe(60 * minute)
      expect(await db.select().from(channelMetricSamples)).toHaveLength(1)

      expect(await readChannelMetrics(context, org, undefined, 30)).toEqual([{ channelId: channel!.id, platform: 'meta', kind: 'facebook_page', supported: true,
        latest: { values: { followers: 120, views: 40 }, unavailable: ['reach'], collectedAt: first.toISOString() },
        samples: [{ collectedAt: first.toISOString(), values: { followers: 120, views: 40 } }] }])
      expect(await readChannelMetrics(context, 'other-org', [channel!.id], 30)).toEqual([])
    })

    // Five requests a read: the collector pays for the first, the adapter reports the other four.
    const fiveRequests = <T>(result: T) => async (input: { spendCall?: () => void }) => {
      for (let call = 0; call < 4; call++) input.spendCall?.()
      return result
    }

    it('spends one budget call for every platform request a metrics read makes', async () => {
      await published(['One', 'Two', 'Three'])
      adapter.metricsWith = fiveRequests({ values: { likes: 1 }, unavailable: [] })
      adapter.accountWith = fiveRequests({ values: { followers: 1 }, unavailable: [] })
      // Six calls and a stopped clock fit two such reads, not all three.
      expect(await collectDueMetrics(context, 20, new CallBudget(60, 6, () => 0))).toEqual({ collected: 2, failed: 0 })
      expect(await collectDueChannelMetrics(context, new CallBudget(60, 6, () => 0))).toEqual({ collected: 2, failed: 0 })
    })

    it('counts every request of a read toward the platform\'s daily share, as it does for YouTube', async () => {
      await published(['One', 'Two', 'Three'])
      adapter.metricsWith = fiveRequests({ values: { likes: 1 }, unavailable: [] })
      adapter.accountWith = fiveRequests({ values: { followers: 1 }, unavailable: [] })
      // A share of seven: the first read spends five, the second starts with two left and finishes, the third is skipped.
      const dailyShare = () => new CallBudget(1_000, 1_000, () => 0, { meta: 7 })
      expect(await collectDueMetrics(context, 20, dailyShare())).toEqual({ collected: 2, failed: 0 })
      expect(await collectDueChannelMetrics(context, dailyShare())).toEqual({ collected: 2, failed: 0 })
    })

    it('pauses every read on a rate-limited channel for an hour', async () => {
      const { jobs: [job] } = await published()
      adapter.responsesWith = async () => { throw new RateLimited('Graph returned 400 (code 4)') }
      expect(await collectDueResponses(context)).toEqual({ checked: 0, failed: 1 })
      const [paused] = await db.select().from(channelMetrics)
      expect(paused!.pausedUntil!.getTime() - now.getTime()).toBe(60 * minute)
      const [check] = await db.select().from(responseChecks).where(eq(responseChecks.jobId, job!.id))
      expect(check).toMatchObject({ state: 'pending', failureCount: 0 })

      advance(30 * minute)
      expect(await collectDueChannelMetrics(context)).toEqual({ collected: 0, failed: 0 })
      expect(await collectDueMetrics(context)).toEqual({ collected: 0, failed: 0 })
      expect(await collectDueResponses(context)).toEqual({ checked: 0, failed: 0 })
      advance(31 * minute)
      adapter.responsesWith = async () => ({ kind: 'ok', responses: [] })
      expect(await collectDueResponses(context)).toEqual({ checked: 1, failed: 0 })
      expect(await collectDueChannelMetrics(context)).toEqual({ collected: 1, failed: 0 })
    })

    it('stores responses, refreshes changes without deleting missing ones, and pages with a cursor', async () => {
      const { jobs: [job], channels: [channel] } = await published()
      adapter.responsesWith = async () => ({ kind: 'ok', responses: [response('c2'), response('c1', { text: 'x'.repeat(6_000) }), response('c2')] })
      expect(await collectDueResponses(context)).toEqual({ checked: 1, failed: 0 })
      expect(adapter.responseCalls[0]).toMatchObject({ externalId: 'post-1', token: 'token-Bottega-secret' })
      const firstSeen = now
      const initial = await readResponses(context, org, { limit: 50 })
      expect(initial.responses).toHaveLength(2)
      expect(initial.responses.find(item => item.externalId === 'c1')!.text).toHaveLength(5_000)
      // This reader does not say whether the brand wrote a response: it stays unknown.
      expect(initial.responses[0]).toEqual({ id: expect.any(String), jobId: job!.id, channelId: channel!.id, platform: 'meta', externalId: expect.any(String),
        parentExternalId: null, author: { name: 'Mario Rossi', handle: null }, text: expect.any(String), likeCount: 0, replyCount: 0,
        publishedAt: firstSeen.toISOString(), firstSeenAt: firstSeen.toISOString(), updatedAt: firstSeen.toISOString(), url: null, fromChannel: null, replyId: null })
      expect(initial.status).toEqual([{ jobId: job!.id, state: 'ok', reason: null, checkedAt: firstSeen.toISOString(),
        nextCheckAt: new Date(firstSeen.getTime() + 2 * minute).toISOString() }])
      expect(initial.cursor).toEqual(expect.any(String))

      advance(2 * minute)
      // c1 is gone from the page (not deleted), c2 was edited, c3 is new.
      adapter.responsesWith = async () => ({ kind: 'ok', responses: [response('c3', { parentExternalId: 'c2' }), response('c2', { text: 'edited', likeCount: 4 })] })
      expect(await collectDueResponses(context)).toEqual({ checked: 1, failed: 0 })
      const rows = await db.select().from(postResponses)
      expect(rows.map(row => row.externalId).sort()).toEqual(['c1', 'c2', 'c3'])
      expect(rows.find(row => row.externalId === 'c2')).toMatchObject({ text: 'edited', likeCount: 4, firstSeenAt: firstSeen, updatedAt: now })
      expect(rows.find(row => row.externalId === 'c1')!.updatedAt).toEqual(firstSeen)

      const appended = await readResponses(context, org, { after: initial.cursor!, limit: 50 })
      expect(appended.responses.map(item => [item.externalId, item.parentExternalId])).toEqual([['c3', 'c2']])
      const quiet = await readResponses(context, org, { after: appended.cursor!, limit: 50 })
      expect(quiet).toMatchObject({ responses: [], cursor: appended.cursor })
      expect((await readResponses(context, org, { limit: 1 })).responses.map(item => item.externalId)).toEqual(['c3'])
      expect(await readResponses(context, 'other-org', { limit: 50, jobIds: [job!.id] })).toEqual({ responses: [], status: [], cursor: null })
    })

    it('checks one post per channel at a time, by age cadence and within the call budget', async () => {
      const [channel] = await connect()
      await submitJobs(context, submission([channel!.id]))
      await submitJobs(context, submission([channel!.id]))
      advance(60 * minute)
      await runDue()
      await runDue()
      expect(await collectDueResponses(context, new CallBudget(60, 0, () => 0))).toEqual({ checked: 0, failed: 0 })
      expect(await collectDueResponses(context)).toEqual({ checked: 1, failed: 0 })
      expect(await collectDueResponses(context)).toEqual({ checked: 1, failed: 0 })
      expect(await collectDueResponses(context)).toEqual({ checked: 0, failed: 0 })
      expect(new Set(adapter.responseCalls.map(call => call.externalId)).size).toBe(2)

      advance(3 * 86_400_000)
      await collectDueResponses(context)
      const check = (await db.select().from(responseChecks)).find(row => row.checkedAt!.getTime() === now.getTime())
      expect(check!.nextCheckAt.getTime() - check!.checkedAt!.getTime()).toBe(10 * minute)
    })

    it('reports missing permissions for a day and failures with backoff', async () => {
      const { jobs: [job] } = await published()
      adapter.responsesWith = async () => ({ kind: 'unavailable', reason: 'Reading comments needs the pages_read_user_content permission.' })
      await collectDueResponses(context)
      const { status: [unavailable] } = await readResponses(context, org, { jobIds: [job!.id], limit: 50 })
      expect(unavailable).toEqual({ jobId: job!.id, state: 'unavailable', reason: 'Reading comments needs the pages_read_user_content permission.',
        checkedAt: now.toISOString(), nextCheckAt: new Date(now.getTime() + 86_400_000).toISOString() })

      advance(86_400_000)
      adapter.responsesWith = async () => { throw new Error('Graph GET /x returned 500') }
      expect(await collectDueResponses(context)).toEqual({ checked: 0, failed: 1 })
      const [failing] = await db.select().from(responseChecks)
      expect(failing).toMatchObject({ state: 'failing', failureCount: 1, lastError: 'Graph GET /x returned 500' })
      expect(failing!.nextCheckAt.getTime() - now.getTime()).toBe(2 * minute)
      expect((await listJobs(context, org, job!.postId)).jobs[0]).toMatchObject({ state: 'published' })
    })

    it('lists the status of checked posts without responses, and of unpublished jobs, in the whole-tenant feed', async () => {
      const { jobs: [job] } = await published()
      adapter.responsesWith = async () => ({ kind: 'unavailable', reason: 'Reading comments needs the instagram_manage_comments permission.' })
      await collectDueResponses(context)
      const feed = await readResponses(context, org, { limit: 50 })
      expect(feed.responses).toEqual([])
      expect(feed.status).toEqual([expect.objectContaining({ jobId: job!.id, state: 'unavailable' })])
      expect((await readResponses(context, 'other-org', { limit: 50 })).status).toEqual([])

      await db.update(jobs).set({ state: 'failed' }).where(eq(jobs.id, job!.id))
      const { status: [failed] } = await readResponses(context, org, { jobIds: [job!.id], limit: 50 })
      expect(failed).toEqual({ jobId: job!.id, state: 'not_supported', reason: 'The post was not published on this channel.', checkedAt: null, nextCheckAt: null })
    })

    it('lists at most 500 statuses for the whole tenant, newest first, from checked and answered jobs', async () => {
      const { jobs: [template] } = await published()
      const [row] = await db.select().from(jobs).where(eq(jobs.id, template!.id))
      const day = 24 * 60 * minute
      const insertJobs = async (ages: number[], organizationId = org) => {
        const rows = ages.map(age => ({ ...row!, id: randomUUID(), postId: randomUUID(), organizationId, publishAt: new Date(now.getTime() - age) }))
        await db.insert(jobs).values(rows)
        return rows
      }
      const check = (rows: Array<typeof jobs.$inferSelect>) => db.insert(responseChecks)
        .values(rows.map(job => ({ jobId: job.id, organizationId: job.organizationId, channelId: job.channelId, state: 'ok' as const, checkedAt: now, nextCheckAt: now })))
      const answer = (rows: Array<typeof jobs.$inferSelect>) => db.insert(postResponses).values(rows.map(job => ({ organizationId: job.organizationId,
        channelId: job.channelId, jobId: job.id, externalId: `c-${job.id}`, text: 'Bello!', publishedAt: now, firstSeenAt: now, updatedAt: now })))

      const recent = await insertJobs(Array.from({ length: 10 }, (_, index) => (index + 1) * 60 * minute))
      await check(recent)
      // Checked and answered: listed once.
      await answer(recent.slice(0, 2))
      // Past the 90-day window: listed only with stored responses, and only until the retention horizon.
      const [answered100, answered150, unswept] = await insertJobs([100 * day, 150 * day, 181 * day])
      await check([answered100!, answered150!, unswept!])
      await answer([answered100!, answered150!, unswept!])
      await check(await insertJobs([120 * day]))
      await check(await insertJobs([minute], 'other-org'))
      const expected = [...recent, answered100!, answered150!].map(job => job.id)
      expect((await readResponses(context, org, { limit: 50 })).status.map(item => item.jobId)).toEqual(expected)

      // 500 newer checked jobs push the older ones out.
      const newer = await insertJobs(Array.from({ length: 495 }, (_, index) => 30_000 + index * 1_000))
      await check(newer)
      const { status } = await readResponses(context, org, { limit: 50 })
      expect(status).toHaveLength(500)
      expect(status.map(item => item.jobId)).toEqual([...newer, ...recent.slice(0, 5)].map(job => job.id))
      expect(status[0]).toEqual({ jobId: newer[0]!.id, state: 'ok', reason: null, checkedAt: now.toISOString(), nextCheckAt: now.toISOString() })
      // Asking for jobs by ID is not capped by the list.
      expect((await readResponses(context, org, { jobIds: [answered150!.id], limit: 50 })).status.map(item => item.jobId)).toEqual([answered150!.id])
    })

    it('reads both status lists in index order, so each stops at the cap without a sort or a table scan', async () => {
      const queries: Array<{ query: string, params: unknown[] }> = []
      const logged = drizzle(fixture.runtime, { schema, logger: { logQuery: (query, params) => { queries.push({ query, params }) } } })
      await readResponses({ ...context, db: logged }, org, { limit: 50 })
      const lists = queries.filter(({ query }) => query.includes('order by "jobs"."publish_at" desc, "jobs"."id" desc'))
      expect(lists).toHaveLength(2)
      interface PlanNode { 'Node Type': string, 'Index Name'?: string, 'Scan Direction'?: string, Plans?: PlanNode[] }
      const flatten = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(flatten)]
      const client = await fixture.runtime.connect()
      try {
        await client.query('begin')
        // With these off, only a plan that walks an index in the list's order is left, if the query allows one.
        for (const setting of ['enable_seqscan', 'enable_bitmapscan', 'enable_sort']) await client.query(`set local ${setting} = off`)
        for (const { query, params } of lists) {
          const { rows: [explained] } = await client.query(`explain (format json) ${query}`, params)
          const nodes = flatten((explained['QUERY PLAN'] as Array<{ Plan: PlanNode }>)[0]!.Plan)
          expect(nodes.filter(node => /Sort|Seq Scan|Bitmap/.test(node['Node Type']))).toEqual([])
          expect(nodes.find(node => node['Index Name'] === 'jobs_organization_publish')).toMatchObject({ 'Scan Direction': 'Backward' })
          expect(nodes.some(node => node['Index Name'] === 'response_checks_pkey' || node['Index Name'] === 'post_responses_job')).toBe(true)
        }
      } finally {
        await client.query('rollback')
        client.release()
      }
    })

    it('indexes the column of every foreign key that cascades', async () => {
      const { rows } = await fixture.migrator.query(`select c.conrelid::regclass::text as "table", a.attname as "column" from pg_constraint c
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
        where c.contype = 'f' and c.confdeltype = 'c' and not exists (select from pg_index i where i.indrelid = c.conrelid and i.indkey[0] = c.conkey[1])`)
      expect(rows).toEqual([])
    })

    it('watches a tenant\'s published posts for five minutes, every 30 seconds', async () => {
      const { jobs: [job] } = await published()
      await collectDueResponses(context)
      advance(minute)
      expect(await watchResponses(context, 'other-org', [job!.id])).toEqual({ watchUntil: new Date(now.getTime() + 5 * minute).toISOString() })
      expect(await collectDueResponses(context)).toEqual({ checked: 0, failed: 0 })

      expect(await watchResponses(context, org, [job!.id])).toEqual({ watchUntil: new Date(now.getTime() + 5 * minute).toISOString() })
      expect(await collectDueResponses(context)).toEqual({ checked: 1, failed: 0 })
      const [watched] = await db.select().from(responseChecks)
      expect(watched!.nextCheckAt.getTime() - now.getTime()).toBe(30_000)
      advance(6 * minute)
      await collectDueResponses(context)
      const [after] = await db.select().from(responseChecks)
      expect(after!.nextCheckAt.getTime() - now.getTime()).toBe(2 * minute)
    })

    it('keeps a read whose usage is high and pauses the app before Meta refuses', async () => {
      const { channels: connected } = await published(['Bottega', 'Forno'])
      adapter.metricsWith = async input => {
        input.slowDown?.(new RateLimited('Meta usage is high (app 93%)', 'app', new Date(now.getTime() + 15 * minute)))
        return { values: { likes: 9 }, unavailable: [] }
      }
      expect((await collectDueMetrics(context)).failed).toBe(0)
      expect((await db.select().from(postMetrics)).map(row => row.values)).toContainEqual({ likes: 9 })
      const paused = await db.select().from(channelMetrics)
      expect(paused.map(row => row.channelId).sort()).toEqual(connected.map(channel => channel.id).sort())
      for (const row of paused) expect(row.pausedUntil).toEqual(new Date(now.getTime() + 15 * minute))
      expect(await collectDueMetrics(context)).toEqual({ collected: 0, failed: 0 })
    })

    it('pauses every channel on the provider app when the limit is the app\'s', async () => {
      const { channels: connected } = await published(['Bottega', 'Forno'])
      adapter.responsesWith = async () => { throw new RateLimited('Graph returned 400 (code 4)', 'app') }
      expect(await collectDueResponses(context)).toMatchObject({ checked: 0 })
      const paused = await db.select().from(channelMetrics)
      expect(paused.map(row => row.channelId).sort()).toEqual(connected.map(channel => channel.id).sort())
      for (const row of paused) expect(row.pausedUntil!.getTime() - now.getTime()).toBe(60 * minute)

      // An explicit end (YouTube's quota day) is kept, and a later success leaves the pause alone.
      const until = new Date(now.getTime() + 5 * 60 * minute)
      adapter.responsesWith = async () => { throw new RateLimited('quotaExceeded', 'app', until) }
      advance(61 * minute)
      await collectDueResponses(context)
      for (const row of await db.select().from(channelMetrics)) expect(row.pausedUntil).toEqual(until)
    })

    it('keeps a watch that arrives while a check is running', async () => {
      const { jobs: [job] } = await published()
      await collectDueResponses(context)
      advance(2 * minute)
      adapter.responsesWith = async () => {
        await watchResponses(context, org, [job!.id])
        return { kind: 'ok', responses: [] }
      }
      expect(await collectDueResponses(context)).toEqual({ checked: 1, failed: 0 })
      const [check] = await db.select().from(responseChecks)
      expect(check!.nextCheckAt.getTime() - now.getTime()).toBe(30_000)
    })

    it('checks several watched posts of one channel in the same pass', async () => {
      const [channel] = await connect()
      const first = await submitJobs(context, submission([channel!.id]))
      const second = await submitJobs(context, submission([channel!.id]))
      advance(60 * minute)
      await runDue()
      await runDue()
      await collectDueResponses(context)
      await collectDueResponses(context)
      advance(minute)
      await watchResponses(context, org, [first.jobs[0]!.id, second.jobs[0]!.id])
      expect(await collectDueResponses(context)).toEqual({ checked: 2, failed: 0 })
    })

    it('marks browser channels unsupported and unchecked posts pending', async () => {
      const { jobs: [job] } = await published()
      const browserId = await browserChannel()
      const [row] = await db.select().from(jobs).where(eq(jobs.id, job!.id))
      const browserJobId = randomUUID()
      await db.insert(jobs).values({ ...row!, id: browserJobId, channelId: browserId })
      const { status } = await readResponses(context, org, { jobIds: [job!.id, browserJobId, randomUUID()], limit: 50 })
      expect(status).toEqual([
        { jobId: job!.id, state: 'pending', reason: null, checkedAt: null, nextCheckAt: now.toISOString() },
        { jobId: browserJobId, state: 'not_supported', reason: expect.any(String), checkedAt: null, nextCheckAt: null },
      ])
      const metrics = await readChannelMetrics(context, org, [browserId], 30)
      expect(metrics).toEqual([{ channelId: browserId, platform: 'reddit', kind: 'reddit_account', supported: false, latest: null, samples: [] }])
      await watchResponses(context, org, [browserJobId])
      expect(await db.select().from(responseChecks)).toEqual([])
    })

    it('deletes expired samples and responses, and responses of disabled channels', async () => {
      const { jobs: [first, second], channels: [one, two] } = await published(['One', 'Two'])
      adapter.responsesWith = async input => ({ kind: 'ok', responses: [response(`on-${input.externalId}`)] })
      await collectDueResponses(context)
      await collectDueMetrics(context)
      await collectDueChannelMetrics(context)
      await db.insert(postMetricSamples).values({ jobId: first!.id, organizationId: org, channelId: one!.id, collectedAt: new Date(now.getTime() - 121 * 86_400_000) })
      await db.insert(channelMetricSamples).values([
        { channelId: one!.id, organizationId: org, collectedAt: new Date(now.getTime() - 401 * 86_400_000) },
        { channelId: one!.id, organizationId: org, collectedAt: new Date(now.getTime() - 399 * 86_400_000) },
      ])
      await db.update(jobs).set({ publishAt: new Date(now.getTime() - 181 * 86_400_000) }).where(eq(jobs.id, first!.id))
      expect(await applyRetention(context)).toEqual({ postMetricSamples: 1, channelMetricSamples: 1, responses: 1, replies: 0,
        conversations: 0, directMessages: 0, outgoingMessages: 0, webhookDeliveries: 0, drafts: 0, learnedAnswers: 0 })
      expect((await db.select().from(postResponses)).map(row => row.jobId)).toEqual([second!.id])
      expect(await db.select().from(postMetricSamples)).toHaveLength(2)

      await disableChannel(context, org, two!.id)
      expect(await db.select().from(postResponses)).toEqual([])
      expect(await db.select().from(responseChecks).where(eq(responseChecks.channelId, two!.id))).toEqual([])
    })

    it('serves the contract over HTTP and keeps tenants apart', async () => {
      const { jobs: [job], channels: [channel] } = await published()
      adapter.responsesWith = async () => ({ kind: 'ok', responses: [response('c1')] })
      await collectDueResponses(context)
      await collectDueMetrics(context)
      await collectDueChannelMetrics(context)
      const token = 's'.repeat(48)
      const server = createServer(toNodeListener(createEngineApp(context, token)))
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      const call = async (path: string, init: RequestInit = {}) => {
        const result = await fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } })
        return { status: result.status, body: await result.json() as Record<string, unknown> }
      }
      try {
        expect(await call(`/v1/tenants/${org}/channel-metrics?days=7`)).toEqual({ status: 200, body: { channels: [{ channelId: channel!.id, platform: 'meta',
          kind: 'facebook_page', supported: true, latest: { values: { followers: 120, views: 40 }, unavailable: ['reach'], collectedAt: now.toISOString() },
          samples: [{ collectedAt: now.toISOString(), values: { followers: 120, views: 40 } }] }] } })
        expect(await call(`/v1/tenants/${org}/metrics/history?jobIds=${job!.id}`)).toEqual({ status: 200, body: { history: [{ jobId: job!.id,
          samples: [{ collectedAt: now.toISOString(), values: { likes: 3, comments: 1, views: 40 } }] }] } })
        const responses = await call(`/v1/tenants/${org}/responses?jobIds=${job!.id}&limit=10`)
        expect(responses.status).toBe(200)
        expect(Object.keys(responses.body).sort()).toEqual(['cursor', 'responses', 'status'])
        expect(responses.body.responses).toMatchObject([{ externalId: 'c1', jobId: job!.id, author: { name: 'Mario Rossi', handle: null } }])
        expect(await call(`/v1/tenants/${org}/responses/watch`, { method: 'POST', body: JSON.stringify({ jobIds: [job!.id] }) }))
          .toEqual({ status: 200, body: { watchUntil: new Date(now.getTime() + 5 * minute).toISOString() } })

        expect(await call(`/v1/tenants/other-org/channel-metrics?channelIds=${channel!.id}`)).toEqual({ status: 200, body: { channels: [] } })
        expect(await call(`/v1/tenants/other-org/metrics/history?jobIds=${job!.id}`)).toEqual({ status: 200, body: { history: [] } })
        expect(await call(`/v1/tenants/other-org/responses`)).toEqual({ status: 200, body: { responses: [], status: [], cursor: null } })
        // Restore answers per job; another tenant's post is not found.
        expect(await call('/v1/jobs/restore', { method: 'POST', body: JSON.stringify({ organizationId: org, postId: job!.postId, revision: 1 }) }))
          .toEqual({ status: 200, body: { jobs: [{ jobId: job!.id, channelId: channel!.id, state: 'published', result: 'not_cancelled_by_pause' }] } })
        expect((await call('/v1/jobs/restore', { method: 'POST', body: JSON.stringify({ organizationId: 'other-org', postId: job!.postId, revision: 1 }) })).status)
          .toBe(404)
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()))
      }
    })
  })

  describe('webhooks', () => {
    const minute = 60_000
    let sent: WebhookRequest[]
    let answers: WebhookResult[]
    beforeEach(() => {
      sent = []
      answers = []
      context.webhookSender = async request => {
        sent.push(request)
        return answers.shift() ?? { kind: 'delivered', status: 204 }
      }
    })
    const hook = (eventTypes: WebhookEventType[],
      channelIds: string[] | null = null) => createWebhook(context, org, { url: 'https://hooks.example.com/social', eventTypes, channelIds, description: 'App Forno' })
    const bodies = () => sent.map(request => JSON.parse(request.body) as { type: string, timestamp: string, data: Record<string, unknown> })
    async function publish(channelIds: string[]) {
      const { jobs: created } = await submitJobs(context, submission(channelIds))
      advance(60 * minute)
      for (let index = 0; index < created.length; index++) await runDue()
      return created
    }

    it('registers endpoints per tenant, returns the secret only on creation and rotation, and seals it', async () => {
      const [channel] = await connect()
      const { webhook, secret } = await hook(['comment.created'], [channel!.id])
      expect(secret).toMatch(/^whsec_/)
      expect(webhook).toEqual({ id: expect.any(String), url: 'https://hooks.example.com/social', description: 'App Forno', eventTypes: ['comment.created'],
        channelIds: [channel!.id], status: 'active', disabledReason: null, failingSince: null, lastDeliveredAt: null, previousSecretExpiresAt: null,
        createdAt: now.toISOString(), updatedAt: now.toISOString() })
      const [row] = await db.select().from(webhooks)
      expect(row!.secretCiphertext.toString('utf8')).not.toContain(secret.slice(6, 20))
      expect(await listWebhooks(context, org)).toEqual([webhook])
      expect(await listWebhooks(context, 'other-org')).toEqual([])
      await expect(updateWebhook(context, 'other-org', webhook.id, { enabled: false })).rejects.toMatchObject({ status: 404 })
      await expect(deleteWebhook(context, 'other-org', webhook.id)).rejects.toMatchObject({ status: 404 })
      await expect(createWebhook(context, 'other-org', { url: 'https://a.example.com/', eventTypes: ['comment.created'], channelIds: [channel!.id], description: null }))
        .rejects.toMatchObject({ code: 'unknown_channel' })

      const rotated = await rotateWebhookSecret(context, org, webhook.id)
      expect(rotated.secret).not.toBe(secret)
      expect(rotated.webhook.previousSecretExpiresAt).toBe(new Date(now.getTime() + 24 * 60 * minute).toISOString())
      // Both secrets sign for a day, then only the new one.
      await testWebhook(context, org, webhook.id)
      await deliverDueWebhooks(context)
      const first = sent[0]!
      expect(first.headers['webhook-signature']).toBe(signWebhook([rotated.secret, secret], first.headers['webhook-id']!, Number(first.headers['webhook-timestamp']), first.body))
      advance(24 * 60 * minute + 1)
      await testWebhook(context, org, webhook.id)
      await deliverDueWebhooks(context)
      expect(sent[1]!.headers['webhook-signature']!.split(' ')).toHaveLength(1)

      for (let index = 1; index < 10; index++) await hook(['post.published'])
      await expect(hook(['post.published'])).rejects.toMatchObject({ code: 'webhook_limit' })
      expect(await deleteWebhook(context, org, webhook.id)).toEqual({ deleted: true })
      expect(await listWebhooks(context, org)).toHaveLength(9)
    })

    it('signs each delivery the Standard Webhooks way, with the delivery as its ID', async () => {
      const { webhook, secret } = await hook(['post.published'])
      await testWebhook(context, org, webhook.id)
      expect(await deliverDueWebhooks(context)).toEqual({ delivered: 1, failed: 0 })
      const [request] = sent
      const [delivery] = await db.select().from(webhookDeliveries)
      expect(request!.url).toBe('https://hooks.example.com/social')
      expect(request!.headers['webhook-id']).toBe(delivery!.id)
      expect(request!.headers['webhook-timestamp']).toBe(String(now.getTime() / 1000))
      const expected = createHmac('sha256', Buffer.from(secret.slice(6), 'base64'))
        .update(`${delivery!.id}.${request!.headers['webhook-timestamp']}.${request!.body}`).digest('base64')
      expect(request!.headers['webhook-signature']).toBe(`v1,${expected}`)
      expect(JSON.parse(request!.body)).toEqual({ type: 'webhook.test', timestamp: now.toISOString(), data: { organizationId: org, webhookId: webhook.id } })
      expect(delivery).toMatchObject({ state: 'delivered', attemptCount: 1, lastStatus: 204, deliveredAt: now })
      expect((await listWebhooks(context, org))[0]!.lastDeliveredAt).toBe(now.toISOString())
    })

    it('tells of published and failed posts, only to endpoints that take them for that channel', async () => {
      const [bottega, other] = await connect(['Bottega', 'Other'])
      await hook(['post.published', 'post.failed'], [bottega!.id])
      await hook(['comment.created'])
      adapter.outcomes = [{ kind: 'published', externalId: 'fb-1', url: 'https://facebook.com/fb-1' }]
      const [job] = await publish([bottega!.id, other!.id])
      await deliverDueWebhooks(context)
      expect(bodies()).toEqual([{ type: 'post.published', timestamp: now.toISOString(), data: { organizationId: org, jobId: job!.id, postId: job!.postId,
        revision: 1, channelId: bottega!.id, platform: 'meta', kind: 'facebook_page', externalId: 'fb-1', url: 'https://facebook.com/fb-1', publishedAt: now.toISOString() } }])

      sent = []
      adapter.outcomes = [{ kind: 'failed', retryable: true, code: 'network', detail: 'x' }]
      await submitJobs(context, submission([bottega!.id]))
      advance(60 * minute)
      await runDue()
      await deliverDueWebhooks(context)
      // A failure that will be retried is not an outcome yet.
      expect(sent).toEqual([])
      adapter.outcomes = [{ kind: 'failed', retryable: false, code: 'rejected', detail: 'x' }]
      advance(5 * minute)
      await runDue()
      await deliverDueWebhooks(context)
      expect(bodies()).toMatchObject([{ type: 'post.failed', data: { channelId: bottega!.id, code: 'rejected' } }])
    })

    it('tells of moving post numbers, reads watched young posts every 15 minutes, and stays quiet when nothing moved', async () => {
      const [channel] = await connect()
      const [job] = await publish([channel!.id])
      await collectDueMetrics(context)
      const [unwatched] = await db.select().from(postMetrics)
      expect(unwatched!.nextCollectAt.getTime() - now.getTime()).toBe(60 * minute)

      await hook(['post.metrics.changed'])
      // Subscribing brings the next read forward.
      const [pulled] = await db.select().from(postMetrics)
      expect(pulled!.nextCollectAt.getTime() - now.getTime()).toBe(15 * minute)
      advance(15 * minute)
      adapter.metricsWith = async () => ({ values: { likes: 3, comments: 1, views: 40 }, unavailable: ['reach'] })
      expect(await collectDueMetrics(context)).toEqual({ collected: 1, failed: 0 })
      expect(await db.select().from(webhookDeliveries)).toEqual([])
      const [watched] = await db.select().from(postMetrics)
      expect(watched!.nextCollectAt.getTime() - now.getTime()).toBe(15 * minute)

      advance(15 * minute)
      adapter.metricsWith = async () => ({ values: { likes: 7, comments: 1, views: 95, shares: 1 }, unavailable: ['reach'] })
      await collectDueMetrics(context)
      await deliverDueWebhooks(context)
      expect(bodies()).toEqual([{ type: 'post.metrics.changed', timestamp: now.toISOString(), data: { organizationId: org, jobId: job!.id, postId: job!.postId,
        revision: 1, channelId: channel!.id, platform: 'meta', kind: 'facebook_page', externalId: 'post-1', url: null,
        values: { likes: 7, comments: 1, views: 95, shares: 1 }, previous: { likes: 3, comments: 1, views: 40 }, changes: { likes: 4, views: 55 },
        unavailable: ['reach'], collectedAt: now.toISOString() } }])

      // After two days the regular cadence takes over.
      advance(2 * 24 * 60 * minute)
      await collectDueMetrics(context)
      const [old] = await db.select().from(postMetrics)
      expect(old!.nextCollectAt.getTime() - now.getTime()).toBe(6 * 60 * minute)
    })

    it('tells of moving account numbers (followers, subscribers) and reads them every 30 minutes while watched', async () => {
      const [channel, other] = await connect(['Bottega', 'Other'])
      await collectDueChannelMetrics(context)
      await hook(['channel.metrics.changed'], [channel!.id])
      const rows = await db.select().from(channelMetrics)
      expect(rows.find(row => row.channelId === channel!.id)!.nextCollectAt.getTime() - now.getTime()).toBe(30 * minute)
      expect(rows.find(row => row.channelId === other!.id)!.nextCollectAt.getTime() - now.getTime()).toBe(6 * 60 * minute)

      advance(30 * minute)
      adapter.accountWith = async () => ({ values: { followers: 125, views: 40 }, unavailable: ['reach'] })
      expect(await collectDueChannelMetrics(context)).toEqual({ collected: 1, failed: 0 })
      await deliverDueWebhooks(context)
      expect(bodies()).toEqual([{ type: 'channel.metrics.changed', timestamp: now.toISOString(), data: { organizationId: org, channelId: channel!.id,
        platform: 'meta', kind: 'facebook_page', name: 'Bottega', values: { followers: 125, views: 40 }, previous: { followers: 120, views: 40 },
        changes: { followers: 5 }, unavailable: ['reach'], collectedAt: now.toISOString() } }])
      const [read] = await db.select().from(channelMetrics).where(eq(channelMetrics.channelId, channel!.id))
      expect(read!.nextCollectAt.getTime() - now.getTime()).toBe(30 * minute)
    })

    it('tells of each new comment once, oldest first, and never of an edit', async () => {
      const [channel] = await connect()
      const [job] = await publish([channel!.id])
      await hook(['comment.created'])
      const at = (minutes: number) => new Date(now.getTime() - minutes * minute)
      const comment = (id: string, overrides: Partial<PlatformResponse> = {}): PlatformResponse => ({ externalId: id, parentExternalId: null,
        authorName: 'Mario Rossi', authorHandle: null, text: `text ${id}`, likeCount: 0, replyCount: 0, publishedAt: now, url: null, ...overrides })
      adapter.responsesWith = async () => ({ kind: 'ok', responses: [comment('c2', { publishedAt: at(1) }), comment('c1', { publishedAt: at(5), url: 'https://facebook.com/c1' })] })
      await collectDueResponses(context)
      advance(2 * minute)
      adapter.responsesWith = async () => ({ kind: 'ok', responses: [comment('c3', { parentExternalId: 'c1', fromChannel: true, authorName: 'Bottega' }),
        comment('c2', { text: 'edited', likeCount: 3 })] })
      await collectDueResponses(context)
      await deliverDueWebhooks(context)
      const [stored] = await db.select().from(postResponses).where(eq(postResponses.externalId, 'c1'))
      expect(bodies().map(body => [body.type, body.data.externalId])).toEqual([['comment.created', 'c1'], ['comment.created', 'c2'], ['comment.created', 'c3']])
      expect(bodies()[0]!.data).toEqual({ organizationId: org, responseId: stored!.id, jobId: job!.id, postId: job!.postId, channelId: channel!.id, platform: 'meta',
        externalId: 'c1', parentExternalId: null, author: { name: 'Mario Rossi', handle: null }, text: 'text c1', publishedAt: at(7).toISOString(),
        url: 'https://facebook.com/c1', fromChannel: null })
      expect(bodies()[2]!.data).toMatchObject({ parentExternalId: 'c1', fromChannel: true })
    })

    it('tells of new posts and videos on the account, wherever they were made, and of profile edits, while watched', async () => {
      const [channel] = await connect()
      const profile = { name: 'Bottega', username: 'bottega', description: 'Agenzia', website: null, category: 'Web', pictureUrl: 'https://cdn.example.com/p/a.jpg?oh=1' }
      const post = (id: string, minutesAgo: number, type: 'video' | 'image' = 'image') =>
        ({ externalId: id, type, text: `post ${id}`, url: `https://facebook.com/${id}`, publishedAt: new Date(now.getTime() - minutesAgo * minute) })
      adapter.activityWith = async () => ({ profile, posts: [post('old-2', 60), post('old-1', 120)] })
      await collectDueChannelMetrics(context)
      // Nobody watches yet: no activity read at all.
      expect(adapter.activityCalls).toHaveLength(0)

      await hook(['channel.post.created', 'channel.profile.changed'], [channel!.id])
      const [pulled] = await db.select().from(channelMetrics)
      expect(pulled!.nextCollectAt.getTime() - now.getTime()).toBe(30 * minute)
      advance(30 * minute)
      await collectDueChannelMetrics(context)
      // The first read only remembers what is there.
      expect(adapter.activityCalls).toHaveLength(1)
      expect(await db.select().from(webhookDeliveries)).toEqual([])

      // A video uploaded on the platform, and a post the engine published; the picture URL's signature changed, nothing else.
      const [job] = await publish([channel!.id])
      adapter.activityWith = async () => ({ profile: { ...profile, pictureUrl: 'https://cdn.example.com/p/a.jpg?oh=2' },
        posts: [post('post-1', 1), post('vid-1', 10, 'video'), post('old-2', 150), post('old-1', 210)] })
      await collectDueChannelMetrics(context)
      await deliverDueWebhooks(context)
      expect(bodies().map(body => [body.type, body.data.externalId, body.data.jobId])).toEqual([['channel.post.created', 'vid-1', null],
        ['channel.post.created', 'post-1', job!.id]])
      expect(bodies()[0]).toEqual({ type: 'channel.post.created', timestamp: now.toISOString(), data: { organizationId: org, channelId: channel!.id, name: 'Bottega',
        platform: 'meta', kind: 'facebook_page', externalId: 'vid-1', type: 'video', text: 'post vid-1', url: 'https://facebook.com/vid-1',
        publishedAt: new Date(now.getTime() - 10 * minute).toISOString(), jobId: null, postId: null } })
      expect(bodies()[1]!.data.postId).toBe(job!.postId)

      // A new name and bio, and an old post that scrolled into view after a deletion: only the profile is news.
      sent = []
      advance(30 * minute)
      adapter.activityWith = async () => ({ profile: { ...profile, name: 'Bottega Digitale', description: 'Agenzia web', pictureUrl: 'https://cdn.example.com/p/b.jpg' },
        posts: [post('post-1', 31), post('vid-1', 40, 'video'), post('ancient', 5 * 24 * 60)] })
      await collectDueChannelMetrics(context)
      await deliverDueWebhooks(context)
      expect(bodies()).toEqual([{ type: 'channel.profile.changed', timestamp: now.toISOString(), data: { organizationId: org, channelId: channel!.id,
        name: 'Bottega', platform: 'meta', kind: 'facebook_page', changed: ['name', 'description', 'pictureUrl'],
        profile: { ...profile, name: 'Bottega Digitale', description: 'Agenzia web', pictureUrl: 'https://cdn.example.com/p/b.jpg' },
        previous: { ...profile, pictureUrl: 'https://cdn.example.com/p/a.jpg?oh=2' } } }])
      expect(adapter.activityCalls.at(-1)).toMatchObject({ token: 'token-Bottega-secret', channel: { id: channel!.id } })
    })

    it('keeps reading account numbers when the activity read fails, and records the failure', async () => {
      const [channel] = await connect()
      await hook(['channel.post.created'])
      adapter.activityWith = async () => { throw new Error('Graph GET /published_posts returned 500') }
      expect(await collectDueChannelMetrics(context)).toEqual({ collected: 1, failed: 0 })
      const [row] = await db.select().from(channelActivity)
      expect(row).toMatchObject({ channelId: channel!.id, failureCount: 1, lastError: 'Graph GET /published_posts returned 500', seenPostIds: null })
    })

    it('tells of channels connected, needing a new login, disabled and reconnected', async () => {
      await hook(['channel.status.changed'])
      const [channel] = await connect()
      adapter.outcomes = [{ kind: 'failed', retryable: false, code: 'auth', detail: 'x', reauth: true }]
      await publish([channel!.id])
      await disableChannel(context, org, channel!.id)
      adapter.accounts = [{ kind: 'facebook_page', externalId: channel!.externalId, name: 'Bottega', token: 'token-again', tokenExpiresAt: null }]
      const { state } = await startConnect(context, org, 'meta-agency')
      await finishConnect(context, org, state, 'code')
      await deliverDueWebhooks(context)
      expect(bodies().map(body => [body.data.previousStatus, body.data.status, body.data.reason])).toEqual([[null, 'active', 'connected'],
        ['active', 'needs_reauth', 'publish_refused'], ['needs_reauth', 'disabled', 'disabled'], ['disabled', 'active', 'reconnected']])
    })

    it('retries failed deliveries on a schedule, then gives up', async () => {
      const { webhook } = await hook(['post.published'])
      await testWebhook(context, org, webhook.id)
      for (let attempt = 1; attempt < maxDeliveryAttempts; attempt++) {
        answers = [{ kind: 'failed', status: 503, error: 'HTTP 503' }]
        expect(await deliverDueWebhooks(context)).toEqual({ delivered: 0, failed: 1 })
        const [row] = await db.select().from(webhookDeliveries)
        expect(row).toMatchObject({ state: 'pending', attemptCount: attempt, lastStatus: 503, lastError: 'HTTP 503' })
        expect(row!.nextAttemptAt.getTime() - now.getTime()).toBe(deliveryRetryDelaysMs[attempt - 1])
        expect(await deliverDueWebhooks(context)).toEqual({ delivered: 0, failed: 0 })
        advance(deliveryRetryDelaysMs[attempt - 1]!)
      }
      answers = [{ kind: 'failed', status: null, error: 'timeout' }]
      await deliverDueWebhooks(context)
      const [given] = await listDeliveries(context, org, webhook.id, { limit: 10 })
      expect(given).toMatchObject({ state: 'failed', attemptCount: maxDeliveryAttempts, lastError: 'timeout', nextAttemptAt: null })
      expect(sent).toHaveLength(maxDeliveryAttempts)
      expect(new Set(sent.map(request => request.headers['webhook-id']))).toEqual(new Set([given!.id]))
      expect(new Set(sent.map(request => request.body)).size).toBe(1)

      // A person may send it again: same ID and body, counted from one.
      expect((await redeliver(context, org, webhook.id, given!.id)).delivery).toMatchObject({ state: 'pending', attemptCount: 0 })
      await deliverDueWebhooks(context)
      expect((await listDeliveries(context, org, webhook.id, { limit: 10 }))[0]).toMatchObject({ state: 'delivered', attemptCount: 1 })
      expect(sent.at(-1)!.headers['webhook-id']).toBe(given!.id)
      await expect(redeliver(context, 'other-org', webhook.id, given!.id)).rejects.toMatchObject({ status: 404 })
    })

    it('a worker that dies mid-request leaves the delivery to be tried again after the lease', async () => {
      const { webhook } = await hook(['post.published'])
      await testWebhook(context, org, webhook.id)
      context.webhookSender = () => new Promise(() => undefined)
      void deliverDueWebhooks(context)
      await new Promise(resolve => setTimeout(resolve, 200))
      context.webhookSender = async request => { sent.push(request); return { kind: 'delivered', status: 200 } }
      expect(await deliverDueWebhooks(context)).toEqual({ delivered: 0, failed: 0 })
      advance(2 * minute)
      expect(await deliverDueWebhooks(context)).toEqual({ delivered: 1, failed: 0 })
      expect((await db.select().from(webhookDeliveries))[0]).toMatchObject({ state: 'delivered', attemptCount: 2 })
    })

    it('disables an endpoint that answers 410, or that failed every attempt for three days, and queues nothing for it', async () => {
      const [channel] = await connect()
      const gone = (await hook(['post.published'])).webhook
      const failing = (await hook(['post.published'])).webhook
      const healthy = (await hook(['post.published'])).webhook
      context.webhookSender = async request => {
        sent.push(request)
        const id = (await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, request.headers['webhook-id']!)))[0]!.webhookId
        return id === gone.id ? { kind: 'failed', status: 410, error: 'HTTP 410' } : id === failing.id ? { kind: 'failed', status: 500, error: 'HTTP 500' }
          : { kind: 'delivered', status: 200 }
      }
      for (const webhook of [gone, failing, healthy]) await testWebhook(context, org, webhook.id)
      await deliverDueWebhooks(context)
      const status = async () => Object.fromEntries((await listWebhooks(context, org)).map(item => [item.id, [item.status, item.disabledReason]]))
      expect(await status()).toEqual({ [gone.id]: ['disabled', 'gone'], [failing.id]: ['active', null], [healthy.id]: ['active', null] })
      expect((await listWebhooks(context, org)).find(item => item.id === failing.id)!.failingSince).toBe(now.toISOString())

      advance(3 * 24 * 60 * minute)
      await publish([channel!.id])
      expect((await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.webhookId, gone.id))).map(row => row.eventType)).toEqual(['webhook.test'])
      await deliverDueWebhooks(context)
      expect(await status()).toEqual({ [gone.id]: ['disabled', 'gone'], [failing.id]: ['disabled', 'failing'], [healthy.id]: ['active', null] })
      // The attempt that disabled it keeps its own error; the other delivery still waiting is given up with it.
      expect((await listDeliveries(context, org, failing.id, { limit: 10 })).map(item => `${item.state} ${item.lastError}`).sort())
        .toEqual(['failed HTTP 500', 'failed webhook_disabled'])

      // Enabling clears the record; nothing missed is sent.
      const enabled = await updateWebhook(context, org, failing.id, { enabled: true })
      expect(enabled).toMatchObject({ status: 'active', disabledReason: null, failingSince: null })
      await expect(testWebhook(context, org, gone.id)).rejects.toMatchObject({ code: 'webhook_disabled' })
      expect(await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.state, 'pending'))).toEqual([])
    })

    it('serves the routes with the service token, per tenant, and deletes deliveries after 30 days', async () => {
      const token = 's'.repeat(48)
      const server = createServer(toNodeListener(createEngineApp(context, token)))
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      const call = async (path: string, init: RequestInit = {}) => {
        const result = await fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } })
        return { status: result.status, body: await result.json() as Record<string, unknown> }
      }
      try {
        const created = await call(`/v1/tenants/${org}/webhooks`, { method: 'POST', body: JSON.stringify({ url: 'https://hooks.example.com/x', eventTypes: ['comment.created'] }) })
        expect(created).toMatchObject({ status: 201, body: { webhook: { url: 'https://hooks.example.com/x', channelIds: null }, secret: expect.stringMatching(/^whsec_/) } })
        const id = (created.body.webhook as { id: string }).id
        expect(await call(`/v1/tenants/${org}/webhooks`, { method: 'POST', body: JSON.stringify({ url: 'https://10.0.0.1/x', eventTypes: ['comment.created'] }) }))
          .toMatchObject({ status: 400, body: { error: 'invalid_request' } })
        expect(await call(`/v1/tenants/${org}/webhooks/${id}`, { method: 'PATCH', body: JSON.stringify({ eventTypes: ['post.published', 'comment.created'] }) }))
          .toMatchObject({ status: 200, body: { webhook: { eventTypes: ['post.published', 'comment.created'] } } })
        expect(await call(`/v1/tenants/${org}/webhooks/${id}/test`, { method: 'POST' })).toMatchObject({ status: 202, body: { delivery: { eventType: 'webhook.test', state: 'pending' } } })
        expect(await call(`/v1/tenants/${org}/webhooks/${id}/deliveries?state=pending`)).toMatchObject({ status: 200, body: { deliveries: [{ eventType: 'webhook.test' }] } })
        expect(await call(`/v1/tenants/other-org/webhooks/${id}/deliveries`)).toMatchObject({ status: 404 })
        expect(await call(`/v1/tenants/other-org/webhooks`)).toEqual({ status: 200, body: { webhooks: [] } })
        const rotated = await call(`/v1/tenants/${org}/webhooks/${id}/rotate-secret`, { method: 'POST' })
        expect(rotated).toMatchObject({ status: 200, body: { secret: expect.stringMatching(/^whsec_/) } })
        const listed = await call(`/v1/tenants/${org}/webhooks`)
        expect(JSON.stringify(listed.body)).not.toContain('whsec_')

        await deliverDueWebhooks(context)
        advance(30 * 24 * 60 * minute + 1)
        expect(await applyRetention(context)).toMatchObject({ webhookDeliveries: 1 })
        expect(await call(`/v1/tenants/${org}/webhooks/${id}`, { method: 'DELETE' })).toEqual({ status: 200, body: { deleted: true } })
        expect(await call(`/v1/tenants/${org}/webhooks/${id}`, { method: 'DELETE' })).toMatchObject({ status: 404 })
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()))
      }
    })
  })
})
