// The home gallery with a big library (200 and 1000 captured pages, mocked with generated 960 x 600 JPEG thumbnails):
// how many DOM elements and images it holds at 100% and 25% zoom, and how smooth panning and Ctrl+wheel zoom are, as
// requestAnimationFrame deltas. The counts and the will-change and tab-order checks are asserted, because they do not
// depend on the machine; the frame times are only logged, because software rendering on a shared machine makes them
// too noisy to gate on. It runs against the Vite dev server (development React, which is slower than the build), so
// treat the numbers as a ceiling. Run it alone to read them:
//   node --import tsx --test web/tests/browser/home-gallery-perf.browser.test.ts
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import type { Page } from "playwright"
import type { PageWithRef, SavedImage, SectionItem } from "../../shared/types.ts"
import { reference, sleep, startApp, until, type App, type Req } from "./harness.ts"

let app: App
let thumbs: Buffer[]
before(async () => {
  app = await startApp()
  thumbs = await makeThumbs()
})
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

/**
 * Eight 960 x 600 JPEGs like the ones the capture agent stores (desktop-thumb.jpg): coloured bands under a few
 * hundred small blocks, so the browser has real pixels to decode. Drawn and encoded by the browser itself.
 */
async function makeThumbs(): Promise<Buffer[]> {
  const t = await app.session()
  // A string, not a function: tsx names arrow functions with a helper the page does not have.
  const urls = await t.page.evaluate<string[]>(`(() => {
    const out = []
    for (let hue = 0; hue < 8; hue++) {
      const c = document.createElement("canvas")
      c.width = 960
      c.height = 600
      const g = c.getContext("2d")
      for (let y = 0; y < 600; y += 40) {
        g.fillStyle = "hsl(" + (hue * 45) + " 45% " + (y % 80 ? 82 : 70) + "%)"
        g.fillRect(0, y, 960, 40)
      }
      let seed = hue + 1
      const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
      for (let i = 0; i < 300; i++) {
        g.fillStyle = "hsl(" + Math.floor(rnd() * 360) + " " + Math.floor(rnd() * 60) + "% " + Math.floor(20 + rnd() * 70) + "%)"
        g.fillRect(rnd() * 900, rnd() * 560, 8 + rnd() * 90, 6 + rnd() * 40)
      }
      out.push(c.toDataURL("image/jpeg", 0.75))
    }
    return out
  })()`)
  await t.page.context().close()
  return urls.map((u) => Buffer.from(u.split(",")[1]!, "base64"))
}

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
    far: !!document.querySelector("[aria-roledescription=canvas] > [data-far]"),
    willChange: getComputedStyle(document.querySelector("[aria-roledescription=canvas] > div")!).willChange,
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

/** Remember the image of the tile closest to where the wheel zooms around. */
async function markNearestTile(page: Page) {
  await page.evaluate(`(() => {
    let best = null, bestD = Infinity
    for (const img of document.querySelectorAll("[aria-roledescription=canvas] button[aria-label] > img")) {
      const r = img.getBoundingClientRect()
      const d = Math.hypot(r.x + r.width / 2 - 640, r.y + r.height / 2 - 420)
      if (d < bestD) { best = img; bestD = d }
    }
    window.__kept = best
  })()`)
}
async function keptTile(page: Page, when: string) {
  assert.equal(await page.evaluate(`!!window.__kept && window.__kept.isConnected`), true, `a tile keeps its image element ${when}`)
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
  at100: { elements: number; images: number; tabbable: number; far: boolean; willChange: string }
  at25: { elements: number; images: number; tabbable: number; far: boolean; willChange: string }
  pan100: Frames
  zoomOut: Frames
  zoomIn: Frames
  pan25: Frames
}

/** A signed-in session whose All feed is `n` seeded items and whose files are the generated thumbnails. */
async function gallery(n: number) {
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
    const hue = [...new URL(route.request().url()).pathname].reduce((s, c) => s + c.charCodeAt(0), 0) % thumbs.length
    return route.fulfill({ status: 200, contentType: "image/jpeg", body: thumbs[hue]!, headers: { "cache-control": "max-age=3600" } })
  })
  return t
}

async function run(n: number): Promise<Report> {
  const t = await gallery(n)
  const { page } = t
  await t.goto("/")
  await page.getByRole("button", { name: /^Zoom \d+%/ }).waitFor()
  await until("tiles are on the canvas", async () => (await counts(page)).images > 20)
  await sleep(1200)
  assert.equal(await zoomPct(page), 100)
  const at100 = await counts(page)
  const a100 = await audit(page)
  checkTabOrder(a100, "100%")

  const pan100 = await frames(page, () => pan(page))

  // The tile nearest the zoom's anchor stays mounted all the way out and back; its image must be the same element
  // throughout (crossing the far threshold changes its look with CSS, not its DOM).
  await markNearestTile(page)

  // About 12 % per tick: the whole range in a dozen ticks, like a trackpad pinch. More ticks than that are sent,
  // because a busy page drops some, and the extra ones at the limit do nothing.
  const zoomOut = await frames(page, () => wheelZoom(page, 12, 24))
  await until("zoomed all the way out", async () => (await zoomPct(page)) === 25, 30_000)
  await keptTile(page, "out past the far threshold")
  await sleep(300) // let the zoom settle
  const at25 = await counts(page)
  const a25 = await audit(page)
  checkTabOrder(a25, "25%")
  const pan25 = await frames(page, () => pan(page))
  await markNearestTile(page)
  const zoomIn = await frames(page, () => wheelZoom(page, -12, 24))
  await until("zoomed back in", async () => (await zoomPct(page)) >= 100, 30_000)
  await keptTile(page, "back in past the far threshold")
  assert.deepEqual(t.consoleErrors, [])
  await page.context().close()
  return {
    items: n,
    at100: { elements: at100.elements, images: at100.images, tabbable: a100.tabbable.length, far: at100.far, willChange: at100.willChange },
    at25: { elements: at25.elements, images: at25.images, tabbable: a25.tabbable.length, far: at25.far, willChange: at25.willChange },
    pan100,
    zoomOut,
    zoomIn,
    pan25,
  }
}

async function measured(n: number) {
  const r = await run(n)
  log(r)
  return r
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

// What the gallery held before it got a light tile and a tighter margin (1280 x 800, all measured here): 437 elements
// and 63 images at 100%, 5,839 elements and 1,142 images at 25%. The bounds leave room for small layout changes, not
// for going back.
function checkWeight(r: Report) {
  assert.ok(r.at100.elements < 400, `${r.at100.elements} elements at 100%`)
  assert.ok(r.at25.elements < 1950, `${r.at25.elements} elements at 25%: less than a third of the old 5,839`)
  assert.ok(r.at25.images < 900, `${r.at25.images} images at 25%, down from 1,142`)
  // A tile is its button and its image; the rest is the page's own chrome.
  assert.ok(r.at25.elements < r.at25.images * 2 + 200, `${r.at25.elements} elements for ${r.at25.images} tiles at 25%`)
  assert.equal(r.at100.far, false, "the world is not marked far at 100%")
  assert.equal(r.at25.far, true, "the world is marked far at 25%")
  // The home canvas is tiled, so its world must not carry will-change: it locks the layer's raster scale, so every tile
  // that mounts while panning at 25% is rasterized for the zoom it came from (8x the raster time measured), and a
  // zoom-in with 1,000 tiles mounted stalls its first frame for 0.8 s instead of 0.2.
  assert.equal(r.at100.willChange, "auto", "no will-change at 100%")
  assert.equal(r.at25.willChange, "auto", "no will-change at 25%, so panning rasterizes at the zoom shown")
}

test("200 items: the zoomed-out gallery stays light", { timeout: 180_000 }, async () => {
  checkWeight(await measured(200))
})

test("1000 items: panning at 100% and zooming out stay light", { timeout: 240_000 }, async () => {
  checkWeight(await measured(1000))
})

// The tile is two elements now, with its hover chip a sibling: the chip must still follow hover and focus, survive the
// pointer moving onto it, and the tile must still open, in tab order.
test("a home tile shows its source on hover and focus, opens on click, and tabs newest first", { timeout: 60_000 }, async () => {
  const t = await gallery(40)
  const { page } = t
  await t.goto("/")
  await page.getByRole("button", { name: /^Zoom \d+%/ }).waitFor()
  await until("tiles are on the canvas", async () => (await counts(page)).images > 5)
  await sleep(500)
  const chip = page.locator('a[title^="Open "]')
  const tile = page.getByRole("button", { name: "Page 0", exact: true })

  await tile.hover()
  await chip.waitFor()
  const [tb, cb] = [(await tile.boundingBox())!, (await chip.boundingBox())!]
  assert.ok(cb.x >= tb.x && cb.x + cb.width <= tb.x + tb.width && cb.y >= tb.y && cb.y + cb.height <= tb.y + tb.height, "the chip sits inside its tile")
  await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2, { steps: 4 })
  await sleep(150)
  assert.equal(await chip.count(), 1, "moving onto the chip keeps it")
  await page.mouse.move(4, 400, { steps: 4 })
  await until("the chip goes when the pointer leaves", async () => (await chip.count()) === 0)

  await tile.focus()
  await chip.waitFor()
  const label = () => page.evaluate<string>(`document.activeElement.getAttribute("aria-label")`)
  const next: string[] = []
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("Tab")
    next.push(await label())
  }
  assert.deepEqual(next, ["Page 1", "Page 2", "Page 3"], "Tab goes to the next newest tile")
  // Page 0 is from alpha.test, Page 3 from delta.test: the chip moved with focus.
  await until("the chip follows focus", async () => (await chip.count()) === 1 && (await chip.getAttribute("title")) === "Open delta.test")

  // Focus panned the canvas to Page 3.
  await page.mouse.move(4, 400)
  await page.getByRole("button", { name: "Page 3", exact: true }).click()
  await until("the inspector opens", async () => new URL(page.url()).searchParams.get("open") === "page:p3")
  assert.deepEqual(t.consoleErrors, [])
})

test("on the Websites filter a tile is a link to its page", { timeout: 60_000 }, async () => {
  const refs = Array.from({ length: 12 }, (_, i) => reference({ id: `w${i}`, url: `https://w${i}.test/`, domain: `w${i}.test`, title: `Site ${i}`, coverKey: `covers/w${i}.png`, createdAt: created(i) }))
  const t = await gallery(0)
  const { page } = t
  t.on("GET", "/api/references", () => ({ json: { items: refs, nextCursor: null } }))
  t.on("GET", "/api/counts", () => ({ json: { websites: refs.length, pages: 0, sections: 0, animations: 0, images: 0 } }))
  await t.goto("/?filter=websites")
  const link = page.locator('a[href="/r/w0"]').first()
  await link.waitFor()
  assert.equal(await link.getAttribute("aria-label"), "Site 0")
  assert.equal(await link.evaluate((el) => el.children.length), 1, "a link tile holds only its image")
  assert.deepEqual(t.consoleErrors, [])
})
