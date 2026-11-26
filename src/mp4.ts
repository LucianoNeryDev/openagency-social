/**
 * What an MP4's `moov` box says about the video, read at upload so a post the
 * platform would refuse after minutes of processing is refused on submit.
 * Only the boxes needed are read: `mvhd` (duration), and per track `tkhd`
 * (display size and rotation), `hdlr` (video or sound) and the first `stsd`
 * sample entry (the codec's four-character code: avc1, hvc1, mp4a, …).
 */
export interface VideoDetails {
  /** Null when the file does not say (a fragmented MP4 without a duration). */
  durationMs: number | null
  /** The first video track's display size, after its rotation. */
  width: number | null
  height: number | null
  /** The first video track's sample entry, such as `avc1` or `hvc1`; null without a video track. */
  videoCodec: string | null
  /** The first sound track's sample entry, such as `mp4a`; null without a sound track. */
  audioCodec: string | null
}

/** A longer `moov` is not read; the file is then let through unchecked. */
const maxMoovBytes = 64 * 1024 * 1024

/**
 * Walks the top-level boxes of a file as it arrives, skipping everything but
 * `moov` (which may come before or after the media data), and keeps only that.
 * Never throws: a file it cannot read gives no details.
 */
export class Mp4Scanner {
  private consumed = 0
  private boxEnd = 0
  private header = Buffer.alloc(0)
  private parts: Buffer[] = []
  private remaining = 0
  private collecting = false
  private moov: Buffer | null = null
  private done = false

  push(chunk: Buffer) {
    let index = 0
    while (index < chunk.length && !this.done) {
      if (this.collecting) {
        const take = Math.min(this.remaining, chunk.length - index)
        this.parts.push(Buffer.from(chunk.subarray(index, index + take)))
        this.remaining -= take
        index += take
        if (!this.remaining) this.finishMoov()
        continue
      }
      const position = this.consumed + index
      if (position < this.boxEnd) {
        index += Math.min(chunk.length - index, this.boxEnd - position)
        continue
      }
      const wanted = this.header.length >= 8 && this.header.readUInt32BE(0) === 1 ? 16 : 8
      const take = Math.min(wanted - this.header.length, chunk.length - index)
      this.header = Buffer.concat([this.header, chunk.subarray(index, index + take)])
      index += take
      if (this.header.length < 8) continue
      const size32 = this.header.readUInt32BE(0)
      if (size32 === 1 && this.header.length < 16) continue
      const headerBytes = this.header.length
      const type = this.header.toString('latin1', 4, 8)
      // Size 0 runs to the end of the file; 1 means a 64-bit size follows the type.
      const size = size32 === 0 ? Infinity : size32 === 1 ? Number(this.header.readBigUInt64BE(8)) : size32
      this.header = Buffer.alloc(0)
      if (size < headerBytes) {
        this.done = true
        continue
      }
      if (type === 'moov') {
        if (size > maxMoovBytes) {
          this.done = true
          continue
        }
        this.collecting = true
        this.remaining = size - headerBytes
        if (!this.remaining) this.finishMoov()
      } else {
        this.boxEnd = position + take - headerBytes + size
        if (!Number.isFinite(this.boxEnd)) this.done = true
      }
    }
    this.consumed += chunk.length
  }

  private finishMoov() {
    this.moov = Buffer.concat(this.parts)
    this.parts = []
    this.collecting = false
    this.done = true
  }

  /** The details, or null when no complete `moov` was found or it could not be read. */
  details(): VideoDetails | null {
    if (!this.moov) return null
    try {
      return readMoov(this.moov)
    } catch {
      return null
    }
  }
}

/** The details of a whole file in memory (tests and small files). */
export function videoDetails(data: Buffer) {
  const scanner = new Mp4Scanner()
  scanner.push(data)
  return scanner.details()
}

interface Box { type: string, start: number, end: number }

/** The boxes between `start` and `end`: each one's type and payload range. */
function* boxes(data: Buffer, start: number, end: number): Generator<Box> {
  let offset = start
  while (offset + 8 <= end) {
    const size32 = data.readUInt32BE(offset)
    const type = data.toString('latin1', offset + 4, offset + 8)
    let header = 8
    let size = size32
    if (size32 === 1) {
      if (offset + 16 > end) return
      size = Number(data.readBigUInt64BE(offset + 8))
      header = 16
    } else if (size32 === 0) {
      size = end - offset
    }
    if (size < header || offset + size > end) return
    yield { type, start: offset + header, end: offset + size }
    offset += size
  }
}

function child(data: Buffer, parent: Box, type: string) {
  for (const box of boxes(data, parent.start, parent.end)) if (box.type === type) return box
  return undefined
}

/** A four-character code as text, when it is printable. */
function fourcc(data: Buffer, offset: number) {
  const value = data.toString('latin1', offset, offset + 4)
  return /^[\x20-\x7e]{4}$/.test(value) ? value : null
}

function readMoov(moov: Buffer): VideoDetails {
  const root: Box = { type: 'moov', start: 0, end: moov.length }
  const details: VideoDetails = { durationMs: null, width: null, height: null, videoCodec: null, audioCodec: null }
  const header = child(moov, root, 'mvhd')
  if (header) details.durationMs = movieDuration(moov, header)
  for (const trak of boxes(moov, root.start, root.end)) {
    if (trak.type !== 'trak') continue
    const mdia = child(moov, trak, 'mdia')
    const hdlr = mdia && child(moov, mdia, 'hdlr')
    if (!mdia || !hdlr || hdlr.end - hdlr.start < 12) continue
    const handler = moov.toString('latin1', hdlr.start + 8, hdlr.start + 12)
    const stbl = child(moov, child(moov, mdia, 'minf') ?? { type: '', start: 0, end: 0 }, 'stbl')
    const stsd = stbl && child(moov, stbl, 'stsd')
    // stsd: version and flags, entry count, then the first sample entry's size and format.
    const codec = stsd && stsd.end - stsd.start >= 16 ? fourcc(moov, stsd.start + 12) : null
    if (handler === 'vide' && details.videoCodec === null) {
      details.videoCodec = codec
      const tkhd = child(moov, trak, 'tkhd')
      if (tkhd) Object.assign(details, displaySize(moov, tkhd))
    } else if (handler === 'soun' && details.audioCodec === null) {
      details.audioCodec = codec
    }
  }
  return details
}

function movieDuration(data: Buffer, box: Box) {
  const version = data[box.start]
  const long = version === 1
  if (box.end - box.start < (long ? 32 : 20)) return null
  const timescale = data.readUInt32BE(box.start + (long ? 20 : 12))
  const duration = long ? Number(data.readBigUInt64BE(box.start + 24)) : data.readUInt32BE(box.start + 16)
  // Zero or all ones: the duration is not known (a fragmented file says it elsewhere).
  if (!timescale || !duration || duration === 0xffffffff || (long && duration >= Number.MAX_SAFE_INTEGER)) return null
  return Math.round(duration / timescale * 1000)
}

/** Width and height in pixels as shown: swapped when the track's matrix turns it a quarter. */
function displaySize(data: Buffer, box: Box) {
  const long = data[box.start] === 1
  const matrix = box.start + (long ? 52 : 40)
  const size = box.start + (long ? 88 : 76)
  if (box.end < size + 8) return {}
  const width = Math.floor(data.readUInt32BE(size) / 65_536)
  const height = Math.floor(data.readUInt32BE(size + 4) / 65_536)
  if (!width || !height) return {}
  const quarterTurn = data.readInt32BE(matrix) === 0 && data.readInt32BE(matrix + 16) === 0
  return quarterTurn ? { width: height, height: width } : { width, height }
}
