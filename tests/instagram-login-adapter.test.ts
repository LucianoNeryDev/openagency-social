import { describe, expect, it } from 'vitest'
import { encodeCredential, decodeCredential } from '../src/credentials.js'
import { InstagramLoginAdapter } from '../src/platforms/instagram/adapter.js'
import { MetaAdapter } from '../src/platforms/meta/adapter.js'
import { ReauthRequired, type MediaFile, type MediaInfo, type PublishInput, type ResolvedProviderApp } from '../src/platforms/types.js'
import { mediaFile } from './fixtures/media.js'

const app: ResolvedProviderApp = { id: 'instagram-test', platform: 'instagram', externalAppId: '1000000000000202', secret: 'ig-secret-123', settings: {} }
const redirectUri = 'https://dash-api.example.com/api/social/connect/instagram/callback'

interface Call { method: string, url: URL, headers: Record<string, string>, body: FormData | URLSearchParams | undefined }
type Reply = (call: Call) => Response | Promise<Response>

function recorder(replies: Reply[]) {
  const calls: Call[] = []
  const fetcher = (async (input: URL | string | Request, init?: RequestInit) => {
    const call: Call = { method: init?.method ?? 'GET', url: new URL(String(input)), headers: init?.headers as Record<string, string>,
      body: init?.body as FormData | URLSearchParams | undefined }
    calls.push(call)
    const reply = replies.shift()
    if (!reply) throw new Error(`Unexpected call ${call.method} ${call.url}`)
    return reply(call)
  }) as typeof fetch
  return { calls, fetcher }
}

function instagram(replies: Reply[], options: { redirectUri?: string } = { redirectUri }) {
  const { calls, fetcher } = recorder(replies)
  return { calls, adapter: new InstagramLoginAdapter({ version: 'v26.0', fetch: fetcher, containerPoll: { intervalMs: 1, attempts: 3 }, ...options }) }
}

const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const graphError = (status: number, code: number) => json({ error: { message: 'boom', code } }, status)

const video: MediaFile = { ...mediaFile('v1', 'ep19.mp4', 'video/mp4'), publicUrl: 'https://dash-api.example.com/api/social/media/org/v1?sig=1' }
const cover: MediaFile = { ...mediaFile('c1', 'thumb.jpg', 'image/jpeg'), publicUrl: 'https://dash-api.example.com/api/social/media/org/c1?sig=2' }
const input = (overrides: Partial<PublishInput> = {}): PublishInput => ({
  attemptId: 'attempt-1', channel: { id: 'c1', kind: 'instagram_account', externalId: '17841400000000010' }, token: 'IGAA-token',
  content: 'Weekly Duel | Arcade Duels Ep. 19', media: [video], settings: {}, ...overrides,
})
const info = (mimeType: string, extra: Partial<MediaInfo> = {}): MediaInfo => ({ id: mimeType, mimeType, sizeBytes: 1_000, width: null, height: null, ...extra })

describe('Instagram login connect', () => {
  it('builds the Instagram authorization URL', () => {
    const url = new URL(instagram([]).adapter.authorizeUrl(app, 'state-value'))
    expect(url.origin + url.pathname).toBe('https://www.instagram.com/oauth/authorize')
    expect(url.searchParams.get('scope')).toBe('instagram_business_basic,instagram_business_content_publish,instagram_business_manage_insights,instagram_business_manage_comments')
    expect(url.searchParams.get('client_id')).toBe(app.externalAppId)
    expect(() => instagram([], {}).adapter.authorizeUrl(app, 'state-value')).toThrow('not configured')
  })

  it('exchanges the code for a long-lived token and reads the account', async () => {
    const { adapter, calls } = instagram([
      json({ access_token: 'short', user_id: 17841400000000010 }),
      json({ access_token: 'IGAA-long', token_type: 'bearer', expires_in: 5_183_944 }),
      json({ user_id: '17841400000000010', username: 'arcadegames' }),
    ])
    const [account] = await adapter.finishConnect(app, 'oauth-code')
    expect(account).toMatchObject({ kind: 'instagram_account', externalId: '17841400000000010', name: '@arcadegames', token: 'IGAA-long' })
    expect(account!.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 59 * 86_400_000)
    expect(calls[0]!.url.href).toBe('https://api.instagram.com/oauth/access_token')
    expect(calls[1]!.url.href.startsWith('https://graph.instagram.com/access_token?')).toBe(true)
    expect(calls[1]!.url.searchParams.get('grant_type')).toBe('ig_exchange_token')
    expect(calls[2]!.url.pathname).toBe('/v26.0/me')
  })
})

describe('Instagram login refresh', () => {
  it('renews the 60-day token on the unversioned endpoint', async () => {
    const { adapter, calls } = instagram([json({ access_token: 'IGAA-renewed', expires_in: 5_184_000 })])
    const renewed = await adapter.refreshCredential(app, { accessToken: 'IGAA-old', expiresAt: new Date() })
    expect(renewed.accessToken).toBe('IGAA-renewed')
    expect(calls[0]!.url.origin + calls[0]!.url.pathname).toBe('https://graph.instagram.com/refresh_access_token')
    expect(calls[0]!.url.searchParams.get('grant_type')).toBe('ig_refresh_token')
    expect(adapter.keepAlive).toBe(true)
  })

  it('asks for a new login when the token is gone', async () => {
    await expect(instagram([graphError(400, 190)]).adapter.refreshCredential(app, { accessToken: 'x', expiresAt: null })).rejects.toBeInstanceOf(ReauthRequired)
    await expect(instagram([graphError(500, 2)]).adapter.refreshCredential(app, { accessToken: 'x', expiresAt: null })).rejects.not.toBeInstanceOf(ReauthRequired)
  })
})

describe('Instagram reels', () => {
  it('refuses on submit a reel Instagram would refuse after processing it', () => {
    const { adapter } = instagram([])
    const reel = (details: Partial<MediaInfo>) => [{ ...info('video/mp4'), durationMs: 20_000, videoCodec: 'avc1', audioCodec: 'mp4a', ...details }]
    const code = (details: Partial<MediaInfo>) => {
      try {
        adapter.validateSettings('instagram_account', {}, reel(details))
        return 'ok'
      } catch (error) {
        return (error as { code?: string }).code
      }
    }
    expect(code({})).toBe('ok')
    expect(code({ videoCodec: 'hvc1', audioCodec: null })).toBe('ok')
    expect(code({ durationMs: 2_900 })).toBe('video_too_short')
    expect(code({ durationMs: 15 * 60_000 + 1 })).toBe('video_too_long')
    expect(code({ sizeBytes: 301 * 1024 * 1024 })).toBe('video_too_large')
    expect(code({ videoCodec: 'av01' })).toBe('unsupported_codec')
    expect(code({ videoCodec: null })).toBe('unsupported_codec')
    expect(code({ audioCodec: 'Opus' })).toBe('unsupported_codec')
    // Stored before details were read: only the size is known.
    expect(code({ durationMs: null, videoCodec: null, audioCodec: null })).toBe('ok')
    expect(code({ durationMs: undefined, videoCodec: undefined, sizeBytes: 400 * 1024 * 1024 })).toBe('video_too_large')
  })

  it('accepts one video with an optional JPEG cover, and reel settings only with a video', () => {
    const { adapter } = instagram([])
    expect(() => adapter.validateSettings('instagram_account', {}, [info('video/mp4')])).not.toThrow()
    expect(() => adapter.validateSettings('instagram_account', { shareToFeed: true, thumbOffsetMs: 15_000 }, [info('video/mp4'), info('image/jpeg')])).not.toThrow()
    expect(() => adapter.validateSettings('instagram_account', {}, [info('image/jpeg'), info('video/mp4')])).toThrow('reel')
    expect(() => adapter.validateSettings('instagram_account', {}, [info('video/mp4'), info('video/mp4')])).toThrow('reel')
    expect(() => adapter.validateSettings('instagram_account', {}, [info('video/mp4'), info('image/png')])).toThrow('reel')
    expect(() => adapter.validateSettings('instagram_account', {}, [info('video/mp4'), info('image/jpeg'), info('image/jpeg')])).toThrow('reel')
    expect(() => adapter.validateSettings('instagram_account', { link: 'x' }, [info('video/mp4')])).toThrow('shareToFeed')
    expect(() => adapter.validateSettings('instagram_account', { shareToFeed: true }, [info('image/jpeg', { width: 1080, height: 1080 })])).toThrow('no channel settings')
    expect(() => adapter.validateSettings('youtube_channel', {}, [info('video/mp4')])).toThrow('Not an Instagram')
  })

  it('publishes a reel with its cover through graph.instagram.com, beating while the video processes', async () => {
    const { adapter, calls } = instagram([
      json({ id: '900' }), json({ status_code: 'IN_PROGRESS' }), json({ status_code: 'FINISHED' }),
      json({ id: '18000' }), json({ permalink: 'https://www.instagram.com/reel/abc/' }),
    ])
    let beats = 0
    const outcome = await adapter.publish(app, input({ media: [video, cover], heartbeat: async () => { beats++ } }))
    expect(outcome).toEqual({ kind: 'published', externalId: '18000', url: 'https://www.instagram.com/reel/abc/' })
    expect(calls.every(call => call.url.hostname === 'graph.instagram.com')).toBe(true)
    const container = calls[0]!.body as URLSearchParams
    expect(Object.fromEntries(container)).toEqual({ media_type: 'REELS', video_url: video.publicUrl, caption: input().content,
      share_to_feed: 'true', cover_url: cover.publicUrl })
    // Instagram's own login takes no app secret proof.
    expect(container.has('appsecret_proof')).toBe(false)
    expect(beats).toBe(1)
  })

  it('uses a cover frame offset when no cover image is attached', async () => {
    const { adapter, calls } = instagram([json({ id: '900' }), json({ status_code: 'FINISHED' }), json({ id: '18000' }), json({})])
    await adapter.publish(app, input({ settings: { thumbOffsetMs: 15_000, shareToFeed: false } }))
    const container = calls[0]!.body as URLSearchParams
    expect(container.get('thumb_offset')).toBe('15000')
    expect(container.get('share_to_feed')).toBe('false')
    expect(container.has('cover_url')).toBe(false)
  })

  it('publishes reels for Page-linked accounts too', async () => {
    const { calls, fetcher } = recorder([json({ id: '900' }), json({ status_code: 'FINISHED' }), json({ id: '18000' }), json({})])
    const meta = new MetaAdapter({ version: 'v26.0', redirectUri, fetch: fetcher, containerPoll: { intervalMs: 1, attempts: 3 } })
    expect(() => meta.validateSettings('instagram_account', {}, [info('video/mp4')])).not.toThrow()
    expect(await meta.publish({ ...app, platform: 'meta' }, input())).toMatchObject({ kind: 'published', externalId: '18000' })
    expect(calls[0]!.url.hostname).toBe('graph.facebook.com')
    expect((calls[0]!.body as URLSearchParams).get('media_type')).toBe('REELS')
  })
})

describe('Credential envelope', () => {
  it('stores a bare token for grants without a refresh token, and reads both forms', () => {
    expect(encodeCredential({ accessToken: 'EAA-page' })).toBe('EAA-page')
    const stored = encodeCredential({ accessToken: 'ya29', refreshToken: '1//r' })
    expect(decodeCredential(stored, null)).toEqual({ accessToken: 'ya29', refreshToken: '1//r', expiresAt: null })
    const at = new Date('2026-12-06T10:39:09Z')
    expect(decodeCredential('EAA-page', at)).toEqual({ accessToken: 'EAA-page', expiresAt: at })
  })
})

describe('Instagram login metrics', () => {
  it('reads counts and insights from graph.instagram.com with the account token', async () => {
    const { adapter, calls } = instagram([
      json({ like_count: 9, comments_count: 2 }),
      json({ data: [{ name: 'views', values: [{ value: 120 }] }, { name: 'reach', values: [{ value: 80 }] }, { name: 'shares', values: [{ value: 1 }] }, { name: 'saved', values: [{ value: 0 }] }] }),
    ])
    expect(await adapter.metrics(null, { channel: { id: 'c1', kind: 'instagram_account', externalId: '17841400000000000' }, token: 'IGtoken', externalId: '18000000000000001' }))
      .toEqual({ values: { likes: 9, comments: 2, views: 120, reach: 80, shares: 1, saves: 0 }, unavailable: [] })
    expect(calls.map(call => call.url.origin + call.url.pathname)).toEqual(['https://graph.instagram.com/v26.0/18000000000000001', 'https://graph.instagram.com/v26.0/18000000000000001/insights'])
    expect(calls[0]!.url.searchParams.has('appsecret_proof')).toBe(false)
  })
})

describe('Instagram login analytics', () => {
  const channel = { id: 'c1', kind: 'instagram_account' as const, externalId: '17841400000000000' }

  it('reads account counts from graph.instagram.com, spending one budget call per request after the first', async () => {
    const { adapter, calls } = instagram([json({ followers_count: 10, follows_count: 2, media_count: 3 }), json({ data: [] })])
    let spent = 0
    expect(await adapter.accountMetrics(null, { channel, token: 'IGtoken', now: new Date('2030-01-02T10:00:00Z'), spendCall: () => { spent++ } }))
      .toEqual({ values: { followers: 10, following: 2, posts: 3 }, unavailable: ['reach', 'views', 'profileViews'] })
    expect(calls[0]!.url.origin + calls[0]!.url.pathname).toBe('https://graph.instagram.com/v26.0/17841400000000000')
    expect(spent).toBe(1)
  })

  it('names instagram_business_manage_comments when comments are refused', async () => {
    const { adapter } = instagram([json({ error: { message: 'no', code: 10 } }, 403)])
    expect(await adapter.responses(null, { channel, token: 'IGtoken', externalId: '18000000000000001' }))
      .toEqual({ kind: 'unavailable', reason: expect.stringContaining('instagram_business_manage_comments') })
  })
})

describe('Instagram login account activity', () => {
  it('asks only for the profile fields Instagram login gives', async () => {
    const { adapter, calls } = instagram([json({ username: 'bottega.digitale', name: 'Bottega', profile_picture_url: 'https://cdn/x.jpg' }), json({ data: [] })])
    expect(await adapter.accountActivity(null, { channel: { id: 'c1', kind: 'instagram_account', externalId: '17841400000000010' }, token: 'IGtoken' })).toEqual({
      profile: { name: 'Bottega', username: 'bottega.digitale', description: null, website: null, category: null, pictureUrl: 'https://cdn/x.jpg' }, posts: [] })
    expect(calls[0]!.url.host).toBe('graph.instagram.com')
    expect(calls[0]!.url.searchParams.get('fields')).toBe('username,name,profile_picture_url')
  })
})
