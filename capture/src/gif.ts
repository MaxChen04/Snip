import sharp from "sharp"

// Every frame is a new image, so libvips' cache would only hold memory. One thread per frame: frames are
// encoded one at a time, and more threads would only add scheduling overhead.
sharp.cache(false)
sharp.concurrency(1)

export interface Frame {
  /** Absent once a scroll frame has been streamed into its GIF; those frames keep a `still` where sampled. */
  png?: Buffer
  /** ms this frame stays on screen */
  delay: number
  /** Measured ms since recording started, where known. */
  offsetMs?: number
  /** window.scrollY when the frame was taken (scroll recordings). */
  scrollY?: number
  phase?: "rest" | "enter" | "hold" | "leave" | "scroll"
  /** Full-size JPEG of this moment, taken live for the scroll frames a contact sheet samples. */
  still?: { jpeg: Buffer; width: number; height: number }
}

/** Width and height from a PNG header. */
export const pngSize = (buf: Buffer) => ({ width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) })

/**
 * Builds a looping GIF from PNG frames as they arrive. libvips downscales, quantizes (libimagequant) and
 * compresses each frame natively on a worker thread, about twice as fast as doing it in JavaScript and with a
 * better palette. Its one-frame GIFs are spliced into the animation, so nothing but the output is kept.
 * Await each add() before the next: frames go in the order they finish.
 */
export function gifWriter(opts: { scale?: number } = {}) {
  const scale = Math.max(1, opts.scale ?? 1)
  const parts: Buffer[] = []
  let width = 0
  let height = 0
  return {
    async add(png: Buffer, delay: number) {
      const size = pngSize(png)
      const w = Math.floor(size.width / scale)
      const h = Math.floor(size.height / scale)
      if (width && (w !== width || h !== height)) return
      const image = scale > 1 ? sharp(png).resize(w, h, { kernel: "linear" }) : sharp(png)
      const block = imageBlock(await image.gif({ effort: 1, dither: 0 }).toBuffer())
      if (!width) {
        width = w
        height = h
        parts.push(header(w, h))
      }
      parts.push(control(delay), block)
    },
    finish() {
      return { bytes: Buffer.concat([...parts, Buffer.from([0x3b])]), width, height }
    },
  }
}

export async function encodeGif(frames: Frame[], opts: { scale?: number } = {}) {
  const writer = gifWriter(opts)
  for (const f of frames) await writer.add(f.png!, f.delay)
  return writer.finish()
}

/** GIF89a header, a screen with no shared palette, and the loop-forever extension. */
function header(width: number, height: number) {
  const b = Buffer.alloc(32)
  b.write("GIF89a", 0, "latin1")
  b.writeUInt16LE(width, 6)
  b.writeUInt16LE(height, 8)
  b[10] = 0x70
  b.set([0x21, 0xff, 0x0b], 13)
  b.write("NETSCAPE2.0", 16, "latin1")
  b.set([0x03, 0x01, 0x00, 0x00, 0x00], 27)
  return b
}

/** Graphics control extension: how long the next frame stays up, in hundredths of a second. */
function control(ms: number) {
  const b = Buffer.from([0x21, 0xf9, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00])
  b.writeUInt16LE(Math.round(Math.max(20, Math.round(ms)) / 10), 4)
  return b
}

/** The image of a one-frame GIF (descriptor, palette, compressed pixels), with a shared palette made its own. */
function imageBlock(gif: Buffer) {
  const flags = gif[10]!
  const shared = flags & 0x80 ? gif.subarray(13, 13 + (3 << ((flags & 7) + 1))) : null
  let at = 13 + (shared?.length ?? 0)
  while (gif[at] === 0x21) { // extension: introducer, label, then data sub-blocks up to a zero-length one
    at += 2
    while (gif[at]) at += gif[at]! + 1
    at++
  }
  if (gif[at] !== 0x2c) throw new Error("Unexpected GIF layout from libvips")
  const descriptor = Buffer.from(gif.subarray(at, at + 10))
  const own = descriptor[9]! & 0x80
  if (!own && !shared) throw new Error("GIF frame has no palette")
  let end = at + 10 + (own ? 3 << ((descriptor[9]! & 7) + 1) : 0) + 1 // past any palette and the LZW code size
  while (gif[end]) end += gif[end]! + 1
  end++
  if (gif[end] === 0x2c) throw new Error("libvips split a frame into several images")
  if (!own) descriptor[9] = (descriptor[9]! & 0x40) | 0x80 | (flags & 7) // keep interlacing, attach the palette
  return Buffer.concat(own ? [descriptor, gif.subarray(at + 10, end)] : [descriptor, shared!, gif.subarray(at + 10, end)])
}
