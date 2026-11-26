import { invalid } from '../errors.js'
import type { MediaInfo } from './types.js'

/** What a platform takes in a video. Codecs are MP4 sample entry codes. */
export interface VideoRules {
  platform: string
  maxBytes: number
  minMs?: number
  maxMs: number
  videoCodecs: ReadonlySet<string>
  /** Absent: any sound track, or none. */
  audioCodecs?: ReadonlySet<string>
}

/** H.264 and HEVC sample entries; dvh1 and dvhe are HEVC carrying Dolby Vision. */
export const h264 = ['avc1', 'avc3'] as const
export const hevc = ['hvc1', 'hev1', 'dvh1', 'dvhe'] as const

const minutes = (value: number) => value % 60_000 === 0 ? `${value / 60_000} minutes` : `${value / 1000} seconds`

/**
 * Refuses a video the platform would refuse after processing it. What a file
 * stored before its details were read does not say is let through; its size is
 * always known.
 */
export function checkVideo(file: MediaInfo, rules: VideoRules) {
  if (file.sizeBytes > rules.maxBytes) {
    throw invalid('video_too_large', `${rules.platform} takes videos up to ${Math.floor(rules.maxBytes / 1_048_576)} MB`)
  }
  if (file.durationMs == null) return
  if (rules.minMs !== undefined && file.durationMs < rules.minMs) throw invalid('video_too_short', `${rules.platform} needs a video of at least ${minutes(rules.minMs)}`)
  if (file.durationMs > rules.maxMs) throw invalid('video_too_long', `${rules.platform} takes videos up to ${minutes(rules.maxMs)}`)
  if (!file.videoCodec) throw invalid('unsupported_codec', 'The MP4 has no video track')
  if (!rules.videoCodecs.has(file.videoCodec)) throw invalid('unsupported_codec', `${rules.platform} does not take ${file.videoCodec} video`)
  if (rules.audioCodecs && file.audioCodec && !rules.audioCodecs.has(file.audioCodec)) {
    throw invalid('unsupported_codec', `${rules.platform} does not take ${file.audioCodec} audio`)
  }
}
