import { describe, expect, it } from 'vitest'
import { sniffMedia } from '../src/media.js'
import { Mp4Scanner, videoDetails } from '../src/mp4.js'
import { box, mp4 } from './fixtures/mp4.js'

describe('MP4 details', () => {
  it('reads duration, display size and codecs from the moov box', () => {
    const file = mp4({ durationMs: 42_500, width: 1080, height: 1920, videoCodec: 'hvc1', audioCodec: 'mp4a' })
    expect(sniffMedia(file)).toBe('video/mp4')
    expect(videoDetails(file)).toEqual({ durationMs: 42_500, width: 1080, height: 1920, videoCodec: 'hvc1', audioCodec: 'mp4a' })
  })

  it('finds moov after the media data, across chunks of any size, with 64-bit sizes', () => {
    const file = mp4({ moovLast: true, largeMdat: true, mdatBytes: 5_000, durationMs: 61_000, version: 1, timescale: 90_000 })
    for (const size of [1, 7, 4096, file.length]) {
      const scanner = new Mp4Scanner()
      for (let offset = 0; offset < file.length; offset += size) scanner.push(file.subarray(offset, offset + size))
      expect(scanner.details(), `chunks of ${size}`).toMatchObject({ durationMs: 61_000, videoCodec: 'avc1', audioCodec: 'mp4a' })
    }
  })

  it('turns the size of a video stored landscape with a quarter turn', () => {
    expect(videoDetails(mp4({ width: 1920, height: 1080, rotate: true }))).toMatchObject({ width: 1080, height: 1920 })
  })

  it('says which tracks are missing', () => {
    expect(videoDetails(mp4({ audioCodec: null }))).toMatchObject({ videoCodec: 'avc1', audioCodec: null })
    expect(videoDetails(mp4({ videoCodec: null }))).toMatchObject({ videoCodec: null, width: null, height: null, audioCodec: 'mp4a' })
  })

  it('gives nothing for a file without a whole moov, and never throws on garbage', () => {
    const file = mp4()
    // A cut in the media data after moov still has its details.
    expect(videoDetails(file.subarray(0, file.length - 40))).toMatchObject({ durationMs: 20_000 })
    const cut = mp4({ moovLast: true })
    expect(videoDetails(cut.subarray(0, cut.length - 10))).toBeNull()
    expect(videoDetails(Buffer.concat([box('ftyp', Buffer.from('isom')), Buffer.from([0, 0, 0, 3, 1, 2, 3])]))).toBeNull()
    expect(videoDetails(Buffer.concat([box('ftyp', Buffer.from('isom')), box('moov', Buffer.from([0, 0, 0, 200, 0x6d, 0x76]))]))).toEqual({
      durationMs: null, width: null, height: null, videoCodec: null, audioCodec: null })
    for (let seed = 0; seed < 200; seed++) {
      const random = Buffer.from(Array.from({ length: 300 }, (_, index) => (seed * 31 + index * 17) % 256))
      expect(() => videoDetails(Buffer.concat([box('ftyp', Buffer.from('isom')), box('moov', random)]))).not.toThrow()
    }
  })
})
