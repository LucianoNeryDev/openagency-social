import { z } from 'zod'
import { invalid } from '../../errors.js'
import type { MediaInfo, PublishInput, PublishOutcome, ReconcileInput, ReconcileOutcome } from '../types.js'
import { classify } from './classify.js'
import { GraphError, type GraphCall, type GraphClient } from './graph.js'

const createdSchema = z.object({ id: z.string().regex(/^[\d_]+$/) })
const containerStatusSchema = z.object({ status_code: z.string().optional(), status: z.string().optional() })
const permalinkSchema = z.object({ permalink: z.string().optional() })
const mediaListSchema = z.object({
  data: z.array(z.object({ id: z.string(), caption: z.string().optional(), timestamp: z.string().optional(), permalink: z.string().optional() })).max(100),
})

/** Reels settings; image posts take none. */
const reelSettingsSchema = z.strictObject({
  // Also show the reel in the profile grid (Instagram's default).
  shareToFeed: z.boolean().optional(),
  // Cover frame, when no cover image is attached.
  thumbOffsetMs: z.number().int().min(0).max(15 * 60_000).optional(),
})
/** Instagram's limits for API-published feed images. */
const maxImageBytes = 8 * 1024 * 1024
const imageRatio = { min: 4 / 5, max: 1.91 }

export interface ContainerPoll {
  intervalMs: number
  attempts: number
}
/** Images are ready in seconds; a reel's video takes minutes to process. */
export const defaultImagePoll: ContainerPoll = { intervalMs: 3_000, attempts: 20 }
export const defaultVideoPoll: ContainerPoll = { intervalMs: 5_000, attempts: 120 }

const isVideo = (file: { mimeType: string }) => file.mimeType === 'video/mp4'

/**
 * Instagram could not fetch a file from its URL (2207052), timed out doing so
 * (2207003) or found it expired (2207020): nothing was created, and a later
 * try with a fresh signed URL usually works.
 */
const downloadSubcodes = new Set([2207003, 2207020, 2207052])
const downloadFailed = (error: unknown) => error instanceof GraphError && error.failure.kind === 'http' && downloadSubcodes.has(error.failure.subcode ?? 0)

/**
 * A post is 1 to 10 JPEG images (several make a carousel), or a reel: one MP4
 * video, optionally followed by a JPEG cover.
 */
export function validateInstagram(settings: Record<string, unknown>, media: MediaInfo[]) {
  if (!media.length) throw invalid('media_required', 'Instagram posts need at least one image or a video')
  if (media.some(isVideo)) {
    if (!isVideo(media[0]!) || media.length > 2 || (media[1] && media[1].mimeType !== 'image/jpeg')) {
      throw invalid('unsupported_media', 'An Instagram reel is one MP4 video, optionally followed by one JPEG cover')
    }
    if (!reelSettingsSchema.safeParse(settings).success) throw invalid('invalid_settings', 'Instagram reels take only shareToFeed and thumbOffsetMs')
    if (media[1] && media[1].sizeBytes > maxImageBytes) throw invalid('unsupported_media', 'Instagram accepts JPEG images up to 8 MB')
    return
  }
  if (Object.keys(settings).length) throw invalid('invalid_settings', 'Instagram image posts take no channel settings')
  for (const file of media) {
    if (file.mimeType !== 'image/jpeg' || file.sizeBytes > maxImageBytes) throw invalid('unsupported_media', 'Instagram accepts JPEG images up to 8 MB')
    if (!file.width || !file.height) throw invalid('unsupported_media', 'Upload the image again so its size can be checked')
    const ratio = file.width / file.height
    if (ratio < imageRatio.min - 0.005 || ratio > imageRatio.max + 0.005) throw invalid('aspect_ratio', 'Instagram images must be between 4:5 and 1.91:1')
  }
}

/**
 * Container publishing, shared by Instagram accounts linked to a Facebook
 * Page and Instagram's own login. Instagram fetches each file from its URL
 * into a container; only `media_publish` makes anything visible, so only it
 * can be uncertain.
 */
export class InstagramPublisher {
  constructor(private readonly graph: GraphClient, private readonly polls: { image?: ContainerPoll, video?: ContainerPoll } = {}) {}

  async publish(call: GraphCall, input: PublishInput): Promise<PublishOutcome> {
    const user = input.channel.externalId
    if (!input.media.length) return { kind: 'failed', retryable: false, code: 'media_required', detail: 'Instagram posts need an image or a video' }
    if (input.media.some(file => !file.publicUrl)) return { kind: 'failed', retryable: false, code: 'public_media_unavailable', detail: 'PUBLIC_MEDIA_URL is not configured' }
    const reel = isVideo(input.media[0]!)
    const poll = reel ? this.polls.video ?? defaultVideoPoll : this.polls.image ?? defaultImagePoll

    let containerId: string
    try {
      if (reel) {
        const settings = reelSettingsSchema.parse(input.settings)
        const cover = input.media[1]?.publicUrl
        containerId = createdSchema.parse(await this.graph.request('POST', `/${user}/media`, { ...call, form: {
          media_type: 'REELS', video_url: input.media[0]!.publicUrl!, caption: input.content,
          share_to_feed: String(settings.shareToFeed ?? true),
          ...(cover ? { cover_url: cover } : settings.thumbOffsetMs === undefined ? {} : { thumb_offset: String(settings.thumbOffsetMs) }),
        } })).id
      } else if (input.media.length === 1) {
        containerId = createdSchema.parse(await this.graph.request('POST', `/${user}/media`, { ...call, form: { image_url: input.media[0]!.publicUrl!, caption: input.content } })).id
      } else {
        const children: string[] = []
        for (const file of input.media) {
          children.push(createdSchema.parse(await this.graph.request('POST', `/${user}/media`, { ...call, form: { image_url: file.publicUrl!, is_carousel_item: 'true' } })).id)
        }
        for (const child of children) {
          const ready = await this.waitForContainer(call, child, poll, input.heartbeat)
          if (ready) return ready
        }
        containerId = createdSchema.parse(await this.graph.request('POST', `/${user}/media`, { ...call, form: {
          media_type: 'CAROUSEL', children: children.join(','), caption: input.content,
        } })).id
      }
      const ready = await this.waitForContainer(call, containerId, poll, input.heartbeat)
      if (ready) return ready
    } catch (error) {
      if (downloadFailed(error)) return { kind: 'failed', retryable: true, code: 'media_download_failed', detail: error instanceof Error ? error.message.slice(0, 500) : 'Media download failed' }
      return classify(error, false)
    }

    let published: z.infer<typeof createdSchema>
    await input.beforeVisible?.()
    try {
      published = createdSchema.parse(await this.graph.request('POST', `/${user}/media_publish`, { ...call, form: { creation_id: containerId } }))
    } catch (error) {
      return classify(error, true)
    }
    // The post exists; a missing permalink only loses the link in the receipt.
    const url = await this.graph.request('GET', `/${published.id}`, { ...call, query: { fields: 'permalink' } })
      .then(value => permalinkSchema.parse(value).permalink).catch(() => undefined)
    return { kind: 'published', externalId: published.id, ...(url ? { url } : {}) }
  }

  /** Resolves to null when the container is ready, or to the failure that ends the attempt. */
  private async waitForContainer(call: GraphCall, id: string, poll: ContainerPoll, heartbeat?: () => Promise<void>): Promise<PublishOutcome | null> {
    for (let attempt = 0; attempt < poll.attempts; attempt++) {
      const status = containerStatusSchema.parse(await this.graph.request('GET', `/${id}`, { ...call, query: { fields: 'status_code,status' } }))
      if (status.status_code === 'FINISHED') return null
      if (status.status_code === 'ERROR' && /\b220(7003|7020|7052)\b/.test(status.status ?? '')) {
        return { kind: 'failed', retryable: true, code: 'media_download_failed', detail: `ERROR: ${status.status}`.slice(0, 500) }
      }
      if (status.status_code === 'ERROR' || status.status_code === 'EXPIRED') {
        return { kind: 'failed', retryable: false, code: 'container_error', detail: `${status.status_code}: ${status.status ?? 'no detail'}`.slice(0, 500) }
      }
      // Video processing outlasts the sweeper's window without a heartbeat.
      await heartbeat?.()
      await new Promise(resolve => setTimeout(resolve, poll.intervalMs))
    }
    return { kind: 'failed', retryable: true, code: 'container_timeout', detail: `Container ${id} was not ready in time` }
  }

  async reconcile(call: GraphCall, input: ReconcileInput): Promise<ReconcileOutcome> {
    const result = mediaListSchema.parse(await this.graph.request('GET', `/${input.channel.externalId}/media`, {
      ...call, query: { fields: 'id,caption,timestamp,permalink', limit: '50' },
    }))
    const matches = result.data.filter(post => post.caption === input.content && !input.excludeExternalIds.includes(post.id)
      && (post.timestamp === undefined || Date.parse(post.timestamp) >= input.since.getTime()))
    if (matches.length === 1) return { kind: 'published', externalId: matches[0]!.id, url: matches[0]!.permalink }
    if (matches.length === 0) return { kind: 'not_found' }
    return { kind: 'ambiguous', detail: `${matches.length} posts match the caption` }
  }
}
