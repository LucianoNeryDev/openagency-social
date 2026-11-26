/** Builds small MP4 files with the boxes src/mp4.ts reads, for tests. */
export function box(type: string, ...payload: Buffer[]) {
  const body = Buffer.concat(payload)
  const head = Buffer.alloc(8)
  head.writeUInt32BE(8 + body.length)
  head.write(type, 4, 'latin1')
  return Buffer.concat([head, body])
}

const u32 = (...values: number[]) => {
  const buffer = Buffer.alloc(4 * values.length)
  values.forEach((value, index) => buffer.writeInt32BE(value | 0, index * 4))
  return buffer
}

function mvhd(durationMs: number, timescale: number, version: 0 | 1) {
  const duration = Math.round(durationMs / 1000 * timescale)
  if (version === 1) {
    const times = Buffer.alloc(16)
    const length = Buffer.alloc(8)
    length.writeBigUInt64BE(BigInt(duration))
    return box('mvhd', Buffer.from([1, 0, 0, 0]), times, u32(timescale), length, Buffer.alloc(80))
  }
  return box('mvhd', Buffer.from([0, 0, 0, 0]), u32(0, 0, timescale, duration), Buffer.alloc(80))
}

function tkhd(width: number, height: number, rotate: boolean) {
  // Identity, or a quarter turn (a vertical phone video stored landscape).
  const matrix = rotate ? u32(0, 0x10000, 0, -0x10000, 0, 0, 0, 0, 0x40000000) : u32(0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000)
  return box('tkhd', Buffer.from([0, 0, 0, 3]), u32(0, 0, 1, 0, 0), Buffer.alloc(8), Buffer.alloc(8), matrix, u32(width * 0x10000, height * 0x10000))
}

function trak(handler: 'vide' | 'soun', codec: string, size?: { width: number, height: number, rotate: boolean }) {
  const hdlr = box('hdlr', Buffer.alloc(8), Buffer.from(handler, 'latin1'), Buffer.alloc(13))
  const entry = Buffer.concat([u32(16), Buffer.from(codec, 'latin1'), Buffer.alloc(8)])
  const stsd = box('stsd', Buffer.alloc(4), u32(1), entry)
  return box('trak', ...(size ? [tkhd(size.width, size.height, size.rotate)] : []), box('mdia', hdlr, box('minf', box('stbl', stsd))))
}

export interface Mp4Options {
  durationMs?: number
  width?: number
  height?: number
  rotate?: boolean
  videoCodec?: string | null
  audioCodec?: string | null
  /** `moov` after the media data, as encoders write it without "fast start". */
  moovLast?: boolean
  mdatBytes?: number
  /** The media data box with a 64-bit size. */
  largeMdat?: boolean
  timescale?: number
  version?: 0 | 1
}

export function mp4(options: Mp4Options = {}) {
  const { durationMs = 20_000, width = 1080, height = 1920, rotate = false, videoCodec = 'avc1', audioCodec = 'mp4a' } = options
  const tracks = [
    ...(videoCodec ? [trak('vide', videoCodec, { width, height, rotate })] : []),
    ...(audioCodec ? [trak('soun', audioCodec)] : []),
  ]
  const moov = box('moov', mvhd(durationMs, options.timescale ?? 600, options.version ?? 0), ...tracks)
  const data = Buffer.alloc(options.mdatBytes ?? 64, 7)
  const mdat = options.largeMdat
    ? Buffer.concat([u32(1), Buffer.from('mdat'), (() => { const size = Buffer.alloc(8); size.writeBigUInt64BE(BigInt(16 + data.length)); return size })(), data])
    : box('mdat', data)
  const ftyp = box('ftyp', Buffer.from('isom', 'latin1'), u32(512), Buffer.from('isomiso2avc1mp41', 'latin1'))
  return Buffer.concat(options.moovLast ? [ftyp, mdat, moov] : [ftyp, moov, mdat])
}
