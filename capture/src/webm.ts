// A minimal WebM (Matroska) muxer for one video track, enough for browsers to play, loop and seek.
// Layout: EBML header, then a Segment with Info (duration), Tracks, one Cluster per keyframe and Cues.

export interface EncodedFrame {
  data: Buffer
  /** Start time in microseconds. */
  timestamp: number
  key: boolean
}

type Child = Buffer | Buffer[]

/** A WebCodecs VideoColorSpace. Without it in the file, players guess and colours shift. */
export interface ColorSpace {
  matrix?: string | null
  primaries?: string | null
  transfer?: string | null
  fullRange?: boolean | null
}

// WebCodecs names to the ISO/IEC 23091-4 code points Matroska uses.
const MATRIX: Record<string, number> = { rgb: 0, bt709: 1, bt470bg: 5, smpte170m: 6, "bt2020-ncl": 9 }
const PRIMARIES: Record<string, number> = { bt709: 1, bt470bg: 5, smpte170m: 6, bt2020: 9, smpte432: 12 }
const TRANSFER: Record<string, number> = { bt709: 1, smpte170m: 6, linear: 8, "iec61966-2-1": 13, pq: 16, hlg: 18 }

/** EBML variable-length size, in the shortest form that fits. */
function vsize(n: number) {
  for (let w = 1; w <= 8; w++) {
    if (n < 2 ** (7 * w) - 1) {
      const b = Buffer.alloc(w)
      let v = n
      for (let i = w - 1; i >= 0; i--) {
        b[i] = v % 256
        v = Math.floor(v / 256)
      }
      b[0]! |= 1 << (8 - w)
      return b
    }
  }
  throw new Error("EBML element too large")
}

function idBytes(id: number) {
  const hex = id.toString(16)
  return Buffer.from(hex.length % 2 ? `0${hex}` : hex, "hex")
}

const el = (id: number, ...children: Child[]) => {
  const body = Buffer.concat(children.flat())
  return Buffer.concat([idBytes(id), vsize(body.length), body])
}

const uint = (id: number, n: number) => {
  const bytes: number[] = []
  let v = Math.max(0, Math.round(n))
  do {
    bytes.unshift(v % 256)
    v = Math.floor(v / 256)
  } while (v > 0)
  return el(id, Buffer.from(bytes))
}

const float = (id: number, n: number) => {
  const b = Buffer.alloc(8)
  b.writeDoubleBE(n)
  return el(id, b)
}

/** Signed integer, two's complement, in the fewest bytes. */
const int = (id: number, n: number) => {
  let w = 1
  while (w < 6 && (n < -(2 ** (8 * w - 1)) || n >= 2 ** (8 * w - 1))) w++
  const b = Buffer.alloc(w)
  b.writeIntBE(n, 0, w)
  return el(id, b)
}

const str = (id: number, s: string) => el(id, Buffer.from(s, "utf8"))

function colour(cs: ColorSpace | null | undefined) {
  if (!cs) return []
  const fields: Buffer[] = []
  const code = (id: number, table: Record<string, number>, name?: string | null) => {
    if (name && name in table) fields.push(uint(id, table[name]!))
  }
  code(ID.MatrixCoefficients, MATRIX, cs.matrix)
  if (cs.fullRange != null) fields.push(uint(ID.Range, cs.fullRange ? 2 : 1))
  code(ID.TransferCharacteristics, TRANSFER, cs.transfer)
  code(ID.Primaries, PRIMARIES, cs.primaries)
  return fields.length ? [el(ID.Colour, ...fields)] : []
}

/** One block: track 1, timestamp relative to its cluster (signed 16-bit ms), flags, frame data. */
const block = (relMs: number, flags: number, data: Buffer) => {
  const head = Buffer.alloc(4)
  head[0] = 0x81
  head.writeInt16BE(relMs, 1)
  head[3] = flags
  return Buffer.concat([head, data])
}

const ID = {
  EBML: 0x1a45dfa3, EBMLVersion: 0x4286, EBMLReadVersion: 0x42f7, EBMLMaxIDLength: 0x42f2, EBMLMaxSizeLength: 0x42f3,
  DocType: 0x4282, DocTypeVersion: 0x4287, DocTypeReadVersion: 0x4285,
  Segment: 0x18538067, Info: 0x1549a966, TimestampScale: 0x2ad7b1, Duration: 0x4489, MuxingApp: 0x4d80, WritingApp: 0x5741,
  Tracks: 0x1654ae6b, TrackEntry: 0xae, TrackNumber: 0xd7, TrackUID: 0x73c5, TrackType: 0x83, FlagLacing: 0x9c, CodecID: 0x86,
  Video: 0xe0, PixelWidth: 0xb0, PixelHeight: 0xba,
  Colour: 0x55b0, MatrixCoefficients: 0x55b1, Range: 0x55b9, TransferCharacteristics: 0x55ba, Primaries: 0x55bb,
  Cluster: 0x1f43b675, Timestamp: 0xe7, SimpleBlock: 0xa3, BlockGroup: 0xa0, Block: 0xa1, BlockDuration: 0x9b, ReferenceBlock: 0xfb,
  Cues: 0x1c53bb6b, CuePoint: 0xbb, CueTime: 0xb3, CueTrackPositions: 0xb7, CueTrack: 0xf7, CueClusterPosition: 0xf1,
}

/**
 * Mux encoded frames (in presentation order, first one a keyframe) into a WebM file. Frames run until the
 * next one starts; the last runs to `durationMs`, which is written as the file's duration so the final frame
 * holds before the video loops.
 */
export function muxWebm(opts: { width: number; height: number; frames: EncodedFrame[]; durationMs: number; colorSpace?: ColorSpace | null }) {
  const { frames } = opts
  if (!frames.length || !frames[0]!.key) throw new Error("A WebM needs at least one frame, starting with a keyframe")
  const ms = (us: number) => Math.round(us / 1000)
  const header = el(ID.EBML,
    uint(ID.EBMLVersion, 1), uint(ID.EBMLReadVersion, 1), uint(ID.EBMLMaxIDLength, 4), uint(ID.EBMLMaxSizeLength, 8),
    str(ID.DocType, "webm"), uint(ID.DocTypeVersion, 4), uint(ID.DocTypeReadVersion, 2))
  const info = el(ID.Info, uint(ID.TimestampScale, 1_000_000), float(ID.Duration, opts.durationMs), str(ID.MuxingApp, "snip"), str(ID.WritingApp, "snip"))
  const tracks = el(ID.Tracks, el(ID.TrackEntry,
    uint(ID.TrackNumber, 1), uint(ID.TrackUID, 1), uint(ID.TrackType, 1), uint(ID.FlagLacing, 0), str(ID.CodecID, "V_VP9"),
    el(ID.Video, uint(ID.PixelWidth, opts.width), uint(ID.PixelHeight, opts.height), colour(opts.colorSpace))))

  // A new cluster at every keyframe, and before a block's offset would overflow 16 bits.
  const clusters: { start: number; key: boolean; blocks: Buffer[] }[] = []
  for (const [i, f] of frames.entries()) {
    const t = ms(f.timestamp)
    const current = clusters.at(-1)
    if (!current || f.key || t - current.start > 30_000) clusters.push({ start: t, key: f.key, blocks: [] })
    const c = clusters.at(-1)!
    if (i === frames.length - 1) {
      // The last frame says how long it lasts, so players hold it to the end instead of guessing. A BlockGroup
      // without a ReferenceBlock is a keyframe, so a delta frame names the frame before it.
      const duration = Math.max(1, Math.round(opts.durationMs) - t)
      const prev = i > 0 ? ms(frames[i - 1]!.timestamp) - t : 0
      c.blocks.push(el(ID.BlockGroup, el(ID.Block, block(t - c.start, 0, f.data)), uint(ID.BlockDuration, duration), ...(f.key ? [] : [int(ID.ReferenceBlock, prev)])))
    } else c.blocks.push(el(ID.SimpleBlock, block(t - c.start, f.key ? 0x80 : 0, f.data)))
  }
  const clusterBufs = clusters.map((c) => el(ID.Cluster, uint(ID.Timestamp, c.start), ...c.blocks))

  // Cues point at clusters that start with a keyframe, relative to the start of the Segment's data.
  let offset = info.length + tracks.length
  const cues: Buffer[] = []
  for (const [i, c] of clusters.entries()) {
    if (c.key) cues.push(el(ID.CuePoint, uint(ID.CueTime, c.start), el(ID.CueTrackPositions, uint(ID.CueTrack, 1), uint(ID.CueClusterPosition, offset))))
    offset += clusterBufs[i]!.length
  }
  return Buffer.concat([header, el(ID.Segment, info, tracks, ...clusterBufs, el(ID.Cues, ...cues))])
}
