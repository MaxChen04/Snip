// The home gallery with a big library, mocked like the real one: mostly section crops (1440 px wide, about 85 KB each,
// wide strips more often than tall ones) around a few 960 x 600 page thumbnails, in a 1440 x 900 window. It counts the DOM
// elements, images and image pixels the gallery holds at 100% and 25% zoom, and measures how smooth panning and zooming
// are, as requestAnimationFrame deltas, for three gestures: Ctrl+wheel notches (each one zooms by half, so the whole range
// is a handful of frames), run first on a page that has never been zoomed; a trackpad pinch (small steps); and, to see
// what the staged mounting leaves behind, how long the viewport has holes after a zoom out. The counts, the will-change
// and tab-order checks, the tiles mounted in one frame, the holes and the CSS transitions running after a zoom are
// asserted, because they do not depend on the machine; the frame times are only logged, because software rendering on a
// shared machine makes them too noisy to gate on. Run it alone to read them. It runs against the Vite dev server
// (development React, which is slower than the build), so treat the numbers as a ceiling:
//   node --import tsx --test web/tests/browser/home-gallery-perf.browser.test.ts
//
// What the first version of this benchmark missed, and the real library showed (247 items, Ctrl+wheel 40 ticks out and in:
// p95 83 to 133 ms, 12 to 50 frames over 33 ms, the first zoom in step up to 600 ms), by measurement:
// - It had no mouse wheel gesture: it zoomed in steps of 12%, and a notch is 49%, so a step brought a few dozen tiles into
//   view, not hundreds.
// - Its tiles were taller and every section was a 960 x 600 picture: a screen held 63 images at 100% and 598 at 25%,
//   against 134 and 865 for the real library, which is 835 images and 992 megapixels loaded at 25%.
// - Every gesture it measured ran after others had. Chromium decodes and scales each image again for every new zoom it
//   paints at, so a gesture that stalls a page that has never zoomed (a 570 ms frame at its first step in) runs with
//   nothing left to decode the next time: three passes of the same gesture on the real library gave a 567 ms, a 150 ms
//   and a 17 ms worst frame. The wheel gesture here runs first for that reason.
// - Zooming back in across FAR_ZOOM started a 150 ms box-shadow transition on every tile, which it never measured.
//
// What it still shows, as the 40 notches' worst frames, is the cost that mounting and transitions do not explain: image
// decode. Chromium decodes and rescales the 1440 px crops (about 1,000 megapixels loaded at 25%) on its worker threads,
// and the next frame's commit waits for them. On the real library with the images hidden the worst frame of the same
// gesture is 33 ms in development and 17 ms in a build; with them it is 100 to 133 ms, from the first step in of a page
// that has never zoomed. Smaller thumbnails of the sections would remove that; the gallery cannot.
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import type { Page } from "playwright"
import type { PageWithRef, SavedImage, SectionItem } from "../../shared/types.ts"
import { MOUNT_PER_FRAME } from "../../src/components/canvas/home-layout.ts"
import { reference, sleep, startApp, until, type App, type Req } from "./harness.ts"

let app: App
let thumbs: Thumbs
before(async () => {
  app = await startApp()
  thumbs = await makeThumbs()
})
after(async () => app?.stop())

// ---------------------------------------------------------------- seed

const NOW = Date.UTC(2026, 0, 1)
const created = (i: number) => new Date(NOW - i * 60_000).toISOString()
// Section crops of the real library: the median is 1.8 wide, a quarter are 2.8 or wider, and the tile clamps at 4.
const SECTION_ASPECTS = [1, 1.2, 1.5, 1.6, 1.8, 1.9, 2.2, 2.8, 3.5, 4, 4, 1.6]
const IMAGE_ASPECTS = [1.6, 0.8, 1.3, 1, 2.4, 0.6]
const DOMAINS = ["alpha.test", "beta.test", "gamma.test", "delta.test", "epsilon.test", "zeta.test", "eta.test", "theta.test"]
const ref = (i: number) => ({ id: `r${i % DOMAINS.length}`, title: `Site ${i % DOMAINS.length}`, domain: DOMAINS[i % DOMAINS.length]!, favicon: null })

/** About 10% pages, 80% sections and 10% images, interleaved by date like the All feed (the real library is 27 pages, 220 sections). */
function seed(n: number) {
  const pages: PageWithRef[] = []
  const sections: SectionItem[] = []
  const images: SavedImage[] = []
  for (let i = 0; i < n; i++) {
    const kind = i % 10 === 0 ? "page" : i % 10 === 9 ? "image" : "section"
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
      sections.push({
        id: `p${i}:0`,
        pageId: `p${i}`,
        referenceId: ref(i).id,
        index: 0,
        kind: "section",
        label: `Section ${i}`,
        key: `pages/p${i}/section-0.jpg`,
        width: 1440,
        height: sectionHeight(i),
        path: `/p${i}`,
        url: `https://${ref(i).domain}/p${i}`,
        reference: ref(i),
        createdAt: created(i),
      })
    } else {
      const aspect = IMAGE_ASPECTS[i % IMAGE_ASPECTS.length]!
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

/** A section's height; every 40th is a tall crop (a long section of a long page) of 1440 x 5000. */
const sectionHeight = (i: number) => (i % 40 === 8 ? 5000 : Math.round(1440 / SECTION_ASPECTS[i % SECTION_ASPECTS.length]!))

// ---------------------------------------------------------------- generated thumbnails

type Thumbs = { page: Buffer[]; sections: Map<number, Buffer> }

/**
 * The files the capture agent stores, at their real sizes: 960 x 600 page thumbnails (about 40 KB) and section crops
 * 1440 px wide and as tall as the section (about 85 KB at 900 px). Each is coloured bands under several hundred small
 * blocks, so the browser has real pixels to decode; drawn and encoded by the browser itself.
 */
async function makeThumbs(): Promise<Thumbs> {
  const t = await app.session()
  // A string, not a function: tsx names arrow functions with a helper the page does not have.
  const draw = (w: number, h: number, hue: number) => `(() => {
    const c = document.createElement("canvas")
    c.width = ${w}
    c.height = ${h}
    const g = c.getContext("2d")
    for (let y = 0; y < ${h}; y += 40) {
      g.fillStyle = "hsl(" + (${hue} * 45) + " 45% " + (y % 80 ? 82 : 70) + "%)"
      g.fillRect(0, y, ${w}, 40)
    }
    let seed = ${hue} + 1
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    for (let i = 0; i < ${w * h} / 1800; i++) {
      g.fillStyle = "hsl(" + Math.floor(rnd() * 360) + " " + Math.floor(rnd() * 60) + "% " + Math.floor(20 + rnd() * 70) + "%)"
      g.fillRect(rnd() * (${w} - 100), rnd() * (${h} - 50), 8 + rnd() * 90, 6 + rnd() * 40)
    }
    return c.toDataURL("image/jpeg", 0.75)
  })()`
  const heights = [...new Set([...SECTION_ASPECTS.map((a) => Math.round(1440 / a)), 5000])]
  const urls = await t.page.evaluate<string[]>(`[${[0, 1, 2, 3, 4, 5, 6, 7].map((hue) => draw(960, 600, hue)).join(",")}, ${heights.map((h, i) => draw(1440, h, i % 8)).join(",")}]`)
  await t.page.context().close()
  const bufs = urls.map((u) => Buffer.from(u.split(",")[1]!, "base64"))
  return { page: bufs.slice(0, 8), sections: new Map(heights.map((h, i) => [h, bufs[8 + i]!])) }
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

// A string, not a function: tsx names arrow functions with a helper the page does not have.
const counts = (page: Page) =>
  page.evaluate<{ elements: number; images: number; mpx: number; mpxOnScreen: number; far: boolean; willChange: string }>(`(() => {
    const imgs = [...document.querySelectorAll("[aria-roledescription=canvas] img")].filter((i) => i.complete && i.naturalWidth)
    const mpx = (list) => Math.round(list.reduce((s, i) => s + i.naturalWidth * i.naturalHeight, 0) / 1e6)
    const onScreen = imgs.filter((i) => {
      const r = i.getBoundingClientRect()
      return r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight
    })
    return {
      elements: document.getElementsByTagName("*").length,
      images: document.images.length,
      // Megapixels the browser has to decode for the images that have loaded, and for those on screen.
      mpx: mpx(imgs),
      mpxOnScreen: mpx(onScreen),
      far: !!document.querySelector("[aria-roledescription=canvas] > [data-far]"),
      willChange: getComputedStyle(document.querySelector("[aria-roledescription=canvas] > div")).willChange,
    }
  })()`)

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

const VIEW = { width: 1440, height: 900 }

/** Remember the image of the tile closest to where the wheel zooms around. */
async function markNearestTile(page: Page) {
  await page.evaluate(`(() => {
    let best = null, bestD = Infinity
    for (const img of document.querySelectorAll("[aria-roledescription=canvas] button[aria-label] > img")) {
      const r = img.getBoundingClientRect()
      const d = Math.hypot(r.x + r.width / 2 - ${VIEW.width / 2}, r.y + r.height / 2 - ${VIEW.height / 2})
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
  await page.mouse.move(VIEW.width / 2, VIEW.height / 2)
  await page.keyboard.down("Control")
  for (let i = 0; i < ticks; i++) {
    await page.mouse.wheel(0, deltaY)
    await sleep(16)
  }
  await page.keyboard.up("Control")
}

/**
 * The end-to-end gesture: `out` Ctrl+wheel ticks of 40 (a notch, which zooms by 49%) and then `back` ticks the other way,
 * 16 ms apart, around the middle of the canvas. They are dispatched from the page: through the browser's input pipeline
 * (wheelZoom) a tick takes about 60 ms here, which spreads the work out; this is the harder gesture of a free-spinning
 * wheel or a trackpad.
 */
async function notches(page: Page, out: number, back: number) {
  await page.evaluate(`(async () => {
    const el = document.querySelector("[aria-roledescription=canvas]")
    const box = el.getBoundingClientRect()
    for (let i = 0; i < ${out + back}; i++) {
      el.dispatchEvent(new WheelEvent("wheel", { deltaY: i < ${out} ? 40 : -40, ctrlKey: true, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2, bubbles: true, cancelable: true }))
      await new Promise((r) => setTimeout(r, 16))
    }
  })()`)
}

/**
 * From now on, count the most tiles added to the canvas in one frame, and the most box-shadow transitions running at
 * once. Both are the same on every machine, unlike the frame times they explain.
 */
const watch = (page: Page) =>
  page.evaluate(`(() => {
    window.__added = 0
    window.__peak = 0
    window.__transitions = 0
    const world = document.querySelector("[aria-roledescription=canvas] > div")
    new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) if (n.nodeName === "BUTTON" || n.nodeName === "A") window.__added++
    }).observe(world, { childList: true })
    const tick = () => {
      window.__peak = Math.max(window.__peak, window.__added)
      window.__added = 0
      window.__transitions = Math.max(window.__transitions, document.getAnimations().filter((a) => a instanceof CSSTransition && a.transitionProperty === "box-shadow").length)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })()`)
const watched = (page: Page) => page.evaluate<{ peak: number; transitions: number }>(`({ peak: window.__peak, transitions: window.__transitions })`)

type Cover = { t: number; k: number; cover: number }
/** From now on, once per frame, the zoom and the share of the viewport that mounted tiles cover. */
const cover = (page: Page) =>
  page.evaluate(`(() => {
    const el = document.querySelector("[aria-roledescription=canvas]")
    const world = el.firstElementChild
    window.__cover = []
    window.__coverOn = true
    const loop = (t) => {
      const m = new DOMMatrix(world.style.transform)
      const view = { x: -m.e / m.a, y: -m.f / m.a, w: el.clientWidth / m.a, h: el.clientHeight / m.a }
      let area = 0
      for (const c of world.children) {
        if (c.nodeName !== "BUTTON" && c.nodeName !== "A") continue
        const x = parseFloat(c.style.left), y = parseFloat(c.style.top), w = parseFloat(c.style.width), h = parseFloat(c.style.height)
        area += Math.max(0, Math.min(x + w, view.x + view.w) - Math.max(x, view.x)) * Math.max(0, Math.min(y + h, view.y + view.h) - Math.max(y, view.y))
      }
      window.__cover.push({ t, k: m.a, cover: area / (view.w * view.h) })
      if (window.__coverOn) requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
  })()`)
const covered = (page: Page) => page.evaluate<Cover[]>(`(() => { window.__coverOn = false; return window.__cover })()`)

/**
 * How long the viewport had holes once the view stopped changing: the frames, and the ms, from the first frame at the final
 * zoom until the tiles covered as much of it as they do at the end. `cover` is that final share (tiles are 240 px wide
 * with 16 px gaps and a plaza in the middle, so a full view is covered about 0.8).
 */
function holes(rows: Cover[]) {
  const end = rows.at(-1)!
  const settled = rows.findIndex((r) => r.k === end.k)
  const full = rows.findIndex((r, i) => i >= settled && r.cover >= end.cover - 0.01)
  return { cover: Math.round(end.cover * 100) / 100, frames: full - settled, ms: Math.round(rows[full]!.t - rows[settled]!.t) }
}

/**
 * The CPU time the page's main thread spent in each task while `work` ran, from a Chromium trace: a task's wall time
 * grows with whatever else the machine is doing, its CPU time does not, so this is the number to compare across runs.
 * Returns the longest task and how many took more than 33 ms of CPU.
 */
async function mainThreadCpu(page: Page, work: () => Promise<void>): Promise<{ longest: number; over33: number }> {
  const browser = page.context().browser()!
  await browser.startTracing(page, { categories: ["toplevel", "devtools.timeline"] })
  await work()
  const trace = JSON.parse((await browser.stopTracing()).toString()) as { traceEvents: { ph: string; name: string; pid: number; tid: number; ts: number; dur?: number; tdur?: number; args?: { name?: string } }[] }
  const events = trace.traceEvents
  const main = events.find((e) => e.ph === "M" && e.name === "thread_name" && e.args?.name === "CrRendererMain")
  if (!main) return { longest: 0, over33: 0 }
  // Top-level tasks only: sorted by start, an event that begins inside the previous one is its child.
  const tasks = events.filter((e) => e.ph === "X" && e.pid === main.pid && e.tid === main.tid && e.dur && e.tdur !== undefined).sort((a, b) => a.ts - b.ts || b.dur! - a.dur!)
  let end = 0
  const cpu: number[] = []
  for (const e of tasks) {
    if (e.ts < end) continue
    end = e.ts + e.dur!
    cpu.push(e.tdur! / 1000)
  }
  return { longest: Math.round(Math.max(0, ...cpu) * 10) / 10, over33: cpu.filter((c) => c > 33).length }
}

/**
 * Park the pointer on the zoom pill, which no tile ever slides under. Any point on the canvas will do for a while, until
 * focus pans the canvas and a tile arrives under the pointer: it then shows its own chip, and a test that counts chips
 * passes or fails by how fast it polls.
 */
const park = (page: Page) => page.getByRole("button", { name: /^Zoom \d+%/ }).hover()

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
  at100: { elements: number; images: number; mpx: number; mpxOnScreen: number; tabbable: number; far: boolean; willChange: string }
  at25: { elements: number; images: number; mpx: number; mpxOnScreen: number; tabbable: number; far: boolean; willChange: string }
  pan100: Frames
  /** The first zoom of a page that has never zoomed: 40 notches out and 40 back. */
  notches: Frames
  zoomOut: Frames
  zoomIn: Frames
  pan25: Frames
  /** 40 notches out and back again, with the trace on: how long the main thread's longest task took, in CPU time. */
  notchesCpu: { longest: number; over33: number }
  /** Holes in the viewport after a zoom out, once the view stopped. */
  holes: { cover: number; frames: number; ms: number }
  mountedInOneFrame: number
  transitions: number
}

/** A signed-in session whose All feed is `n` seeded items and whose files are the generated thumbnails. */
async function gallery(n: number) {
  const { pages, sections, images } = seed(n)
  const t = await app.session({ viewport: VIEW })
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
    const path = new URL(route.request().url()).pathname
    const hue = [...path].reduce((s, c) => s + c.charCodeAt(0), 0) % thumbs.page.length
    // A section crop is as tall as its section says; a page or an upload is a 960 x 600 thumbnail.
    const section = /\/pages\/p(\d+)\/section-0\.jpg$/.exec(path)
    const body = (section && thumbs.sections.get(sectionHeight(Number(section[1])))) || thumbs.page[hue]!
    return route.fulfill({ status: 200, contentType: "image/jpeg", body, headers: { "cache-control": "max-age=3600" } })
  })
  return t
}

async function run(n: number): Promise<Report> {
  const t = await gallery(n)
  const { page } = t
  const reset = async () => {
    await page.getByRole("button", { name: /^Zoom \d+%/ }).click()
    await until("back at 100%", async () => (await zoomPct(page)) === 100)
    await sleep(500)
  }
  await t.goto("/")
  await page.getByRole("button", { name: /^Zoom \d+%/ }).waitFor()
  await until("tiles are on the canvas", async () => (await counts(page)).images > 20)
  await sleep(1200)
  assert.equal(await zoomPct(page), 100)
  const at100 = await counts(page)
  const a100 = await audit(page)
  checkTabOrder(a100, "100%")

  const pan100 = await frames(page, () => pan(page))

  // The first zoom of a page that has never zoomed, as a mouse wheel does it: each notch zooms by half, so 4 of them cross
  // the whole range and the field changes by hundreds of tiles in a frame. The tile nearest the anchor stays mounted all
  // the way out and back: its image must be the same element throughout (crossing the far threshold changes its look with
  // CSS, not its DOM, and staging mounts only tiles that are new).
  await watch(page)
  await markNearestTile(page)
  const notchFrames = await frames(page, () => notches(page, 40, 40))
  await until("the notches are done", async () => (await zoomPct(page)) === 200, 30_000)
  await keptTile(page, "through the notches")
  await reset()

  // About 12% per tick: the whole range in a dozen ticks, like a trackpad pinch. More ticks than that are sent,
  // because a busy page drops some, and the extra ones at the limit do nothing.
  await markNearestTile(page)
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

  // Staging mounts the tiles of a big step over a few frames. Straight after the last notch of a zoom out some are still
  // to come: the tiles there must already be in tab order and announced once, newest first. Then the viewport must fill
  // within a few frames.
  await reset()
  await cover(page)
  await notches(page, 6, 0)
  checkTabOrder(await audit(page), "the middle of a zoom out")
  await until("zoomed all the way out", async () => (await zoomPct(page)) === 25, 30_000)
  await sleep(1500)
  const gap = holes(await covered(page))

  // Again with the trace on, which slows the page too much for the frame times above (and the images are decoded now, so
  // what is left is mostly mounting).
  await reset()
  const notchesCpu = await mainThreadCpu(page, () => notches(page, 40, 40))
  await until("the notches are done again", async () => (await zoomPct(page)) === 200, 30_000)
  const { peak, transitions } = await watched(page)
  assert.deepEqual(t.consoleErrors, [])
  await page.context().close()
  const weight = (c: Awaited<ReturnType<typeof counts>>, a: Awaited<ReturnType<typeof audit>>) => ({ elements: c.elements, images: c.images, mpx: c.mpx, mpxOnScreen: c.mpxOnScreen, tabbable: a.tabbable.length, far: c.far, willChange: c.willChange })
  return {
    items: n,
    at100: weight(at100, a100),
    at25: weight(at25, a25),
    pan100,
    notches: notchFrames,
    zoomOut,
    zoomIn,
    pan25,
    notchesCpu,
    holes: gap,
    mountedInOneFrame: peak,
    transitions,
  }
}

async function measured(n: number) {
  const r = await run(n)
  log(r)
  return r
}

function log(r: Report) {
  const row = (name: string, f: Frames) => `${name.padEnd(12)} p50 ${String(f.p50).padStart(5)}  p95 ${String(f.p95).padStart(6)}  max ${String(f.max).padStart(6)}  >33ms ${String(f.over33).padStart(3)}  >100ms ${String(f.over100).padStart(3)}  (${f.n} frames)`
  const size = (w: Report["at25"]) => `${w.elements} elements, ${w.images} images, ${w.mpx} megapixels loaded (${w.mpxOnScreen} on screen), ${w.tabbable} tiles in tab order`
  console.log(
    [
      `home gallery, ${r.items} items`,
      `  100%: ${size(r.at100)}`,
      `   25%: ${size(r.at25)}`,
      "  " + row("pan 100%", r.pan100),
      "  " + row("40 notches", r.notches),
      "  " + row("zoom out", r.zoomOut),
      "  " + row("zoom in", r.zoomIn),
      "  " + row("pan 25%", r.pan25),
      `  40 notches again: longest main-thread task ${r.notchesCpu.longest} ms of CPU (${r.notchesCpu.over33} over 33 ms)`,
      `  most tiles mounted in a frame ${r.mountedInOneFrame}, most box-shadow transitions at once ${r.transitions}`,
      `  after a zoom out the viewport had holes for ${r.holes.frames} frames, ${r.holes.ms} ms (it ends ${Math.round(r.holes.cover * 100)}% covered)`,
    ].join("\n"),
  )
  console.log(`PERF ${JSON.stringify(r)}`)
}

// What the gallery held before it got a light tile and a tighter margin (1280 x 800, taller tiles, all measured here):
// 437 elements and 63 images at 100%, 5,839 elements and 1,142 images at 25%. This window and these tiles put about twice
// as many on screen, and the light tile holds 356 and 1,916 elements here (890 images at 25%). The bounds leave room for
// small layout changes, not for going back.
function checkWeight(r: Report) {
  assert.ok(r.at100.elements < 450, `${r.at100.elements} elements at 100%`)
  assert.ok(r.at25.elements < 2400, `${r.at25.elements} elements at 25%`)
  assert.ok(r.at25.images < 1100, `${r.at25.images} images at 25%`)
  // A tile is its button and its image; the rest is the page's own chrome.
  assert.ok(r.at25.elements < r.at25.images * 2 + 200, `${r.at25.elements} elements for ${r.at25.images} tiles at 25%`)
  assert.equal(r.at100.far, false, "the world is not marked far at 100%")
  assert.equal(r.at25.far, true, "the world is marked far at 25%")
  // The home canvas is tiled, so its world must not carry will-change: it locks the layer's raster scale, so every tile
  // that mounts while panning at 25% is rasterized for the zoom it came from (8x the raster time measured), and a
  // zoom-in with 1,000 tiles mounted stalls its first frame for 0.8 s instead of 0.2.
  assert.equal(r.at100.willChange, "auto", "no will-change at 100%")
  assert.equal(r.at25.willChange, "auto", "no will-change at 25%, so panning rasterizes at the zoom shown")
  // Zooming back in past FAR_ZOOM changes every tile's box-shadow at once; with box-shadow in the tiles' transition list
  // that started one transition each (361 at once measured), and style recalculation took 154 ms in that frame, not 14.
  assert.equal(r.transitions, 0, "leaving far mode starts no box-shadow transitions")
  // A notch brings hundreds of tiles into view in one step (549 mounted in one 59 ms frame in a build, before the field
  // staged them). A frame mounts no more than MOUNT_PER_FRAME, and the viewport fills within a few frames.
  assert.ok(r.mountedInOneFrame <= MOUNT_PER_FRAME, `${r.mountedInOneFrame} tiles mounted in one frame`)
  assert.ok(r.holes.cover > 0.7, `a zoomed-out viewport is ${Math.round(r.holes.cover * 100)}% covered by tiles`)
  assert.ok(r.holes.frames <= 10, `the viewport had holes for ${r.holes.frames} frames after a zoom out`)
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
  await park(page)
  await until("the chip goes when the pointer leaves", async () => (await chip.count()) === 0)

  await tile.focus()
  await chip.waitFor()
  const label = () => page.evaluate<string>(`document.activeElement.getAttribute("aria-label")`)
  const next: string[] = []
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("Tab")
    next.push(await label())
  }
  assert.deepEqual(next, ["Section 1 · beta.test", "Section 2 · gamma.test", "Section 3 · delta.test"], "Tab goes to the next newest tile")
  // Page 0 is from alpha.test, Section 3 from delta.test: the chip moved with focus.
  await until("the chip follows focus", async () => (await chip.count()) === 1 && (await chip.getAttribute("title")) === "Open delta.test")

  // Focus panned the canvas to Section 3.
  await page.getByRole("button", { name: "Section 3 · delta.test", exact: true }).click()
  await until("the inspector opens", async () => new URL(page.url()).searchParams.get("open") === "section:p3:0")
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
