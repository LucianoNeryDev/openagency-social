import { z } from 'zod'
import type { ChannelKind, ChannelMetricName, ChannelMetricValues, MetricName, MetricValues } from '../../db/schema.js'
import { invalid } from '../../errors.js'
import { mediaFileBytes } from '../../media.js'
import {
  AttemptClosedError, RateLimited, ReauthRequired, type AccountActivityInput, type AccountActivityResult, type AccountMetricsInput, type AccountMetricsResult, type ChannelProfile, type ChannelTarget,
  type PlatformPost, type ChannelCredential, type ChannelLimits, type ConnectedAccount,
  type FindReplyInput, type FindReplyOutcome, type MediaFile, type MediaInfo, type MetricsInput, type MetricsResult, type PlatformAdapter, type PlatformResponse,
  type PublishInput, type PublishOutcome, type ReconcileInput, type ReconcileOutcome, type ReplyInput, type ReplyOutcome, type ResolvedProviderApp,
  type ResponsesInput, type ResponsesResult,
} from '../types.js'
import { pickOwnReply, type ReplyCandidate } from '../reply-match.js'
import { GoogleClient, GoogleError } from './google.js'
import { checkVideo, h264, hevc, type VideoRules } from '../video.js'
import { activityPostsPerRead, clipText } from '../activity.js'

/** `youtube.force-ssl` lets the channel reply to comments. */
export const youtubeReplyScope = 'https://www.googleapis.com/auth/youtube.force-ssl'
export const defaultYoutubeScopes = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly', youtubeReplyScope]

const api = 'https://www.googleapis.com/youtube/v3'
const tokenUrl = 'https://oauth2.googleapis.com/token'
const uploadUrl = 'https://www.googleapis.com/upload/youtube/v3/videos'
/**
 * YouTube takes uploads up to 256 GB or 12 hours (https://support.google.com/youtube/answer/71673;
 * the engine stores at most 1 GB) and recommends H.264 in MP4
 * (https://support.google.com/youtube/answer/1722171, read 2026-11-26). Any
 * common codec is processed: H.264, HEVC, AV1, VP9 and VP8, MPEG-4 Part 2 and
 * ProRes; the sound track is not checked. A square or vertical video up to
 * three minutes becomes a Short (https://support.google.com/youtube/answer/15424877);
 * a longer one is an ordinary video. Channels that are not verified are held
 * to 15 minutes, which the API does not tell before the upload.
 */
export const youtubeVideoRules: VideoRules = {
  platform: 'YouTube', maxBytes: 256 * 1024 ** 3, maxMs: 12 * 3_600_000,
  videoCodecs: new Set([...h264, ...hevc, 'av01', 'vp09', 'vp08', 'mp4v', 'apch', 'apcn', 'apcs', 'apco', 'ap4h', 'ap4x']),
}
/** YouTube rejects angle brackets in titles and descriptions. */
const plain = (value: string) => !/[<>]/.test(value)

export const youtubeSettingsSchema = z.strictObject({
  title: z.string().trim().min(1).max(400).refine(title => Array.from(title).length <= 100, 'title too long').refine(plain, 'no angle brackets'),
  privacy: z.enum(['public', 'unlisted', 'private']).default('public'),
  madeForKids: z.boolean().default(false),
  tags: z.array(z.string().trim().min(1).max(100).refine(plain)).max(30).refine(tags => tags.join(',').length <= 500, 'tags too long').default([]),
  // YouTube's video category, for example 20 (Gaming) or 1 (Film & Animation).
  categoryId: z.string().regex(/^\d{1,3}$/).optional(),
  // Altered or synthetic content that looks realistic.
  containsSyntheticMedia: z.boolean().optional(),
})

// `scope`: the granted scopes, space-delimited, in the code exchange and in renewals.
const tokenSchema = z.object({ access_token: z.string().min(1), expires_in: z.number().int().positive(), refresh_token: z.string().min(1).optional(),
  scope: z.string().max(4_000).optional() })
const scopesOf = (scope: string | undefined) => scope === undefined ? {} : { grantedScopes: scope.split(' ').filter(Boolean) }
const channelListSchema = z.object({ items: z.array(z.object({
  id: z.string().regex(/^UC[\w-]{22}$/),
  snippet: z.object({ title: z.string().max(1000) }).optional(),
  contentDetails: z.object({ relatedPlaylists: z.object({ uploads: z.string() }) }).optional(),
})).max(50).default([]) })
const videoSchema = z.object({ id: z.string().regex(/^[\w-]{6,20}$/) })
// The Data API returns counts as decimal strings; hidden counts are omitted.
const statisticSchema = z.string().regex(/^\d{1,15}$/).transform(Number).optional()
const statisticsSchema = z.object({ items: z.array(z.object({ id: z.string(), statistics: z.object({
  viewCount: statisticSchema, likeCount: statisticSchema, commentCount: statisticSchema,
}).optional() })).max(1) })
const channelStatisticsSchema = z.object({ items: z.array(z.object({ statistics: z.object({
  viewCount: statisticSchema, subscriberCount: statisticSchema, hiddenSubscriberCount: z.boolean().optional(), videoCount: statisticSchema,
}).optional() })).max(1).default([]) })
const optionalText = z.string().optional().nullable()
const thumbnailSchema = z.object({ url: optionalText }).optional()
const channelProfileSchema = z.object({ items: z.array(z.object({
  snippet: z.object({ title: optionalText, description: optionalText, customUrl: optionalText,
    thumbnails: z.object({ high: thumbnailSchema, medium: thumbnailSchema, default: thumbnailSchema }).optional() }).optional(),
  contentDetails: z.object({ relatedPlaylists: z.object({ uploads: optionalText }).optional() }).optional(),
})).max(1).default([]) })
const uploadsSchema = z.object({ items: z.array(z.object({
  snippet: z.object({ title: optionalText, publishedAt: optionalText }).optional(),
  contentDetails: z.object({ videoId: z.string().min(1).max(100), videoPublishedAt: optionalText }),
  status: z.object({ privacyStatus: z.enum(['public', 'unlisted', 'private']).optional() }).optional(),
})).default([]) })
const commentSnippetSchema = z.object({
  authorDisplayName: z.string().optional(),
  // Only compared with the channel's own ID; never stored.
  authorChannelId: z.object({ value: z.string().max(200).optional() }).optional(),
  textDisplay: z.string().optional(),
  // Returned only to the comment's author.
  textOriginal: z.string().optional(),
  likeCount: z.number().int().nonnegative().optional(),
  publishedAt: z.string().max(40),
})
const commentSchema = z.object({ id: z.string().min(1).max(200), snippet: commentSnippetSchema })
const commentThreadsSchema = z.object({
  nextPageToken: z.string().max(1_000).optional(),
  items: z.array(z.object({
    snippet: z.object({ topLevelComment: commentSchema, totalReplyCount: z.number().int().nonnegative().optional() }),
    replies: z.object({ comments: z.array(commentSchema.extend({ snippet: commentSnippetSchema.extend({ parentId: z.string().max(200).optional() }) })).max(100) }).optional(),
  })).max(100).default([]),
})
const repliesSchema = z.object({ nextPageToken: z.string().max(1_000).optional(), items: z.array(commentSchema).max(100).default([]) })
const playlistSchema = z.object({ items: z.array(z.object({ snippet: z.object({
  title: z.string(), publishedAt: z.string().optional(), resourceId: z.object({ videoId: z.string() }),
}) })).max(50).default([]) })

/** Thumbnails.set takes images up to 2 MB. */
const maxThumbnailBytes = 2 * 1024 * 1024
/** About 300 comments per read: three pages of 100 threads, with the replies YouTube includes. */
const commentPages = 3
const maxResponsesPerRead = 300
/** Retry, rather than fail, when the project's daily quota or rate runs out. */
const rateReasons = new Set(['quotaExceeded', 'rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded'])
/** The grant itself is refused: a new login is needed. Other 403s are about this one action or channel. */
const authReasons = new Set(['authError'])
const permissionReasons = new Set(['insufficientPermissions', 'forbidden', 'youtubeSignupRequired'])

/**
 * YouTube channels through the Data API v3: one MP4 per post, uploaded in a
 * resumable session. Only the upload's last request creates the video, so
 * only it can be uncertain; and the session itself says whether it finished.
 */
export class YoutubeAdapter implements PlatformAdapter {
  readonly platform = 'youtube' as const
  // Google access tokens last an hour.
  readonly refreshBeforeMs = 10 * 60_000
  private readonly google: GoogleClient

  constructor(private readonly options: { redirectUri?: string, fetch?: typeof fetch, uploadTimeoutMs?: number } = {}) {
    this.google = new GoogleClient(options)
  }

  authorizeUrl(app: ResolvedProviderApp, state: string) {
    if (!this.options.redirectUri) throw invalid('unsupported_channel', 'YouTube login is not configured on this engine')
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    url.searchParams.set('client_id', app.externalAppId)
    url.searchParams.set('redirect_uri', this.options.redirectUri)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', (app.settings.scopes ?? defaultYoutubeScopes).join(' '))
    // A refresh token is only issued with offline access and fresh consent.
    url.searchParams.set('access_type', 'offline')
    url.searchParams.set('prompt', 'consent')
    url.searchParams.set('include_granted_scopes', 'true')
    url.searchParams.set('state', state)
    return url.href
  }

  async finishConnect(app: ResolvedProviderApp, code: string): Promise<ConnectedAccount[]> {
    if (!this.options.redirectUri) throw invalid('unsupported_channel', 'YouTube login is not configured on this engine')
    const token = tokenSchema.parse((await this.google.request('POST', tokenUrl, { form: {
      code, client_id: app.externalAppId, client_secret: app.secret, redirect_uri: this.options.redirectUri, grant_type: 'authorization_code',
    } })).payload)
    if (!token.refresh_token) throw invalid('invalid_state', 'Google did not grant offline access; connect again')
    const { items } = channelListSchema.parse((await this.google.request('GET', `${api}/channels`, { token: token.access_token,
      query: { part: 'snippet', mine: 'true', maxResults: '50' } })).payload)
    const expiresAt = new Date(Date.now() + token.expires_in * 1000)
    return items.map(item => ({ kind: 'youtube_channel' as const, externalId: item.id, name: item.snippet?.title ?? item.id,
      token: token.access_token, refreshToken: token.refresh_token, tokenExpiresAt: expiresAt, ...scopesOf(token.scope) }))
  }

  async refreshCredential(app: ResolvedProviderApp, credential: ChannelCredential): Promise<ChannelCredential> {
    if (!credential.refreshToken) throw new ReauthRequired('No refresh token stored')
    try {
      const token = tokenSchema.parse((await this.google.request('POST', tokenUrl, { form: {
        client_id: app.externalAppId, client_secret: app.secret, refresh_token: credential.refreshToken, grant_type: 'refresh_token',
      } })).payload)
      return { accessToken: token.access_token, ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
        expiresAt: new Date(Date.now() + token.expires_in * 1000), ...scopesOf(token.scope) }
    } catch (error) {
      if (error instanceof GoogleError && error.failure.kind === 'http' && error.failure.reason === 'invalid_grant') throw new ReauthRequired('Google refused the refresh token')
      throw error
    }
  }

  limits(): ChannelLimits {
    // The description, in UTF-8 bytes as the Data API counts it; a thumbnail may follow the video.
    return { maxLength: 5_000, maxMedia: 2, lengthUnit: 'bytes', titleMaxLength: 100 }
  }

  validateSettings(kind: ChannelKind, settings: Record<string, unknown>, media: MediaInfo[], content?: string) {
    if (kind !== 'youtube_channel') throw invalid('unsupported_channel', 'Not a YouTube channel')
    if (!youtubeSettingsSchema.safeParse(settings).success) throw invalid('invalid_settings', 'YouTube needs a title of up to 100 characters, without < or >')
    if (!media.length || media[0]!.mimeType !== 'video/mp4' || media.length > 2 || (media[1] && media[1].mimeType === 'video/mp4')) {
      throw invalid('unsupported_media', 'A YouTube post is one MP4 video, optionally followed by a JPEG or PNG thumbnail')
    }
    checkVideo(media[0]!, youtubeVideoRules)
    if (media[1] && media[1].sizeBytes > maxThumbnailBytes) throw invalid('unsupported_media', 'YouTube thumbnails may be up to 2 MB')
    if (content !== undefined && (!plain(content) || Buffer.byteLength(content) > 5_000)) {
      throw invalid('content_too_long', 'YouTube descriptions are up to 5,000 bytes, without < or >')
    }
  }

  async publish(_app: ResolvedProviderApp | null, input: PublishInput): Promise<PublishOutcome> {
    const settings = youtubeSettingsSchema.parse(input.settings)
    const [video, thumbnail] = input.media
    if (!video || video.mimeType !== 'video/mp4') return { kind: 'failed', retryable: false, code: 'media_required', detail: 'YouTube posts need one MP4 video' }

    // Opening the session creates nothing.
    let session: string
    try {
      const opened = await this.google.request('POST', uploadUrl, {
        token: input.token, query: { uploadType: 'resumable', part: 'snippet,status' },
        headers: { 'X-Upload-Content-Type': video.mimeType, 'X-Upload-Content-Length': String(video.sizeBytes) },
        json: {
          snippet: { title: settings.title, description: input.content, ...(settings.tags.length ? { tags: settings.tags } : {}),
            ...(settings.categoryId ? { categoryId: settings.categoryId } : {}) },
          status: { privacyStatus: settings.privacy, selfDeclaredMadeForKids: settings.madeForKids,
            ...(settings.containsSyntheticMedia === undefined ? {} : { containsSyntheticMedia: settings.containsSyntheticMedia }) },
        },
      })
      const location = opened.headers.get('location')
      if (!location) return { kind: 'failed', retryable: true, code: 'no_upload_session', detail: 'YouTube returned no upload session' }
      session = location
    } catch (error) {
      return classify(error, false)
    }

    let created: z.infer<typeof videoSchema>
    try {
      // One request per stored chunk, so a long video stays out of memory.
      let sent = 0
      let last: unknown
      for await (const chunk of video.chunks()) {
        // Stays inside the sweeper's window: each chunk times out first.
        await input.heartbeat?.()
        // The last chunk completes the upload, and that creates the video.
        if (sent + chunk.length >= video.sizeBytes) await input.beforeVisible?.()
        const reply = await this.google.request('PUT', session, { token: input.token, bytes: { data: chunk, type: video.mimeType }, accept: [308],
          headers: { 'Content-Range': `bytes ${sent}-${sent + chunk.length - 1}/${video.sizeBytes}` }, timeoutMs: this.options.uploadTimeoutMs ?? 8 * 60_000 })
        sent += chunk.length
        if (reply.status === 308 && reply.headers.get('range') !== `bytes=0-${sent - 1}`) throw new GoogleError({ kind: 'lost' }, 'YouTube did not keep the whole chunk')
        last = reply.payload
      }
      created = videoSchema.parse(last)
    } catch (error) {
      if (error instanceof AttemptClosedError) throw error
      if (error instanceof GoogleError && error.failure.kind === 'http' && error.failure.status < 500) return classify(error, false)
      // The session knows whether the upload completed.
      const settled = await this.sessionState(session, input.token, video)
      if (settled) return settled
      return classify(error, true)
    }

    await this.setThumbnail(created.id, thumbnail, input.token)
    return { kind: 'published', externalId: created.id, url: `https://youtu.be/${created.id}` }
  }

  /** Reads an upload session after a lost response: a finished video, a definite non-upload, or null when unknown. */
  private async sessionState(session: string, token: string, video: MediaFile): Promise<PublishOutcome | null> {
    try {
      const status = await this.google.request('PUT', session, { token, headers: { 'Content-Range': `bytes */${video.sizeBytes}` }, accept: [308] })
      if (status.status === 308) return { kind: 'failed', retryable: true, code: 'upload_incomplete', detail: 'The upload did not finish; nothing was published' }
      const parsed = videoSchema.safeParse(status.payload)
      return parsed.success ? { kind: 'published', externalId: parsed.data.id, url: `https://youtu.be/${parsed.data.id}` } : null
    } catch {
      return null
    }
  }

  /** Best effort: custom thumbnails need a verified channel, and the video exists either way. */
  private async setThumbnail(videoId: string, thumbnail: MediaFile | undefined, token: string) {
    if (!thumbnail) return
    await mediaFileBytes(thumbnail).then(data => this.google.request('POST', 'https://www.googleapis.com/upload/youtube/v3/thumbnails/set', {
      token, query: { videoId }, bytes: { data, type: thumbnail.mimeType },
    })).catch(() => undefined)
  }

  async checkCredential(_app: ResolvedProviderApp | null, input: { channel: ChannelTarget, token: string }) {
    await guardQuota(() => this.google.request('GET', `${api}/channels`, { token: input.token, query: { part: 'id', id: input.channel.externalId } }))
  }

  async reconcile(_app: ResolvedProviderApp | null, input: ReconcileInput): Promise<ReconcileOutcome> {
    const settings = youtubeSettingsSchema.parse(input.settings)
    const { items } = channelListSchema.parse((await this.google.request('GET', `${api}/channels`, { token: input.token,
      query: { part: 'contentDetails', id: input.channel.externalId } })).payload)
    const uploads = items[0]?.contentDetails?.relatedPlaylists.uploads
    if (!uploads) return { kind: 'ambiguous', detail: 'The channel has no uploads playlist' }
    const recent = playlistSchema.parse((await this.google.request('GET', `${api}/playlistItems`, { token: input.token,
      query: { part: 'snippet', playlistId: uploads, maxResults: '50' } })).payload)
    const matches = recent.items.map(item => item.snippet).filter(item => item.title === settings.title
      && !input.excludeExternalIds.includes(item.resourceId.videoId)
      && (item.publishedAt === undefined || Date.parse(item.publishedAt) >= input.since.getTime()))
    if (matches.length === 1) return { kind: 'published', externalId: matches[0]!.resourceId.videoId, url: `https://youtu.be/${matches[0]!.resourceId.videoId}` }
    if (matches.length === 0) return { kind: 'not_found' }
    return { kind: 'ambiguous', detail: `${matches.length} videos match the title` }
  }

  /** View, like and comment counts from the Data API; `youtube.readonly` is enough. */
  async metrics(_app: ResolvedProviderApp | null, input: MetricsInput): Promise<MetricsResult> {
    const { items } = statisticsSchema.parse((await guardQuota(() => this.google.request('GET', `${api}/videos`, { token: input.token,
      query: { part: 'statistics', id: input.externalId } }))).payload)
    const statistics = items[0]?.statistics
    if (!statistics) throw new Error('Video not found')
    const values: MetricValues = {}
    const unavailable: MetricName[] = []
    for (const [name, value] of [['views', statistics.viewCount], ['likes', statistics.likeCount], ['comments', statistics.commentCount]] as const) {
      if (value === undefined) unavailable.push(name)
      else values[name] = value
    }
    return { values, unavailable }
  }

  /** Subscribers, total views and video count of the channel. A hidden subscriber count is unavailable. */
  async accountMetrics(_app: ResolvedProviderApp | null, input: AccountMetricsInput): Promise<AccountMetricsResult> {
    const { items } = channelStatisticsSchema.parse((await guardQuota(() => this.google.request('GET', `${api}/channels`, { token: input.token,
      query: { part: 'statistics', id: input.channel.externalId } }))).payload)
    const statistics = items[0]?.statistics
    if (!statistics) throw new Error('Channel not found')
    const values: ChannelMetricValues = {}
    const unavailable: ChannelMetricName[] = []
    const followers = statistics.hiddenSubscriberCount ? undefined : statistics.subscriberCount
    for (const [name, value] of [['followers', followers], ['totalViews', statistics.viewCount], ['posts', statistics.videoCount]] as const) {
      if (value === undefined) unavailable.push(name)
      else values[name] = value
    }
    return { values, unavailable }
  }

  /**
   * Title, description, handle and picture of the channel, then its newest
   * uploads (the uploads playlist lists private and scheduled videos to the
   * owner, so an upload shows before it goes public). Two requests, a quota
   * unit each; a search would cost a hundred.
   */
  async accountActivity(_app: ResolvedProviderApp | null, input: AccountActivityInput): Promise<AccountActivityResult> {
    const { items: [item] } = channelProfileSchema.parse((await guardQuota(() => this.google.request('GET', `${api}/channels`, { token: input.token,
      query: { part: 'snippet,contentDetails', id: input.channel.externalId } }))).payload)
    if (!item) throw new Error('Channel not found')
    const snippet = item.snippet
    const thumbnails = snippet?.thumbnails
    const profile: ChannelProfile = { name: snippet?.title ?? null, username: snippet?.customUrl ?? null, description: snippet?.description ?? null,
      website: null, category: null, pictureUrl: thumbnails?.high?.url ?? thumbnails?.medium?.url ?? thumbnails?.default?.url ?? null }
    const uploads = item.contentDetails?.relatedPlaylists?.uploads
    if (!uploads) return { profile, posts: [] }
    input.spendCall?.()
    const result = uploadsSchema.parse((await guardQuota(() => this.google.request('GET', `${api}/playlistItems`, { token: input.token,
      query: { part: 'snippet,contentDetails,status', playlistId: uploads, maxResults: String(activityPostsPerRead) } }))).payload)
    return { profile, posts: result.items.map((upload): PlatformPost => {
      const published = upload.contentDetails.videoPublishedAt ?? upload.snippet?.publishedAt
      return { externalId: upload.contentDetails.videoId, type: 'video', text: clipText(upload.snippet?.title), url: `https://www.youtube.com/watch?v=${upload.contentDetails.videoId}`,
        publishedAt: published && !Number.isNaN(Date.parse(published)) ? new Date(published) : null,
        ...(upload.status?.privacyStatus ? { privacy: upload.status.privacyStatus } : {}) }
    }) }
  }

  /**
   * Newest comment threads with the replies YouTube includes (a few per
   * thread). `youtube.readonly` is enough; comments turned off or a removed
   * video are unavailable.
   */
  async responses(_app: ResolvedProviderApp | null, input: ResponsesInput): Promise<ResponsesResult> {
    const responses: PlatformResponse[] = []
    let pageToken: string | undefined
    for (let page = 0; page < commentPages; page++) {
      let result: z.infer<typeof commentThreadsSchema>
      try {
        result = commentThreadsSchema.parse((await guardQuota(() => this.google.request('GET', `${api}/commentThreads`, { token: input.token, query: {
          part: 'snippet,replies', videoId: input.externalId, order: 'time', maxResults: '100', textFormat: 'plainText', ...(pageToken ? { pageToken } : {}),
        } }))).payload)
      } catch (error) {
        const reason = page === 0 ? commentsRefusal(error) : null
        if (reason) return { kind: 'unavailable', reason }
        throw error
      }
      for (const thread of result.items) {
        const top = thread.snippet.topLevelComment
        const entries = [{ comment: top, parent: null, replyCount: thread.snippet.totalReplyCount ?? null },
          ...(thread.replies?.comments ?? []).map(reply => ({ comment: reply, parent: top.id, replyCount: null }))]
        for (const { comment, parent, replyCount } of entries) {
          const publishedAt = Date.parse(comment.snippet.publishedAt)
          if (Number.isNaN(publishedAt)) continue
          responses.push({ externalId: comment.id, parentExternalId: parent, authorName: comment.snippet.authorDisplayName ?? null, authorHandle: null,
            text: comment.snippet.textDisplay ?? '', likeCount: comment.snippet.likeCount ?? null, replyCount, publishedAt: new Date(publishedAt),
            url: commentUrl(input.externalId, comment.id), fromChannel: comment.snippet.authorChannelId?.value === input.channel.externalId })
        }
      }
      pageToken = result.nextPageToken
      if (!pageToken || responses.length >= maxResponsesPerRead || !(input.morePages?.() ?? true)) break
    }
    return { kind: 'ok', responses: responses.slice(0, maxResponsesPerRead) }
  }

  replyRules(kind: ChannelKind) {
    // YouTube names `commentTextTooLong` without a number; 10,000 is the comment box's limit.
    return kind === 'youtube_channel' ? { permission: youtubeReplyScope, maxLength: 10_000 } : null
  }

  /** `comments.insert` with the top-level comment as `parentId`: 50 quota units. */
  async reply(_app: ResolvedProviderApp | null, input: ReplyInput): Promise<ReplyOutcome> {
    let created: z.infer<typeof commentSchema>
    try {
      created = commentSchema.parse((await this.google.request('POST', `${api}/comments`, { token: input.token, query: { part: 'snippet' },
        json: { snippet: { parentId: input.targetExternalId, textOriginal: input.text } } })).payload)
    } catch (error) {
      return classifyReply(error)
    }
    return { kind: 'sent', externalId: created.id, url: commentUrl(input.postExternalId, created.id) }
  }

  /** The channel's replies under a comment (`comments.list`, 1 unit a page), for an uncertain send. */
  async findReply(_app: ResolvedProviderApp | null, input: FindReplyInput): Promise<FindReplyOutcome> {
    const candidates: ReplyCandidate[] = []
    let pageToken: string | undefined
    for (let page = 0; page < commentPages; page++) {
      if (page > 0) input.spendCall?.()
      const result = repliesSchema.parse((await guardQuota(() => this.google.request('GET', `${api}/comments`, { token: input.token, query: {
        part: 'snippet', parentId: input.targetExternalId, maxResults: '100', textFormat: 'plainText', ...(pageToken ? { pageToken } : {}),
      } }))).payload)
      for (const comment of result.items) {
        const published = Date.parse(comment.snippet.publishedAt)
        candidates.push({ id: comment.id, text: comment.snippet.textOriginal ?? comment.snippet.textDisplay ?? '', createdAt: Number.isNaN(published) ? null : published,
          own: comment.snippet.authorChannelId?.value === input.channel.externalId, url: commentUrl(input.postExternalId, comment.id) })
      }
      pageToken = result.nextPageToken
      if (!pageToken) break
    }
    return pickOwnReply(candidates, input)
  }
}

const commentUrl = (videoId: string, commentId: string) => `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&lc=${encodeURIComponent(commentId)}`

const replyRefusals: Record<string, string> = {
  parentCommentNotFound: 'comment_gone', commentNotFound: 'comment_gone', videoNotFound: 'comment_gone',
  commentTextTooLong: 'text_too_long',
  operationNotSupported: 'reply_not_allowed', parentCommentIsPrivate: 'reply_not_allowed', commentsDisabled: 'reply_not_allowed',
}

/** A refused reply is definite; only a request that may have arrived without a readable answer is uncertain. */
function classifyReply(error: unknown): ReplyOutcome {
  if (!(error instanceof GoogleError)) return { kind: 'uncertain', code: 'unexpected_response', detail: 'Unreadable success response' }
  const failure = error.failure
  if (failure.kind === 'unreachable') return { kind: 'failed', retryable: true, code: 'unreachable', detail: error.message }
  if (failure.kind === 'lost') return { kind: 'uncertain', code: 'response_lost', detail: error.message }
  const detail = `HTTP ${failure.status}${failure.reason ? ` ${failure.reason}` : ''}: ${failure.message}`
  // The project's daily quota is gone until midnight Pacific: retrying within the hour cannot help.
  if (failure.reason === 'quotaExceeded' || failure.reason === 'dailyLimitExceeded') return { kind: 'failed', retryable: false, code: 'quota_exceeded', detail }
  if (failure.status === 429 || (failure.reason && rateReasons.has(failure.reason))) return { kind: 'failed', retryable: true, code: 'rate_limited', detail }
  if (failure.status === 401 || failure.reason === 'authError') return { kind: 'failed', retryable: false, code: 'channel_inactive', detail, reauth: true }
  // Only a refusal that names the grant's scopes marks the channel; `forbidden` is about this comment or video.
  if (failure.status === 403 && failure.reason === 'insufficientPermissions') {
    return { kind: 'failed', retryable: false, code: 'missing_permission', detail, permission: youtubeReplyScope }
  }
  if (failure.status === 403 && failure.reason === 'forbidden') return { kind: 'failed', retryable: false, code: 'reply_not_allowed', detail }
  const refusal = failure.reason ? replyRefusals[failure.reason] : undefined
  if (refusal) return { kind: 'failed', retryable: false, code: refusal, detail }
  if (failure.status === 404) return { kind: 'failed', retryable: false, code: 'comment_gone', detail }
  if (failure.status >= 500) return { kind: 'uncertain', code: 'platform_error', detail }
  return { kind: 'failed', retryable: false, code: 'rejected', detail }
}

/** Quota and rate errors pause reads on the channel instead of counting as failures; a refused token (401) needs a new login. */
async function guardQuota<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  } catch (error) {
    if (error instanceof GoogleError && error.failure.kind === 'http' && error.failure.status === 401) throw new ReauthRequired(error.message)
    if (error instanceof GoogleError && error.failure.kind === 'http' && (error.failure.status === 429 || (error.failure.reason && rateReasons.has(error.failure.reason)))) {
      // The daily quota belongs to the Google project and resets at midnight Pacific time.
      if (error.failure.reason === 'quotaExceeded' || error.failure.reason === 'dailyLimitExceeded') {
        throw new RateLimited(error.message, 'app', nextPacificMidnight(new Date()))
      }
      throw new RateLimited(error.message)
    }
    throw error
  }
}

/** The next midnight in America/Los_Angeles, when the Data API quota resets. */
export function nextPacificMidnight(now: Date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23',
    hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(now).map(part => [part.type, part.value]))
  const elapsed = ((Number(parts.hour) * 60 + Number(parts.minute)) * 60 + Number(parts.second)) * 1000 + now.getMilliseconds()
  return new Date(now.getTime() - elapsed + 86_400_000)
}

function commentsRefusal(error: unknown): string | null {
  if (!(error instanceof GoogleError) || error.failure.kind !== 'http') return null
  const reason = error.failure.reason
  if (reason === 'commentsDisabled') return 'Comments are turned off for this video.'
  if (reason === 'videoNotFound' || error.failure.status === 404) return 'The video was removed or the channel can no longer see it.'
  if (reason === 'insufficientPermissions' || reason === 'forbidden') return 'Reading comments needs the youtube.readonly scope; connect the channel again to grant it.'
  return null
}

/** `sent` is true for the request that creates the video. */
function classify(error: unknown, sent: boolean): PublishOutcome {
  if (!(error instanceof GoogleError)) {
    return sent ? { kind: 'uncertain', code: 'unexpected_response', detail: 'Unreadable success response' }
      : { kind: 'failed', retryable: true, code: 'unexpected_response', detail: 'Unreadable response before upload' }
  }
  const failure = error.failure
  if (failure.kind === 'unreachable') return { kind: 'failed', retryable: true, code: 'unreachable', detail: error.message }
  if (failure.kind === 'lost') {
    return sent ? { kind: 'uncertain', code: 'response_lost', detail: error.message } : { kind: 'failed', retryable: true, code: 'response_lost', detail: error.message }
  }
  const detail = `HTTP ${failure.status}${failure.reason ? ` ${failure.reason}` : ''}: ${failure.message}`
  if (failure.status === 401 || (failure.status === 403 && failure.reason && authReasons.has(failure.reason))) {
    return { kind: 'failed', retryable: false, code: 'auth', detail, reauth: true }
  }
  if (failure.status === 403 && failure.reason && permissionReasons.has(failure.reason)) return { kind: 'failed', retryable: false, code: 'permission_missing', detail }
  if (failure.status === 429 || (failure.reason && rateReasons.has(failure.reason))) return { kind: 'failed', retryable: true, code: 'rate_limited', detail }
  if (failure.status >= 500) return sent ? { kind: 'uncertain', code: 'platform_error', detail } : { kind: 'failed', retryable: true, code: 'platform_error', detail }
  return { kind: 'failed', retryable: false, code: 'rejected', detail }
}
