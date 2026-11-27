import { z } from 'zod'
import type { BrowserPlatform, ChannelKind } from '../../db/schema.js'
import { invalid } from '../../errors.js'
import type { ChannelLimits, MediaInfo } from '../types.js'

/** What one browser platform accepts: channel kinds, limits, settings and media. */
export interface BrowserRules {
  platform: BrowserPlatform
  label: string
  kinds: readonly ChannelKind[]
  limits: ChannelLimits
  settings: z.ZodType<Record<string, unknown>>
  /** Throws an EngineError when the media do not suit the platform. */
  media(media: MediaInfo[]): void
}

const none = z.strictObject({})
const isImage = (file: MediaInfo) => file.mimeType === 'image/jpeg' || file.mimeType === 'image/png'
const isVideo = (file: MediaInfo) => file.mimeType === 'video/mp4'

/** Up to `maxImages` JPEG or PNG images, or a single MP4 video. */
function imagesOrOneVideo(label: string, maxImages: number, required = false) {
  return (media: MediaInfo[]) => {
    if (required && !media.length) throw invalid('media_required', `${label} posts need an image or a video`)
    if (media.some(isVideo) && media.length > 1) throw invalid('unsupported_media', `${label} takes one video on its own`)
    if (!media.every(file => isImage(file) || isVideo(file))) throw invalid('unsupported_media', `${label} takes JPEG or PNG images and MP4 videos`)
    if (media.length > maxImages) throw invalid('too_many_media', `${label} takes at most ${maxImages} images`)
  }
}

export const browserRules: Record<BrowserPlatform, BrowserRules> = {
  tiktok: {
    platform: 'tiktok', label: 'TikTok', kinds: ['tiktok_account'], limits: { maxLength: 2_200, maxMedia: 1 }, settings: none,
    media(media) {
      if (media.length !== 1 || media[0]!.mimeType !== 'video/mp4') throw invalid('unsupported_media', 'TikTok posts need exactly one MP4 video')
    },
  },
  // Free accounts: 280, X's weighted length (every link 23, emoji and CJK 2).
  x: {
    platform: 'x', label: 'X', kinds: ['x_account'], limits: { maxLength: 280, maxMedia: 4, lengthUnit: 'x_weighted' }, settings: none,
    media: imagesOrOneVideo('X', 4),
  },
  linkedin: {
    platform: 'linkedin', label: 'LinkedIn', kinds: ['linkedin_profile', 'linkedin_page'], limits: { maxLength: 3_000, maxMedia: 9 },
    settings: none, media: imagesOrOneVideo('LinkedIn', 9),
  },
  threads: {
    platform: 'threads', label: 'Threads', kinds: ['threads_account'], limits: { maxLength: 500, maxMedia: 10 }, settings: none,
    media(media) {
      if (!media.every(file => isImage(file) || isVideo(file))) throw invalid('unsupported_media', 'Threads takes JPEG or PNG images and MP4 videos')
    },
  },
  // The post text is the Pin's description.
  pinterest: {
    platform: 'pinterest', label: 'Pinterest', kinds: ['pinterest_account'], limits: { maxLength: 500, maxMedia: 1, titleMaxLength: 100 },
    settings: z.strictObject({
      board: z.string().trim().min(1).max(180),
      title: z.string().trim().max(100).optional(),
      link: z.url({ protocol: /^https?$/ }).max(2_000).optional(),
    }),
    media: imagesOrOneVideo('Pinterest', 1, true),
  },
  // The post text is the body; `subreddit` is a name without `r/`, or `u_<username>` for the account's own profile.
  reddit: {
    platform: 'reddit', label: 'Reddit', kinds: ['reddit_account'], limits: { maxLength: 40_000, maxMedia: 20, titleMaxLength: 300 },
    settings: z.strictObject({
      subreddit: z.string().regex(/^(u_)?[A-Za-z0-9_]{2,21}$/),
      title: z.string().trim().min(1).max(300),
    }),
    media: imagesOrOneVideo('Reddit', 20),
  },
}

/** The channel kind a browser account publishes as. Only LinkedIn has two: the member's profile, or a Page they administer. */
export function browserChannelKind(platform: BrowserPlatform, page?: string): ChannelKind {
  if (page !== undefined && platform !== 'linkedin') throw invalid('unsupported_channel', 'Only LinkedIn accounts publish to a Page')
  if (platform === 'linkedin') return page === undefined ? 'linkedin_profile' : 'linkedin_page'
  return browserRules[platform].kinds[0]!
}
