import { describe, expect, it } from 'vitest'
import { MetaAdapter } from '../src/platforms/meta/adapter.js'
import { appSecretProof } from '../src/platforms/meta/graph.js'
import { RateLimited, type MediaInfo, type PublishInput, type ResolvedProviderApp } from '../src/platforms/types.js'
import { mediaFile } from './fixtures/media.js'

const app: ResolvedProviderApp = { id: 'meta-test', platform: 'meta', externalAppId: '111', secret: 'app-secret-123', settings: { configId: '222' } }
const redirectUri = 'https://dash-api.example.com/api/social/connect/meta/callback'

interface Call { method: string, url: URL, headers: Record<string, string>, body: FormData | URLSearchParams | undefined }
type Reply = (call: Call) => Response | Promise<Response>

function fakeGraph(replies: Reply[], options: Partial<ConstructorParameters<typeof MetaAdapter>[0]> = {}) {
  const calls: Call[] = []
  const fetcher = (async (input: URL | string | Request, init?: RequestInit) => {
    const call: Call = { method: init?.method ?? 'GET', url: new URL(String(input)), headers: init?.headers as Record<string, string>,
      body: init?.body as FormData | URLSearchParams | undefined }
    calls.push(call)
    const reply = replies.shift()
    if (!reply) throw new Error(`Unexpected call ${call.method} ${call.url}`)
    return reply(call)
  }) as typeof fetch
  return { calls, adapter: new MetaAdapter({ version: 'v26.0', redirectUri, fetch: fetcher, ...options }) }
}

const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const graphError = (status: number, code: number, extra: Record<string, unknown> = {}) => json({ error: { message: 'boom access_token=EAAsecret', code, ...extra } }, status)
const timeout = () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }) }
const refused = () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }) }

const input = (overrides: Partial<PublishInput> = {}): PublishInput => ({
  attemptId: 'attempt-1', channel: { id: 'c1', kind: 'facebook_page', externalId: '1000000000000101' }, token: 'page-token-abc',
  content: 'Ciao Brescia', media: [], settings: {}, ...overrides,
})

describe('Meta connect', () => {
  it('builds a Login for Business dialog URL with the configuration ID', () => {
    const url = new URL(fakeGraph([]).adapter.authorizeUrl(app, 'state-value'))
    expect(url.origin + url.pathname).toBe('https://www.facebook.com/v26.0/dialog/oauth')
    expect(Object.fromEntries(url.searchParams)).toEqual({ client_id: '111', redirect_uri: redirectUri, state: 'state-value', response_type: 'code', config_id: '222' })
  })

  it('falls back to scopes without a configuration', () => {
    const url = new URL(fakeGraph([]).adapter.authorizeUrl({ ...app, settings: {} }, 'state-value'))
    expect(url.searchParams.get('scope')).toContain('pages_manage_posts')
    expect(url.searchParams.has('config_id')).toBe(false)
  })

  it('exchanges the code and keeps only Pages it may post to, across pages of results', async () => {
    const { adapter, calls } = fakeGraph([
      json({ access_token: 'short-user' }),
      json({ access_token: 'long-user', expires_in: 5_184_000 }),
      json({ data: [{ id: '1', name: 'Bottega', access_token: 'page-1', tasks: ['CREATE_CONTENT', 'MANAGE'] }, { id: '2', name: 'Read only', access_token: 'page-2', tasks: ['ANALYZE'] }],
        paging: { cursors: { after: 'cursor-1' }, next: 'https://graph.facebook.com/next' } }),
      json({ data: [{ id: '3', name: 'Client', access_token: 'page-3', tasks: ['CREATE_CONTENT'] }] }),
      json({ data: { granular_scopes: [{ scope: 'pages_manage_posts', target_ids: ['1', '3'] }] } }),
    ])
    const accounts = await adapter.finishConnect(app, 'oauth-code')
    expect(accounts).toEqual([
      { kind: 'facebook_page', externalId: '1', name: 'Bottega', token: 'page-1', tokenExpiresAt: null },
      { kind: 'facebook_page', externalId: '3', name: 'Client', token: 'page-3', tokenExpiresAt: null },
    ])
    expect(calls[0]!.url.searchParams.get('redirect_uri')).toBe(redirectUri)
    expect(calls[1]!.url.searchParams.get('fb_exchange_token')).toBe('short-user')
    expect(calls[2]!.headers.Authorization).toBe('Bearer long-user')
    expect(calls[2]!.url.searchParams.get('access_token')).toBeNull()
    expect(calls[2]!.url.searchParams.get('appsecret_proof')).toBe(appSecretProof('long-user', app.secret))
    expect(calls[3]!.url.searchParams.get('after')).toBe('cursor-1')
  })
})

describe('Meta publish', () => {
  it('posts text to the Page feed with an app secret proof', async () => {
    const { adapter, calls } = fakeGraph([json({ id: '1000000000000101_99' })])
    expect(await adapter.publish(app, input())).toEqual({ kind: 'published', externalId: '1000000000000101_99', url: 'https://www.facebook.com/1000000000000101_99' })
    const body = calls[0]!.body as URLSearchParams
    expect(calls[0]!.url.pathname).toBe('/v26.0/1000000000000101/feed')
    expect(body.get('message')).toBe('Ciao Brescia')
    expect(body.get('appsecret_proof')).toBe(appSecretProof('page-token-abc', app.secret))
    expect(body.has('published')).toBe(false)
    expect(calls[0]!.url.search).toBe('')
  })

  it('uploads photos unpublished, then attaches them to one feed post', async () => {
    const { adapter, calls } = fakeGraph([json({ id: '501' }), json({ id: '502' }), json({ id: '1_77' })])
    const media = [1, 2].map(index => mediaFile(`m${index}`, `${index}.jpg`, 'image/jpeg', Buffer.from([0xff, 0xd8, 0xff, index])))
    expect(await adapter.publish(app, input({ media }))).toMatchObject({ kind: 'published', externalId: '1_77' })
    expect(calls.map(call => call.url.pathname)).toEqual(['/v26.0/1000000000000101/photos', '/v26.0/1000000000000101/photos', '/v26.0/1000000000000101/feed'])
    expect((calls[0]!.body as FormData).get('published')).toBe('false')
    expect((calls[0]!.body as FormData).get('source')).toBeInstanceOf(Blob)
    const feed = calls[2]!.body as URLSearchParams
    expect(feed.get('attached_media[0]')).toBe('{"media_fbid":"501"}')
    expect(feed.get('attached_media[1]')).toBe('{"media_fbid":"502"}')
  })

  it('shares a link with its preview card', async () => {
    const { adapter, calls } = fakeGraph([json({ id: '1_6' })])
    await adapter.publish(app, input({ settings: { link: 'https://bottega.example/blog/sito' } }))
    expect((calls[0]!.body as URLSearchParams).get('link')).toBe('https://bottega.example/blog/sito')
  })

  it('creates a hidden post when the channel settings ask for it', async () => {
    const { adapter, calls } = fakeGraph([json({ id: '1_5' })])
    await adapter.publish(app, input({ settings: { unpublished: true } }))
    expect((calls[0]!.body as URLSearchParams).get('published')).toBe('false')
  })

  it('treats a lost feed response as uncertain', async () => {
    const { adapter } = fakeGraph([timeout])
    expect(await adapter.publish(app, input())).toMatchObject({ kind: 'uncertain', code: 'response_lost' })
  })

  it('treats a lost photo upload as retryable, because nothing is visible yet', async () => {
    const { adapter, calls } = fakeGraph([timeout])
    const media = [mediaFile('m', 'a.jpg', 'image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0]))]
    expect(await adapter.publish(app, input({ media }))).toMatchObject({ kind: 'failed', retryable: true })
    expect(calls).toHaveLength(1)
  })

  it('retries a refused connection even on the feed call', async () => {
    const { adapter } = fakeGraph([refused])
    expect(await adapter.publish(app, input())).toMatchObject({ kind: 'failed', retryable: true, code: 'unreachable' })
  })

  it('classifies Graph errors', async () => {
    const cases: Array<[Reply, Record<string, unknown>]> = [
      [graphError(400, 190), { kind: 'failed', retryable: false, code: 'auth', reauth: true }],
      [graphError(403, 200), { kind: 'failed', retryable: false, code: 'auth', reauth: true }],
      [graphError(400, 32), { kind: 'failed', retryable: true, code: 'rate_limited' }],
      [graphError(500, 2, { is_transient: true }), { kind: 'uncertain', code: 'platform_error' }],
      [graphError(400, 100), { kind: 'failed', retryable: false, code: 'rejected' }],
      [json({ unexpected: true }), { kind: 'uncertain', code: 'unexpected_response' }],
    ]
    for (const [reply, expected] of cases) {
      const outcome = await fakeGraph([reply]).adapter.publish(app, input())
      expect(outcome).toMatchObject(expected)
      if (outcome.kind !== 'published') expect(outcome.detail).not.toContain('EAAsecret')
    }
  })

  it('rejects settings it does not know', () => {
    const { adapter } = fakeGraph([])
    const image = [jpegInfo(1080, 1080)]
    expect(() => adapter.validateSettings('facebook_page', { unpublished: true, link: 'https://bottega.example/blog/a' }, [])).not.toThrow()
    expect(() => adapter.validateSettings('facebook_page', { link: 'x' }, [])).toThrow('Invalid Facebook Page settings')
    expect(() => adapter.validateSettings('facebook_page', { link: 'http://example.com' }, [])).toThrow('Invalid Facebook Page settings')
    expect(() => adapter.validateSettings('facebook_page', { other: true }, [])).toThrow('Invalid Facebook Page settings')
    expect(() => adapter.validateSettings('facebook_page', { link: 'https://example.com' }, image)).toThrow('either a link or images')
  })
})

const jpegInfo = (width: number | null, height: number | null, overrides: Partial<MediaInfo> = {}): MediaInfo =>
  ({ id: 'm1', mimeType: 'image/jpeg', sizeBytes: 200_000, width, height, ...overrides })

describe('Instagram', () => {
  const igChannel = { id: 'c2', kind: 'instagram_account' as const, externalId: '17841400000000002' }
  const image = (index: number) => ({ ...mediaFile(`m${index}`, `${index}.jpg`, 'image/jpeg', Buffer.from([0xff, 0xd8, 0xff, index])),
    publicUrl: `https://dash-api.example.com/api/social/media/org/m${index}?expires=1&signature=s` })
  const igInput = (overrides: Partial<PublishInput> = {}) => input({ channel: igChannel, media: [image(1)], ...overrides })
  const poll = { intervalMs: 0, attempts: 3 }
  const instagram = (replies: Reply[]) => fakeGraph(replies, { containerPoll: poll })

  it('connects the Instagram account linked to a Page with the Page token', async () => {
    const { adapter, calls } = fakeGraph([
      json({ access_token: 'short-user' }), json({ access_token: 'long-user' }),
      json({ data: [{ id: '1', name: 'Bottega', access_token: 'page-1', tasks: ['CREATE_CONTENT'], instagram_business_account: { id: '178', username: 'bottega.digitale' } }] }),
      json({ data: { granular_scopes: [{ scope: 'pages_manage_posts', target_ids: ['1'] }] } }),
    ])
    expect(await adapter.finishConnect(app, 'code')).toEqual([
      { kind: 'facebook_page', externalId: '1', name: 'Bottega', token: 'page-1', tokenExpiresAt: null },
      { kind: 'instagram_account', externalId: '178', name: '@bottega.digitale', token: 'page-1', tokenExpiresAt: null },
    ])
    expect(calls[2]!.url.searchParams.get('fields')).toContain('instagram_business_account{id,username}')
  })

  it('reads Pages named by the grant when /me/accounts lists none', async () => {
    const { adapter, calls } = fakeGraph([
      json({ access_token: 'short-user' }), json({ access_token: 'long-user' }), json({ data: [] }),
      json({ data: { granular_scopes: [{ scope: 'pages_show_list', target_ids: ['9'] }, { scope: 'pages_manage_posts', target_ids: ['1288'] }] } }),
      json({ id: '1288', name: 'Bottega', access_token: 'page-1288', instagram_business_account: { id: '178', username: 'bottega.digitale' } }),
    ])
    expect(await adapter.finishConnect(app, 'code')).toEqual([
      { kind: 'facebook_page', externalId: '1288', name: 'Bottega', token: 'page-1288', tokenExpiresAt: null },
      { kind: 'instagram_account', externalId: '178', name: '@bottega.digitale', token: 'page-1288', tokenExpiresAt: null },
    ])
    expect(calls[3]!.url.pathname).toBe('/v26.0/debug_token')
    expect(calls[3]!.url.searchParams.get('input_token')).toBe('long-user')
    expect(calls[3]!.headers.Authorization).toBe(`Bearer 111|${app.secret}`)
    expect(calls[4]!.url.pathname).toBe('/v26.0/1288')
    expect(calls[4]!.headers.Authorization).toBe('Bearer long-user')
  })

  it('accepts JPEG images between 4:5 and 1.91:1 and nothing else', () => {
    const { adapter } = fakeGraph([])
    expect(() => adapter.validateSettings('instagram_account', {}, [jpegInfo(1080, 1350), jpegInfo(1080, 566)])).not.toThrow()
    expect(() => adapter.validateSettings('instagram_account', {}, [])).toThrow('at least one image')
    expect(() => adapter.validateSettings('instagram_account', { link: 'https://example.com' }, [jpegInfo(1080, 1080)])).toThrow('no channel settings')
    expect(() => adapter.validateSettings('instagram_account', {}, [jpegInfo(1080, 1080, { mimeType: 'image/png' })])).toThrow('JPEG')
    expect(() => adapter.validateSettings('instagram_account', {}, [jpegInfo(1080, 1080, { sizeBytes: 9 * 1024 * 1024 })])).toThrow('8 MB')
    expect(() => adapter.validateSettings('instagram_account', {}, [jpegInfo(null, null)])).toThrow('again')
    expect(() => adapter.validateSettings('instagram_account', {}, [jpegInfo(1080, 1920)])).toThrow('4:5')
    expect(() => adapter.validateSettings('instagram_account', {}, [jpegInfo(1640, 624)])).toThrow('4:5')
  })

  it('publishes one image through a container and returns the permalink', async () => {
    const { adapter, calls } = instagram([
      json({ id: '900' }), json({ status_code: 'IN_PROGRESS' }), json({ status_code: 'FINISHED' }),
      json({ id: '18000' }), json({ permalink: 'https://www.instagram.com/p/abc/' }),
    ])
    expect(await adapter.publish(app, igInput())).toEqual({ kind: 'published', externalId: '18000', url: 'https://www.instagram.com/p/abc/' })
    expect(calls.map(call => `${call.method} ${call.url.pathname}`)).toEqual([
      'POST /v26.0/17841400000000002/media', 'GET /v26.0/900', 'GET /v26.0/900', 'POST /v26.0/17841400000000002/media_publish', 'GET /v26.0/18000',
    ])
    const container = calls[0]!.body as URLSearchParams
    expect(container.get('image_url')).toBe(image(1).publicUrl)
    expect(container.get('caption')).toBe('Ciao Brescia')
    expect((calls[3]!.body as URLSearchParams).get('creation_id')).toBe('900')
    expect(container.get('appsecret_proof')).toBe(appSecretProof('page-token-abc', app.secret))
  })

  it('publishes several images as a carousel', async () => {
    const { adapter, calls } = instagram([
      json({ id: '901' }), json({ id: '902' }), json({ status_code: 'FINISHED' }), json({ status_code: 'FINISHED' }),
      json({ id: '903' }), json({ status_code: 'FINISHED' }), json({ id: '18001' }), graphError(500, 2),
    ])
    expect(await adapter.publish(app, igInput({ media: [image(1), image(2)] }))).toEqual({ kind: 'published', externalId: '18001' })
    expect((calls[0]!.body as URLSearchParams).get('is_carousel_item')).toBe('true')
    expect((calls[0]!.body as URLSearchParams).has('caption')).toBe(false)
    const carousel = calls[4]!.body as URLSearchParams
    expect(carousel.get('media_type')).toBe('CAROUSEL')
    expect(carousel.get('children')).toBe('901,902')
    expect(carousel.get('caption')).toBe('Ciao Brescia')
  })

  it('fails without publishing when a container errors or never finishes', async () => {
    expect(await instagram([json({ id: '900' }), json({ status_code: 'ERROR', status: 'Error: 2207026' })]).adapter.publish(app, igInput()))
      .toMatchObject({ kind: 'failed', retryable: false, code: 'container_error' })
    // Instagram could not fetch the file: nothing exists, and a later try with a fresh URL usually works.
    expect(await instagram([json({ id: '900' }), json({ status_code: 'ERROR', status: 'Error: Media download has failed. (2207052)' })]).adapter.publish(app, igInput()))
      .toMatchObject({ kind: 'failed', retryable: true, code: 'media_download_failed' })
    expect(await instagram([graphError(400, 9004, { error_subcode: 2207052 })]).adapter.publish(app, igInput()))
      .toMatchObject({ kind: 'failed', retryable: true, code: 'media_download_failed' })
    const slow = instagram([json({ id: '900' }), ...[1, 2, 3].map(() => json({ status_code: 'IN_PROGRESS' }))])
    expect(await slow.adapter.publish(app, igInput())).toMatchObject({ kind: 'failed', retryable: true, code: 'container_timeout' })
    expect(slow.calls.some(call => call.url.pathname.endsWith('media_publish'))).toBe(false)
  })

  it('retries a lost container response, but a lost publish is uncertain', async () => {
    expect(await instagram([timeout]).adapter.publish(app, igInput())).toMatchObject({ kind: 'failed', retryable: true, code: 'response_lost' })
    expect(await instagram([json({ id: '900' }), json({ status_code: 'FINISHED' }), timeout]).adapter.publish(app, igInput()))
      .toMatchObject({ kind: 'uncertain', code: 'response_lost' })
  })

  it('refuses to publish without an image or a public URL', async () => {
    expect(await instagram([]).adapter.publish(app, igInput({ media: [] }))).toMatchObject({ kind: 'failed', code: 'media_required' })
    expect(await instagram([]).adapter.publish(app, igInput({ media: [{ ...image(1), publicUrl: undefined }] })))
      .toMatchObject({ kind: 'failed', code: 'public_media_unavailable' })
  })

  it('reconciles on the exact caption after the attempt started', async () => {
    const reconcile = { attemptId: 'attempt-1', channel: igChannel, token: 't', content: 'Ciao Brescia', settings: {}, since: new Date('2026-10-24T10:00:00Z'), excludeExternalIds: ['1'] }
    const { adapter } = fakeGraph([json({ data: [
      { id: '1', caption: 'Ciao Brescia', timestamp: '2026-10-24T10:05:00+0000' },
      { id: '2', caption: 'Ciao Brescia', timestamp: '2026-10-24T09:00:00+0000' },
      { id: '3', caption: 'Ciao Brescia', timestamp: '2026-10-24T10:06:00+0000', permalink: 'https://www.instagram.com/p/x/' },
    ] })])
    expect(await adapter.reconcile(app, reconcile)).toEqual({ kind: 'published', externalId: '3', url: 'https://www.instagram.com/p/x/' })
  })
})

describe('Meta reconcile', () => {
  const reconcileInput = { attemptId: 'attempt-1', channel: input().channel, token: 'page-token-abc', content: 'Ciao Brescia', settings: {}, since: new Date('2026-10-20T08:00:00Z'), excludeExternalIds: ['1_1'] }

  it('settles a unique exact match and ignores receipts held by other jobs', async () => {
    const { adapter, calls } = fakeGraph([json({ data: [
      { id: '1_1', message: 'Ciao Brescia' }, { id: '1_2', message: 'Ciao Brescia', permalink_url: 'https://facebook.com/p/2' }, { id: '1_3', message: 'Altro' },
    ] })])
    expect(await adapter.reconcile(app, reconcileInput)).toEqual({ kind: 'published', externalId: '1_2', url: 'https://facebook.com/p/2' })
    expect(calls[0]!.url.searchParams.get('since')).toBe(String(Date.parse('2026-10-20T08:00:00Z') / 1000))
  })

  it('reports no match and ambiguous matches', async () => {
    expect(await fakeGraph([json({ data: [] })]).adapter.reconcile(app, reconcileInput)).toEqual({ kind: 'not_found' })
    expect((await fakeGraph([json({ data: [{ id: '1_2', message: 'Ciao Brescia' }, { id: '1_3', message: 'Ciao Brescia' }] })]).adapter.reconcile(app, reconcileInput)).kind).toBe('ambiguous')
  })
})

describe('Meta metrics', () => {
  const metricsInput = (kind: 'facebook_page' | 'instagram_account', externalId: string) => ({
    channel: { id: 'c1', kind, externalId: '1000000000000101' }, token: 'page-token-abc', externalId,
  })

  it('reads a Page post\'s reactions, comments, shares, views and reach', async () => {
    const { adapter, calls } = fakeGraph([
      json({ id: '1_2', reactions: { data: [], summary: { total_count: 12 } }, comments: { data: [], summary: { total_count: 3 } }, shares: { count: 2 } }),
      json({ data: [{ name: 'post_media_view', period: 'lifetime', values: [{ value: 340 }] }, { name: 'post_total_media_view_unique', period: 'lifetime', values: [{ value: 210 }] }] }),
    ])
    expect(await adapter.metrics(app, metricsInput('facebook_page', '1_2'))).toEqual({
      values: { likes: 12, comments: 3, shares: 2, views: 340, reach: 210 }, unavailable: [],
    })
    expect(calls[1]!.url.pathname).toBe('/v26.0/1_2/insights')
    expect(calls[1]!.url.searchParams.get('metric')).toBe('post_media_view,post_total_media_view_unique')
    expect(calls[1]!.url.searchParams.get('appsecret_proof')).toBe(appSecretProof('page-token-abc', 'app-secret-123'))
  })

  it('reports views and reach as unavailable without read_insights, and shares as 0 before any', async () => {
    const { adapter } = fakeGraph([
      json({ id: '1_2', reactions: { data: [], summary: { total_count: 0 } }, comments: { data: [], summary: { total_count: 0 } } }),
      graphError(403, 10), graphError(403, 10), graphError(403, 10),
    ])
    expect(await adapter.metrics(app, metricsInput('facebook_page', '1_2'))).toEqual({
      values: { likes: 0, comments: 0, shares: 0 }, unavailable: ['views', 'reach'],
    })
  })

  it('reports views and reach as unavailable when the Page answers with no insights data', async () => {
    const { adapter } = fakeGraph([
      json({ id: '1_2', reactions: { data: [], summary: { total_count: 1 } }, comments: { data: [], summary: { total_count: 0 } } }),
      json({ data: [], paging: {} }),
    ])
    expect(await adapter.metrics(app, metricsInput('facebook_page', '1_2'))).toEqual({
      values: { likes: 1, comments: 0, shares: 0 }, unavailable: ['views', 'reach'],
    })
  })

  it('reads an Instagram post and keeps the metrics Meta does support for it', async () => {
    const { adapter, calls } = fakeGraph([
      json({ like_count: 41, comments_count: 5, id: '1801' }),
      graphError(400, 100),
      json({ data: [{ name: 'views', values: [{ value: 900 }] }] }),
      json({ data: [{ name: 'reach', values: [{ value: 600 }] }] }),
      graphError(400, 100),
      json({ data: [{ name: 'saved', values: [{ value: 7 }] }] }),
    ])
    expect(await adapter.metrics(app, metricsInput('instagram_account', '1801'))).toEqual({
      values: { likes: 41, comments: 5, views: 900, reach: 600, saves: 7 }, unavailable: ['shares'],
    })
    expect(calls.slice(2).map(call => call.url.searchParams.get('metric'))).toEqual(['views', 'reach', 'shares', 'saved'])
  })

  it('fails the read on errors other than a refused metric', async () => {
    const { adapter } = fakeGraph([json({ like_count: 1, comments_count: 0 }), graphError(500, 2, { is_transient: true })])
    await expect(adapter.metrics(app, metricsInput('instagram_account', '1801'))).rejects.toThrow(/returned 500/)
  })

  it('spends one budget call for each request after the first', async () => {
    const { adapter, calls } = fakeGraph([json({ like_count: 41, comments_count: 5 }), graphError(400, 100),
      ...['views', 'reach', 'shares', 'saved'].map(name => json({ data: [{ name, values: [{ value: 1 }] }] }))])
    let spent = 0
    await adapter.metrics(app, { ...metricsInput('instagram_account', '1801'), spendCall: () => { spent++ } })
    expect(calls).toHaveLength(6)
    expect(spent).toBe(5)
  })
})

describe('Meta account metrics', () => {
  const page = { id: 'c1', kind: 'facebook_page' as const, externalId: '1000000000000101' }
  const account = { id: 'c2', kind: 'instagram_account' as const, externalId: '17841400000000000' }
  const now = new Date('2030-01-02T10:00:00Z')

  it('reads Page followers and the last full day of views, reach and Page views', async () => {
    const days = (a: number, b: number) => [{ value: a, end_time: '2030-01-01T08:00:00+0000' }, { value: b, end_time: '2030-01-02T08:00:00+0000' },
      { value: 999, end_time: '2030-01-03T08:00:00+0000' }]
    const { adapter, calls } = fakeGraph([
      json({ id: '1000000000000101', followers_count: 1520, fan_count: 1400 }),
      json({ data: [{ name: 'page_media_view', period: 'day', values: days(10, 340) }, { name: 'page_total_media_view_unique', period: 'day', values: days(5, 210) },
        { name: 'page_views_total', period: 'day', values: days(1, 12) }] }),
    ])
    expect(await adapter.accountMetrics(app, { channel: page, token: 'page-token-abc', now })).toEqual({
      values: { followers: 1520, views: 340, reach: 210, profileViews: 12 }, unavailable: [],
    })
    expect(calls[0]!.url.searchParams.get('fields')).toBe('followers_count,fan_count')
    expect(calls[1]!.url.searchParams.get('metric')).toBe('page_media_view,page_total_media_view_unique,page_views_total')
    expect(calls[1]!.url.searchParams.get('period')).toBe('day')
  })

  it('falls back to fan_count and reports day metrics unavailable without read_insights', async () => {
    const { adapter } = fakeGraph([json({ fan_count: 88 }), json({ data: [] })])
    expect(await adapter.accountMetrics(app, { channel: page, token: 'page-token-abc', now })).toEqual({
      values: { followers: 88 }, unavailable: ['views', 'reach', 'profileViews'],
    })
  })

  it('reads Instagram counts and the previous UTC day of insights', async () => {
    const { adapter, calls } = fakeGraph([
      json({ followers_count: 300, follows_count: 20, media_count: 41 }),
      json({ data: [{ name: 'reach', total_value: { value: 90 } }, { name: 'views', total_value: { value: 400 } }, { name: 'profile_views', total_value: { value: 7 } }] }),
    ])
    expect(await adapter.accountMetrics(app, { channel: account, token: 'page-token-abc', now })).toEqual({
      values: { followers: 300, following: 20, posts: 41, reach: 90, views: 400, profileViews: 7 }, unavailable: [],
    })
    const query = Object.fromEntries(calls[1]!.url.searchParams)
    expect(query).toMatchObject({ metric: 'reach,views,profile_views', period: 'day', metric_type: 'total_value',
      since: String(Date.parse('2030-01-01T00:00:00Z') / 1000), until: String(Date.parse('2030-01-02T00:00:00Z') / 1000) })
  })

  it('spends one budget call for each request after the first, refused insights included', async () => {
    const refusedInsights = fakeGraph([json({ fan_count: 88 }), graphError(403, 10), graphError(403, 10), graphError(403, 10), graphError(403, 10)])
    let spent = 0
    await refusedInsights.adapter.accountMetrics(app, { channel: page, token: 'page-token-abc', now, spendCall: () => { spent++ } })
    expect(refusedInsights.calls).toHaveLength(5)
    expect(spent).toBe(4)

    const instagram = fakeGraph([json({ followers_count: 300 }), json({ data: [] })])
    spent = 0
    await instagram.adapter.accountMetrics(app, { channel: account, token: 'page-token-abc', now, spendCall: () => { spent++ } })
    expect(instagram.calls).toHaveLength(2)
    expect(spent).toBe(1)
  })

  it('turns Meta rate limits into RateLimited', async () => {
    for (const code of [4, 17, 32, 613, 80001]) {
      const { adapter } = fakeGraph([graphError(400, code)])
      await expect(adapter.accountMetrics(app, { channel: page, token: 'page-token-abc', now })).rejects.toBeInstanceOf(RateLimited)
    }
    const { adapter } = fakeGraph([graphError(500, 2)])
    await expect(adapter.accountMetrics(app, { channel: page, token: 'page-token-abc', now })).rejects.not.toBeInstanceOf(RateLimited)
  })
})

describe('Meta responses', () => {
  const post = { channel: { id: 'c1', kind: 'facebook_page' as const, externalId: '1000000000000101' }, token: 'page-token-abc', externalId: '1_2' }
  const media = { channel: { id: 'c2', kind: 'instagram_account' as const, externalId: '17841400000000000' }, token: 'page-token-abc', externalId: '1801' }
  const comment = (id: string, extra: Record<string, unknown> = {}) => ({ id, message: `text ${id}`, created_time: '2030-01-01T10:00:00+0000', like_count: 1,
    comment_count: 0, from: { name: 'Mario Rossi', id: '999' }, permalink_url: `https://www.facebook.com/${id}`, ...extra })

  it('reads Page comments and replies newest first, keeping only the commenter\'s name and whether the Page wrote it', async () => {
    const { adapter, calls } = fakeGraph([
      json({ data: [comment('1_2_4', { parent: { id: '1_2_1' }, from: { name: 'Bottega', id: post.channel.externalId } }),
        comment('1_2_3', { parent: { id: '1_2_1' } }), comment('1_2_1', { comment_count: 1 })], paging: { cursors: { after: 'next-1' }, next: 'https://graph.facebook.com/next' } }),
      json({ data: [comment('1_2_0', { from: undefined, message: undefined })], paging: { cursors: { after: 'next-2' } } }),
    ])
    const result = await adapter.responses(app, post)
    expect(result).toEqual({ kind: 'ok', responses: [
      expect.objectContaining({ externalId: '1_2_4', authorName: 'Bottega', fromChannel: true }),
      { externalId: '1_2_3', parentExternalId: '1_2_1', authorName: 'Mario Rossi', authorHandle: null, text: 'text 1_2_3', likeCount: 1, replyCount: 0,
        publishedAt: new Date('2030-01-01T10:00:00Z'), url: 'https://www.facebook.com/1_2_3', fromChannel: false },
      expect.objectContaining({ externalId: '1_2_1', parentExternalId: null, replyCount: 1, fromChannel: false }),
      expect.objectContaining({ externalId: '1_2_0', authorName: null, text: '', fromChannel: false }),
    ] })
    expect(JSON.stringify(result)).not.toContain('999')
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toMatchObject({ filter: 'stream', order: 'reverse_chronological',
      fields: 'id,message,created_time,like_count,comment_count,parent{id},from{id,name},permalink_url' })
    expect(calls[1]!.url.searchParams.get('after')).toBe('next-1')
  })

  it('stops paging when the caller\'s budget runs out', async () => {
    const { adapter, calls } = fakeGraph([json({ data: [comment('1_2_1')], paging: { cursors: { after: 'n' }, next: 'https://graph.facebook.com/next' } })])
    expect(await adapter.responses(app, { ...post, morePages: () => false })).toMatchObject({ kind: 'ok', responses: [{ externalId: '1_2_1' }] })
    expect(calls).toHaveLength(1)
  })

  it('names the missing permission when Meta refuses the edge', async () => {
    const { adapter } = fakeGraph([graphError(403, 10)])
    expect(await adapter.responses(app, post)).toEqual({ kind: 'unavailable', reason: expect.stringContaining('pages_read_user_content') })
    const instagramRefused = fakeGraph([graphError(403, 200)])
    expect(await instagramRefused.adapter.responses(app, media)).toEqual({ kind: 'unavailable', reason: expect.stringContaining('instagram_manage_comments') })
  })

  it('reads Instagram comments with their replies, by username only, and tells the account\'s own', async () => {
    const { adapter, calls } = fakeGraph([json({ data: [
      { id: '17900', text: 'Bello!', username: 'mario.rossi', timestamp: '2030-01-01T09:00:00+0000', like_count: 2,
        replies: { data: [{ id: '17901', text: 'Grazie', username: 'bottega', timestamp: '2030-01-01T11:00:00+0000', like_count: 0, user: { id: media.channel.externalId } }] } },
      { id: '17800', text: 'Primo', username: 'anna', timestamp: '2030-01-01T08:00:00+0000' },
    ] })])
    expect(await adapter.responses(app, media)).toEqual({ kind: 'ok', responses: [
      { externalId: '17901', parentExternalId: '17900', authorName: null, authorHandle: 'bottega', text: 'Grazie', likeCount: 0, replyCount: null,
        publishedAt: new Date('2030-01-01T11:00:00Z'), url: null, fromChannel: true },
      expect.objectContaining({ externalId: '17900', parentExternalId: null, authorHandle: 'mario.rossi', replyCount: 1, fromChannel: false }),
      expect.objectContaining({ externalId: '17800', likeCount: null, replyCount: 0, fromChannel: false }),
    ] })
    expect(calls[0]!.url.searchParams.get('fields')).toBe('id,text,username,timestamp,like_count,user,replies{id,text,username,timestamp,like_count,user}')
    // Without `user`, the account's own username tells it.
    const named = fakeGraph([json({ data: [{ id: '17902', text: 'Grazie!', username: 'Bottega', timestamp: '2030-01-01T12:00:00+0000' }] })])
    expect(await named.adapter.responses(app, { ...media, channel: { ...media.channel, handle: 'bottega' } }))
      .toMatchObject({ responses: [{ externalId: '17902', fromChannel: true }] })
  })

  it('cuts a long Instagram read to 300 by whole threads, keeping the parent of every reply', async () => {
    const time = (minutes: number) => new Date(Date.parse('2030-01-01T00:00:00Z') + minutes * 60_000).toISOString().replace('.000Z', '+0000')
    const igComment = (id: string, minutes: number) => ({ id, text: id, username: 'anna', timestamp: time(minutes) })
    // The oldest comment has the newest reply; 49 newer comments have six replies each: 345 in all.
    const data = [{ ...igComment('c0', 0), replies: { data: [igComment('c0-r', 10_000)] } },
      ...Array.from({ length: 49 }, (_, index) => ({ ...igComment(`c${index + 1}`, index + 1),
        replies: { data: Array.from({ length: 6 }, (_, reply) => igComment(`c${index + 1}-r${reply}`, 100 + index * 10 + reply)) } }))]
    const { adapter } = fakeGraph([json({ data })])
    const result = await adapter.responses(app, media)
    if (result.kind !== 'ok') throw new Error('expected responses')
    const kept = new Set(result.responses.map(response => response.externalId))
    expect(result.responses).toHaveLength(300)
    expect(kept.has('c0') && kept.has('c0-r')).toBe(true)
    expect(result.responses.filter(response => response.parentExternalId && !kept.has(response.parentExternalId))).toEqual([])
    const times = result.responses.map(response => response.publishedAt.getTime())
    expect(times).toEqual([...times].sort((a, b) => b - a))
  })
})

describe('Meta account activity', () => {
  const page = { id: 'c1', kind: 'facebook_page' as const, externalId: '1000000000000101' }
  const account = { id: 'c2', kind: 'instagram_account' as const, externalId: '17841400000000000' }

  it('reads a Page profile and its newest published posts, in two requests the budget pays for', async () => {
    const { adapter, calls } = fakeGraph([
      json({ name: 'Bottega Digitale', username: 'bottegadigitale', about: 'Agenzia web', website: 'https://bottega.example', category: 'Web designer',
        picture: { data: { url: 'https://scontent.xx.fbcdn.net/v/t39/pic.jpg?oh=1&oe=2' } } }),
      json({ data: [{ id: '1000000000000101_2', message: 'Nuovo video', created_time: '2030-01-02T09:00:00+0000', permalink_url: 'https://facebook.com/p/2',
        status_type: 'added_video' }, { id: '1000000000000101_1', created_time: '2030-01-01T09:00:00+0000', status_type: 'published_story' }] }),
    ])
    let spent = 0
    expect(await adapter.accountActivity(app, { channel: page, token: 'page-token-abc', spendCall: () => { spent++ } })).toEqual({
      profile: { name: 'Bottega Digitale', username: 'bottegadigitale', description: 'Agenzia web', website: 'https://bottega.example',
        category: 'Web designer', pictureUrl: 'https://scontent.xx.fbcdn.net/v/t39/pic.jpg?oh=1&oe=2' },
      posts: [
        { externalId: '1000000000000101_2', type: 'video', text: 'Nuovo video', url: 'https://facebook.com/p/2', publishedAt: new Date('2030-01-02T09:00:00Z') },
        { externalId: '1000000000000101_1', type: 'other', text: null, url: null, publishedAt: new Date('2030-01-01T09:00:00Z') },
      ],
    })
    expect(calls.map(call => call.url.pathname)).toEqual(['/v26.0/1000000000000101', '/v26.0/1000000000000101/published_posts'])
    expect(calls[0]!.url.searchParams.get('fields')).toBe('name,username,about,website,category,picture{url}')
    expect(calls[1]!.url.searchParams.get('limit')).toBe('25')
    expect(spent).toBe(1)
  })

  it('reads a Page-linked Instagram profile and media, telling reels and carousels apart', async () => {
    const { adapter, calls } = fakeGraph([
      json({ username: 'bottega.digitale', name: 'Bottega', biography: 'Siti e app', website: 'https://bottega.example', profile_picture_url: 'https://cdn/x.jpg?a=1' }),
      json({ data: [{ id: 'm3', media_type: 'VIDEO', media_product_type: 'REELS', caption: 'x'.repeat(900), permalink: 'https://instagram.com/reel/m3', timestamp: '2030-01-02T09:00:00+0000' },
        { id: 'm2', media_type: 'CAROUSEL_ALBUM', media_product_type: 'FEED' }, { id: 'm1', media_type: 'IMAGE' }] }),
    ])
    const result = await adapter.accountActivity(app, { channel: account, token: 'page-token-abc' })
    expect(result.profile).toEqual({ name: 'Bottega', username: 'bottega.digitale', description: 'Siti e app', website: 'https://bottega.example',
      category: null, pictureUrl: 'https://cdn/x.jpg?a=1' })
    expect(result.posts.map(post => [post.externalId, post.type])).toEqual([['m3', 'reel'], ['m2', 'carousel'], ['m1', 'image']])
    expect(result.posts[0]!.text).toHaveLength(500)
    expect(calls[0]!.url.searchParams.get('fields')).toBe('username,name,biography,website,profile_picture_url')
    expect(calls[1]!.url.pathname).toBe('/v26.0/17841400000000000/media')
  })

  it('reports rate limits as RateLimited', async () => {
    const { adapter } = fakeGraph([graphError(400, 32)])
    await expect(adapter.accountActivity(app, { channel: page, token: 'page-token-abc' })).rejects.toBeInstanceOf(RateLimited)
  })
})
