import { errorFields, log } from './log.js'
import { createHash, createHmac, hkdfSync } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import { recordEvent, type EngineContext } from './context.js'
import type { Executor } from './db/client.js'
import { media, mediaChunks } from './db/schema.js'
import { invalid, notFound } from './errors.js'
import type { MediaFile, MediaInfo } from './platforms/types.js'
import { Mp4Scanner } from './mp4.js'

export const maxImageBytes = 10 * 1024 * 1024
export const maxVideoBytes = 1024 * 1024 * 1024
export const maxMediaBytes = maxVideoBytes
/**
 * Files are stored and read one chunk at a time, so their size does not reach
 * the engine's memory. An image always fits in its first chunk. A multiple of
 * 256 KiB, the unit of YouTube's resumable upload.
 */
export const mediaChunkBytes = 16 * 1024 * 1024

export function sniffMedia(data: Buffer): 'image/jpeg' | 'image/png' | 'video/mp4' | null {
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.length > 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  // ISO base media: a leading `ftyp` box with an MP4-family brand.
  if (data.length > 12 && data.toString('latin1', 4, 8) === 'ftyp' && /^(isom|iso[2-9]|mp4[12]|avc1|M4V |dash)$/.test(data.toString('latin1', 8, 12))) return 'video/mp4'
  return null
}

/** JPEG start-of-frame markers; C4, C8 and CC share the range but are not frames. */
const jpegFrames = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

/** Pixel size from the file header, or null when the header cannot be read. */
export function imageSize(data: Buffer, mimeType: 'image/jpeg' | 'image/png'): { width: number, height: number } | null {
  if (mimeType === 'image/png') {
    if (data.length < 24 || data.toString('latin1', 12, 16) !== 'IHDR') return null
    return positive(data.readUInt32BE(16), data.readUInt32BE(20))
  }
  let offset = 2
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) return null
    const marker = data[offset + 1]!
    if (marker === 0xff) {
      offset += 1
      continue
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset += 2
      continue
    }
    if (jpegFrames.has(marker)) return positive(data.readUInt16BE(offset + 7), data.readUInt16BE(offset + 5))
    offset += 2 + data.readUInt16BE(offset + 2)
  }
  return null
}

function positive(width: number, height: number) {
  return width > 0 && height > 0 ? { width, height } : null
}

async function* inChunks(body: Buffer | AsyncIterable<Uint8Array>, size: number) {
  let pending: Buffer[] = []
  let pendingBytes = 0
  for await (const piece of Buffer.isBuffer(body) ? [body] : body) {
    pending.push(Buffer.from(piece.buffer, piece.byteOffset, piece.byteLength))
    pendingBytes += piece.byteLength
    if (pendingBytes < size) continue
    let joined = Buffer.concat(pending)
    while (joined.length >= size) {
      yield joined.subarray(0, size)
      joined = joined.subarray(size)
    }
    pending = joined.length ? [joined] : []
    pendingBytes = joined.length
  }
  if (pendingBytes) yield Buffer.concat(pending)
}

/** Stores a file as it arrives. A refused or interrupted upload leaves nothing behind. */
export async function storeMedia(context: EngineContext, organizationId: string, name: string, declaredType: string, body: Buffer | AsyncIterable<Uint8Array>) {
  return context.db.transaction(async transaction => {
    const hash = createHash('sha256')
    let id: string | undefined
    let limit = 0
    let total = 0
    let position = 0
    let scanner: Mp4Scanner | undefined
    for await (const chunk of inChunks(body, mediaChunkBytes)) {
      total += chunk.length
      if (!id) {
        const mimeType = sniffMedia(chunk)
        if (!mimeType || mimeType !== declaredType) throw invalid('invalid_media', 'Only JPEG and PNG images and MP4 videos are supported')
        limit = mimeType === 'video/mp4' ? maxVideoBytes : maxImageBytes
        if (mimeType === 'video/mp4') scanner = new Mp4Scanner()
        const size = mimeType === 'video/mp4' ? null : imageSize(chunk, mimeType)
        const [row] = await transaction.insert(media).values({ organizationId, name, mimeType, sizeBytes: 0, sha256: '', width: size?.width, height: size?.height }).returning({ id: media.id })
        id = row!.id
      }
      if (total > limit) throw invalid('invalid_media', 'Images may be up to 10 MB and videos up to 1 GB')
      hash.update(chunk)
      scanner?.push(chunk)
      await transaction.insert(mediaChunks).values({ mediaId: id, position: position++, data: chunk })
    }
    if (!id) throw invalid('invalid_media', 'Only JPEG and PNG images and MP4 videos are supported')
    // A video's details, so submit can refuse what the platform would refuse after processing it.
    const video = scanner?.details()
    const [row] = await transaction.update(media).set({ sizeBytes: total, sha256: hash.digest('hex'), ...(video ? { width: video.width, height: video.height,
      durationMs: video.durationMs, videoCodec: video.videoCodec, audioCodec: video.audioCodec } : {}) }).where(eq(media.id, id))
      .returning({ id: media.id, name: media.name, mimeType: media.mimeType, sizeBytes: media.sizeBytes, width: media.width, height: media.height,
        durationMs: media.durationMs, videoCodec: media.videoCodec, audioCodec: media.audioCodec })
    await recordEvent(transaction, { organizationId, kind: 'media.stored', detail: { mediaId: id, sizeBytes: total } })
    return row!
  })
}

/** Metadata of the tenant's media, in the order given. Throws when one is missing or foreign. */
export async function loadMediaInfo(executor: Executor, organizationId: string, ids: string[]): Promise<MediaInfo[]> {
  if (!ids.length) return []
  const rows = await executor.select({ id: media.id, mimeType: media.mimeType, sizeBytes: media.sizeBytes, width: media.width, height: media.height,
    durationMs: media.durationMs, videoCodec: media.videoCodec, audioCodec: media.audioCodec })
    .from(media).where(and(eq(media.organizationId, organizationId), inArray(media.id, ids)))
  return ids.map(id => {
    const row = rows.find(value => value.id === id)
    if (!row) throw notFound('Media')
    return row
  })
}

/** One file's bytes in order, read from the database as they are consumed. */
async function* mediaBytes(executor: Executor, id: string) {
  const [row] = await executor.select({ data: media.data }).from(media).where(eq(media.id, id)).limit(1)
  if (row?.data) {
    yield row.data
    return
  }
  for (let position = 0; ; position++) {
    const [chunk] = await executor.select({ data: mediaChunks.data }).from(mediaChunks).where(and(eq(mediaChunks.mediaId, id), eq(mediaChunks.position, position))).limit(1)
    if (!chunk) return
    yield chunk.data
  }
}

export async function loadMedia(executor: Executor, organizationId: string, ids: string[]): Promise<MediaFile[]> {
  if (!ids.length) return []
  const rows = await executor.select({ id: media.id, name: media.name, mimeType: media.mimeType, sizeBytes: media.sizeBytes }).from(media)
    .where(and(eq(media.organizationId, organizationId), inArray(media.id, ids)))
  return ids.map(id => {
    const row = rows.find(value => value.id === id)
    if (!row) throw notFound('Media')
    return { ...row, chunks: () => mediaBytes(executor, row.id) }
  })
}

export async function readMedia(executor: Executor, organizationId: string, id: string) {
  const [row] = await loadMedia(executor, organizationId, [id])
  return row!
}

/** The whole file in memory, for what a platform takes in one piece: images only. */
export async function mediaFileBytes(file: Pick<MediaFile, 'chunks'>) {
  const parts: Buffer[] = []
  for await (const part of file.chunks()) parts.push(part)
  return Buffer.concat(parts)
}

/**
 * Signed, short-lived public URLs for media, served by the dashboard API.
 * Platforms such as Instagram fetch images from a URL, and the engine has no
 * public ingress. Both sides derive the key from the shared service token.
 */
export interface PublicMedia {
  baseUrl: string
  key: Buffer
  lifetimeMs: number
}

export function publicMediaKey(serviceToken: string) {
  return Buffer.from(hkdfSync('sha256', serviceToken, '', 'openagency-social media-url v1', 32))
}

export function mediaSignature(key: Buffer, organizationId: string, mediaId: string, expires: number) {
  return createHmac('sha256', key).update(`${organizationId}\n${mediaId}\n${expires}`).digest('base64url')
}

export function publicMediaUrl(publicMedia: PublicMedia, organizationId: string, mediaId: string, now: Date) {
  const expires = Math.floor((now.getTime() + publicMedia.lifetimeMs) / 1000)
  const url = new URL(`${publicMedia.baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(organizationId)}/${encodeURIComponent(mediaId)}`)
  url.searchParams.set('expires', String(expires))
  url.searchParams.set('signature', mediaSignature(publicMedia.key, organizationId, mediaId, expires))
  return url.href
}

/**
 * At start: PUBLIC_MEDIA_URL is where Instagram and the browser runner fetch
 * media, so an address that does not answer at all makes every such post fail
 * later. Any HTTP answer counts (the route wants a signature); only a network
 * failure is reported. Returns whether it answered.
 */
export async function checkPublicMediaUrl(baseUrl: string | undefined, fetcher: typeof fetch = fetch) {
  if (!baseUrl) {
    log('warn', 'PUBLIC_MEDIA_URL is not set: Instagram and browser posts with media are refused')
    return false
  }
  try {
    await fetcher(baseUrl, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(10_000) })
    return true
  } catch (error) {
    log('error', 'PUBLIC_MEDIA_URL does not answer: Instagram and browser posts with media will fail', { url: new URL(baseUrl).origin, ...errorFields(error) })
    return false
  }
}
