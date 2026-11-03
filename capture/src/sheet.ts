import type { Browser, BrowserContext } from "playwright"
import type { AnimationFrame, AnimationMeta } from "../../web/shared/types"
import type { SnipApi } from "./api"
import { pngSize, type Frame } from "./gif"

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

let ctx: BrowserContext | null = null
async function renderer(browser: Browser) {
  if (!ctx || !ctx.browser()?.isConnected()) ctx = await browser.newContext({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 })
  return ctx.newPage()
}

const dataUrl = (png: Buffer) => `data:image/png;base64,${png.toString("base64")}`
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)

/** Re-encode one PNG frame as JPEG at its own size. */
async function toJpeg(browser: Browser, png: Buffer, width: number, height: number) {
  const page = await renderer(browser)
  try {
    await page.setViewportSize({ width, height })
    await page.setContent(`<style>*{margin:0}img{display:block}</style><img src="${dataUrl(png)}" width="${width}" height="${height}">`)
    await page.locator("img").evaluate((img: HTMLImageElement) => img.decode())
    return await page.screenshot({ type: "jpeg", quality: 82 })
  } finally {
    await page.close()
  }
}

/** Tile frames into a labelled grid. Labels show order and playback time, plus measured offsets or scroll position when known. */
async function contactSheet(browser: Browser, frames: { png: Buffer; label: string }[], frameW: number, frameH: number) {
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
        `<figure><img src="${dataUrl(f.png)}" width="${cellW}" height="${cellH}"><figcaption>${esc(f.label)}</figcaption></figure>`,
    )
    .join("")
  const page = await renderer(browser)
  try {
    await page.setViewportSize({ width, height })
    await page.setContent(
      `<style>*{margin:0;box-sizing:border-box}body{display:grid;grid-template-columns:repeat(${columns},${cellW}px);background:#fff}
      figure{border:1px solid #ddd}img{display:block;object-fit:contain;background:#f4f4f4}
      figcaption{height:${labelH}px;font:12px/${labelH}px ui-monospace,Menlo,monospace;padding:0 6px;color:#111;background:#fafafa;white-space:nowrap;overflow:hidden}</style>${cells}`,
    )
    await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode())))
    const buf = await page.screenshot({ type: "jpeg", quality: 80 })
    return { buf, width, height, columns }
  } finally {
    await page.close()
  }
}

/**
 * Upload sampled frames and a contact sheet for one animation and return its metadata.
 * `frames` are the GIF's source frames (PNG, before GIF downscaling).
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
  const size = pngSize(frames[0]!.png)
  const picked = sampleIndexes(frames.length)
  const out: AnimationFrame[] = []
  const labelled: { png: Buffer; label: string }[] = []
  for (const [n, i] of picked.entries()) {
    const f = frames[i]!
    const fi = { captureOffsetMs: f.offsetMs ?? null, scrollY: f.scrollY ?? null, phase: f.phase ?? ("scroll" as const) }
    const own = pngSize(f.png)
    if (own.width !== size.width || own.height !== size.height) continue
    const key = await api.upload(`${keyPrefix}-f${n}.jpg`, await toJpeg(browser, f.png, size.width, size.height), "image/jpeg")
    out.push({ key, width: size.width, height: size.height, sourceIndex: i, playbackMs: starts[i]!, ...fi })
    const where = fi.scrollY != null ? ` y=${fi.scrollY}` : fi.captureOffsetMs != null ? ` +${fi.captureOffsetMs}ms` : ""
    labelled.push({ png: f.png, label: `#${n} ${fi.phase} play ${(starts[i]! / 1000).toFixed(2)}s${where}` })
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
