import { existsSync, readFileSync } from "node:fs"
import sharp from "sharp"
import type { Browser, BrowserContext, BrowserContextOptions, CDPSession, Page as PwPage } from "playwright"
import type { CrawlState, DesignTokens, Job, PageUpload } from "../../web/shared/types"
import { JobGoneError, type SnipApi } from "./api"
import type { Frame } from "./gif"
import { allowPrivateUrls, assertPublicUrl, createCaptureNetwork, PrivateAddressError } from "./network-guard"
import { buildStills, closeRenderer, sampleIndexes } from "./sheet"
import { encodeRecording, recordingWriter, type Recording } from "./video"

// In-page scripts live in plain .js files so the TS toolchain can't inject helpers into them.
const script = (name: string) => readFileSync(new URL(`./inpage/${name}.js`, import.meta.url), "utf8")
const STYLES_JS = script("styles")
const SNAPSHOT_JS = script("snapshot")
const HOVER_JS = script("hover-targets")
const META_JS = script("meta")
const DISMISS_JS = script("dismiss")
const TRANSITION_JS = script("transition-ms")
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
const HIGH_VALUE = /^\/(pricing|enterprise|products?|features|about|customers|solutions)(\/|$)/i

/**
 * A page's links in the order to capture them, so a crawl that hits max_pages has seen the pages worth
 * keeping: well-known pages first, login/legal/careers pages last (but still queued), then nav/header/footer
 * links before the rest and shallow paths before deep ones. Ties keep DOM order.
 */
export function rankLinks<L extends { href: string; nav: boolean }>(links: L[]): L[] {
  const score = ({ href, nav }: L) => {
    const path = new URL(href).pathname
    const tier = LOW_VALUE.test(path) ? 2 : HIGH_VALUE.test(path) ? 0 : 1
    return tier * 1000 + (nav ? 0 : 100) + Math.min(path.split("/").filter(Boolean).length, 99)
  }
  return links.map((l) => ({ l, s: score(l) })).sort((a, b) => a.s - b.s).map(({ l }) => l)
}

/**
 * The page this one duplicates, or null. Redirecting to a different same-site URL the crawl has already been
 * through always counts. A canonical link counts only when the page it names was captured in this run with the
 * same title (`titles`), because some sites declare one canonical on every route.
 */
export function duplicateOf(
  url: string,
  finalUrl: string,
  canonical: string | null,
  title: string | null,
  root: URL,
  visited: string[],
  titles: Map<string, string>,
): string | null {
  const redirect = normalize(finalUrl, root)
  if (redirect && redirect !== url && visited.includes(redirect)) return redirect
  const target = canonical && normalize(canonical, root)
  if (target && target !== url && titles.get(target) === title) return target
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

async function load(page: PwPage, url: string, network: CaptureNetwork) {
  try {
    await page.goto(url, { waitUntil: "load", timeout: 45_000 })
  } catch (error) {
    network?.assertAllowed()
    throw error
  }
  network?.assertAllowed()
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {})
  await dismissBanners(page)
  await page.evaluate(() => document.fonts?.ready).catch(() => {})
  await sleep(600)
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

async function fullPageShot(page: PwPage, dpr: number) {
  const height = await docHeight(page)
  const width = page.viewportSize()!.width
  const clipH = Math.min(height, Math.floor(MAX_SHOT_PX / dpr))
  const buf = await page.screenshot({ type: "jpeg", quality: 80, fullPage: true, clip: { x: 0, y: 0, width, height: clipH } })
  return { buf, width: Math.round(width * dpr), height: Math.round(clipH * dpr) }
}

async function recordHovers(page: PwPage, seen: Set<string>, recordingFormat: Recording["ext"]) {
  const found = await run<{ i: number; label: string; selector: string }[]>(page, HOVER_JS, { max: MAX_HOVERS * 2 })
  // Shared chrome (nav links, footer buttons) repeats on every page: record each effect once per site.
  const targets = found.filter((t) => !seen.has(`${t.selector}|${t.label}`)).slice(0, MAX_HOVERS)
  const out: { recording: Recording; label: string; selector: string; frames: Frame[]; observedStyles: Record<string, string> | null }[] = []
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
        void timing.then((ms) => { least = Math.min(max, Math.max(min, ms + HOVER_CSS_PAD_MS)) }, () => {})
        for (let elapsed = 0; elapsed < max; elapsed = Date.now() - from) {
          if (elapsed >= least && Date.now() - Math.max(last, from) >= HOVER_QUIET_MS) break
          await grab()
          onTick?.(Date.now() - from, least)
        }
      }
      await grab()
      phase = "enter"
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 })
      const hoverMs = cssTiming()
      await recordPhase(HOVER_ENTER, hoverMs, (elapsed, least) => { if (elapsed > least / 2) phase = "hold" })
      frames[frames.length - 1]!.delay = 700
      phase = "leave"
      await page.mouse.move(2, 2, { steps: 4 })
      await recordPhase(HOVER_LEAVE, Promise.resolve(restMs))
      frames[frames.length - 1]!.delay = 900

      // Skip effects that changed nothing visible (repeats were merged, so that leaves one frame).
      if (frames.length < 2) continue
      const scale = clip.width > 700 ? 2 : 1
      const recording = await encodeRecording(page.context().browser()!, frames, { scale, format: recordingFormat })
      seen.add(`${t.selector}|${t.label}`)
      out.push({ recording, label: t.label, selector: t.selector, frames, observedStyles })
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
  const queue: string[] = resume ? [...resume.queue] : [normalize(root.href, root) ?? root.href]
  const visited: string[] = resume ? [...resume.visited] : []
  const seen = new Set([...visited, ...queue])
  const titles = new Map<string, string>() // pages captured in this run, for duplicateOf; empty after a resume
  if (job.mode === "crawl" && !resume) {
    for (const u of await sitemapUrls(desktop, root)) {
      const n = normalize(u, root)
      if (n && !seen.has(n)) {
        seen.add(n)
        queue.push(n)
      }
    }
  }

  // A resumed crawl picks up its counts and findings; its pages are already saved.
  const allTokens: DesignTokens[] = resume?.tokens ? [resume.tokens] : []
  let meta: CrawlState["meta"] = resume?.meta ?? null
  let coverKey: string | null = null
  let captured = resume?.captured ?? 0
  let failures = resume?.failures ?? 0
  let navLinksQueued = resume?.navLinksQueued ?? false
  const hoverSeen = new Set<string>(resume?.hoverSeen)
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
    type MobileShots = { shot: { buf: Buffer; width: number; height: number }; thumb: Buffer } | null
    let mobileTask: Promise<MobileShots> | undefined
    try {
      // ---- Desktop ----
      const dPage = await newPage(desktop)
      await load(dPage, url, network)
      const pageMeta = await run<{ canonical: string | null; title: string | null; description: string | null; favicon: string | null; links: { href: string; nav: boolean }[] }>(dPage, META_JS)
      // Before any screenshots or recordings. The URL stays in `visited`, so it is not queued again, and it is not counted as captured.
      const duplicate = duplicateOf(url, dPage.url(), pageMeta.canonical, pageMeta.title, root, visited, titles)
      if (duplicate) {
        log(`  - ${path} duplicates ${duplicate}, skipped`)
        continue
      }
      if (!meta) meta = pageMeta

      if (job.mode === "crawl") {
        const fresh: string[] = []
        for (const l of rankLinks(pageMeta.links)) {
          const n = normalize(l.href, root)
          if (n && !seen.has(n)) {
            seen.add(n)
            fresh.push(n)
          }
        }
        // Links from the first page outrank sitemap order.
        if (!navLinksQueued) {
          queue.unshift(...fresh)
          navLinksQueued = true
        } else queue.push(...fresh)
      }

      // ---- Mobile, alongside the desktop recordings ----
      mobileTask = (async (): Promise<MobileShots> => {
        try {
          const mPage = await newPage(mobile)
          await load(mPage, url, network)
          await recordScroll(mPage, false)
          const shot = await fullPageShot(mPage, MOBILE_DPR)
          const thumb = await thumbnail(await mPage.screenshot({ type: "jpeg", quality: 75 }), THUMB_WIDTH.mobile)
          await mPage.close()
          return { shot, thumb }
        } catch (e) {
          log("  mobile capture failed:", (e as Error).message.split("\n")[0])
          return null
        }
      })()

      const scroll = await recordScroll(dPage, true, recordingFormat)
      await dismissBanners(dPage) // popups that only appear after scrolling
      const desktopShot = await fullPageShot(dPage, 1)
      const desktopThumb = await thumbnail(await dPage.screenshot({ type: "jpeg", quality: 75 }), THUMB_WIDTH.desktop)
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
      const stills = async (key: string, frames: Frame[], timing: "synthetic" | "measured", observed: Record<string, string> | null) => {
        try {
          return await buildStills(browser, api, key, frames, timing, observed)
        } catch (e) {
          log("  contact sheet skipped:", (e as Error).message.split("\n")[0])
          return { sheetKey: null, meta: null }
        }
      }
      if (scroll.recording) {
        const rec = scroll.recording
        animations.push({
          ...(await stills(`${p}/scroll`, scroll.frames, "synthetic", null)),
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
          ...(await stills(`${p}/hover-${i}`, h.frames, "measured", h.observedStyles)),
          kind: "hover",
          label: h.label,
          selector: h.selector,
          viewport: "desktop",
          gifKey: await api.upload(`${p}/hover-${i}.${h.recording.ext}`, h.recording.bytes, h.recording.contentType),
          width: h.recording.width,
          height: h.recording.height,
        })
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
        snapshotKey: await api.upload(`${p}/snapshot.html`, html, "text/html; charset=utf-8"),
        stylesKey: await api.upload(`${p}/styles.json`, JSON.stringify(styles), "application/json"),
        tokens: styles.tokens,
        animations,
      }
      await api.addPage(job.id, upload)
      coverKey ??= upload.desktopThumbKey
      allTokens.push(styles.tokens)
      captured++
      if (pageMeta.title) titles.set(url, pageMeta.title)
      log(`  ✓ ${path} (${animations.length} recordings)`)
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
    favicon: meta?.favicon ?? null,
    // A resumed crawl already has its cover from its first page; null keeps it.
    coverKey: resume?.captured ? null : coverKey,
    tokens: mergeTokens(allTokens),
  })
  log(`[${job.id}] done: ${captured} page(s)`)
}
