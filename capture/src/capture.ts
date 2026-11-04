import { readFileSync } from "node:fs"
import type { Browser, BrowserContext, Page as PwPage } from "playwright"
import type { CrawlState, DesignTokens, Job, PageUpload } from "../../web/shared/types"
import { STOPPED_EMPTY } from "../../web/shared/capture-errors"
import { JobGoneError, type SnipApi } from "./api"
import { encodeGif, type Frame } from "./gif"
import { buildStills } from "./sheet"

// In-page scripts live in plain .js files so the TS toolchain can't inject helpers into them.
const script = (name: string) => readFileSync(new URL(`./inpage/${name}.js`, import.meta.url), "utf8")
const STYLES_JS = script("styles")
const SNAPSHOT_JS = script("snapshot")
const HOVER_JS = script("hover-targets")
const META_JS = script("meta")
const DISMISS_JS = script("dismiss")
const DISMISS_POPUPS = process.env.DISMISS_POPUPS !== "false"
const run = <T>(page: PwPage, source: string, arg?: unknown) => page.evaluate(`(${source})(${JSON.stringify(arg ?? null)})`) as Promise<T>

const DESKTOP = { width: 1440, height: 900 }
const MOBILE = { width: 390, height: 844 }
const MOBILE_DPR = 1.5
const MAX_SHOT_PX = 16000 // Chromium texture limit for full-page screenshots
// Scroll GIF: frames are captured at fixed scroll increments and played back at a fixed rate,
// so playback is smooth no matter how long each screenshot took.
const SCROLL_FPS = Math.min(50, Math.max(5, Number(process.env.SCROLL_FPS ?? 30)))
const SCROLL_STEP = Math.max(8, Number(process.env.SCROLL_STEP ?? 40)) // px per frame at 1440 wide
const MAX_SCROLL_FRAMES = Math.max(20, Number(process.env.SCROLL_MAX_FRAMES ?? 360))
const MAX_HOVER_GIFS = 6
const MAX_SAVED_QUEUE = 2000 // URLs kept when a crawl pauses
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

async function load(page: PwPage, url: string) {
  await page.goto(url, { waitUntil: "load", timeout: 45_000 })
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

const docHeight = (page: PwPage) => page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0))

/** Scroll through the page recording frames; also triggers lazy loading and scroll-reveal content. */
export async function recordScroll(page: PwPage, record: boolean): Promise<Frame[]> {
  const frames: Frame[] = []
  const vh = page.viewportSize()!.height
  let height = await docHeight(page)
  const travel = Math.max(0, height - vh)
  // Small fixed steps for smooth motion; long pages take bigger steps to stay under the frame cap.
  const step = record ? Math.max(SCROLL_STEP, Math.ceil(travel / (MAX_SCROLL_FRAMES - 1))) : 400
  const delay = Math.round(1000 / SCROLL_FPS)
  // Raw CDP with optimizeForSpeed is ~3-4x faster than page.screenshot for PNG frames.
  const cdp = record ? await page.context().newCDPSession(page) : null
  const shot = async () => {
    const { data } = await cdp!.send("Page.captureScreenshot", { format: "png", optimizeForSpeed: true } as { format: "png" })
    return Buffer.from(data, "base64")
  }
  for (let y = 0; ; y += step) {
    await page.evaluate((top) => window.scrollTo({ top, behavior: "instant" as ScrollBehavior }), y)
    await sleep(record ? 30 : 60)
    if (record) {
      const scrollY = await page.evaluate(() => Math.round(window.scrollY))
      frames.push({ png: await shot(), delay, scrollY, phase: "scroll" })
    }
    height = await docHeight(page) // infinite/lazy pages can grow
    if (y >= Math.min(height, 40_000) - vh || (record && frames.length >= MAX_SCROLL_FRAMES)) break
  }
  await cdp?.detach().catch(() => {})
  if (frames.length) {
    frames[0]!.delay = 700 // beat at the top before it starts moving
    frames[frames.length - 1]!.delay = 1200
  }
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior }))
  await sleep(400)
  return frames
}

async function fullPageShot(page: PwPage, dpr: number) {
  const height = await docHeight(page)
  const width = page.viewportSize()!.width
  const clipH = Math.min(height, Math.floor(MAX_SHOT_PX / dpr))
  const buf = await page.screenshot({ type: "jpeg", quality: 80, fullPage: true, clip: { x: 0, y: 0, width, height: clipH } })
  return { buf, width: Math.round(width * dpr), height: Math.round(clipH * dpr) }
}

async function recordHovers(page: PwPage, seen: Set<string>) {
  const found = await run<{ i: number; label: string; selector: string }[]>(page, HOVER_JS, { max: MAX_HOVER_GIFS * 2 })
  // Shared chrome (nav links, footer buttons) repeats on every page: record each effect once per site.
  const targets = found.filter((t) => !seen.has(`${t.selector}|${t.label}`)).slice(0, MAX_HOVER_GIFS)
  const out: { gif: Buffer; width: number; height: number; label: string; selector: string; frames: Frame[]; observedStyles: Record<string, string> | null }[] = []
  for (const t of targets) {
    try {
      const el = page.locator(`[data-rs-hover="${t.i}"]`).first()
      await el.scrollIntoViewIfNeeded({ timeout: 2000 })
      await page.mouse.move(2, 2)
      await sleep(350)
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

      const frames: Frame[] = []
      const t0 = Date.now()
      let last = t0
      let phase: Frame["phase"] = "rest"
      const grab = async () => {
        const png = await page.screenshot({ type: "png", clip })
        const now = Date.now()
        if (frames.length) frames[frames.length - 1]!.delay = now - last
        frames.push({ png, delay: 80, offsetMs: now - t0, phase })
        last = now
      }
      await grab()
      phase = "enter"
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 })
      const start = Date.now()
      while (Date.now() - start < 900) {
        await grab()
        if (Date.now() - start > 450) phase = "hold"
      }
      frames[frames.length - 1]!.delay = 700
      phase = "leave"
      await page.mouse.move(2, 2, { steps: 4 })
      const leave = Date.now()
      while (Date.now() - leave < 600) await grab()
      frames[frames.length - 1]!.delay = 900

      // Skip effects that changed nothing visible.
      if (frames.every((f) => f.png.equals(frames[0]!.png))) continue
      const scale = clip.width > 700 ? 2 : 1
      const gif = encodeGif(frames, { scale })
      seen.add(`${t.selector}|${t.label}`)
      out.push({ gif: gif.bytes, width: gif.width, height: gif.height, label: t.label, selector: t.selector, frames, observedStyles })
    } catch (e) {
      log("  hover capture skipped:", (e as Error).message.split("\n")[0])
    }
  }
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

export async function captureJob(browser: Browser, api: SnipApi, job: Job) {
  const root = new URL(job.url)
  const prefix = `refs/${job.id}/${job.attempt}`
  const desktop = await browser.newContext({ viewport: DESKTOP, deviceScaleFactor: 1, colorScheme: "light", locale: "en-US" })
  const mobile = await browser.newContext({
    viewport: MOBILE,
    deviceScaleFactor: MOBILE_DPR,
    isMobile: true,
    hasTouch: true,
    userAgent: MOBILE_UA,
    colorScheme: "light",
    locale: "en-US",
  })
  const dPage = await desktop.newPage()
  const mPage = await mobile.newPage()

  const resume = job.resume
  const queue: string[] = resume ? [...resume.queue] : [normalize(root.href, root) ?? root.href]
  const visited: string[] = resume ? [...resume.visited] : []
  const seen = new Set([...visited, ...queue])
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
  try {
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
      try {
        // ---- Desktop ----
        await load(dPage, url)
        const pageMeta = await run<{ title: string | null; description: string | null; favicon: string | null; links: { href: string; nav: boolean }[] }>(dPage, META_JS)
        if (!meta) meta = pageMeta

        if (job.mode === "crawl") {
          // Nav/header/footer links first (they are the site's main pages), then the rest.
          const links = [...pageMeta.links].sort((a, b) => Number(b.nav) - Number(a.nav))
          const fresh: string[] = []
          for (const l of links) {
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

        const scrollFrames = await recordScroll(dPage, true)
        await dismissBanners(dPage) // popups that only appear after scrolling
        const desktopShot = await fullPageShot(dPage, 1)
        const desktopThumb = await dPage.screenshot({ type: "jpeg", quality: 75 })
        const styles = await run<{ tokens: DesignTokens }>(dPage, STYLES_JS, { maxElements: 3000 })
        const html = await buildSnapshot(dPage, desktop)
        const hovers = await recordHovers(dPage, hoverSeen)

        // ---- Mobile ----
        let mobileShot: { buf: Buffer; width: number; height: number } | null = null
        let mobileThumb: Buffer | null = null
        try {
          await load(mPage, url)
          await recordScroll(mPage, false)
          mobileShot = await fullPageShot(mPage, MOBILE_DPR)
          mobileThumb = await mPage.screenshot({ type: "jpeg", quality: 75 })
        } catch (e) {
          log("  mobile capture failed:", (e as Error).message.split("\n")[0])
        }

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
        if (scrollFrames.length > 1) {
          const gif = encodeGif(scrollFrames, { scale: 2 })
          animations.push({
            ...(await stills(`${p}/scroll`, scrollFrames, "synthetic", null)),
            kind: "scroll",
            label: path === "/" ? "Home" : path,
            selector: null,
            viewport: "desktop",
            gifKey: await api.upload(`${p}/scroll.gif`, gif.bytes, "image/gif"),
            width: gif.width,
            height: gif.height,
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
            gifKey: await api.upload(`${p}/hover-${i}.gif`, h.gif, "image/gif"),
            width: h.width,
            height: h.height,
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
        log(`  ✓ ${path} (${animations.length} GIFs)`)
      } catch (e) {
        if (e instanceof JobGoneError) throw e
        failures++
        log(`  ✗ ${url}: ${(e as Error).message.split("\n")[0]}`)
        if (captured === 0 && job.mode === "single") throw e
        if (failures > Math.max(5, job.maxPages)) throw e
      }
    }

    if (!captured) throw new Error(stopped ? STOPPED_EMPTY : "No pages could be captured")
    await api.complete(job.id, {
      title: meta?.title ?? null,
      description: meta?.description ?? null,
      favicon: meta?.favicon ?? null,
      coverKey,
      tokens: mergeTokens(allTokens),
    })
    log(`[${job.id}] done: ${captured} page(s)`)
  } finally {
    await desktop.close().catch(() => {})
    await mobile.close().catch(() => {})
  }
}
