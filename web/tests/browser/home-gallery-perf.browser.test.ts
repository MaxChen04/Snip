// The home gallery with a big library: how many DOM elements and images it holds at each zoom, and how smooth
// panning and Ctrl+wheel zoom are. The counts are asserted (they are deterministic); the frame times are logged
// only, because software rendering in CI makes them too noisy to gate on. Run alone to read the numbers:
//   node --import tsx --test web/tests/browser/home-gallery-perf.browser.test.ts
import assert from "node:assert/strict"
import zlib from "node:zlib"
import { after, before, test } from "node:test"
import type { Page } from "playwright"
import type { PageWithRef, SavedImage, SectionItem } from "../../shared/types.ts"
import { sleep, startApp, until, type App, type Req } from "./harness.ts"

let app: App
before(async () => void (app = await startApp()))
after(async () => app?.stop())

// ---------------------------------------------------------------- seed

const NOW = Date.UTC(2026, 0, 1)
const created = (i: number) => new Date(NOW - i * 60_000).toISOString()
const ASPECTS = [1.6, 1.6, 0.8, 1.3, 1, 2.4, 1.6, 0.6, 1.2, 0.45, 3, 1.5]
const DOMAINS = ["alpha.test", "beta.test", "gamma.test", "delta.test", "epsilon.test", "zeta.test", "eta.test", "theta.test"]
const ref = (i: number) => ({ id: `r${i % DOMAINS.length}`, title: `Site ${i % DOMAINS.length}`, domain: DOMAINS[i % DOMAINS.length]!, favicon: null })

/** About 40% pages, 30% sections and 30% images, interleaved by date like the All feed. */
function seed(n: number) {
  const pages: PageWithRef[] = []
  const sections: SectionItem[] = []
  const images: SavedImage[] = []
  for (let i = 0; i < n; i++) {
    const kind = i % 10 < 4 ? "page" : i % 10 < 7 ? "section" : "image"
    if (kind === "page") {
      pages.push({
        id: `p${i}`,
        referenceId: ref(i).id,
        url: `https://${ref(i).domain}/p${i}`,
        path: `/p${i}`,
        title: `Page ${i}`,
        ord: 0,
        desktopKey: `pages/p${i}/desktop.jpg`,
        desktopThumbKey: `pages/p${i}/desktop-thumb.jpg`,
        desktopWidth: 1440,
        desktopHeight: 900,
        mobileKey: null,
        mobileThumbKey: null,
        mobileWidth: null,
        mobileHeight: null,
        snapshotKey: null,
        stylesKey: null,
        tokens: null,
        sections: [],
        altScheme: null,
        sectionsCaptured: true,
        collectionIds: [],
        createdAt: created(i),
        reference: ref(i),
      })
    } else if (kind === "section") {
      const aspect = ASPECTS[i % ASPECTS.length]!
      sections.push({
        id: `p${i}:0`,
        pageId: `p${i}`,
        referenceId: ref(i).id,
        index: 0,
        kind: "section",
        label: `Section ${i}`,
        key: `pages/p${i}/section-0.jpg`,
        width: 1440,
        height: Math.round(1440 / aspect),
        path: `/p${i}`,
        url: `https://${ref(i).domain}/p${i}`,
        reference: ref(i),
        createdAt: created(i),
      })
    } else {
      const aspect = ASPECTS[i % ASPECTS.length]!
      images.push({
        id: `i${i}`,
        title: `Image ${i}`,
        key: `uploads/i${i}/original.png`,
        thumbKey: `uploads/i${i}/thumb.jpg`,
        width: 800,
        height: Math.round(800 / aspect),
        mime: "image/png",
        palette: [],
        collectionIds: [],
        createdAt: created(i),
      })
    }
  }
  return { pages, sections, images }
}

// ---------------------------------------------------------------- generated thumbnails

/** A PNG with horizontal colour bands: real pixels for the browser to decode, a few hundred bytes on the wire. */
function bandedPng(w: number, h: number, hue: number) {
  const rows = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    const o = y * (w * 3 + 1)
    const band = Math.floor(y / 40) % 2
    const rgb = [(hue * 53 + band * 70) % 256, (hue * 97 + 90) % 256, (hue * 31 + band * 40 + 60) % 256]
    for (let x = 0; x < w; x++) rows.set(rgb, o + 1 + x * 3)
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(body))
    return Buffer.concat([len, body, crc])
  }
  const head = Buffer.alloc(13)
  head.writeUInt32BE(w, 0)
  head.writeUInt32BE(h, 4)
  head.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", head), chunk("IDAT", zlib.deflateSync(rows)), chunk("IEND", Buffer.alloc(0))])
}
const THUMBS = Array.from({ length: 8 }, (_, hue) => bandedPng(960, 600, hue))

// ---------------------------------------------------------------- measuring

type Frames = { n: number; p50: number; p95: number; max: number; over33: number; over100: number }
const q = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!
function stats(deltas: number[]): Frames {
  const s = [...deltas].sort((a, b) => a - b)
  const r = (x: number) => Math.round(x * 10) / 10
  return { n: s.length, p50: r(q(s, 0.5)), p95: r(q(s, 0.95)), max: r(s.at(-1)!), over33: s.filter((d) => d > 33.4).length, over100: s.filter((d) => d > 100).length }
}

/** requestAnimationFrame deltas in ms while `work` runs, plus a short tail for whatever it leaves behind. */
async function frames(page: Page, work: () => Promise<void>): Promise<Frames> {
  // A string, not a function: tsx names arrow functions with a helper the page does not have.
  await page.evaluate(`(() => {
    window.__f = []
    window.__run = true
    let last = performance.now()
    const loop = (t) => {
      window.__f.push(t - last)
      last = t
      if (window.__run) requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
  })()`)
  await work()
  await sleep(300)
  const deltas = await page.evaluate<number[]>(`(() => { window.__run = false; return window.__f.slice(2) })()`)
  return stats(deltas)
}

const counts = (page: Page) =>
  page.evaluate(() => ({
    elements: document.getElementsByTagName("*").length,
    images: document.images.length,
    buttons: document.querySelectorAll("#root button, #root a").length,
  }))

/**
 * Keyboard and screen-reader view of the tiles: the ones a screen reader meets are the origin copy's, in tab order
 * (newest first); every repeated copy is hidden from both. Returns the labels in DOM order and any violation.
 */
async function audit(page: Page) {
  return page.evaluate<{ tabbable: number[]; announced: number; copies: number; leaks: number }>(`(() => {
    const out = { tabbable: [], announced: 0, copies: 0, leaks: 0 }
    for (const el of document.querySelectorAll("[aria-roledescription=canvas] button[aria-label], [aria-roledescription=canvas] a[aria-label]")) {
      const m = /^(?:Page|Section|Image) (\\d+)/.exec(el.getAttribute("aria-label") || "")
      if (!m) continue
      if (el.closest("[aria-hidden=true]")) {
        out.copies++
        if (el.tabIndex >= 0) out.leaks++
      } else {
        out.announced++
        if (el.tabIndex < 0) out.leaks++
        else out.tabbable.push(Number(m[1]))
      }
    }
    return out
  })()`)
}

/** One drag across the canvas in small steps, then a pause so no fling follows. */
async function drag(page: Page, from: [number, number], to: [number, number], steps = 60) {
  await page.mouse.move(...from)
  await page.mouse.down()
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps)
    await sleep(8)
  }
  await sleep(90)
  await page.mouse.up()
}

async function pan(page: Page, bounce = 3) {
  for (let r = 0; r < bounce; r++) {
    const dir = r % 2 ? -1 : 1
    await drag(page, [dir > 0 ? 200 : 900, 520], [dir > 0 ? 900 : 200, 300])
  }
}

/** Ctrl+wheel in `ticks` events 16 ms apart, around the middle of the canvas. */
async function wheelZoom(page: Page, deltaY: number, ticks: number) {
  await page.mouse.move(640, 420)
  await page.keyboard.down("Control")
  for (let i = 0; i < ticks; i++) {
    await page.mouse.wheel(0, deltaY)
    await sleep(16)
  }
  await page.keyboard.up("Control")
}

const zoomPct = async (page: Page) => Number(((await page.getByRole("button", { name: /^Zoom \d+%/ }).innerText()).match(/\d+/) ?? ["0"])[0])

// ---------------------------------------------------------------- the benchmark

function checkTabOrder(a: Awaited<ReturnType<typeof audit>>, at: string) {
  assert.ok(a.tabbable.length > 0, `tiles are in the tab order at ${at}`)
  assert.equal(a.leaks, 0, `at ${at}: announced tiles are focusable and repeated copies are not`)
  assert.deepEqual(a.tabbable, [...a.tabbable].sort((x, y) => x - y), `at ${at}: tab order is newest first`)
  assert.equal(new Set(a.tabbable).size, a.tabbable.length, `at ${at}: each item is announced once`)
}

type Report = {
  items: number
  at100: { elements: number; images: number; tabbable: number }
  at25: { elements: number; images: number; tabbable: number }
  pan100: Frames
  zoomOut: Frames
  zoomIn: Frames
  pan25: Frames
}

async function run(n: number): Promise<Report> {
  const { pages, sections, images } = seed(n)
  const t = await app.session({ viewport: { width: 1280, height: 800 } })
  const { page } = t
  const paged = (all: unknown[]) => ({ query }: Req) => {
    const from = Number(query.get("cursor") ?? 0)
    const limit = Number(query.get("limit") ?? 30)
    return { json: { items: all.slice(from, from + limit), nextCursor: from + limit < all.length ? String(from + limit) : null } }
  }
  t.on("GET", "/api/pages", paged(pages))
  t.on("GET", "/api/sections", paged(sections))
  t.on("GET", "/api/images", paged(images))
  t.on("GET", "/api/counts", () => ({ json: { websites: 0, pages: pages.length, sections: sections.length, animations: 0, images: images.length } }))
  // Registered after the harness's own /files/ stub, so this one answers.
  await page.route(/\/files\//, (route) => {
    const hue = [...new URL(route.request().url()).pathname].reduce((s, c) => s + c.charCodeAt(0), 0) % THUMBS.length
    return route.fulfill({ status: 200, contentType: "image/png", body: THUMBS[hue]!, headers: { "cache-control": "max-age=3600" } })
  })

  await t.goto("/")
  await page.getByRole("button", { name: /^Zoom \d+%/ }).waitFor()
  await until("tiles are on the canvas", async () => (await counts(page)).images > 20)
  await sleep(1200)
  assert.equal(await zoomPct(page), 100)
  const at100 = await counts(page)
  const a100 = await audit(page)
  checkTabOrder(a100, "100%")

  const pan100 = await frames(page, () => pan(page))

  // About 12 % per tick: the whole range in a dozen ticks, like a trackpad pinch. More ticks than that are sent,
  // because a busy page drops some, and the extra ones at the limit do nothing.
  const zoomOut = await frames(page, () => wheelZoom(page, 12, 24))
  await until("zoomed all the way out", async () => (await zoomPct(page)) === 25)
  const at25 = await counts(page)
  const a25 = await audit(page)
  checkTabOrder(a25, "25%")
  const pan25 = await frames(page, () => pan(page))
  const zoomIn = await frames(page, () => wheelZoom(page, -12, 24))
  await until("zoomed back in", async () => (await zoomPct(page)) >= 100)
  assert.deepEqual(t.consoleErrors, [])
  await page.context().close()
  return {
    items: n,
    at100: { elements: at100.elements, images: at100.images, tabbable: a100.tabbable.length },
    at25: { elements: at25.elements, images: at25.images, tabbable: a25.tabbable.length },
    pan100,
    zoomOut,
    zoomIn,
    pan25,
  }
}

function log(r: Report) {
  const row = (name: string, f: Frames) => `${name.padEnd(12)} p50 ${String(f.p50).padStart(5)}  p95 ${String(f.p95).padStart(6)}  max ${String(f.max).padStart(6)}  >33ms ${String(f.over33).padStart(3)}  >100ms ${String(f.over100).padStart(3)}  (${f.n} frames)`
  console.log(
    [
      `home gallery, ${r.items} items`,
      `  100%: ${r.at100.elements} elements, ${r.at100.images} images, ${r.at100.tabbable} tiles in tab order`,
      `   25%: ${r.at25.elements} elements, ${r.at25.images} images, ${r.at25.tabbable} tiles in tab order`,
      "  " + row("pan 100%", r.pan100),
      "  " + row("zoom out", r.zoomOut),
      "  " + row("zoom in", r.zoomIn),
      "  " + row("pan 25%", r.pan25),
    ].join("\n"),
  )
  console.log(`PERF ${JSON.stringify(r)}`)
}

test("200 items: the zoomed-out gallery stays light", { timeout: 180_000 }, async () => {
  const r = await run(200)
  log(r)
  assert.ok(r.at100.elements < 1500, `${r.at100.elements} elements at 100%`)
})

test("1000 items: panning at 100% stays light", { timeout: 240_000 }, async () => {
  const r = await run(1000)
  log(r)
  assert.ok(r.at100.elements < 1500, `${r.at100.elements} elements at 100%`)
})
