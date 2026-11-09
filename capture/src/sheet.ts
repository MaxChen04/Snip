import type { Browser, Page } from "playwright"
import type { AnimationFrame, AnimationMeta } from "../../web/shared/types"
import type { SnipApi } from "./api"
import { imageSize, type Frame } from "./gif"

// Still representations of an animation, for models that can't watch a GIF (many only read the first frame).
// Frames are sampled uniformly; the count and sheet width are settings to evaluate, not a proven recipe.
const SHEET_FRAMES = Math.min(16, Math.max(2, Number(process.env.SHEET_FRAMES ?? 9)))
const SHEET_WIDTH = Math.max(600, Number(process.env.SHEET_WIDTH ?? 1536))
const SHEET_COLUMNS = 3

/** Evenly spaced indexes that always include the first and last frame. */
export function sampleIndexes(n: number, k = SHEET_FRAMES) {
  if (n <= k) return [...Array(n).keys()]
  return [...new Set(Array.from({ length: k }, (_, i) => Math.round((i * (n - 1)) / (k - 1))))]
}

/** Frames to make stills from. Recordings with full-size stills only have them where a sample was planned: use the nearest. */
export function pickStills(frames: Frame[]) {
  const withStill = frames.flatMap((f, i) => (f.still ? [i] : []))
  const nearest = (i: number) => (withStill.length ? withStill.reduce((a, b) => (Math.abs(b - i) < Math.abs(a - i) ? b : a)) : i)
  return [...new Set(sampleIndexes(frames.length).map(nearest))]
}

// One helper page renders every still and contact sheet and encodes recordings (video.ts). A page per image
// started a renderer process each time. It is served at http://localhost/ (answered here, never fetched) so it
// is a secure context, which WebCodecs needs.
const HELPER_URL = "http://localhost/snip-helper"
let rendererPage: Page | null = null
export async function renderer(browser: Browser) {
  if (rendererPage && !rendererPage.isClosed() && rendererPage.context().browser() === browser && browser.isConnected()) return rendererPage
  const ctx = await browser.newContext({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 })
  const page = await ctx.newPage()
  await page.route(HELPER_URL, (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>snip</title>" }))
  await page.goto(HELPER_URL)
  rendererPage = page
  return page
}

/** Close the helper page once a page's stills are done, so its process doesn't idle through the next capture. */
export async function closeRenderer() {
  const page = rendererPage
  rendererPage = null
  await page?.context().close().catch(() => {})
}

const dataUrl = (image: Buffer) => `data:image/${image[0] === 0xff ? "jpeg" : "png"};base64,${image.toString("base64")}`
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)

/** Re-encode same-size PNG frames as JPEGs: decode them in one document, then show and capture each in turn. */
async function toJpegs(browser: Browser, pngs: Buffer[], width: number, height: number) {
  if (!pngs.length) return []
  const page = await renderer(browser)
  await page.setViewportSize({ width, height })
  await page.setContent(`<style>*{margin:0}img{display:block;position:fixed;top:0;left:0;visibility:hidden}</style>${pngs.map((png) => `<img src="${dataUrl(png)}" width="${width}" height="${height}">`).join("")}`)
  await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode())))
  const out: Buffer[] = []
  for (let i = 0; i < pngs.length; i++) {
    await page.evaluate((shown) => [...document.images].forEach((img, n) => { img.style.visibility = n === shown ? "visible" : "hidden" }), i)
    out.push(await page.screenshot({ type: "jpeg", quality: 82 }))
  }
  return out
}

/** Tile frames into a labelled grid. Labels show order and playback time, plus measured offsets or scroll position when known. */
async function contactSheet(browser: Browser, frames: { image: Buffer; label: string }[], frameW: number, frameH: number) {
  const columns = Math.min(SHEET_COLUMNS, frames.length)
  const cellW = Math.min(frameW, Math.floor(SHEET_WIDTH / columns)) // never upscale small hover crops
  const cellH = Math.round((cellW * frameH) / frameW)
  const labelH = 22
  const rows = Math.ceil(frames.length / columns)
  const width = cellW * columns
  const height = rows * (cellH + labelH)
  const cells = frames
    .map(
      (f) =>
        `<figure><img src="${dataUrl(f.image)}" width="${cellW}" height="${cellH}"><figcaption>${esc(f.label)}</figcaption></figure>`,
    )
    .join("")
  const page = await renderer(browser)
  await page.setViewportSize({ width, height })
  await page.setContent(
    `<style>*{margin:0;box-sizing:border-box}body{display:grid;grid-template-columns:repeat(${columns},${cellW}px);background:#fff}
    figure{border:1px solid #ddd}img{display:block;object-fit:contain;background:#f4f4f4}
    figcaption{height:${labelH}px;font:12px/${labelH}px ui-monospace,Menlo,monospace;padding:0 6px;color:#111;background:#fafafa;white-space:nowrap;overflow:hidden}</style>${cells}`,
  )
  await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode())))
  const buf = await page.screenshot({ type: "jpeg", quality: 80 })
  await page.setContent("") // drop the decoded frames until the next animation
  return { buf, width, height, columns }
}

/**
 * Upload sampled frames and a contact sheet for one animation and return its metadata.
 * `frames` are the GIF's source frames; a frame's `still`, when present, is its full-size image.
 */
export async function buildStills(
  browser: Browser,
  api: SnipApi,
  keyPrefix: string,
  frames: Frame[],
  timing: AnimationMeta["timing"],
  observedStyles: Record<string, string> | null,
): Promise<{ sheetKey: string | null; meta: AnimationMeta }> {
  const starts: number[] = []
  let t = 0
  for (const f of frames) {
    starts.push(t)
    t += Math.max(20, Math.round(f.delay))
  }
  const picked = pickStills(frames)
  const sizeOf = (f: Frame) => f.still ?? imageSize(f.png!) // frames without a png always carry a still
  const size = sizeOf(frames[picked[0]!]!)
  const fits = (f: Frame) => sizeOf(f).width === size.width && sizeOf(f).height === size.height
  const convert = picked.filter((i) => fits(frames[i]!) && !frames[i]!.still)
  const converted = await toJpegs(browser, convert.map((i) => frames[i]!.png!), size.width, size.height)
  const jpegs = new Map(convert.map((i, k) => [i, converted[k]!]))
  const out: AnimationFrame[] = []
  const labelled: { image: Buffer; label: string }[] = []
  for (const [n, i] of picked.entries()) {
    const f = frames[i]!
    const fi = { captureOffsetMs: f.offsetMs ?? null, scrollY: f.scrollY ?? null, phase: f.phase ?? ("scroll" as const) }
    if (!fits(f)) continue
    const jpeg = f.still?.jpeg ?? jpegs.get(i)!
    const key = await api.upload(`${keyPrefix}-f${n}.jpg`, jpeg, "image/jpeg")
    out.push({ key, width: size.width, height: size.height, sourceIndex: i, playbackMs: starts[i]!, ...fi })
    const where = fi.scrollY != null ? ` y=${fi.scrollY}` : fi.captureOffsetMs != null ? ` +${fi.captureOffsetMs}ms` : ""
    labelled.push({ image: f.still?.jpeg ?? f.png!, label: `#${n} ${fi.phase} play ${(starts[i]! / 1000).toFixed(2)}s${where}` })
  }
  let sheetKey: string | null = null
  let sheet: AnimationMeta["sheet"] = null
  if (labelled.length > 1) {
    const s = await contactSheet(browser, labelled, size.width, size.height)
    sheetKey = await api.upload(`${keyPrefix}-sheet.jpg`, s.buf, "image/jpeg")
    sheet = { width: s.width, height: s.height, columns: s.columns }
  }
  return {
    sheetKey,
    meta: { version: 1, frameCount: frames.length, playbackMs: t, timing, frames: out, sheet, observedStyles },
  }
}

/**
 * Cut a full-page screenshot into horizontal bands (page sections), as JPEGs. The screenshot is decoded once in
 * the helper page and each band drawn from it, which is far cheaper than asking the captured page to re-render
 * its full height for every section. Bands are in the screenshot's pixels; any past its bottom are clipped.
 */
export async function cropBands(browser: Browser, jpeg: Buffer, bands: { y: number; height: number }[]): Promise<Buffer[]> {
  if (!bands.length) return []
  const page = await renderer(browser)
  try {
    const out = await page.evaluate(async ({ src, bands }) => {
      const img = new Image()
      img.src = src
      await img.decode()
      const canvas = document.createElement("canvas")
      const ctx = canvas.getContext("2d")!
      const parts: string[] = []
      for (const b of bands) {
        const h = Math.max(1, Math.min(b.height, img.naturalHeight - b.y))
        canvas.width = img.naturalWidth
        canvas.height = h
        ctx.drawImage(img, 0, b.y, img.naturalWidth, h, 0, 0, img.naturalWidth, h)
        parts.push(canvas.toDataURL("image/jpeg", 0.8).slice("data:image/jpeg;base64,".length))
      }
      return parts
    }, { src: dataUrl(jpeg), bands })
    return out.map((b64) => Buffer.from(b64, "base64"))
  } finally {
    await page.setContent("").catch(() => {})
  }
}
