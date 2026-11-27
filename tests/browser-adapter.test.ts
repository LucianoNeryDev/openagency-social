import { describe, expect, it, vi } from 'vitest'
import { RunnerClient } from '../src/platforms/browser/runner-client.js'
import { BrowserAdapter } from '../src/platforms/browser/adapter.js'
import { browserChannelKind, browserRules } from '../src/platforms/browser/rules.js'
import type { PublishInput } from '../src/platforms/types.js'
import { mediaFile } from './fixtures/media.js'

const accountId = '6b1f4c0e-8a52-4d3c-9b7e-2f1a3c4d5e6f'
const actionId = '0d9c8b7a-6f5e-4d3c-8b2a-1f0e9d8c7b6a'
const view = (state: string, extra: Record<string, unknown> = {}) => ({ id: actionId, actionId: 'attempt-1', kind: 'publish_post', accountId, state, visible: false, ...extra })
const json = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function adapter(replies: Array<() => Promise<Response>>, options = { pollMs: 0, maxWaitMs: 60_000 }, rules = browserRules.tiktok) {
  const calls: Array<{ url: string, init?: RequestInit }> = []
  const fetcher = (async (url: URL | string, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    const reply = replies.shift()
    if (!reply) throw new Error(`Unexpected call ${String(url)}`)
    return reply()
  }) as typeof fetch
  return { calls, adapter: new BrowserAdapter(new RunnerClient({ url: 'http://100.64.1.4:3430', token: 't'.repeat(40), fetch: fetcher }), rules, options) }
}

const input = (overrides: Partial<PublishInput> = {}): PublishInput => ({
  attemptId: 'attempt-1', channel: { id: 'c', kind: 'tiktok_account', externalId: 'bottega.digitale' }, token: '',
  browserAccount: { id: accountId, handle: 'bottega.digitale', sealed: { ephemeralPublicKey: Buffer.alloc(32, 1), nonce: Buffer.alloc(12, 2), ciphertext: Buffer.alloc(40, 3) } },
  content: 'Ciao Brescia', settings: {},
  media: [{ ...mediaFile('m', 'a.mp4', 'video/mp4'), publicUrl: 'https://dash-api.example.com/api/social/media/org/m?expires=1&signature=s' }],
  ...overrides,
})

describe('TikTok through the runner', () => {
  it('accepts exactly one MP4 and no settings', () => {
    const { adapter: tiktok } = adapter([])
    const mp4 = { id: 'm', mimeType: 'video/mp4', sizeBytes: 1, width: null, height: null }
    expect(() => tiktok.validateSettings('tiktok_account', {}, [mp4])).not.toThrow()
    expect(() => tiktok.validateSettings('tiktok_account', {}, [])).toThrow('MP4')
    expect(() => tiktok.validateSettings('tiktok_account', {}, [{ ...mp4, mimeType: 'image/jpeg' }])).toThrow('MP4')
    expect(() => tiktok.validateSettings('tiktok_account', { privacy: 'public' }, [mp4])).toThrow('no channel settings')
  })

  it('submits the sealed login by attempt, beats while a person takes over, and returns the receipt', async () => {
    const { adapter: tiktok, calls } = adapter([
      json(view('queued'), 202), json(view('needs_human', { takeover: { reason: 'captcha', since: '' } })), json(view('running', { visible: true })),
      json(view('succeeded', { visible: true, receipt: { externalId: '7400000000000000000', url: 'https://www.tiktok.com/@bottega.digitale/video/7400000000000000000' } })),
    ])
    const heartbeat = vi.fn().mockResolvedValue(undefined)
    expect(await tiktok.publish(null, input({ heartbeat }))).toEqual({ kind: 'published', externalId: '7400000000000000000', url: 'https://www.tiktok.com/@bottega.digitale/video/7400000000000000000' })
    expect(heartbeat).toHaveBeenCalledTimes(3)
    const body = JSON.parse(String(calls[0]!.init!.body))
    expect(body).toMatchObject({ actionId: 'attempt-1', kind: 'publish_post', account: { id: accountId, platform: 'tiktok', handle: 'bottega.digitale' },
      target: { kind: 'tiktok_account', externalId: 'bottega.digitale' }, settings: {} })
    expect(body.account.sealed.ciphertext).toBe(Buffer.alloc(40, 3).toString('base64'))
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe(`Bearer ${'t'.repeat(40)}`)
  })

  it('maps runner outcomes: failed before posting, uncertain after, and lost submissions', async () => {
    expect(await adapter([json(view('queued'), 202), json(view('failed', { error: { code: 'upload_failed', detail: 'x' } }))]).adapter.publish(null, input()))
      .toMatchObject({ kind: 'failed', retryable: false, code: 'upload_failed' })
    expect(await adapter([json(view('queued'), 202), json(view('failed', { error: { code: 'media_download_failed', detail: 'fetch failed' } }))]).adapter.publish(null, input()))
      .toMatchObject({ kind: 'failed', retryable: true, code: 'media_download_failed' })
    expect(await adapter([json(view('uncertain', { visible: true, error: { code: 'script_error', detail: 'x' } }), 202)]).adapter.publish(null, input()))
      .toMatchObject({ kind: 'uncertain', code: 'script_error' })
    const refused = async () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }) }
    expect(await adapter([refused]).adapter.publish(null, input())).toMatchObject({ kind: 'failed', retryable: true, code: 'runner_unreachable' })
    const lost = async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }) }
    expect(await adapter([lost]).adapter.publish(null, input())).toMatchObject({ kind: 'uncertain', code: 'runner_lost' })
  })

  it('gives up as uncertain when the runner outlives the wait', async () => {
    const { adapter: tiktok } = adapter([json(view('running'), 202), json(view('running'))], { pollMs: 5, maxWaitMs: 1 })
    expect(await tiktok.publish(null, input())).toMatchObject({ kind: 'uncertain', code: 'runner_timeout' })
  })

  it('reconciles from the runner by attempt ID', async () => {
    const reconcile = { attemptId: 'attempt-1', channel: input().channel, token: '', content: 'Ciao', settings: {}, since: new Date(), excludeExternalIds: [] }
    const done = adapter([json(view('succeeded', { receipt: { externalId: '74' } }))])
    expect(await done.adapter.reconcile(null, reconcile)).toEqual({ kind: 'published', externalId: '74' })
    expect(done.calls[0]!.url).toBe('http://100.64.1.4:3430/v1/actions?actionId=attempt-1')
    expect(await adapter([json({ error: 'not_found' }, 404)]).adapter.reconcile(null, reconcile)).toEqual({ kind: 'not_found' })
    expect(await adapter([json(view('failed'))]).adapter.reconcile(null, reconcile)).toEqual({ kind: 'not_found' })
    expect((await adapter([json(view('needs_human'))]).adapter.reconcile(null, reconcile)).kind).toBe('ambiguous')
  })
})

describe('other browser platforms', () => {
  const image = { id: 'i', mimeType: 'image/jpeg', sizeBytes: 1, width: 1000, height: 1000 }
  const video = { id: 'v', mimeType: 'video/mp4', sizeBytes: 1, width: null, height: null }
  const rulesFor = (platform: keyof typeof browserRules) => adapter([], undefined, browserRules[platform]).adapter

  it('takes images or one video on X and LinkedIn, and no settings', () => {
    const x = rulesFor('x')
    expect(x.limits()).toEqual({ maxLength: 280, maxMedia: 4, lengthUnit: 'x_weighted' })
    expect(() => x.validateSettings('x_account', {}, [])).not.toThrow()
    expect(() => x.validateSettings('x_account', {}, [image, image, image, image])).not.toThrow()
    expect(() => x.validateSettings('x_account', {}, [video, image])).toThrow('one video')
    expect(() => x.validateSettings('x_account', { reply: 'everyone' }, [])).toThrow('no channel settings')
    expect(() => x.validateSettings('tiktok_account', {}, [])).toThrow('Wrong channel kind for X')
    const linkedin = rulesFor('linkedin')
    expect(() => linkedin.validateSettings('linkedin_page', {}, [video])).not.toThrow()
    expect(() => linkedin.validateSettings('linkedin_profile', {}, [])).not.toThrow()
  })

  it('needs a board and one medium on Pinterest, a subreddit and title on Reddit', () => {
    const pinterest = rulesFor('pinterest')
    expect(() => pinterest.validateSettings('pinterest_account', { board: 'Siti web', link: 'https://bottega.example/blog' }, [image])).not.toThrow()
    expect(() => pinterest.validateSettings('pinterest_account', { board: 'Siti web' }, [])).toThrow('need an image')
    expect(() => pinterest.validateSettings('pinterest_account', {}, [image])).toThrow('Invalid Pinterest settings: board')
    expect(() => pinterest.validateSettings('pinterest_account', { board: 'x', link: 'javascript:alert(1)' }, [image])).toThrow('link')
    const reddit = rulesFor('reddit')
    expect(() => reddit.validateSettings('reddit_account', { subreddit: 'brescia', title: 'Ciao' }, [])).not.toThrow()
    expect(() => reddit.validateSettings('reddit_account', { subreddit: 'u_bottegadigitale', title: 'Ciao' }, [image, image])).not.toThrow()
    expect(() => reddit.validateSettings('reddit_account', { subreddit: 'r/brescia', title: 'Ciao' }, [])).toThrow('subreddit')
    expect(() => reddit.validateSettings('reddit_account', { subreddit: 'brescia' }, [])).toThrow('title')
  })

  it('accepts mixed media on Threads up to its limit', () => {
    const threads = rulesFor('threads')
    expect(threads.limits()).toEqual({ maxLength: 500, maxMedia: 10 })
    expect(() => threads.validateSettings('threads_account', {}, [image, video])).not.toThrow()
  })

  it('sends the channel target and the parsed settings to the runner', async () => {
    const { adapter: reddit, calls } = adapter([json(view('succeeded', { receipt: { externalId: 't3_abc', url: 'https://www.reddit.com/r/brescia/comments/abc/ciao/' } }), 202)], undefined, browserRules.reddit)
    const result = await reddit.publish(null, input({ channel: { id: 'c', kind: 'reddit_account', externalId: 'bottegadigitale' }, media: [], settings: { subreddit: 'brescia', title: 'Ciao' } }))
    expect(result).toEqual({ kind: 'published', externalId: 't3_abc', url: 'https://www.reddit.com/r/brescia/comments/abc/ciao/' })
    expect(JSON.parse(String(calls[0]!.init!.body))).toMatchObject({ account: { platform: 'reddit' }, target: { kind: 'reddit_account' }, settings: { subreddit: 'brescia', title: 'Ciao' } })
    expect(await reddit.publish(null, input({ media: [], settings: {} }))).toMatchObject({ kind: 'failed', retryable: false, code: 'invalid_settings' })
  })

  it('maps LinkedIn accounts to a profile or a Page channel', () => {
    expect(browserChannelKind('linkedin')).toBe('linkedin_profile')
    expect(browserChannelKind('linkedin', '12345678')).toBe('linkedin_page')
    expect(browserChannelKind('reddit')).toBe('reddit_account')
    expect(() => browserChannelKind('x', '1')).toThrow('Only LinkedIn')
  })
})
