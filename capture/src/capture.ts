import { existsSync, readFileSync } from "node:fs"
import sharp from "sharp"
import type { Browser, BrowserContext, BrowserContextOptions, CDPSession, Page as PwPage } from "playwright"
import type { CrawlState, DesignTokens, Job, MotionEntry, PageSection, PageUpload } from "../../web/shared/types"
import { JobGoneError, uploadText, type SnipApi } from "./api"
import { imageSize, type Frame } from "./gif"
import { allowPrivateUrls, assertPublicUrl, createCaptureNetwork, PrivateAddressError } from "./network-guard"
import { buildStills, closeRenderer, cropBands, sampleIndexes } from "./sheet"
import { pageText, TEXT_LIMITS, type TextBlock } from "./text"
import { encodeRecording, recordingWriter, type Recording } from "./video"

// In-page scripts live in plain .js files so the TS toolchain can't inject helpers into them.
const script = (name: string) => readFileSync(new URL(`./inpage/${name}.js`, import.meta.url), "utf8")
const STYLES_JS = script("styles")
const SNAPSHOT_JS = script("snapshot")
const HOVER_JS = script("hover-targets")
const META_JS = script("meta")
const DISMISS_JS = script("dismiss")
const TRANSITION_JS = script("transition-ms")
const SECTIONS_JS = script("sections")
const MOTION_JS = script("motion")
const TEXT_JS = script("text")
const MAX_SECTIONS = 24
// Live section clips: a section is recorded only if two stills taken LIVE_PROBE_MS apart differ.
const LIVE_SECTIONS = process.env.SNIP_LIVE_SECTIONS !== "false"
const MAX_LIVE = Math.max(0, Number(process.env.SNIP_LIVE_MAX ?? 8))
const LIVE_MS = Math.min(8000, Math.max(1000, Number(process.env.SNIP_LIVE_MS ?? 3000)))
const LIVE_PROBE_MS = 400
const LIVE_RECHECK_MS = 900 // further watching of a section that kept repainting but had not changed yet (see recordLiveSections)
const LIVE_BUSY_FRAMES = 4 // frames in the probe window that count as repainting: a one-off repaint (a transition ending) sends two or three
const LIVE_FRAME_MS = 33 // ~30 fps; the screencast is asked for every second frame of up to ~60
const LIVE_SETTLE_MS = Math.max(0, Number(process.env.SNIP_LIVE_SETTLE_MS ?? 400)) // longest wait for one-shot animations (scroll reveals) to finish before probing
const LIVE_MIN_CHANGED = 0.002 // share of a section's pixels that must change between probe frames (a caret is far less)
// A moving section up to this many viewports tall is recorded whole, in a viewport grown to fit it.
// ponytail: fixed cap; taller sections keep a viewport-high clip over a still remainder. Raise it if clips stay in budget.
const LIVE_TALL = Math.max(1, Number(process.env.SNIP_LIVE_TALL ?? 1.5))
const LIVE_QUIET_MS = 1000 // no frame for this long before the window ends: the motion stopped, so it doesn't loop
const LIVE_QUANTIZER = Math.min(63, Math.max(0, Number(process.env.SNIP_LIVE_QUANTIZER ?? 40)))
const LIVE_CLIP_BYTES = Math.max(100_000, Number(process.env.SNIP_LIVE_CLIP_BYTES ?? 2_500_000))
const LIVE_PAGE_BYTES = Math.max(100_000, Number(process.env.SNIP_LIVE_PAGE_BYTES ?? 8_000_000))
const OTHER_SCHEME_CHANGED = 0.15 // share of the viewport that must change when the color scheme flips: the page has a theme for it
const IN_VIEW_CHANGED = 0.02 // share of a section that must differ in view from the full-page shot to patch it in
const IN_VIEW_EXTRA = 3 // further frames down a tall section that is patched
const LIVE_CRAWL_PAGES = Math.max(0, Number(process.env.SNIP_LIVE_PAGES ?? 20)) // pages of a crawl that get clips
// Pages without clips (later crawl pages, the mobile shot) still get in-view patches, from one still per section.
const IN_VIEW_PATCH = process.env.SNIP_INVIEW_PATCH !== "false"
const DISMISS_POPUPS = process.env.DISMISS_POPUPS !== "false"
const run = <T>(page: PwPage, source: string, arg?: unknown) => page.evaluate(`(${source})(${JSON.stringify(arg ?? null)})`) as Promise<T>

const DESKTOP = { width: 1440, height: 900 }
const MOBILE = { width: 390, height: 844 }
const MOBILE_DPR = 1.5
const MAX_SHOT_PX = 16000 // Chromium texture limit for full-page screenshots
// Gallery thumbnails render 230-600 css px wide (950 device px at 2x on the large grid); the mobile one is a ~210 css px tall inset.
const THUMB_WIDTH = { desktop: 960, mobile: 320 }
const thumbnail = (jpeg: Buffer, width: number) => sharp(jpeg).resize({ width, withoutEnlargement: true }).jpeg({ quality: 75 }).toBuffer()
// Scroll recording: frames are captured at fixed scroll increments and played back at a fixed rate,
// so playback is smooth no matter how long each screenshot took.
const SCROLL_FPS = Math.min(50, Math.max(5, Number(process.env.SCROLL_FPS ?? 30)))
const SCROLL_STEP = Math.max(8, Number(process.env.SCROLL_STEP ?? 40)) // px per frame at 1440 wide
const MAX_SCROLL_FRAMES = Math.max(20, Number(process.env.SCROLL_MAX_FRAMES ?? 360))
const SCROLL_SCALE = 2 // scroll recordings are half the viewport size
const FRAME_JPEG_QUALITY = 97 // scroll frames for video, see recordScroll
const FIRST_FRAME_MS = 700 // beat at the top before it starts moving
const LAST_FRAME_MS = 1200
const MAX_HOVERS = 6
const HOVER_FRAME_MS = 33
// Hover recording windows. Each phase records at least as long as the CSS transitions on the target and its
// children say it lasts, then keeps going while frames still change (JS-driven effects), up to the cap.
const HOVER_SETTLE_MS = 120 // pointer moved away before recording; resting effects have mostly finished
const HOVER_ENTER = { min: 300, max: 900 }
const HOVER_LEAVE = { min: 250, max: 600 }
const HOVER_QUIET_MS = 150 // no new frame for this long after the minimum: the effect has finished
const HOVER_CSS_PAD_MS = 150
const MAX_SAVED_QUEUE = 2000 // URLs kept when a crawl pauses
// Same text as STOPPED_EMPTY in web/shared/capture-errors.ts. Released apps ship capture/src without
// web/shared, so the agent may only import types from there.
const STOPPED_EMPTY = "Stopped before any pages were captured"
const FONT_BUDGET = 4_000_000

const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a)

const sameSite = (a: URL, b: URL) => a.hostname.replace(/^www\./, "") === b.hostname.replace(/^www\./, "")
const SKIP_EXT = /\.(pdf|zip|png|jpe?g|gif|webp|svg|mp4|mov|webm|mp3|wav|dmg|exe|xml|json|txt|csv|ico|woff2?|ttf|rss)$/i

function normalize(href: string, root: URL): string | null {
  try {
    const u = new URL(href)
    if (u.protocol !== "http:" && u.protocol !== "https:") return null
    if (!sameSite(u, root)) return null
    if (SKIP_EXT.test(u.pathname)) return null
    u.hash = ""
    u.search = ""
    u.protocol = root.protocol
    u.hostname = root.hostname
    if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "")
    return u.href
  } catch {
    return null
  }
}

const LOW_VALUE = /^\/(log-?(in|out)|sign-?(in|up)|register|dashboard|account|cart|checkout|legal|careers|jobs|new|(terms|privacy|cookies?)[\w-]*)(\/|$)/i
// Only the top-level page itself: /customers is boosted, its case studies under /customers/x are not.
const HIGH_VALUE = /^\/(pricing|enterprise|products?|features|about|customers|solutions)\/?$/i

/**
 * A page's links in the order to capture them, so a crawl that hits max_pages has seen the pages worth
 * keeping: well-known pages first, login/legal/careers pages last (but still queued), then nav/header/footer
 * links before the rest and shallow paths before deep ones. Ties keep DOM order.
 */
export function rankLinks<L extends { href: string; nav: boolean }>(links: L[]): L[] {
  const score = ({ href, nav }: L) => {
    const path = new URL(href).pathname
    return tierOf(href) * 1000 + (nav ? 0 : 100) + Math.min(path.split("/").filter(Boolean).length, 99)
  }
  return links.map((l) => ({ l, s: score(l) })).sort((a, b) => a.s - b.s).map(({ l }) => l)
}

/** 0 for well-known pages, 2 for login/legal/careers pages, 1 otherwise. */
const tierOf = (href: string) => {
  const path = new URL(href).pathname
  return LOW_VALUE.test(path) ? 2 : HIGH_VALUE.test(path) ? 0 : 1
}

/**
 * The queue once the first page's links are known: those links, already ranked, go ahead of everything queued
 * so far (a sitemap's order says little about which pages matter) and the rest follows in its old order.
 * A link that is already queued moves up from its place. Visited URLs are never added. Low-value links stay
 * behind the other queued pages, or go last if they were not queued.
 */
export function promoteLinks(queue: string[], links: string[], visited: string[]): string[] {
  const fresh = [...new Set(links)].filter((u) => !visited.includes(u))
  const front = fresh.filter((u) => tierOf(u) < 2)
  const moved = new Set(front)
  const rest = queue.filter((u) => !moved.has(u))
  const queued = new Set(rest)
  return [...front, ...rest, ...fresh.filter((u) => tierOf(u) === 2 && !queued.has(u))]
}

/** The host a page ended up on if it redirected off the site, else null. */
export function leftSite(finalUrl: string, root: URL): string | null {
  try {
    const u = new URL(finalUrl)
    return /^https?:$/.test(u.protocol) && !sameSite(u, root) ? u.hostname : null
  } catch {
    return null
  }
}

/** Why a crawled link is not a page of the site (it errored, or redirected off it), or null. */
export function skipReason(finalUrl: string, status: number | null, root: URL): string | null {
  if (status !== null && status >= 400) return `returned ${status}`
  const host = leftSite(finalUrl, root)
  return host ? `left the site (${host})` : null
}

/**
 * The page this one duplicates, or null. `titles` holds every page captured in this run (a failed or skipped
 * URL is not in it) with its title. Redirecting to a different same-site URL in it always counts. A canonical
 * link counts only when the page it names also has the same title, because some sites declare one canonical on
 * every route.
 */
export function duplicateOf(
  url: string,
  finalUrl: string,
  canonical: string | null,
  title: string | null,
  root: URL,
  titles: Map<string, string | null>,
): string | null {
  const redirect = normalize(finalUrl, root)
  if (redirect && redirect !== url && titles.has(redirect)) return redirect
  const target = canonical && normalize(canonical, root)
  if (target && target !== url && title !== null && titles.get(target) === title) return target
  return null
}

async function sitemapUrls(context: BrowserContext, root: URL): Promise<string[]> {
  try {
    const res = await context.request.get(new URL("/sitemap.xml", root).href, { timeout: 10_000 })
    if (!res.ok()) return []
    const xml = await res.text()
    return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]!).filter((u) => !u.endsWith(".xml")).slice(0, 500)
  } catch {
    return []
  }
}

type CaptureNetwork = Awaited<ReturnType<typeof createCaptureNetwork>> | null

/** Loads the page and returns the HTTP status of the document it landed on, or null if there was no response. */
async function load(page: PwPage, url: string, network: CaptureNetwork) {
  let status: number | null = null
  try {
    status = (await page.goto(url, { waitUntil: "load", timeout: 45_000 }))?.status() ?? null
  } catch (error) {
    network?.assertAllowed()
    throw error
  }
  network?.assertAllowed()
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {})
  await dismissBanners(page)
  await page.evaluate(() => document.fonts?.ready).catch(() => {})
  await sleep(600)
  return status
}

/** Close cookie banners and popups in the page and its frames. Banners often animate in late, so try twice. */
export async function dismissBanners(page: PwPage) {
  if (!DISMISS_POPUPS) return
  let total = { clicked: 0, hidden: 0 }
  for (let pass = 0; pass < 2; pass++) {
    for (const frame of page.frames()) {
      const r = await frame
        .evaluate(`(${DISMISS_JS})(null)`)
        .catch(() => null) as { clicked: number; hidden: number } | null
      if (r) total = { clicked: total.clicked + r.clicked, hidden: total.hidden + r.hidden }
    }
    await sleep(pass === 0 ? 700 : 300)
  }
  // Anything a click revealed (e.g. a second consent step) gets hidden rather than clicked again.
  await run(page, DISMISS_JS, { hideOnly: true }).catch(() => {})
  if (total.clicked || total.hidden) log(`  closed popups: ${total.clicked} clicked, ${total.hidden} hidden`)
}

const scrollState = (page: PwPage) =>
  page.evaluate(() => ({ y: Math.round(window.scrollY), height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0) }))
const docHeight = async (page: PwPage) => (await scrollState(page)).height

/**
 * Chromium's screencast, scaled to fit `width` x `height` on the GPU as frames are composited. Call scrolled()
 * after each scroll step; frameAt(y) is then the newest frame painted at scroll offset y, else the next one to
 * arrive, or null if none comes within `waitMs`. After 3 misses in a row it gives up: the screencast stops and
 * frameAt returns null at once, so a browser that never sends frames costs 3 waits, not one per frame.
 */
export async function screencast(cdp: CDPSession, width: number, height: number, waitMs = 250, format: "png" | "jpeg" = "png") {
  let latest: { y: number; data: string } | null = null
  let waiting: { y: number; done: (data: string) => void } | null = null
  let running = false
  let perStep = false
  let received = 0
  let kept = 0
  let misses = 0 // in a row
  const onFrame = ({ data, metadata, sessionId }: { data: string; metadata: { scrollOffsetY: number }; sessionId: number }) => {
    cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {})
    received++
    latest = { y: metadata.scrollOffsetY, data }
    if (waiting && Math.abs(waiting.y - latest.y) < 1) waiting.done(data)
  }
  cdp.on("Page.screencastFrame", onFrame)
  const run = async (on: boolean) => {
    if (on === running) return
    running = on
    if (on) await cdp.send("Page.startScreencast", { format, quality: FRAME_JPEG_QUALITY, maxWidth: width, maxHeight: height })
    else await cdp.send("Page.stopScreencast").catch(() => {})
  }
  return {
    scrolled: async () => { if (misses < 3) await run(true) },
    frameAt: async (y: number) => {
      if (misses >= 3) return null
      const data = latest && Math.abs(latest.y - y) < 1 ? latest.data : await new Promise<string | null>((resolve) => {
        const timer = setTimeout(() => { waiting = null; resolve(null) }, waitMs)
        waiting = { y, done: (d) => { clearTimeout(timer); waiting = null; resolve(d) } }
      })
      misses = data == null ? misses + 1 : 0
      // Left running, the screencast also captures every frame an animation paints between steps. Once those
      // outnumber the kept frames 3 to 1, stop it after each step: every restart costs one extra capture, which
      // is cheaper than a running animation but dearer than a still page.
      if (++kept >= 5 && received > kept * 3) perStep = true
      if (perStep || misses >= 3) await run(false)
      return data == null ? null : Buffer.from(data, "base64")
    },
    stop: async () => {
      cdp.off("Page.screencastFrame", onFrame)
      await run(false)
    },
  }
}

/** Scroll through the page recording a video; also triggers lazy loading and scroll-reveal content. */
export async function recordScroll(page: PwPage, record: boolean, recordingFormat: Recording["ext"] = "gif") {
  const frames: Frame[] = []
  const { width: vw, height: vh } = page.viewportSize()!
  let height = await docHeight(page)
  const travel = Math.max(0, height - vh)
  // Small fixed steps for smooth motion; long pages take bigger steps to stay under the frame cap.
  const step = record ? Math.max(SCROLL_STEP, Math.ceil(travel / (MAX_SCROLL_FRAMES - 1))) : 400
  const delay = Math.round(1000 / SCROLL_FPS)
  const frameCount = (h: number) => Math.min(MAX_SCROLL_FRAMES, Math.ceil(Math.max(0, Math.min(h, 40_000) - vh) / step) + 1)
  // Frames come from the screencast, which scales each composited frame to recording size on the GPU: on a real
  // site about half the browser and GPU work of a full-size screenshot. A smaller captureScreenshot would
  // re-raster the whole page every frame, so it is only the fallback when no frame arrives in time. Each frame
  // is encoded (video.ts) in the helper page's process while the next scroll paints, then dropped. Sampled frames keep
  // a full-size JPEG still.
  const cdp = record ? await page.context().newCDPSession(page) : null
  const shot = async (params: object) => {
    const { data } = await cdp!.send("Page.captureScreenshot", params as { format: "png" })
    return Buffer.from(data, "base64")
  }
  const writer = record ? await recordingWriter(page.context().browser()!, { format: recordingFormat }) : null
  // Video takes JPEG frames: fewer bytes to pass along and cheaper for Chromium to encode than PNG. At quality 97
  // the video is ~10% bigger than from PNG (90 made it 50% bigger: VP9 spends bits on JPEG noise). A GIF's palette
  // is built best from PNG.
  const format = writer?.format === "webm" ? "jpeg" : "png"
  const cast = cdp ? await screencast(cdp, Math.round(vw / SCROLL_SCALE), Math.round(vh / SCROLL_SCALE), 250, format) : null
  let fallbacks = 0
  const encode = async (frame: Frame | undefined, ms: number) => {
    if (!frame?.png) return
    const png = frame.png
    delete frame.png
    frame.delay = ms
    await writer!.add(png, ms)
  }
  for (let y = 0; ; y += step) {
    await page.evaluate((top) => window.scrollTo({ top, behavior: "instant" as ScrollBehavior }), y)
    await cast?.scrolled()
    await Promise.all([encode(frames.at(-1), frames.length === 1 ? FIRST_FRAME_MS : delay), sleep(record ? 30 : 60)])
    const state = await scrollState(page)
    height = state.height // infinite/lazy pages can grow
    let frame: Frame | undefined
    if (record) {
      let png = await cast!.frameAt(state.y)
      if (!png) {
        fallbacks++
        png = await shot({ format, quality: FRAME_JPEG_QUALITY, optimizeForSpeed: true, clip: { x: 0, y: state.y, width: vw, height: vh, scale: 1 / SCROLL_SCALE } })
      }
      frame = { png, delay, scrollY: state.y, phase: "scroll" }
      frames.push(frame)
    }
    const last = y >= Math.min(height, 40_000) - vh || (record && frames.length >= MAX_SCROLL_FRAMES)
    // The sample plan follows the page's current height; buildStills uses the nearest still if it grew later.
    if (frame && (last || sampleIndexes(frameCount(height)).includes(frames.length - 1)))
      frame.still = { jpeg: await shot({ format: "jpeg", quality: 82, optimizeForSpeed: true }), width: vw, height: vh }
    if (last) break
  }
  await encode(frames.at(-1), LAST_FRAME_MS)
  await cast?.stop()
  await cdp?.detach().catch(() => {})
  if (fallbacks) log(`  scroll: ${fallbacks}/${frames.length} frames fell back to screenshots`)
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior }))
  await sleep(400)
  let recording: Recording | null = null
  if (frames.length > 1) {
    try {
      recording = await writer!.finish()
    } catch (e) {
      log("  scroll recording failed:", (e as Error).message.split("\n")[0])
    }
  }
  // The encoder's page would otherwise hold its memory through the rest of the page. Only a recording scroll
  // opened it: the mobile scroll runs alongside the desktop recording and must not close its encoder.
  if (writer) await closeRenderer()
  return { frames, recording }
}

/** Try once more after a failure, unless the job is gone. */
async function retryOnce<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof JobGoneError) throw e
    return fn()
  }
}

const ICON_MAX_BYTES = 256 * 1024

/** What a site's icon is, judged by its bytes (the site's Content-Type is not trusted). Null for anything that is not an image. */
export function iconType(b: Buffer): { ext: string; type: string } | null {
  const at = (...bytes: number[]) => bytes.every((x, i) => b[i] === x)
  if (at(0x89, 0x50, 0x4e, 0x47)) return { ext: "png", type: "image/png" }
  if (at(0, 0, 1, 0)) return { ext: "ico", type: "image/x-icon" }
  if (at(0x47, 0x49, 0x46, 0x38)) return { ext: "gif", type: "image/gif" }
  if (at(0xff, 0xd8, 0xff)) return { ext: "jpg", type: "image/jpeg" }
  if (b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return { ext: "webp", type: "image/webp" }
  if (/^[\s\uFEFF]*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)?<svg[\s>]/.test(b.toString("utf8", 0, 2048))) return { ext: "svg", type: "image/svg+xml" }
  return null
}

/**
 * Save the site's icon with the capture so Snip shows it from its own files, never by asking the site (or anyone else) again.
 * Null when the icon can't be fetched, is too big or isn't an image: the website then shows its first letter.
 * Never throws: it runs beside the first page and must not fail the capture. A job that went away fails the
 * capture's own next call.
 */
async function storeIcon(context: BrowserContext, api: SnipApi, url: string, prefix: string): Promise<string | null> {
  try {
    const res = await context.request.get(url, { timeout: 10_000 })
    if (!res.ok() || Number(res.headers()["content-length"]) > ICON_MAX_BYTES) return null
    const body = await res.body()
    const icon = body.length <= ICON_MAX_BYTES ? iconType(body) : null
    return icon ? await api.upload(`${prefix}/icon.${icon.ext}`, body, icon.type) : null
  } catch {
    return null
  }
}

/** Map `items` with at most `n` calls running at once, keeping order. */
async function pool<T, R>(items: T[], n: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]!, i)
    }
  }))
  return out
}

/** Animations the browser started since the last call (see inpage/motion.js). Logging failures only lose the log. */
const takeMotion = (page: PwPage) => run<MotionEntry[]>(page, MOTION_JS, { op: "take" }).catch(() => [])

/** Where the page breaks into its visual sections (see inpage/sections.js). The page must be scrolled to the top. */
const findSections = (page: PwPage) =>
  run<SectionCut[]>(page, SECTIONS_JS, { maxPx: MAX_SHOT_PX, max: MAX_SECTIONS }).catch((e) => {
    log("  sections skipped:", (e as Error).message.split("\n")[0])
    return []
  })

/** A clip uploaded for an earlier page of the same capture, reused for the same section on later pages. */
export type LiveReuse = { key: string; height: number; durationMs: number; still?: Buffer }

/**
 * One clip. Touching sections that move are recorded together, so several sections can share one clip.
 * `reuse` points at a clip already uploaded for this section on an earlier page; `recording` is then null.
 * `sig` names a single-section clip so later pages can reuse it. `still` is the clip's first frame (JPEG, the
 * clip's own band): it is pasted into the full-page shot, so the screenshot is the frame the clip starts on.
 */
type LiveClip = { recording: Recording | null; reuse?: LiveReuse; y: number; height: number; durationMs: number; sig: string | null; still?: Buffer }

/** A section as sections.js finds it: `fp` fingerprints its text and media, and is not stored. */
type SectionCut = Omit<PageSection, "key"> & { fp?: string }

/**
 * What identifies the same section on another page of a site: shared chrome like a logo marquee or animated
 * footer. Kind, label and height alone would match two different pages' "Overview" heroes, so the content
 * fingerprint must match too. Generic labels ("Section 4") name nothing, so those are never reused.
 */
export const liveSignature = (s: SectionCut) => (!s.fp || /^Section \d+$/.test(s.label) ? null : `${s.kind}|${s.label}|${s.height}|${s.fp}`)

/** Share of pixels that differ in one band of two same-size frames, compared at quarter size. */
async function changedShare(a: Buffer, b: Buffer, band: { top: number; height: number }) {
  const { width } = imageSize(a)
  const out = { width: Math.max(1, Math.round(width / 4)), height: Math.max(1, Math.round(band.height / 4)) }
  return pixelShare(...(await Promise.all([bandPixels(a, band, out), bandPixels(b, band, out)])))
}

/**
 * `height` CSS px from `top` as rows of an image `rows` tall, at `k` image px per CSS px. Both edges are rounded, not
 * the top and the height apart: at a fractional scale those can add up to a row past the image (example.com on a phone).
 */
const bandRows = (top: number, height: number, k: number, rows: number) => {
  const first = Math.min(rows - 1, Math.max(0, Math.round(top * k)))
  return { top: first, height: Math.max(1, Math.min(rows, Math.round((top + height) * k)) - first) }
}

/** A full-width horizontal band of an image, scaled to `out` (RGB, 8 bit), for comparing bands of images of different sizes. */
const bandPixels = (img: Buffer, band: { top: number; height: number }, out: { width: number; height: number }) =>
  sharp(img).extract({ left: 0, top: band.top, width: imageSize(img).width, height: band.height }).resize({ ...out, fit: "fill" }).removeAlpha().raw().toBuffer()

/** Share of pixels that differ between two same-size RGB buffers. */
function pixelShare(x: Buffer, y: Buffer) {
  let changed = 0
  for (let i = 0; i < x.length; i += 3) {
    // 16 levels: well above JPEG noise at the screencast's quality, low enough for a slow drift caught over a short span.
    if (Math.abs(x[i]! - y[i]!) > 16 || Math.abs(x[i + 1]! - y[i + 1]!) > 16 || Math.abs(x[i + 2]! - y[i + 2]!) > 16) changed++
  }
  return changed / (x.length / 3)
}

/** Part of the page as it looked scrolled into view: `jpeg` covers `height` CSS px from document y `y`, at page width. */
export type InViewPatch = { y: number; height: number; jpeg: Buffer }
/** The full-page shot to compare sections against, taken at `dpr` image px per CSS px (1 if left out), and the patches found. */
export type InView = { shot: Buffer; patches: InViewPatch[]; dpr?: number }

/**
 * Paste in-view patches into a full-page screenshot taken at `dpr` image px per CSS px (the desktop shot is at 1,
 * the mobile one at MOBILE_DPR). Returns the shot unchanged when there are none.
 */
export async function patchInView(shot: Buffer, patches: InViewPatch[], dpr = 1): Promise<Buffer> {
  if (!patches.length) return shot
  const { width, height } = imageSize(shot)
  const inputs = await Promise.all(patches.filter((p) => Math.round(p.y * dpr) < height).map(async (p) => ({
    input: await sharp(p.jpeg).resize({ width, height: Math.max(1, Math.min(Math.round(p.height * dpr), height - Math.round(p.y * dpr))), fit: "fill" }).toBuffer(),
    left: 0,
    top: Math.round(p.y * dpr),
  })))
  return sharp(shot).composite(inputs).jpeg({ quality: 80 }).toBuffer()
}

/**
 * Which sections may look different scrolled into view, read from the page at the top: they hold an element an
 * IntersectionObserver watches (reveals; see OBSERVED_JS), one with a scroll- or view-driven animation, or one
 * that is hidden by opacity (a reveal's starting state). The rest are skipped by the patch-only pass.
 */
const likelyInView = (page: PwPage, cuts: Omit<PageSection, "key">[]) =>
  page.evaluate((bands) => {
    const hit = bands.map(() => false)
    const mark = (el: Element) => {
      const r = el.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) return
      const top = r.top + scrollY
      const bottom = r.bottom + scrollY
      bands.forEach((b, i) => { if (top < b.y + b.height && bottom > b.y) hit[i] = true })
    }
    const observed = (window as unknown as { __snipObserved?: Set<Element> }).__snipObserved
    observed?.forEach((el) => el.isConnected && mark(el))
    for (const a of document.getAnimations()) {
      const target = (a.effect as KeyframeEffect | null)?.target
      if (target && a.timeline && !(a.timeline instanceof DocumentTimeline)) mark(target)
    }
    for (const el of document.querySelectorAll("body *")) if (parseFloat(getComputedStyle(el).opacity) < 0.1) mark(el)
    return hit
  }, cuts.map(({ y, height }) => ({ y, height }))).catch(() => cuts.map(() => true))

/**
 * Record the parts of the page that move on their own (canvas gradients, marquees, carousels) as short
 * real-time clips.
 *
 * Each section is probed first: once one-shot animations (scroll reveals) have finished, the screencast is
 * watched briefly. A still page sends a frame or two; otherwise the section's own pixels are compared across
 * the window, so motion elsewhere on screen or a blinking caret doesn't count. If frames kept coming (the
 * section is repainting) but it hasn't changed, the watch is extended once: a loop can hold still for a
 * second, or start after a beat. Touching sections that both move, such as a transparent header over a hero
 * gradient, are recorded as one clip when they fit in the viewport: clips made at different moments would show
 * the same animation out of step at their shared edge. A clip whose motion stops before the window ends is
 * dropped, since it wouldn't loop. Oversized clips are re-encoded smaller from the frames already held, then
 * dropped if still over the per-clip or per-page byte budget.
 *
 * Fixed and sticky bars are hidden below the top of the page, since the full-page screenshot shows them only
 * there. Frames come from the screencast at viewport size and are cropped by the encoder. `seen` holds clips
 * uploaded for earlier pages of this capture, by liveSignature: a single-section clip found there is reused
 * instead of probed and recorded. Returns one entry per section (sections in one band share the clip), null where
 * still or not recorded. Leaves the page scrolled to the top with its bars restored.
 */
export async function recordLiveSections(
  page: PwPage,
  cuts: SectionCut[],
  format: Recording["ext"],
  seen: ReadonlyMap<string, LiveReuse> = new Map(),
  inView?: InView,
): Promise<(LiveClip | null)[]> {
  const out: (LiveClip | null)[] = cuts.map(() => null)
  const live = LIVE_SECTIONS && format === "webm" && MAX_LIVE > 0
  // Without clips, in-view patches still come from one still per section: no probe, no screencast.
  const patchOnly = !live && !!inView && IN_VIEW_PATCH
  if (!cuts.length || (!live && !patchOnly)) return out
  const browser = page.context().browser()!
  const { width: vw, height: vh } = page.viewportSize()!
  const cdp = await page.context().newCDPSession(page)
  /**
   * Hide the page's bars while it is scrolled away from the top: the full-page shot shows a fixed header only at
   * the top, so a clip or in-view frame must not show it over another section. A bar is a fixed element, or a
   * sticky one that is currently stuck, that is less than half the viewport tall and sits in the top or bottom
   * quarter of it. Fixed backgrounds and pinned content inside a section (a sticky image column) are larger or
   * not stuck, so they stay. "all" hides top and bottom bars; "bottom" only bottom ones (chat bubbles, cookie bars).
   */
  const bars = (hide: "none" | "bottom" | "all") => page.evaluate((hide) => {
    document.querySelectorAll<HTMLElement>("[data-snip-live-hidden]").forEach((el) => {
      el.style.visibility = el.dataset.snipLiveHidden!
      delete el.dataset.snipLiveHidden
    })
    if (hide === "none") return
    for (const el of document.querySelectorAll<HTMLElement>("body *")) {
      const cs = getComputedStyle(el)
      if (cs.position !== "fixed" && cs.position !== "sticky") continue
      const r = el.getBoundingClientRect()
      if (r.height < 1 || r.width < 1 || r.height > innerHeight / 2) continue
      if (cs.position === "sticky") {
        const stuck = Math.abs(r.top - parseFloat(cs.top)) < 2 || Math.abs(innerHeight - r.bottom - parseFloat(cs.bottom)) < 2
        if (!stuck) continue
      }
      const top = r.top < innerHeight / 4
      const bottom = r.bottom > (innerHeight * 3) / 4
      if (hide === "all" ? top || bottom : bottom) {
        el.dataset.snipLiveHidden = el.style.visibility
        el.style.visibility = "hidden"
      }
    }
  }, hide)
  /**
   * Scroll so document y `y` is as near the top as the page allows, and let animations it set off finish.
   * Returns where y landed in the viewport.
   */
  const showAt = async (y: number) => {
    await bars(y > 0 ? "all" : "bottom")
    await page.evaluate((top) => window.scrollTo({ top, behavior: "instant" as ScrollBehavior }), y)
    // Reveal observers fire on the next frames, and the animations they start begin a frame or two later.
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))).catch(() => {})
    await sleep(60)
    // Wait out what the running one-shot animations on screen have left, never longer than the cap. Waiting for
    // them to finish never ends on sites whose scripts keep starting short animations; ones off screen don't show.
    const left = await page.evaluate(() => Math.max(0, ...document.getAnimations().map((a) => {
      const t = a.effect?.getComputedTiming()
      if (a.playState !== "running" || !t || !Number.isFinite(t.endTime)) return 0
      const r = (a.effect as KeyframeEffect).target?.getBoundingClientRect()
      if (r && (r.bottom <= 0 || r.top >= innerHeight || r.width * r.height === 0)) return 0
      return Number(t.endTime) - Number(t.localTime ?? 0)
    }))).catch(() => 0)
    await sleep(Math.min(LIVE_SETTLE_MS, left))
    return y - (await page.evaluate(() => Math.round(window.scrollY)))
  }
  /** Screencast frames (JPEG, viewport size) for `ms`, with when each arrived. */
  const screencast = async (ms: number, everyNthFrame: number, maxHeight = vh) => {
    const frames: { data: string; t: number }[] = []
    const onFrame = ({ data, sessionId }: { data: string; sessionId: number }) => {
      cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {})
      const t = Date.now()
      if (!frames.length || t - frames.at(-1)!.t >= LIVE_FRAME_MS) frames.push({ data, t })
    }
    cdp.on("Page.screencastFrame", onFrame)
    const from = Date.now()
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: FRAME_JPEG_QUALITY, maxWidth: vw, maxHeight, everyNthFrame })
    await sleep(ms)
    await cdp.send("Page.stopScreencast").catch(() => {})
    cdp.off("Page.screencastFrame", onFrame)
    return { frames, from, to: Date.now() }
  }
  const holdResize = (on: boolean) => page.evaluate((on) => new Promise<void>((done) => {
    if (on) (window as unknown as { __snipHoldResize: boolean }).__snipHoldResize = true
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!on) (window as unknown as { __snipHoldResize: boolean }).__snipHoldResize = false
      done()
    }))
  }), on).catch(() => {})
  /**
   * The vertical extent [top, bottom], in document px, of each element that takes room in the page's flow, by its
   * place in `body *`. Taken from offsets, which ignore transforms: the section being recorded is always moving.
   * Fixed and sticky elements and what they hold follow the viewport, not the layout, so they are left out.
   */
  type Layout = { count: number; at: Record<number, [number, number]> }
  const layout = () => page.evaluate((): Layout => {
    const all = Array.from(document.body.querySelectorAll("*"))
    const at: Layout["at"] = {}
    let pinned: Element | null = null
    for (const [i, el] of all.entries()) {
      if (pinned?.contains(el)) continue
      const { position } = getComputedStyle(el)
      pinned = position === "fixed" || position === "sticky" ? el : null
      if (pinned || !(el instanceof HTMLElement) || !el.offsetParent || !el.offsetWidth || !el.offsetHeight) continue
      let top = 0 // offsetTop is from the offset parent: add up the few positioned ancestors
      for (let up: Element | null = el; up instanceof HTMLElement; up = up.offsetParent) top += up.offsetTop
      at[i] = [top, top + el.offsetHeight]
    }
    return { count: all.length, at }
  })
  const measure = () => Promise.all([docHeight(page), layout()]).catch((e) => {
    log("  page layout not measured:", (e as Error).message.split("\n")[0])
    return null
  })
  const slack = 2 // px the layout may move when the viewport grows (rounding) and still count as where it was
  /** Whether everything touching document rows `keep` in `after` sits where it did in `before`, give or take `slack`. */
  const placed = (before: Layout, after: Layout, keep: { y: number; height: number }) => {
    const touches = (r?: [number, number]) => !!r && r[0] < keep.y + keep.height && r[1] > keep.y
    return before.count === after.count && Object.keys({ ...before.at, ...after.at }).every((i) => {
      const [then, now] = [before.at[+i], after.at[+i]]
      return (!touches(then) && !touches(now)) || (!!then && !!now && Math.abs(then[0] - now[0]) <= slack && Math.abs(then[1] - now[1]) <= slack)
    })
  }
  /**
   * Make the viewport `height` tall (the page's own events for it are held, as in fullPageShot). Pages size things by
   * the viewport, so a taller one can move or resize sections while the total height stays put. It is only kept if
   * the page is as it was: the same total height, and nothing touching the rows `keep` (the whole page unless the
   * caller says which rows its coordinates and patches rely on) moved or resized. Otherwise, or if that can't be
   * measured, the viewport is put back and this returns false.
   */
  const viewport = async (height: number, keep = { y: 0, height: Infinity }) => {
    const grow = height !== vh
    const before = grow ? await measure() : null
    if (grow && !before) return false
    await holdResize(true)
    await page.setViewportSize({ width: vw, height })
    await holdResize(grow)
    if (!grow) return true
    const after = await measure()
    if (before && after && Math.abs(after[0] - before[0]) <= slack && placed(before[1], after[1], keep)) return true
    await viewport(vh)
    return false
  }
  const scale = async (frame: string) => imageSize(Buffer.from(frame, "base64")).width / vw // screencast pixels per CSS px
  // A viewport still at the page's DPR: CDP's own captureScreenshot is at DPR 1 under mobile emulation.
  const still = () => page.screenshot({ type: "jpeg", quality: 90 })

  /**
   * The section as it looks scrolled into view, against the full-page shot. Content whose state follows the scroll
   * position or visibility (reveals that reset, scroll-driven overlays, carousels) shows its "not reached yet" state
   * in a shot taken from the top. If over IN_VIEW_CHANGED of the band differs, the in-view frame is kept as a patch,
   * plus further frames down the section where it is taller than the viewport.
   */
  const collectInView = async (s: Omit<PageSection, "key">, top: number, height: number, k: number, frame: Buffer) => {
    const shot = inView!.shot
    const d = inView!.dpr ?? 1
    const shotH = Math.floor(imageSize(shot).height / d) // in CSS px
    if (s.y + height > shotH) return
    const out = { width: 360, height: Math.max(1, Math.round((height * 360) / vw)) }
    const seen = await bandPixels(frame, bandRows(top, height, k, imageSize(frame).height), out)
    const shown = await bandPixels(shot, bandRows(s.y, height, d, imageSize(shot).height), out)
    if (pixelShare(seen, shown) < IN_VIEW_CHANGED) return
    const piece = async (img: Buffer, at: number, viewTop: number, h: number) =>
      inView!.patches.push({ y: at, height: h, jpeg: await sharp(img).extract({ left: 0, width: Math.round(vw * k), ...bandRows(viewTop, h, k, imageSize(img).height) }).jpeg({ quality: 90 }).toBuffer() })
    await piece(frame, s.y, top, height)
    // The rest of a tall section, a viewport at a time, up to the shot's bottom.
    for (let off = height, extra = 0; off < s.height && extra < IN_VIEW_EXTRA; extra++) {
      const at = s.y + off
      const viewTop = await showAt(at)
      const h = Math.min(s.height - off, vh - viewTop, shotH - at)
      if (viewTop < 0 || h < 40) break
      await piece(await still(), at, viewTop, h)
      off += h
    }
  }
  try {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.()).catch(() => {}) // no caret

    // ---- Which sections move ----
    const moving = cuts.map(() => false)
    const likely = patchOnly ? await likelyInView(page, cuts) : []
    for (const [i, s] of cuts.entries()) {
      if (patchOnly) {
        if (!likely[i]) continue
        try {
          const top = await showAt(s.y)
          const height = Math.min(s.height, vh - top)
          if (top < 0 || height < 40) continue
          const frame = await still()
          await collectInView(s, top, height, imageSize(frame).width / vw, frame)
        } catch (e) {
          log(`  in-view check of "${s.label}" skipped:`, (e as Error).message.split("\n")[0])
        }
        continue
      }
      const sig = liveSignature(s)
      if (sig && seen.has(sig)) {
        moving[i] = true // recorded on an earlier page
        continue
      }
      try {
        const top = await showAt(s.y)
        const height = Math.min(s.height, vh - top)
        if (top < 0 || height < 40) continue
        const { frames } = await screencast(LIVE_PROBE_MS, 1)
        if (!frames.length) continue
        const k = await scale(frames[0]!.data)
        const band = { top: Math.round(top * k), height: Math.max(1, Math.round(height * k)) }
        const last = Buffer.from(frames.at(-1)!.data, "base64")
        if (inView) await collectInView(s, top, height, k, last)
        // A still page sends one frame. Two or more are compared, since a busy machine can slow the screencast to a trickle.
        if (frames.length < 2) continue
        // The first frame against the last, and against the middle one: a back-and-forth animation can be at the same point at both ends.
        const changes = async (fs: { data: string }[]) => {
          const at = (n: number) => Buffer.from(fs[n]!.data, "base64")
          return (await changedShare(at(0), at(fs.length - 1), band)) >= LIVE_MIN_CHANGED
            || (fs.length > 2 && (await changedShare(at(0), at(fs.length >> 1), band)) >= LIVE_MIN_CHANGED)
        }
        moving[i] = await changes(frames)
        // Frames kept coming but the section hasn't changed: its motion may hold still (a video on its last frame) or start a beat
        // after it scrolls in (a demo that loads on view). Watch on before calling it still.
        if (!moving[i] && frames.length >= LIVE_BUSY_FRAMES) moving[i] = await changes([...frames, ...(await screencast(LIVE_RECHECK_MS, 1)).frames])
      } catch (e) {
        log(`  live probe of "${s.label}" skipped:`, (e as Error).message.split("\n")[0])
      }
    }

    // ---- Record each run of touching, moving sections that fits in one viewport ----
    let made = 0
    let pageBytes = 0
    let tall = false // the viewport is grown to fit the section being recorded
    for (let i = 0; live && i < cuts.length && made < MAX_LIVE; i++) {
      if (!moving[i]) continue
      let j = i
      while (j + 1 < cuts.length && moving[j + 1] && cuts[j + 1]!.y === cuts[j]!.y + cuts[j]!.height && cuts[j + 1]!.y + cuts[j + 1]!.height - cuts[i]!.y <= vh) j++
      const y = cuts[i]!.y
      const sig = i === j ? liveSignature(cuts[i]!) : null
      try {
        const reuse = sig ? seen.get(sig) : undefined
        if (reuse) {
          const height = Math.min(reuse.height, cuts[i]!.height)
          out[i] = { recording: null, reuse, y, height, durationMs: reuse.durationMs, sig, still: reuse.still }
          if (inView && reuse.still) {
            // The viewer shows a reused clip from its top, cut to this section's height: cut the still the same way.
            const size = imageSize(reuse.still)
            const jpeg = height < reuse.height
              ? await sharp(reuse.still).extract({ left: 0, top: 0, width: size.width, height: Math.max(1, Math.round((size.height * height) / reuse.height)) }).jpeg({ quality: 90 }).toBuffer()
              : reuse.still
            inView.patches.push({ y, height, jpeg })
          }
          continue
        }
        const band = cuts[j]!.y + cuts[j]!.height - y
        if (band > vh && band <= vh * LIVE_TALL) tall = await viewport(Math.ceil(band), { y, height: band })
        const view = tall ? Math.ceil(band) : vh
        const top = await showAt(y)
        const height = Math.floor(Math.min(band, view - top) / 2) * 2
        if (top < 0 || height < 40) continue
        const { frames, to } = await screencast(LIVE_MS, 2, view)
        if (frames.length < 2 || to - frames.at(-1)!.t > LIVE_QUIET_MS) continue // still, or the motion stopped: it wouldn't loop

        const k = await scale(frames[0]!.data)
        const crop = { x: 0, y: Math.round(top * k), width: Math.round(vw * k), height: Math.round(height * k) }
        let clipHeight = height
        const durationMs = Math.round(Math.min(LIVE_MS, frames.at(-1)!.t - frames[0]!.t + LIVE_FRAME_MS))
        // The clip loops, so it can start anywhere: start it on its fullest frame, which becomes the screenshot.
        // A frame's JPEG size stands for how much is on screen; one the page rested on (no new frame for a while)
        // counts for more than one passed through. Even indexes only, so the half-rate encode keeps it first.
        // ponytail: size-and-rest heuristic, can land mid-transition; compare frames to neighbours if it picks badly.
        const score = (n: number) => frames[n]!.data.length * Math.min(500, Math.max(100, (frames[n + 1]?.t ?? frames[0]!.t + durationMs) - frames[n]!.t))
        let start = 0
        for (let n = 2; n < frames.length; n += 2) if (score(n) > score(start)) start = n
        frames.push(...frames.splice(0, start).map((f) => ({ ...f, t: f.t + durationMs })))
        const encode = async (quantizer: number, step: number) => {
          const writer = await recordingWriter(browser, { format: "webm", quantizer })
          if (writer.format !== "webm") return null // no VP9 here: a GIF of a whole section would be far too big
          const kept = frames.filter((_, n) => n % step === 0)
          for (let f = 0; f < kept.length; f++) {
            const next = kept[f + 1]?.t ?? kept[0]!.t + durationMs
            await writer.add(Buffer.from(kept[f]!.data, "base64"), next - kept[f]!.t, crop)
          }
          return writer.finish()
        }
        let recording = await encode(LIVE_QUANTIZER, 1)
        if (!recording) break
        if (recording.bytes.length > LIVE_CLIP_BYTES) recording = (await encode(52, 2)) ?? recording // half the frames, coarser
        if (recording.bytes.length > LIVE_CLIP_BYTES && height > vh) {
          // A whole tall section is over budget: keep its first viewport rather than nothing.
          clipHeight = Math.floor(vh / 2) * 2
          crop.height = Math.round(clipHeight * k)
          recording = (await encode(LIVE_QUANTIZER, 1)) ?? recording
          if (recording.bytes.length > LIVE_CLIP_BYTES) recording = (await encode(52, 2)) ?? recording
        }
        if (recording.bytes.length > LIVE_CLIP_BYTES || pageBytes + recording.bytes.length > LIVE_PAGE_BYTES) {
          log(`  live clip of "${cuts[i]!.label}" dropped: ${recording.bytes.length} bytes is over budget`)
          continue
        }
        pageBytes += recording.bytes.length
        // The clip's first frame becomes this band of the full-page shot (after any in-view patch of it, so it
        // wins): the viewer can then swap screenshot and clip with nothing moving.
        const still = await sharp(Buffer.from(frames[0]!.data, "base64")).extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height }).jpeg({ quality: 90 }).toBuffer()
        inView?.patches.push({ y, height: clipHeight, jpeg: still })
        const clip: LiveClip = { recording, y, height: clipHeight, durationMs, sig, still }
        for (let n = i; n <= j; n++) out[n] = clip
        made++
      } catch (e) {
        log(`  live clip of "${cuts[i]!.label}" skipped:`, (e as Error).message.split("\n")[0])
      } finally {
        if (tall) await viewport(vh).catch(() => {})
        tall = false
        i = j
      }
    }
  } finally {
    await cdp.send("Page.stopScreencast").catch(() => {})
    await cdp.detach().catch(() => {})
    await bars("none").catch(() => {})
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior })).catch(() => {})
    await sleep(300)
  }
  return out
}

/**
 * Whether the page has a theme for the other color scheme, found by flipping prefers-color-scheme on the loaded
 * page (no reload) and comparing the viewport. Sites that follow the system theme repaint at once; others barely
 * change (their own motion only). If it does, returns that scheme's full-page shot and thumbnail. Always leaves
 * the page back in its own scheme, scrolled where it was (the top).
 */
export async function captureOtherScheme(page: PwPage, base: "light" | "dark") {
  const scheme = base === "dark" ? ("light" as const) : ("dark" as const)
  try {
    const before = await page.screenshot({ type: "jpeg", quality: 70 })
    await page.emulateMedia({ colorScheme: scheme })
    await sleep(400)
    const after = await page.screenshot({ type: "jpeg", quality: 70 })
    if ((await changedShare(before, after, { top: 0, height: imageSize(before).height })) < OTHER_SCHEME_CHANGED) return null
    const shot = await fullPageShot(page, 1)
    const thumb = await thumbnail(await page.screenshot({ type: "jpeg", quality: 75 }), THUMB_WIDTH.desktop)
    return { scheme, shot, thumb }
  } catch (e) {
    log(`  ${scheme} scheme skipped:`, (e as Error).message.split("\n")[0])
    return null
  } finally {
    await page.emulateMedia({ colorScheme: base }).catch(() => {})
    await sleep(300)
  }
}

/**
 * Installed in every capture page before its own scripts: remembers the elements IntersectionObservers watch, which
 * likelyInView reads. The Set is never exposed as an enumerable global the page could trip over.
 */
const OBSERVED_JS = `(() => {
  const IO = window.IntersectionObserver
  if (!IO) return
  const seen = new Set()
  Object.defineProperty(window, "__snipObserved", { value: seen })
  const observe = IO.prototype.observe
  IO.prototype.observe = function (el) { if (el instanceof Element) seen.add(el); return observe.call(this, el) }
})()`

/**
 * Installed in every capture page before its own scripts. A full-page screenshot fires a resize event on window
 * and visualViewport although the viewport doesn't change; sites that rebuild on resize (mistral.ai's physics
 * section re-creates its chips hidden) then lose content for the rest of the capture. fullPageShot sets the flag
 * so the page never sees that event.
 */
const HOLD_RESIZE_JS = `(() => {
  const hold = (e) => { if (window.__snipHoldResize) e.stopImmediatePropagation() }
  window.addEventListener("resize", hold, true)
  window.visualViewport?.addEventListener("resize", hold, true)
})()`

async function fullPageShot(page: PwPage, dpr: number) {
  const height = await docHeight(page)
  const width = page.viewportSize()!.width
  const clipH = Math.min(height, Math.floor(MAX_SHOT_PX / dpr))
  // content-visibility: auto parts of the page outside the viewport aren't painted in a full-page capture (blank
  // sections on vercel.com); show them for the shot. Only `auto`: `hidden` is content the site keeps unpainted on
  // purpose (inactive panels). contain-intrinsic-size keeps their measured size, so the layout doesn't move. The
  // flag and inline styles are undone afterwards, so the HTML snapshot never sees them.
  await page.evaluate(() => {
    ;(window as unknown as { __snipHoldResize: boolean }).__snipHoldResize = true
    for (const el of document.querySelectorAll<HTMLElement>("body *")) {
      if (getComputedStyle(el).getPropertyValue("content-visibility") !== "auto") continue
      el.dataset.snipCv = el.style.getPropertyValue("content-visibility")
      el.style.setProperty("content-visibility", "visible", "important")
    }
  }).catch(() => {})
  try {
    const buf = await page.screenshot({ type: "jpeg", quality: 80, fullPage: true, clip: { x: 0, y: 0, width, height: clipH } })
    return { buf, width: Math.round(width * dpr), height: Math.round(clipH * dpr) }
  } finally {
    // Late resize events from restoring the viewport are held too: wait two frames before letting them through.
    await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => {
      ;(window as unknown as { __snipHoldResize: boolean }).__snipHoldResize = false
      document.querySelectorAll<HTMLElement>("[data-snip-cv]").forEach((el) => {
        el.style.removeProperty("content-visibility")
        if (el.dataset.snipCv) el.style.setProperty("content-visibility", el.dataset.snipCv)
        delete el.dataset.snipCv
      })
      done()
    })))).catch(() => {})
  }
}

async function recordHovers(page: PwPage, seen: Set<string>, recordingFormat: Recording["ext"]) {
  const found = await run<{ i: number; label: string; selector: string }[]>(page, HOVER_JS, { max: MAX_HOVERS * 2 })
  // Shared chrome (nav links, footer buttons) repeats on every page: record each effect once per site.
  const targets = found.filter((t) => !seen.has(`${t.selector}|${t.label}`)).slice(0, MAX_HOVERS)
  const out: { recording: Recording; label: string; selector: string; frames: Frame[]; observedStyles: Record<string, string> | null; motion: MotionEntry[] }[] = []
  if (!targets.length) return out
  const cdp = await page.context().newCDPSession(page)
  for (const t of targets) {
    try {
      const el = page.locator(`[data-rs-hover="${t.i}"]`).first()
      await el.scrollIntoViewIfNeeded({ timeout: 2000 })
      await page.mouse.move(2, 2)
      await sleep(HOVER_SETTLE_MS)
      const box = await el.boundingBox()
      if (!box) continue
      const vp = page.viewportSize()!
      const pad = 24
      const clip = {
        x: Math.max(0, box.x - pad),
        y: Math.max(0, box.y - pad),
        width: Math.min(vp.width, box.width + pad * 2),
        height: Math.min(vp.height, box.height + pad * 2),
      }
      clip.width = Math.min(clip.width, vp.width - clip.x)
      clip.height = Math.min(clip.height, vp.height - clip.y)
      if (clip.width < 20 || clip.height < 20) continue

      // Resting computed styles of the target: observed values only, not the site's source CSS or its :hover rule.
      const observedStyles = await el
        .evaluate((node) => {
          const cs = getComputedStyle(node)
          const props = ["transition", "transition-property", "transition-duration", "transition-timing-function", "transition-delay",
            "animation", "transform", "opacity", "color", "background-color", "border-color", "box-shadow", "filter"]
          const o: Record<string, string> = {}
          for (const p of props) {
            const v = cs.getPropertyValue(p)
            if (v && v !== "none" && v !== "all 0s ease 0s" && v !== "0s") o[p] = v
          }
          return o
        })
        .catch(() => null)
      // Leaving runs the resting state's transitions; entering runs the :hover state's, read once hovered.
      const cssTiming = () => run<number>(page, TRANSITION_JS, `[data-rs-hover="${t.i}"]`)
      const restMs = await cssTiming().catch(() => HOVER_LEAVE.max)

      // Raw CDP skips page.screenshot's per-shot work in every frame (caret hiding, font wait). It takes the
      // clip in document coordinates; whole-pixel sizes match what page.screenshot produced.
      const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }))
      const shotClip = { x: clip.x + scroll.x, y: clip.y + scroll.y, width: Math.floor(clip.width + 1e-3), height: Math.floor(clip.height + 1e-3), scale: 1 }
      const frames: Frame[] = []
      const t0 = Date.now()
      let last = t0
      let started = 0
      let phase: Frame["phase"] = "rest"
      const grab = async () => {
        // Hold the ~30 fps page.screenshot managed: faster shots would only add frames and CPU.
        const wait = started + HOVER_FRAME_MS - Date.now()
        if (wait > 0) await sleep(wait)
        started = Date.now()
        const { data } = await cdp.send("Page.captureScreenshot", { format: "png", optimizeForSpeed: true, clip: shotClip } as { format: "png" })
        const png = Buffer.from(data, "base64")
        const now = Date.now()
        const prev = frames.at(-1)
        // An unchanged shot just keeps the previous frame on screen longer, so the recording and stills skip repeats.
        if (prev?.png?.equals(png)) return
        if (prev) prev.delay = now - last
        frames.push({ png, delay: 80, offsetMs: now - t0, phase })
        last = now
      }
      /** Record one phase: at least the CSS duration, then until frames stop changing, never past the cap. */
      // The timing can arrive while recording: until it does, the phase runs to its cap.
      const recordPhase = async ({ min, max }: { min: number; max: number }, timing: Promise<number>, onTick?: (elapsed: number, least: number) => void) => {
        const from = Date.now()
        let least = max
        // No timing at all means the effect is instant or driven by script (which may start late): keep the full window.
        void timing.then((ms) => { least = ms > 0 ? Math.min(max, Math.max(min, ms + HOVER_CSS_PAD_MS)) : max }, () => {})
        for (let elapsed = 0; elapsed < max; elapsed = Date.now() - from) {
          if (elapsed >= least && Date.now() - Math.max(last, from) >= HOVER_QUIET_MS) break
          await grab()
          onTick?.(Date.now() - from, least)
        }
      }
      await grab()
      await takeMotion(page) // the resting state's; the clock restarts as the pointer arrives
      phase = "enter"
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 })
      const hoverMs = cssTiming()
      await recordPhase(HOVER_ENTER, hoverMs, (elapsed, least) => { if (elapsed > least / 2) phase = "hold" })
      frames[frames.length - 1]!.delay = 700
      phase = "leave"
      await page.mouse.move(2, 2, { steps: 4 })
      await recordPhase(HOVER_LEAVE, Promise.resolve(restMs))
      frames[frames.length - 1]!.delay = 900
      const motion = await takeMotion(page)

      // Skip effects that changed nothing visible (repeats were merged, so that leaves one frame).
      if (frames.length < 2) continue
      const scale = clip.width > 700 ? 2 : 1
      const recording = await encodeRecording(page.context().browser()!, frames, { scale, format: recordingFormat })
      seen.add(`${t.selector}|${t.label}`)
      out.push({ recording, label: t.label, selector: t.selector, frames, observedStyles, motion })
    } catch (e) {
      log("  hover capture skipped:", (e as Error).message.split("\n")[0])
    }
  }
  await cdp.detach().catch(() => {})
  return out
}

/** Fetch linked CSS, absolutize url()s and inline small web fonts. */
async function buildSnapshot(page: PwPage, context: BrowserContext) {
  const snap = await run<{ html: string; sheets: { href: string; inline: string | null }[]; token: string }>(page, SNAPSHOT_JS)
  let fontBytes = 0
  const fontCache = new Map<string, string>()

  const absolutize = (css: string, base: string) =>
    css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, u: string) => {
      if (/^(data:|#|about:)/i.test(u.trim())) return m
      try {
        return `url("${new URL(u.trim(), base).href}")`
      } catch {
        return m
      }
    })

  const inlineFonts = async (css: string) => {
    const blocks = css.match(/@font-face\s*{[^}]*}/g) ?? []
    for (const block of blocks) {
      let next = block
      const hasWoff2 = /format\(\s*['"]?woff2/.test(block) || /\.woff2/.test(block)
      const urls = [...block.matchAll(/url\("([^"]+)"\)/g)].map((m) => m[1]!)
      for (const u of urls) {
        if (u.startsWith("data:")) continue
        if (hasWoff2 && !/woff2/i.test(u)) continue
        let data = fontCache.get(u)
        if (!data && fontBytes < FONT_BUDGET) {
          try {
            const res = await context.request.get(u, { timeout: 10_000 })
            if (res.ok()) {
              const body = await res.body()
              fontBytes += body.length
              const mime = /woff2/i.test(u) ? "font/woff2" : /woff/i.test(u) ? "font/woff" : /otf/i.test(u) ? "font/otf" : "font/ttf"
              data = `data:${mime};base64,${body.toString("base64")}`
              fontCache.set(u, data)
            }
          } catch {
            /* leave remote */
          }
        }
        if (data) next = next.split(`url("${u}")`).join(`url("${data}")`)
      }
      css = css.replace(block, next)
    }
    return css
  }

  let html = snap.html
  for (let i = 0; i < snap.sheets.length; i++) {
    const s = snap.sheets[i]!
    let css = s.inline
    if (css == null) {
      try {
        const res = await context.request.get(s.href, { timeout: 15_000 })
        css = res.ok() ? await res.text() : `/* failed to fetch ${s.href} */`
      } catch {
        css = `/* failed to fetch ${s.href} */`
      }
    }
    css = await inlineFonts(absolutize(css, s.href))
    html = html.replace(`${snap.token}${i}__`, () => css!.replace(/<\/style/gi, "<\\/style"))
  }
  // Inline <style> blocks resolve against <base href>, but fonts still need inlining for CORS.
  html = await replaceAsync(html, /<style([^>]*)>([\s\S]*?)<\/style>/g, async (m, attrs: string, body: string) =>
    /@font-face/.test(body) && !/data-rs-href/.test(attrs) ? `<style${attrs}>${await inlineFonts(absolutize(body, page.url()))}</style>` : m,
  )
  return html
}

async function replaceAsync(s: string, re: RegExp, fn: (...m: string[]) => Promise<string>) {
  const parts: Promise<string>[] = []
  s.replace(re, (...m) => {
    parts.push(fn(...(m.slice(0, -2) as string[])))
    return ""
  })
  const done = await Promise.all(parts)
  let i = 0
  return s.replace(re, () => done[i++]!)
}

function mergeTokens(list: DesignTokens[]): DesignTokens | null {
  if (!list.length) return null
  const merge = (pick: (t: DesignTokens) => { value: string; count: number }[], n: number) => {
    const m = new Map<string, number>()
    for (const t of list) for (const v of pick(t)) m.set(v.value, (m.get(v.value) ?? 0) + v.count)
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([value, count]) => ({ value, count }))
  }
  const byNum = (a: { value: string }, b: { value: string }) => parseFloat(a.value) - parseFloat(b.value)
  const fonts = merge((t) => t.fonts.map((f) => ({ value: f.family, count: f.count })), 10).map((f) => ({ family: f.value, count: f.count }))
  return {
    colors: merge((t) => t.colors, 48),
    fonts,
    fontSizes: merge((t) => t.fontSizes, 24).sort(byNum),
    spacing: merge((t) => t.spacing, 24).sort(byNum),
    radii: merge((t) => t.radii, 16),
    shadows: merge((t) => t.shadows, 12),
    transitions: merge((t) => t.transitions, 24),
    keyframes: [...new Set(list.flatMap((t) => t.keyframes))],
    cssVariables: Object.assign({}, ...list.map((t) => t.cssVariables)),
  }
}

/** The saved sign-in a capture asked for: a Playwright storage-state file named by STORAGE_STATE. */
export function signedInState(env = process.env): string {
  const file = env.STORAGE_STATE
  if (!file) throw new Error("This capture uses your saved sign-in, but STORAGE_STATE isn't set in capture/.env. Create one with `npx playwright open --save-storage=auth.json <site>` and set STORAGE_STATE to its path.")
  if (!existsSync(file)) throw new Error(`STORAGE_STATE points at ${file}, which doesn't exist.`)
  return file
}

export async function captureJob(browser: Browser, api: SnipApi, job: Job) {
  await assertPublicUrl(job.url)
  const options = job.options ?? {}
  const colorScheme = options.colorScheme === "dark" ? "dark" : "light"
  const storageState = options.signedIn ? signedInState() : undefined
  const network = allowPrivateUrls() ? null : await createCaptureNetwork()
  const contexts: BrowserContext[] = []
  try {
    const common: BrowserContextOptions = { colorScheme, storageState, locale: "en-US", proxy: network?.proxy, serviceWorkers: "block" as const }
    const desktop = await browser.newContext({ ...common, viewport: { ...DESKTOP, width: options.desktopWidth ?? DESKTOP.width }, deviceScaleFactor: 1 })
    contexts.push(desktop)
    const mobile = await browser.newContext({ ...common, viewport: MOBILE, deviceScaleFactor: MOBILE_DPR, isMobile: true, hasTouch: true, userAgent: MOBILE_UA })
    contexts.push(mobile)
    await Promise.all(contexts.flatMap((context) => [context.addInitScript(HOLD_RESIZE_JS), context.addInitScript(OBSERVED_JS)]))
    await capturePages(browser, api, job, desktop, mobile, network)
  } finally {
    await Promise.allSettled(contexts.map(context => context.close()))
    await network?.close()
  }
}

async function capturePages(browser: Browser, api: SnipApi, job: Job, desktop: BrowserContext, mobile: BrowserContext, network: CaptureNetwork) {
  const root = new URL(job.url)
  const prefix = `refs/${job.id}/${job.attempt}`
  // Protocol 3 predates video. Missing capabilities mean the Worker still renders recordings as GIF images.
  const recordingFormat = Array.isArray(job.recordingFormats) && job.recordingFormats.includes("webm") ? "webm" : "gif"

  const resume = job.resume
  const start = normalize(root.href, root) ?? root.href
  const queue: string[] = resume ? [...resume.queue] : [start]
  const visited: string[] = resume ? [...resume.visited] : []
  const seen = new Set([...visited, ...queue])
  const titles = new Map<string, string | null>() // every page captured in this run, for duplicateOf; empty after a resume
  if (job.mode === "crawl" && !resume) {
    const urls = (await sitemapUrls(desktop, root)).flatMap((u) => normalize(u, root) ?? [])
    for (const { href } of rankLinks(urls.map((href) => ({ href, nav: false })))) {
      if (!seen.has(href)) {
        seen.add(href)
        queue.push(href)
      }
    }
  }

  // A resumed crawl picks up its counts and findings; its pages are already saved.
  const allTokens: DesignTokens[] = resume?.tokens ? [resume.tokens] : []
  let meta: CrawlState["meta"] = resume?.meta ?? null
  let coverKey: string | null = null
  let iconTask: Promise<void> | undefined
  let captured = resume?.captured ?? 0
  let failures = resume?.failures ?? 0
  let navLinksQueued = resume?.navLinksQueued ?? false
  const hoverSeen = new Set<string>(resume?.hoverSeen)
  // Live clips already uploaded in this run, by liveSignature. Not kept across a pause: a resumed crawl is a new
  // capture attempt, and its pages may only point at files under their own attempt's prefix.
  const liveSeen = new Map<string, LiveReuse>()
  // Sections and clips are only sent to a Worker that stores them; an older one would accept the files and drop them.
  const features = new Set(job.features ?? [])
  if (resume) log(`[${job.id}] resuming after ${captured} page(s)`)

  /** Between pages: honour a pause or stop the user asked for. A pause hands back where the crawl is. */
  const windDown = async (): Promise<"stop" | "paused" | null> => {
    try {
      for (let checks = 0; checks < 5; checks++) {
        const control = await api.control(job.id)
        if (control !== "pause") return control
        const state: CrawlState = {
          version: 1,
          queue: queue.slice(0, MAX_SAVED_QUEUE),
          visited,
          captured,
          failures,
          navLinksQueued,
          hoverSeen: [...hoverSeen],
          meta,
          tokens: mergeTokens(allTokens),
        }
        if (await api.pause(job.id, state)) return "paused"
        // The pause was cancelled or replaced by a stop meanwhile: check again.
      }
    } catch (e) {
      if (e instanceof JobGoneError) throw e
      // A missed check only delays the pause or stop until the next page.
      log("  control check failed:", (e as Error).message.split("\n")[0])
    }
    return null
  }

  let stopped = false
  while (queue.length && captured < job.maxPages) {
    const next = await windDown()
    if (next === "paused") {
      log(`[${job.id}] paused after ${captured} page(s)`)
      return
    }
    if (next === "stop") {
      stopped = true
      log(`[${job.id}] stopped after ${captured} page(s)`)
      break
    }
    const url = queue.shift()!
    visited.push(url)
    const ord = captured
    const path = new URL(url).pathname || "/"
    await api.progress(job.id, `Capturing ${captured + 1}/${job.mode === "crawl" ? `${Math.min(job.maxPages, captured + 1 + queue.length)}` : 1}: ${path}`)
    log(`[${job.id}] ${url}`)
    const p = `${prefix}/p${ord}`
    // Each viewport gets a fresh page that closes once captured. The mobile page loads and screenshots while
    // the desktop page records, so at most two of the site's renderers are alive at once.
    // The contexts live for the whole job and keep cookies (dismissed banners stay dismissed).
    const open: PwPage[] = []
    const newPage = async (context: BrowserContext) => { const page = await context.newPage(); open.push(page); return page }
    const closePages = () => Promise.allSettled(open.map((page) => page.close()))
    type MobileShots = { shot: { buf: Buffer; width: number; height: number }; thumb: Buffer; patches: number } | null
    let mobileTask: Promise<MobileShots> | undefined
    try {
      // ---- Desktop ----
      const dPage = await newPage(desktop)
      const status = await load(dPage, url, network)
      const pageMeta = await run<{ canonical: string | null; title: string | null; description: string | null; favicon: string | null; links: { href: string; nav: boolean }[] }>(dPage, META_JS)
      // Both checks run before any screenshots or recordings. A skipped URL stays in `visited`, so it is not queued again, and it is not counted as captured.
      // A crawled link that errored or redirected off the site (e.g. to a Slack invite) is not a page of it. The start page and single-page captures keep whatever they get.
      const skip = job.mode === "crawl" && url !== start ? skipReason(dPage.url(), status, root) : null
      if (skip) {
        log(`  - ${path} ${skip}, skipped`)
        continue
      }
      const duplicate = duplicateOf(url, dPage.url(), pageMeta.canonical, pageMeta.title, root, titles)
      if (duplicate) {
        log(`  - ${path} duplicates ${duplicate}, skipped`)
        continue
      }
      if (!meta) meta = pageMeta
      // The icon is saved beside the first page's own work, never ahead of it, and nothing waits for it. Its key replaces
      // the URL in `meta` when it lands, so the next pause checkpoint, or completion, carries whichever it has by then.
      // A resumed crawl whose checkpoint already holds the key (not a URL) keeps it; one that only has the URL tries once.
      if (features.has("icon") && !iconTask && meta.favicon && !meta.favicon.startsWith("refs/")) {
        iconTask = storeIcon(desktop, api, meta.favicon, prefix).then((key) => { if (key && meta) meta = { ...meta, favicon: key } })
      }

      if (job.mode === "crawl") {
        const links = rankLinks(pageMeta.links).flatMap((l) => normalize(l.href, root) ?? [])
        if (!navLinksQueued) {
          queue.splice(0, queue.length, ...promoteLinks(queue, links, visited))
          navLinksQueued = true
        } else queue.push(...new Set(links.filter((n) => !seen.has(n))))
        for (const n of links) seen.add(n)
      }

      // ---- Mobile, alongside the desktop recordings ----
      mobileTask = (async (): Promise<MobileShots> => {
        let mPage: PwPage | undefined
        try {
          mPage = await newPage(mobile)
          await load(mPage, url, network)
          await recordScroll(mPage, false)
          const shot = await fullPageShot(mPage, MOBILE_DPR)
          // Sections that look different in view are patched into the shot; mobile sections are not stored.
          const cuts = features.has("sections") ? await findSections(mPage) : []
          const inView: InView = { shot: shot.buf, patches: [], dpr: MOBILE_DPR }
          await recordLiveSections(mPage, cuts, "gif", undefined, inView)
          if (inView.patches.length) {
            shot.buf = await patchInView(shot.buf, inView.patches, MOBILE_DPR).catch((e) => {
              log("  mobile in-view patches skipped:", (e as Error).message.split("\n")[0])
              return shot.buf
            })
          }
          const thumb = await thumbnail(await mPage.screenshot({ type: "jpeg", quality: 75 }), THUMB_WIDTH.mobile)
          return { shot, thumb, patches: inView.patches.length }
        } catch (e) {
          log("  mobile capture failed:", (e as Error).message.split("\n")[0])
          return null
        } finally {
          // Free its renderer now, also after a failure, rather than when the desktop page is done.
          await mPage?.close().catch(() => {})
        }
      })()

      await run(dPage, MOTION_JS, { op: "install" }).catch(() => {})
      const scroll = await recordScroll(dPage, true, recordingFormat)
      const scrollMotion = await takeMotion(dPage)
      await dismissBanners(dPage) // popups that only appear after scrolling
      const desktopShot = await fullPageShot(dPage, 1)
      const sectionCuts = features.has("sections") ? (await findSections(dPage)).filter((s) => s.y < desktopShot.height) : []
      // Searchable text, read while the page is at the top like the section cuts it is matched to. Losing it loses only search.
      const text = features.has("text")
        ? await run<TextBlock[]>(dPage, TEXT_JS, { max: TEXT_LIMITS.blocks }).then((blocks) => pageText(blocks, sectionCuts), (e) => {
          log("  page text skipped:", (e as Error).message.split("\n")[0])
          return undefined
        })
        : undefined
      // In a crawl, only the first pages get clips: later pages mostly repeat the same chrome, at the same cost.
      const liveOn = features.has("live") && (job.mode !== "crawl" || captured < LIVE_CRAWL_PAGES)
      const inView: InView = { shot: desktopShot.buf, patches: [] }
      const liveClips = await recordLiveSections(dPage, sectionCuts, liveOn ? recordingFormat : "gif", liveSeen, inView)
      // Sections that look different scrolled into view replace their band in the full-page shot, before it is cut.
      if (inView.patches.length) {
        desktopShot.buf = await patchInView(desktopShot.buf, inView.patches).catch((e) => {
          log("  in-view patches skipped:", (e as Error).message.split("\n")[0])
          return desktopShot.buf
        })
      }
      const desktopThumb = await thumbnail(await dPage.screenshot({ type: "jpeg", quality: 75 }), THUMB_WIDTH.desktop)
      const other = features.has("schemes") ? await captureOtherScheme(dPage, job.options?.colorScheme === "dark" ? "dark" : "light") : null
      const styles = await run<{ tokens: DesignTokens }>(dPage, STYLES_JS, { maxElements: 3000 })
      const html = await buildSnapshot(dPage, desktop)
      const hovers = await recordHovers(dPage, hoverSeen, recordingFormat)
      await dPage.close()
      const mobileShots = await mobileTask
      const mobileShot = mobileShots?.shot ?? null
      const mobileThumb = mobileShots?.thumb ?? null

      network?.assertAllowed()

      // ---- Upload ----
      const animations: PageUpload["animations"] = []
      const stills = async (key: string, frames: Frame[], timing: "synthetic" | "measured", observed: Record<string, string> | null, motion: MotionEntry[]) => {
        try {
          const s = await buildStills(browser, api, key, frames, timing, observed)
          return { ...s, meta: s.meta && { ...s.meta, motion } }
        } catch (e) {
          log("  contact sheet skipped:", (e as Error).message.split("\n")[0])
          return { sheetKey: null, meta: null }
        }
      }
      if (scroll.recording) {
        const rec = scroll.recording
        animations.push({
          ...(await stills(`${p}/scroll`, scroll.frames, "synthetic", null, scrollMotion)),
          kind: "scroll",
          label: path === "/" ? "Home" : path,
          selector: null,
          viewport: "desktop",
          gifKey: await api.upload(`${p}/scroll.${rec.ext}`, rec.bytes, rec.contentType),
          width: rec.width,
          height: rec.height,
        })
      }
      for (let i = 0; i < hovers.length; i++) {
        const h = hovers[i]!
        animations.push({
          ...(await stills(`${p}/hover-${i}`, h.frames, "measured", h.observedStyles, h.motion)),
          kind: "hover",
          label: h.label,
          selector: h.selector,
          viewport: "desktop",
          gifKey: await api.upload(`${p}/hover-${i}.${h.recording.ext}`, h.recording.bytes, h.recording.contentType),
          width: h.recording.width,
          height: h.recording.height,
        })
      }

      // Cut from the full-page screenshot, which is clipped at MAX_SHOT_PX like the sections. A failed crop or section
      // upload loses the sections; a failed clip upload loses only that clip. Each upload is retried once.
      const uploadSections = async (): Promise<PageSection[] | undefined> => {
        if (!features.has("sections")) return undefined
        try {
          const crops = await cropBands(browser, desktopShot.buf, sectionCuts)
          // Sections recorded together share one clip, uploaded once; a clip from an earlier page is reused as is.
          const clipKeys = new Map<LiveClip, Promise<string | null>>()
          const clipKey = (clip: LiveClip, i: number) => {
            if (clip.reuse) return Promise.resolve(clip.reuse.key)
            if (!clipKeys.has(clip)) {
              const rec = clip.recording!
              clipKeys.set(clip, retryOnce(() => api.upload(`${p}/section-${i}-live.webm`, rec.bytes, rec.contentType)).then(
                (key) => {
                  if (clip.sig) liveSeen.set(clip.sig, { key, height: clip.height, durationMs: clip.durationMs, still: clip.still })
                  return key
                },
                (e) => {
                  if (e instanceof JobGoneError) throw e
                  log(`  live clip of "${sectionCuts[i]!.label}" not uploaded:`, (e as Error).message.split("\n")[0])
                  return null
                },
              ))
            }
            return clipKeys.get(clip)!
          }
          return await pool(sectionCuts, 4, async (s, i) => {
            const clip = liveClips[i]
            const key = clip ? await clipKey(clip, i) : null
            const live = clip && key ? { key, y: clip.y, height: clip.height, durationMs: clip.durationMs } : null
            const { fp: _fp, ...section } = s as SectionCut
            return { ...section, key: await retryOnce(() => api.upload(`${p}/section-${i}.jpg`, crops[i]!, "image/jpeg")), ...(live ? { live } : {}) }
          })
        } catch (e) {
          if (e instanceof JobGoneError) throw e
          log("  sections skipped:", (e as Error).message.split("\n")[0])
          return []
        }
      }
      // The other color scheme: its full-page shot, thumbnail and section crops cut at the same lines.
      const uploadOtherScheme = async (): Promise<PageUpload["altScheme"]> => {
        if (!other) return undefined
        try {
          // Sections that start below this scheme's (possibly shorter) page have no crop.
          const inside = sectionCuts.filter((s) => s.y < other.shot.height)
          const cropped = await cropBands(browser, other.shot.buf, inside)
          const crop = new Map(inside.map((s, n) => [s, cropped[n]!]))
          return {
            scheme: other.scheme,
            desktopKey: await retryOnce(() => api.upload(`${p}/desktop-${other.scheme}.jpg`, other.shot.buf, "image/jpeg")),
            desktopThumbKey: await retryOnce(() => api.upload(`${p}/desktop-${other.scheme}-thumb.jpg`, other.thumb, "image/jpeg")),
            desktopWidth: other.shot.width,
            desktopHeight: other.shot.height,
            sectionKeys: await pool(sectionCuts, 4, async (s, i) => {
              const img = crop.get(s)
              return img ? retryOnce(() => api.upload(`${p}/section-${i}-${other.scheme}.jpg`, img, "image/jpeg")) : null
            }),
          }
        } catch (e) {
          if (e instanceof JobGoneError) throw e
          log(`  ${other.scheme} scheme not uploaded:`, (e as Error).message.split("\n")[0])
          return undefined
        }
      }
      const upload: PageUpload = {
        url,
        path,
        title: pageMeta.title,
        ord,
        desktopKey: await api.upload(`${p}/desktop.jpg`, desktopShot.buf, "image/jpeg"),
        desktopThumbKey: await api.upload(`${p}/desktop-thumb.jpg`, desktopThumb, "image/jpeg"),
        desktopWidth: desktopShot.width,
        desktopHeight: desktopShot.height,
        mobileKey: mobileShot ? await api.upload(`${p}/mobile.jpg`, mobileShot.buf, "image/jpeg") : null,
        mobileThumbKey: mobileThumb ? await api.upload(`${p}/mobile-thumb.jpg`, mobileThumb, "image/jpeg") : null,
        mobileWidth: mobileShot?.width ?? null,
        mobileHeight: mobileShot?.height ?? null,
        snapshotKey: await uploadText(api, `${p}/snapshot.html`, html, "text/html; charset=utf-8", features.has("gzip")),
        stylesKey: await uploadText(api, `${p}/styles.json`, JSON.stringify(styles), "application/json", features.has("gzip")),
        tokens: styles.tokens,
        sections: await uploadSections(),
        altScheme: await uploadOtherScheme(),
        ...(text ? { text } : {}),
        animations,
      }
      await api.addPage(job.id, upload)
      coverKey ??= upload.desktopThumbKey
      allTokens.push(styles.tokens)
      captured++
      titles.set(url, pageMeta.title)
      log(`  ✓ ${path} (${animations.length} recordings, ${upload.sections?.length ?? 0} sections, ${new Set(liveClips.filter(Boolean)).size} live clips${other ? `, ${other.scheme} scheme` : ""}${inView.patches.length ? `, ${inView.patches.length} in-view patches` : ""}${mobileShots?.patches ? `, ${mobileShots.patches} mobile in-view patches` : ""})`)
    } catch (e) {
      network?.assertAllowed()
      if (e instanceof JobGoneError || e instanceof PrivateAddressError) throw e
      failures++
      log(`  ✗ ${url}: ${(e as Error).message.split("\n")[0]}`)
      if (captured === 0 && job.mode === "single") throw e
      if (failures > Math.max(5, job.maxPages)) throw e
    } finally {
      await Promise.allSettled([closePages(), closeRenderer()])
      // A desktop failure closes the mobile page above, which ends its task.
      await mobileTask
    }
  }

  network?.assertAllowed()
  if (!captured) throw new Error(stopped ? STOPPED_EMPTY : "No pages could be captured")
  await api.complete(job.id, {
    title: meta?.title ?? null,
    description: meta?.description ?? null,
    // The saved icon's key, or the site's icon URL when it isn't saved (the Worker keeps only a key; an older one keeps the URL).
    favicon: meta?.favicon ?? null,
    // A resumed crawl already has its cover from its first page; null keeps it.
    coverKey: resume?.captured ? null : coverKey,
    tokens: mergeTokens(allTokens),
  })
  log(`[${job.id}] done: ${captured} page(s)`)
}

/** For tests only. */
export const fullPageShotForTest = (page: PwPage) => fullPageShot(page, 1)
export const HOLD_RESIZE_FOR_TEST = HOLD_RESIZE_JS
export const OBSERVED_FOR_TEST = OBSERVED_JS
export const fullPageShotAtForTest = fullPageShot
