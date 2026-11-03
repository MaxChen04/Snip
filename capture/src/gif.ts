import gifenc from "gifenc"
const { GIFEncoder, applyPalette, quantize } = gifenc
import { PNG } from "pngjs"

export interface Frame {
  png: Buffer
  /** ms this frame stays on screen */
  delay: number
}

/** Decode a PNG, optionally downscaling by an integer factor (box filter). */
function decode(buf: Buffer, scale: number) {
  const png = PNG.sync.read(buf)
  if (scale <= 1) return { width: png.width, height: png.height, data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.length) }
  const w = Math.floor(png.width / scale)
  const h = Math.floor(png.height / scale)
  const out = new Uint8Array(w * h * 4)
  const src = png.data
  const n = scale * scale
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let dy = 0; dy < scale; dy++) {
        let i = ((y * scale + dy) * png.width + x * scale) * 4
        for (let dx = 0; dx < scale; dx++, i += 4) {
          r += src[i]!; g += src[i + 1]!; b += src[i + 2]!; a += src[i + 3]!
        }
      }
      const o = (y * w + x) * 4
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n
    }
  }
  return { width: w, height: h, data: out }
}

export function encodeGif(frames: Frame[], opts: { scale?: number } = {}) {
  const gif = GIFEncoder()
  let width = 0
  let height = 0
  for (const f of frames) {
    const img = decode(f.png, opts.scale ?? 1)
    if (!width) {
      width = img.width
      height = img.height
    }
    if (img.width !== width || img.height !== height) continue
    const palette = quantize(img.data, 256, { format: "rgb565" })
    const index = applyPalette(img.data, palette, "rgb565")
    gif.writeFrame(index, width, height, { palette, delay: Math.max(20, Math.round(f.delay)) })
  }
  gif.finish()
  return { bytes: Buffer.from(gif.bytes()), width, height }
}
