import { describe, expect, it } from 'vitest'
import { imageSize, mediaSignature, publicMediaKey, publicMediaUrl } from '../src/media.js'

function png(width: number, height: number) {
  const data = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(data)
  data.writeUInt32BE(13, 8)
  data.write('IHDR', 12, 'latin1')
  data.writeUInt32BE(width, 16)
  data.writeUInt32BE(height, 20)
  return data
}

/** SOI, an APP0 segment, then a baseline or progressive frame header. */
function jpeg(width: number, height: number, frame = 0xc0) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.from('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0])
  const sof = Buffer.from([0xff, frame, 0x00, 0x11, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1])
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])])
}

describe('image size', () => {
  it('reads PNG and JPEG headers', () => {
    expect(imageSize(png(1640, 624), 'image/png')).toEqual({ width: 1640, height: 624 })
    expect(imageSize(jpeg(1080, 1350), 'image/jpeg')).toEqual({ width: 1080, height: 1350 })
    expect(imageSize(jpeg(1080, 1350, 0xc2), 'image/jpeg')).toEqual({ width: 1080, height: 1350 })
  })

  it('returns null for headers it cannot read', () => {
    expect(imageSize(Buffer.from([0xff, 0xd8, 0xff, 0]), 'image/jpeg')).toBeNull()
    expect(imageSize(png(0, 10), 'image/png')).toBeNull()
    expect(imageSize(Buffer.from([0xff, 0xd8, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0]), 'image/jpeg')).toBeNull()
  })
})

describe('public media URLs', () => {
  const key = publicMediaKey('s'.repeat(48))
  const config = { baseUrl: 'https://dash-api.example.com/api/social/media/', key, lifetimeMs: 3_600_000 }

  it('signs the organization, media and expiry', () => {
    const url = new URL(publicMediaUrl(config, 'agency-bottega-digitale', '0b0f7c3e-4b7e-4c11-9a51-8f1c2a7a0c11', new Date('2026-10-24T10:00:00Z')))
    expect(url.pathname).toBe('/api/social/media/agency-bottega-digitale/0b0f7c3e-4b7e-4c11-9a51-8f1c2a7a0c11')
    const expires = Number(url.searchParams.get('expires'))
    expect(expires).toBe(Date.parse('2026-10-24T11:00:00Z') / 1000)
    expect(url.searchParams.get('signature')).toBe(mediaSignature(key, 'agency-bottega-digitale', '0b0f7c3e-4b7e-4c11-9a51-8f1c2a7a0c11', expires))
    expect(mediaSignature(key, 'another-org', '0b0f7c3e-4b7e-4c11-9a51-8f1c2a7a0c11', expires)).not.toBe(url.searchParams.get('signature'))
  })

  // The dashboard's verifyMediaSignature test checks the same vector.
  it('matches the vector shared with the dashboard', () => {
    expect(mediaSignature(publicMediaKey('fixture-engine-service-token-0123456789'), 'org-a', 'c3d4e5f6-0000-4000-8000-000000000000', 1_900_000_000))
      .toBe('7NtnaE1tLncj354NZaDY9Ckc5RNIOXYzZMsVYM78iG4')
  })

  it('derives a key distinct from the service token', () => {
    expect(key).toHaveLength(32)
    expect(key.equals(Buffer.from('s'.repeat(32)))).toBe(false)
    expect(publicMediaKey('t'.repeat(48)).equals(key)).toBe(false)
  })
})

describe('media sniffing', () => {
  it('recognises MP4 by its ftyp box', async () => {
    const { sniffMedia } = await import('../src/media.js')
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom'), Buffer.alloc(20)])
    expect(sniffMedia(mp4)).toBe('video/mp4')
    expect(sniffMedia(Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypqt  '), Buffer.alloc(20)]))).toBeNull()
    expect(sniffMedia(Buffer.from('not media at all'))).toBeNull()
  })
})
