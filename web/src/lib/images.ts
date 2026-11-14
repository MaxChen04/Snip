import { api, type SavedImage } from "@/lib/api"

/** Image types the server accepts. SVG is excluded: it can carry script. */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"] as const
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024

const isImageType = (type: string) => (IMAGE_TYPES as readonly string[]).includes(type)

const THUMB_WIDTH = 800
const THUMB_MAX_HEIGHT = 2000
const PALETTE_SIDE = 64

/** Decode with createImageBitmap, or an <img> where that refuses the file. GIFs give their first frame. */
async function decode(file: File): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  try {
    const bmp = await createImageBitmap(file)
    return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() }
  } catch {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.src = url
    try {
      await img.decode()
    } catch (err) {
      URL.revokeObjectURL(url)
      throw err
    }
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) }
  }
}

const toBlob = (canvas: HTMLCanvasElement, type: string, quality: number) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality))

/**
 * Up to 6 distinct colours from RGBA pixels, most common first. Pixels are bucketed at 4 bits per channel,
 * each bucket averaged, and buckets too close to one already picked are skipped.
 */
export function paletteFrom(data: Uint8ClampedArray, max = 6): string[] {
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>()
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue
    const r = data[i], g = data[i + 1], b = data[i + 2]
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)
    const s = buckets.get(key)
    if (s) {
      s.n++
      s.r += r
      s.g += g
      s.b += b
    } else buckets.set(key, { n: 1, r, g, b })
  }
  const picked: [number, number, number][] = []
  for (const s of [...buckets.values()].sort((a, b) => b.n - a.n)) {
    const c: [number, number, number] = [Math.round(s.r / s.n), Math.round(s.g / s.n), Math.round(s.b / s.n)]
    // 40 apart in RGB: two shades of one colour read as one swatch.
    if (picked.some((p) => (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2 < 40 ** 2)) continue
    picked.push(c)
    if (picked.length === max) break
  }
  return picked.map((c) => `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`)
}

/** Natural size, a thumbnail at most 800 px wide (WebP, else JPEG) and a palette, all made in the browser. */
export async function prepareImage(file: File): Promise<{ thumb: Blob; width: number; height: number; palette: string[] }> {
  const img = await decode(file)
  try {
    const { width, height } = img
    if (!width || !height) throw new Error("Empty image")
    const scale = Math.min(1, THUMB_WIDTH / width)
    const canvas = document.createElement("canvas")
    canvas.width = Math.max(1, Math.round(width * scale))
    const fullHeight = Math.max(1, Math.round(height * scale))
    // A very tall screenshot keeps its top: tiles never show more than ~2.5× their width, and the server
    // refuses thumbnails over 2 MB.
    canvas.height = Math.min(fullHeight, THUMB_MAX_HEIGHT)
    const ctx = canvas.getContext("2d")
    if (!ctx) throw new Error("No canvas")
    ctx.drawImage(img.source, 0, 0, canvas.width, fullHeight)

    const small = document.createElement("canvas")
    const s = Math.min(1, PALETTE_SIDE / Math.max(canvas.width, canvas.height))
    small.width = Math.max(1, Math.round(canvas.width * s))
    small.height = Math.max(1, Math.round(canvas.height * s))
    const sctx = small.getContext("2d", { willReadFrequently: true })
    if (!sctx) throw new Error("No canvas")
    sctx.drawImage(canvas, 0, 0, small.width, small.height)
    const palette = paletteFrom(sctx.getImageData(0, 0, small.width, small.height).data)

    // Browsers that can't encode WebP hand back a PNG; fall back to JPEG on white (JPEG has no transparency).
    let thumb = await toBlob(canvas, "image/webp", 0.82)
    if (thumb?.type !== "image/webp") {
      ctx.globalCompositeOperation = "destination-over"
      ctx.fillStyle = "#fff"
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      thumb = await toBlob(canvas, "image/jpeg", 0.85)
    }
    if (!thumb) throw new Error("No thumbnail")
    return { thumb, width, height, palette }
  } finally {
    img.close()
  }
}

/** Upload images (at most 3 at a time), making each one's thumbnail and palette in the browser first. */
export async function uploadImages(
  files: File[],
  opts: { collectionId?: string; onProgress?: (done: number, total: number) => void } = {},
): Promise<{ uploaded: SavedImage[]; failed: { name: string; error: string }[] }> {
  const results: (SavedImage | undefined)[] = []
  const failed: { name: string; error: string }[] = []
  let next = 0
  let done = 0
  const one = async (file: File, i: number) => {
    try {
      if (!isImageType(file.type)) throw new Error("Only PNG, JPEG, WebP, GIF or AVIF images")
      if (file.size > MAX_IMAGE_BYTES) throw new Error(`Larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB`)
      const prepared = await prepareImage(file).catch(() => {
        throw new Error("Couldn't read this image")
      })
      results[i] = await api.uploadImage({ file, fileName: file.name, collectionId: opts.collectionId, ...prepared })
    } catch (err) {
      failed.push({ name: file.name, error: (err as Error).message })
    }
    opts.onProgress?.(++done, files.length)
  }
  const worker = async () => {
    while (next < files.length) {
      const i = next++
      await one(files[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, files.length) }, worker))
  // Keep the order they were chosen in, so a board can lay them out that way.
  return { uploaded: results.filter((r): r is SavedImage => !!r), failed }
}
