import { describe, expect, it } from 'vitest'
import { YoutubeAdapter } from '../src/platforms/youtube/adapter.js'
import { RateLimited, ReauthRequired, type MediaInfo, type PublishInput, type ResolvedProviderApp } from '../src/platforms/types.js'
import { mediaFile } from './fixtures/media.js'

const app: ResolvedProviderApp = { id: 'google-test', platform: 'youtube', externalAppId: '123-abc.apps.googleusercontent.com', secret: 'google-secret-123', settings: {} }
const redirectUri = 'https://dash-api.example.com/api/social/connect/youtube/callback'
const session = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=abc'

interface Call { method: string, url: URL, headers: Record<string, string>, body: unknown }
type Reply = (call: Call) => Response | Promise<Response>

function fakeGoogle(replies: Reply[], options: { redirectUri?: string } = { redirectUri }) {
  const calls: Call[] = []
  const fetcher = (async (input: URL | string | Request, init?: RequestInit) => {
    const call: Call = { method: init?.method ?? 'GET', url: new URL(String(input)), headers: init?.headers as Record<string, string>, body: init?.body }
    calls.push(call)
    const reply = replies.shift()
    if (!reply) throw new Error(`Unexpected call ${call.method} ${call.url}`)
    return reply(call)
  }) as typeof fetch
  return { calls, adapter: new YoutubeAdapter({ ...options, fetch: fetcher }) }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const empty = (status: number, headers: Record<string, string> = {}) => () => new Response(null, { status, headers })
const apiError = (status: number, reason: string) => json({ error: { code: status, message: `boom ${reason}`, errors: [{ reason }] } }, status)
const timeout = () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }) }
const opened = empty(200, { location: session })

const video = mediaFile('m1', 'ep19.mp4', 'video/mp4', Buffer.from('ftypisom-video-bytes'))
const thumbnail = mediaFile('m2', 'thumb.jpg', 'image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0x00]))
const settings = { title: 'Weekly Duel | Arcade Duels Ep. 19 #Shorts', tags: ['arcadegames'], categoryId: '20' }
const input = (overrides: Partial<PublishInput> = {}): PublishInput => ({
  attemptId: 'attempt-1', channel: { id: 'c1', kind: 'youtube_channel', externalId: 'UCexampleChannel0000001a' }, token: 'ya29.access',
  content: 'Play free in your browser: https://arcade.example', media: [video], settings, ...overrides,
})
const info = (mimeType: string, sizeBytes = 1_000): MediaInfo => ({ id: mimeType, mimeType, sizeBytes, width: null, height: null })

describe('YouTube connect', () => {
  it('asks for offline access with fresh consent', () => {
    const url = new URL(fakeGoogle([]).adapter.authorizeUrl(app, 'state-value'))
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('prompt')).toBe('consent')
    expect(url.searchParams.get('scope')).toContain('youtube.upload')
    expect(url.searchParams.get('redirect_uri')).toBe(redirectUri)
  })

  it('refuses to connect without a redirect URI', () => {
    expect(() => fakeGoogle([], {}).adapter.authorizeUrl(app, 'state-value')).toThrow('not configured')
  })

  it('exchanges the code and lists the channels with the refresh token', async () => {
    const { adapter, calls } = fakeGoogle([
      json({ access_token: 'ya29.new', expires_in: 3599, refresh_token: '1//refresh' }),
      json({ items: [{ id: 'UCexampleChannel0000001a', snippet: { title: 'Arcade Games' } }] }),
    ])
    const [account, ...others] = await adapter.finishConnect(app, 'oauth-code')
    expect(others).toEqual([])
    expect(account).toMatchObject({ kind: 'youtube_channel', externalId: 'UCexampleChannel0000001a', name: 'Arcade Games', token: 'ya29.new', refreshToken: '1//refresh' })
    expect((calls[0]!.body as URLSearchParams).get('grant_type')).toBe('authorization_code')
    expect(calls[1]!.headers.Authorization).toBe('Bearer ya29.new')
  })

  it('refuses a grant without offline access', async () => {
    await expect(fakeGoogle([json({ access_token: 'ya29.new', expires_in: 3599 })]).adapter.finishConnect(app, 'code')).rejects.toThrow('offline')
  })
})

describe('YouTube token refresh', () => {
  it('renews the access token and keeps the refresh token', async () => {
    const { adapter, calls } = fakeGoogle([json({ access_token: 'ya29.renewed', expires_in: 3599 })])
    const renewed = await adapter.refreshCredential(app, { accessToken: 'old', refreshToken: '1//refresh', expiresAt: new Date() })
    expect(renewed.accessToken).toBe('ya29.renewed')
    expect(renewed.refreshToken).toBeUndefined()
    expect(renewed.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 3_000_000)
    expect((calls[0]!.body as URLSearchParams).get('refresh_token')).toBe('1//refresh')
  })

  it('asks for a new login when Google refuses the refresh token', async () => {
    const refused = fakeGoogle([json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400)])
    await expect(refused.adapter.refreshCredential(app, { accessToken: 'old', refreshToken: '1//refresh', expiresAt: null })).rejects.toBeInstanceOf(ReauthRequired)
    await expect(fakeGoogle([]).adapter.refreshCredential(app, { accessToken: 'old', expiresAt: null })).rejects.toBeInstanceOf(ReauthRequired)
  })

  it('treats an unreachable token endpoint as transient', async () => {
    const down = fakeGoogle([() => { throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }) }])
    await expect(down.adapter.refreshCredential(app, { accessToken: 'old', refreshToken: '1//r', expiresAt: null })).rejects.not.toBeInstanceOf(ReauthRequired)
  })
})

describe('YouTube validation', () => {
  const { adapter } = fakeGoogle([])
  it('takes any common codec, refuses a video without a video track or longer than 12 hours', () => {
    const settings = { title: 'Episodio 19' }
    const video = (details: Partial<MediaInfo>) => [{ ...info('video/mp4'), durationMs: 600_000, videoCodec: 'avc1', audioCodec: 'mp4a', ...details }]
    for (const videoCodec of ['avc1', 'hvc1', 'av01', 'vp09', 'mp4v', 'apcn']) {
      expect(() => adapter.validateSettings('youtube_channel', settings, video({ videoCodec, audioCodec: 'Opus' }))).not.toThrow()
    }
    expect(() => adapter.validateSettings('youtube_channel', settings, video({ videoCodec: 'xyz1' }))).toThrow(expect.objectContaining({ code: 'unsupported_codec' }))
    expect(() => adapter.validateSettings('youtube_channel', settings, video({ videoCodec: null }))).toThrow(expect.objectContaining({ code: 'unsupported_codec' }))
    expect(() => adapter.validateSettings('youtube_channel', settings, video({ durationMs: 13 * 3_600_000 }))).toThrow(expect.objectContaining({ code: 'video_too_long' }))
    // A long vertical video is an ordinary video, not refused.
    expect(() => adapter.validateSettings('youtube_channel', settings, video({ durationMs: 30 * 60_000, width: 1080, height: 1920 }))).not.toThrow()
    expect(() => adapter.validateSettings('youtube_channel', settings, video({ durationMs: null, videoCodec: null }))).not.toThrow()
  })

  it('takes one MP4 with a title, and optionally a thumbnail', () => {
    expect(() => adapter.validateSettings('youtube_channel', settings, [info('video/mp4')], 'ok')).not.toThrow()
    expect(() => adapter.validateSettings('youtube_channel', settings, [info('video/mp4'), info('image/jpeg')])).not.toThrow()
    expect(() => adapter.validateSettings('youtube_channel', {}, [info('video/mp4')])).toThrow('title')
    expect(() => adapter.validateSettings('youtube_channel', { title: 'a <b>' }, [info('video/mp4')])).toThrow('title')
    expect(() => adapter.validateSettings('youtube_channel', { ...settings, extra: 1 }, [info('video/mp4')])).toThrow('title')
    expect(() => adapter.validateSettings('youtube_channel', settings, [])).toThrow('MP4')
    expect(() => adapter.validateSettings('youtube_channel', settings, [info('image/jpeg')])).toThrow('MP4')
    expect(() => adapter.validateSettings('youtube_channel', settings, [info('video/mp4'), info('video/mp4')])).toThrow('MP4')
    expect(() => adapter.validateSettings('youtube_channel', settings, [info('video/mp4'), info('image/jpeg', 3 * 1024 * 1024)])).toThrow('2 MB')
    expect(() => adapter.validateSettings('youtube_channel', settings, [info('video/mp4')], 'use <html>')).toThrow('5,000')
    expect(() => adapter.validateSettings('youtube_channel', settings, [info('video/mp4')], 'é'.repeat(2_501))).toThrow('5,000')
    expect(() => adapter.validateSettings('facebook_page', settings, [info('video/mp4')])).toThrow('Not a YouTube')
    // The title counts characters: 100 emoji fit, 101 letters do not.
    expect(() => adapter.validateSettings('youtube_channel', { title: '🎮'.repeat(100) }, [info('video/mp4')])).not.toThrow()
    expect(() => adapter.validateSettings('youtube_channel', { title: 'a'.repeat(101) }, [info('video/mp4')])).toThrow('title')
    expect(adapter.limits()).toEqual({ maxLength: 5_000, maxMedia: 2, lengthUnit: 'bytes', titleMaxLength: 100 })
  })
})

describe('YouTube publish', () => {
  it('uploads through a resumable session', async () => {
    const { adapter, calls } = fakeGoogle([opened, json({ id: 'dQw4w9WgXcQ' })])
    expect(await adapter.publish(app, input())).toEqual({ kind: 'published', externalId: 'dQw4w9WgXcQ', url: 'https://youtu.be/dQw4w9WgXcQ' })
    expect(calls[0]!.url.searchParams.get('uploadType')).toBe('resumable')
    expect(calls[0]!.headers['X-Upload-Content-Length']).toBe(String(video.sizeBytes))
    expect(JSON.parse(calls[0]!.body as string)).toEqual({
      snippet: { title: settings.title, description: input().content, tags: ['arcadegames'], categoryId: '20' },
      status: { privacyStatus: 'public', selfDeclaredMadeForKids: false },
    })
    expect(calls[1]!.method).toBe('PUT')
    expect(calls[1]!.url.href).toBe(session)
    expect(calls[1]!.headers['Content-Type']).toBe('video/mp4')
    expect(calls[1]!.headers['Content-Range']).toBe(`bytes 0-19/20`)
  })

  it('sends a long video one chunk at a time', async () => {
    const whole = Buffer.alloc(30, 7)
    const { adapter, calls } = fakeGoogle([opened, empty(308, { range: 'bytes=0-19' }), json({ id: 'dQw4w9WgXcQ' })])
    let beats = 0
    const media = [mediaFile('m', 'long.mp4', 'video/mp4', whole, [whole.subarray(0, 20), whole.subarray(20)])]
    expect(await adapter.publish(app, input({ media, heartbeat: async () => { beats++ } }))).toMatchObject({ kind: 'published', externalId: 'dQw4w9WgXcQ' })
    expect(calls.slice(1).map(call => call.headers['Content-Range'])).toEqual(['bytes 0-19/30', 'bytes 20-29/30'])
    expect(beats).toBe(2)
  })

  it('asks the session when YouTube kept less of a chunk than was sent', async () => {
    const whole = Buffer.alloc(30, 7)
    const media = [mediaFile('m', 'long.mp4', 'video/mp4', whole, [whole.subarray(0, 20), whole.subarray(20)])]
    const { adapter } = fakeGoogle([opened, empty(308, { range: 'bytes=0-9' }), empty(308, { range: 'bytes=0-9' })])
    expect(await adapter.publish(app, input({ media }))).toMatchObject({ kind: 'failed', retryable: true, code: 'upload_incomplete' })
  })

  it('sets the thumbnail after the upload, and ignores its failure', async () => {
    const { adapter, calls } = fakeGoogle([opened, json({ id: 'dQw4w9WgXcQ' }), apiError(403, 'forbidden')])
    expect(await adapter.publish(app, input({ media: [video, thumbnail] }))).toMatchObject({ kind: 'published', externalId: 'dQw4w9WgXcQ' })
    expect(calls[2]!.url.pathname).toBe('/upload/youtube/v3/thumbnails/set')
    expect(calls[2]!.url.searchParams.get('videoId')).toBe('dQw4w9WgXcQ')
  })

  it('retries when the session cannot be opened', async () => {
    expect(await fakeGoogle([timeout]).adapter.publish(app, input())).toMatchObject({ kind: 'failed', retryable: true, code: 'response_lost' })
    expect(await fakeGoogle([apiError(503, 'backendError')]).adapter.publish(app, input())).toMatchObject({ kind: 'failed', retryable: true })
    expect(await fakeGoogle([empty(200)]).adapter.publish(app, input())).toMatchObject({ kind: 'failed', retryable: true, code: 'no_upload_session' })
  })

  it('retries on quota, asks for a login on 401, fails on a refusal', async () => {
    expect(await fakeGoogle([apiError(403, 'quotaExceeded')]).adapter.publish(app, input())).toMatchObject({ kind: 'failed', retryable: true, code: 'rate_limited' })
    expect(await fakeGoogle([apiError(401, 'authError')]).adapter.publish(app, input())).toMatchObject({ kind: 'failed', retryable: false, reauth: true })
    // A missing permission for this one action is not a lost login.
    const refused = await fakeGoogle([apiError(403, 'insufficientPermissions')]).adapter.publish(app, input())
    expect(refused).toMatchObject({ kind: 'failed', retryable: false, code: 'permission_missing' })
    expect(refused).not.toHaveProperty('reauth')
    expect(await fakeGoogle([apiError(400, 'invalidTitle')]).adapter.publish(app, input())).toMatchObject({ kind: 'failed', retryable: false, code: 'rejected' })
    expect(await fakeGoogle([opened, apiError(403, 'uploadLimitExceeded')]).adapter.publish(app, input())).toMatchObject({ kind: 'failed', retryable: false })
  })

  it('reads the session after a lost upload: incomplete, finished, or unknown', async () => {
    const incomplete = fakeGoogle([opened, timeout, empty(308, { range: 'bytes=0-9' })])
    expect(await incomplete.adapter.publish(app, input())).toMatchObject({ kind: 'failed', retryable: true, code: 'upload_incomplete' })
    expect(incomplete.calls[2]!.headers['Content-Range']).toBe(`bytes */${video.sizeBytes}`)
    expect(await fakeGoogle([opened, timeout, json({ id: 'dQw4w9WgXcQ' })]).adapter.publish(app, input()))
      .toEqual({ kind: 'published', externalId: 'dQw4w9WgXcQ', url: 'https://youtu.be/dQw4w9WgXcQ' })
    expect(await fakeGoogle([opened, timeout, timeout]).adapter.publish(app, input())).toMatchObject({ kind: 'uncertain', code: 'response_lost' })
    expect(await fakeGoogle([opened, apiError(500, 'backendError'), timeout]).adapter.publish(app, input())).toMatchObject({ kind: 'uncertain', code: 'platform_error' })
  })
})

describe('YouTube reconcile', () => {
  const reconcile = { attemptId: 'attempt-1', channel: input().channel, token: 'ya29.access', content: 'desc', settings,
    since: new Date('2026-10-25T10:00:00Z'), excludeExternalIds: ['old1'] }
  const uploads = json({ items: [{ id: 'UCexampleChannel0000001a', contentDetails: { relatedPlaylists: { uploads: 'UUexampleChannel0000001a' } } }] })
  const item = (videoId: string, title: string, publishedAt: string) => ({ snippet: { title, publishedAt, resourceId: { videoId } } })

  it('settles on the one upload with the title since the attempt', async () => {
    const { adapter, calls } = fakeGoogle([uploads, json({ items: [
      item('old1', settings.title, '2026-10-25T10:05:00Z'), item('early', settings.title, '2026-10-25T09:00:00Z'),
      item('match1', settings.title, '2026-10-25T10:06:00Z'), item('other', 'Another title', '2026-10-25T10:07:00Z'),
    ] })])
    expect(await adapter.reconcile(app, reconcile)).toEqual({ kind: 'published', externalId: 'match1', url: 'https://youtu.be/match1' })
    expect(calls[1]!.url.searchParams.get('playlistId')).toBe('UUexampleChannel0000001a')
  })

  it('reports no match and ambiguous matches', async () => {
    expect(await fakeGoogle([uploads, json({ items: [] })]).adapter.reconcile(app, reconcile)).toEqual({ kind: 'not_found' })
    const twice = fakeGoogle([uploads, json({ items: [item('a', settings.title, '2026-10-25T10:06:00Z'), item('b', settings.title, '2026-10-25T10:07:00Z')] })])
    expect((await twice.adapter.reconcile(app, reconcile)).kind).toBe('ambiguous')
  })
})

describe('YouTube metrics', () => {
  const metricsInput = { channel: { id: 'c1', kind: 'youtube_channel' as const, externalId: 'UCexampleChannel0000001a' }, token: 'ya29.access', externalId: 'vid00000001' }

  it('reads the video statistics and marks hidden counts unavailable', async () => {
    const { adapter, calls } = fakeGoogle([json({ items: [{ id: 'vid00000001', statistics: { viewCount: '1520', commentCount: '4', favoriteCount: '0' } }] })])
    expect(await adapter.metrics(null, metricsInput)).toEqual({ values: { views: 1520, comments: 4 }, unavailable: ['likes'] })
    expect(calls[0]!.url.searchParams.get('part')).toBe('statistics')
    expect(calls[0]!.url.searchParams.get('id')).toBe('vid00000001')
  })

  it('fails when the video is gone', async () => {
    const { adapter } = fakeGoogle([json({ items: [] })])
    await expect(adapter.metrics(null, metricsInput)).rejects.toThrow('Video not found')
  })
})

describe('YouTube analytics', () => {
  const channel = { id: 'c1', kind: 'youtube_channel' as const, externalId: 'UCexampleChannel0000001a' }
  const comment = (id: string, publishedAt: string, extra: Record<string, unknown> = {}) => ({ id, snippet: { authorDisplayName: '@mario', textDisplay: `text ${id}`,
    likeCount: 2, publishedAt, authorProfileImageUrl: 'https://yt3.ggpht.com/x', authorChannelUrl: 'https://www.youtube.com/@mario', ...extra } })

  it('maps channel statistics and hides a hidden subscriber count', async () => {
    const { adapter, calls } = fakeGoogle([json({ items: [{ statistics: { viewCount: '9000', subscriberCount: '120', hiddenSubscriberCount: false, videoCount: '19' } }] }),
      json({ items: [{ statistics: { viewCount: '9000', subscriberCount: '100', hiddenSubscriberCount: true, videoCount: '19' } }] })])
    expect(await adapter.accountMetrics(null, { channel, token: 'ya29.access' })).toEqual({ values: { followers: 120, totalViews: 9000, posts: 19 }, unavailable: [] })
    expect(await adapter.accountMetrics(null, { channel, token: 'ya29.access' })).toEqual({ values: { totalViews: 9000, posts: 19 }, unavailable: ['followers'] })
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({ part: 'statistics', id: channel.externalId })
  })

  it('reads account numbers in one request, which the collector pays for out of the daily share', async () => {
    const { adapter, calls } = fakeGoogle([json({ items: [{ statistics: { viewCount: '9000', subscriberCount: '120', videoCount: '19' } }] })])
    let spent = 0
    await adapter.accountMetrics(null, { channel, token: 'ya29.access', spendCall: () => { spent++ } })
    expect(calls).toHaveLength(1)
    expect(spent).toBe(0)
  })

  it('reads comment threads newest first with their replies, without avatars or channel links', async () => {
    const { adapter, calls } = fakeGoogle([
      json({ nextPageToken: 'page-2', items: [{ snippet: { topLevelComment: comment('Ug1', '2030-01-01T10:00:00Z', { authorChannelId: { value: 'UCmario0000000000000000000' } }), totalReplyCount: 1 },
        replies: { comments: [comment('Ug1.r1', '2030-01-01T11:00:00Z', { parentId: 'Ug1', authorChannelId: { value: channel.externalId } })] } }] }),
      json({ items: [{ snippet: { topLevelComment: comment('Ug0', '2030-01-01T09:00:00Z'), totalReplyCount: 0 } }] }),
    ])
    const result = await adapter.responses(null, { channel, token: 'ya29.access', externalId: 'vid00000001' })
    expect(result).toEqual({ kind: 'ok', responses: [
      { externalId: 'Ug1', parentExternalId: null, authorName: '@mario', authorHandle: null, text: 'text Ug1', likeCount: 2, replyCount: 1,
        publishedAt: new Date('2030-01-01T10:00:00Z'), url: 'https://www.youtube.com/watch?v=vid00000001&lc=Ug1', fromChannel: false },
      expect.objectContaining({ externalId: 'Ug1.r1', parentExternalId: 'Ug1', replyCount: null, fromChannel: true }),
      expect.objectContaining({ externalId: 'Ug0', replyCount: 0, fromChannel: false }),
    ] })
    expect(JSON.stringify(result)).not.toContain('ggpht')
    expect(JSON.stringify(result)).not.toContain('authorChannelUrl')
    expect(JSON.stringify(result)).not.toContain('UCmario')
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({ part: 'snippet,replies', videoId: 'vid00000001', order: 'time', maxResults: '100', textFormat: 'plainText' })
    expect(calls[1]!.url.searchParams.get('pageToken')).toBe('page-2')
  })

  it('reports disabled comments as unavailable and quota errors as rate limits', async () => {
    const { adapter } = fakeGoogle([apiError(403, 'commentsDisabled'), apiError(403, 'quotaExceeded')])
    const input = { channel, token: 'ya29.access', externalId: 'vid00000001' }
    expect(await adapter.responses(null, input)).toEqual({ kind: 'unavailable', reason: 'Comments are turned off for this video.' })
    await expect(adapter.responses(null, input)).rejects.toBeInstanceOf(RateLimited)
  })
})

describe('YouTube account activity', () => {
  const channel = { id: 'c1', kind: 'youtube_channel' as const, externalId: 'UCexampleChannel0000001a' }

  it('reads the channel profile, then its newest uploads with their privacy, two quota units', async () => {
    const { adapter, calls } = fakeGoogle([
      json({ items: [{ snippet: { title: 'Bottega Digitale', description: 'Video', customUrl: '@bottegadigitale',
        thumbnails: { default: { url: 'https://yt3.ggpht.com/s88' }, high: { url: 'https://yt3.ggpht.com/s800' } } },
        contentDetails: { relatedPlaylists: { uploads: 'UUexampleChannel0000001a' } } }] }),
      json({ items: [{ snippet: { title: 'Nuovo video', publishedAt: '2030-01-02T09:00:00Z' }, contentDetails: { videoId: 'vid2' }, status: { privacyStatus: 'private' } },
        { snippet: { title: 'Prima' }, contentDetails: { videoId: 'vid1', videoPublishedAt: '2030-01-01T09:00:00Z' }, status: { privacyStatus: 'public' } }] }),
    ])
    let spent = 0
    expect(await adapter.accountActivity(null, { channel, token: 'ya29.access', spendCall: () => { spent++ } })).toEqual({
      profile: { name: 'Bottega Digitale', username: '@bottegadigitale', description: 'Video', website: null, category: null, pictureUrl: 'https://yt3.ggpht.com/s800' },
      posts: [
        { externalId: 'vid2', type: 'video', text: 'Nuovo video', url: 'https://www.youtube.com/watch?v=vid2', publishedAt: new Date('2030-01-02T09:00:00Z'), privacy: 'private' },
        { externalId: 'vid1', type: 'video', text: 'Prima', url: 'https://www.youtube.com/watch?v=vid1', publishedAt: new Date('2030-01-01T09:00:00Z'), privacy: 'public' },
      ],
    })
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({ part: 'snippet,contentDetails', id: channel.externalId })
    expect(Object.fromEntries(calls[1]!.url.searchParams)).toEqual({ part: 'snippet,contentDetails,status', playlistId: 'UUexampleChannel0000001a', maxResults: '25' })
    expect(spent).toBe(1)
  })

  it('treats the daily quota as a rate limit', async () => {
    const { adapter } = fakeGoogle([apiError(403, 'quotaExceeded')])
    await expect(adapter.accountActivity(null, { channel, token: 'ya29.access' })).rejects.toBeInstanceOf(RateLimited)
  })
})
