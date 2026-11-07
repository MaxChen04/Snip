import { EventEmitter } from "node:events"
import { test } from "node:test"
import assert from "node:assert/strict"
import { chromium, type CDPSession } from "playwright"
import sharp from "sharp"
import type { SnipApi } from "../src/api"
import { recordScroll, screencast } from "../src/capture"
import type { Frame } from "../src/gif"
import { buildStills, closeRenderer, pickStills, sampleIndexes } from "../src/sheet"

const BAND = 400
const COLORS = [[230, 30, 30], [30, 160, 60], [40, 70, 220], [240, 200, 20], [150, 40, 200], [20, 190, 200], [250, 120, 20], [90, 90, 90], [200, 60, 140], [60, 120, 40]] as const
const frame = (still: boolean): Frame => ({ png: Buffer.alloc(0), delay: 33, ...(still ? { still: { jpeg: Buffer.alloc(0), width: 1440, height: 900 } } : {}) })

test("pickStills samples evenly, and uses the nearest full-size still when stills are sparse", () => {
  assert.deepEqual(pickStills(Array.from({ length: 30 }, () => frame(false))), sampleIndexes(30))
  const planned = new Set(sampleIndexes(30))
  assert.deepEqual(pickStills(Array.from({ length: 30 }, (_, i) => frame(planned.has(i)))), sampleIndexes(30))
  // The page grew while recording: stills were planned for 20 frames, then the last frame got one too.
  const early = new Set([...sampleIndexes(20), 39])
  const picks = pickStills(Array.from({ length: 40 }, (_, i) => frame(early.has(i))))
  assert.equal(picks[0], 0)
  assert.equal(picks.at(-1), 39)
  assert.ok(picks.every((i) => early.has(i)), "only frames that have a still are picked")
  assert.equal(new Set(picks).size, picks.length, "no duplicates")
})

test("screencast keeps the newest frame at a scroll offset, and stops between steps once a page animates", async () => {
  const sent: string[] = []
  const session = Object.assign(new EventEmitter(), { send: async (method: string) => { sent.push(method); return {} } })
  const calls = () => sent.filter((m) => m !== "Page.screencastFrameAck")
  const cast = await screencast(session as unknown as CDPSession, 720, 450, 50)
  const paint = (y: number, n: number) => session.emit("Page.screencastFrame", { data: Buffer.from([n]).toString("base64"), metadata: { scrollOffsetY: y }, sessionId: n })
  await cast.scrolled()
  paint(0, 1)
  paint(0, 2)
  assert.deepEqual([...(await cast.frameAt(0))!], [2])
  await cast.scrolled()
  const next = cast.frameAt(40)
  paint(0, 3) // painted before the scroll landed
  paint(40, 4)
  assert.deepEqual([...(await next)!], [4])
  assert.equal(await cast.frameAt(80), null, "no frame at that offset in time")
  assert.deepEqual(calls(), ["Page.startScreencast"], "a still page keeps one screencast running")
  // An animation paints 12 frames per step: after 5 kept frames the screencast stops between steps.
  for (let step = 0; step < 2; step++) {
    for (let n = 0; n < 12; n++) paint(120, 10 + n)
    await cast.frameAt(120)
  }
  await cast.scrolled()
  await cast.stop()
  assert.deepEqual(calls(), ["Page.startScreencast", "Page.stopScreencast", "Page.startScreencast", "Page.stopScreencast"])
  assert.equal(sent.filter((m) => m === "Page.screencastFrameAck").length, 28, "every frame is acked")
})

test("screencast is given up after 3 misses in a row, so a browser that sends no frames doesn't wait out every frame", async () => {
  const sent: string[] = []
  const session = Object.assign(new EventEmitter(), { send: async (method: string) => { sent.push(method); return {} } })
  const calls = () => sent.filter((m) => m !== "Page.screencastFrameAck")
  const cast = await screencast(session as unknown as CDPSession, 720, 450, 100)
  const step = async (y: number, painted = false) => {
    await cast.scrolled()
    if (painted) session.emit("Page.screencastFrame", { data: "AA==", metadata: { scrollOffsetY: y }, sessionId: 1 })
    return (await cast.frameAt(y)) != null
  }
  assert.deepEqual([await step(0), await step(40), await step(80, true), await step(120), await step(160)], [false, false, true, false, false])
  assert.deepEqual(calls(), ["Page.startScreencast"], "a frame resets the count")
  assert.equal(await step(200), false)
  assert.deepEqual(calls(), ["Page.startScreencast", "Page.stopScreencast"], "the third miss in a row stops it")
  const start = performance.now()
  assert.equal(await step(240, true), false, "after that, frames go straight to the fallback")
  assert.ok(performance.now() - start < 50, "without waiting")
  await cast.stop()
  assert.deepEqual(calls(), ["Page.startScreencast", "Page.stopScreencast"], "and it never restarts")
})

test("stills converted together keep each frame's own image, in order", { timeout: 60_000 }, async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const solid = ([r, g, b]: readonly number[]) => sharp({ create: { width: 120, height: 80, channels: 3, background: { r: r!, g: g!, b: b! } } }).png().toBuffer()
    const frames: Frame[] = await Promise.all(Array.from({ length: 20 }, async (_, i) => ({ png: await solid(COLORS[i % COLORS.length]!), delay: 33, offsetMs: i * 33, phase: "enter" as const })))
    const uploads = new Map<string, Buffer>()
    const api = { upload: async (key: string, body: Buffer) => { uploads.set(key, body); return key } } as unknown as SnipApi
    const { meta, sheetKey } = await buildStills(browser, api, "t", frames, "measured", null)
    assert.equal(meta.frames.length, sampleIndexes(20).length)
    assert.ok(sheetKey && uploads.get(sheetKey)?.[0] === 0xff, "contact sheet is a JPEG")
    const page = await browser.newPage()
    for (const f of meta.frames) {
      const center = await page.evaluate(async (src) => {
        const img = new Image()
        img.src = src
        await img.decode()
        const canvas = Object.assign(document.createElement("canvas"), { width: img.width, height: img.height })
        const g = canvas.getContext("2d")!
        g.drawImage(img, 0, 0)
        return [...g.getImageData(img.width >> 1, img.height >> 1, 1, 1).data].slice(0, 3)
      }, `data:image/jpeg;base64,${uploads.get(f.key)!.toString("base64")}`)
      const expected = COLORS[f.sourceIndex % COLORS.length]!
      assert.ok(center.every((v, c) => Math.abs(v - expected[c]!) < 12), `still for frame ${f.sourceIndex} shows ${center}, expected ${expected}`)
    }
  } finally {
    await closeRenderer()
    await browser.close()
  }
})

test("scroll recording streams frames into a half-size GIF and keeps full-size stills where sampled", { timeout: 60_000 }, async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page.setContent(`<style>body{margin:0}div{height:${BAND}px}</style>${COLORS.map(([r, g, b]) => `<div style="background:rgb(${r},${g},${b})"></div>`).join("")}`)
    const { frames, gif } = await recordScroll(page, true)
    const travel = COLORS.length * BAND - 900
    assert.equal(frames.length, Math.ceil(travel / 40) + 1)
    assert.deepEqual(frames.flatMap((f, i) => (f.still ? [i] : [])), sampleIndexes(frames.length))
    assert.ok(frames.every((f) => !f.png), "frames are dropped once encoded")
    assert.deepEqual([frames[0]!.delay, frames.at(-1)!.delay], [700, 1200])
    assert.deepEqual([gif?.width, gif?.height, gif?.bytes.toString("latin1", 0, 6)], [720, 450, "GIF89a"])
    // Each GIF frame was painted at its own scroll position: the band at scrollY + 20 CSS px (10 GIF px).
    for (const [i, f] of frames.entries()) {
      const { data } = await sharp(gif!.bytes, { page: i }).removeAlpha().raw().toBuffer({ resolveWithObject: true })
      const px = [...data.subarray((10 * 720 + 10) * 3, (10 * 720 + 10) * 3 + 3)]
      const expected = COLORS[Math.floor((f.scrollY! + 20) / BAND)]!
      assert.ok(px.every((v, c) => Math.abs(v - expected[c]!) < 12), `GIF frame ${i} at y=${f.scrollY} shows ${px}, expected ${expected}`)
    }
    // Each still shows the page at its frame's scroll position: the band at scrollY + 20 CSS px.
    for (const f of frames.filter((f) => f.still)) {
      assert.deepEqual([f.still!.width, f.still!.height], [1440, 900])
      const px = await page.evaluate(async (src) => {
        const img = new Image()
        img.src = src
        await img.decode()
        const canvas = Object.assign(document.createElement("canvas"), { width: img.width, height: img.height })
        const g = canvas.getContext("2d")!
        g.drawImage(img, 0, 0)
        return [...g.getImageData(20, 20, 1, 1).data].slice(0, 3)
      }, `data:image/jpeg;base64,${f.still!.jpeg.toString("base64")}`)
      const expected = COLORS[Math.floor((f.scrollY! + 20) / BAND)]!
      assert.ok(px.every((v, c) => Math.abs(v - expected[c]!) < 12), `still at y=${f.scrollY} shows ${px}, expected ${expected}`)
    }
  } finally {
    await browser.close()
  }
})
