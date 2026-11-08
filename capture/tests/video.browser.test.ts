import { test } from "node:test"
import assert from "node:assert/strict"
import { chromium } from "playwright"
import sharp from "sharp"
import { closeRenderer, renderer } from "../src/sheet"
import { encodeRecording, recordingWriter } from "../src/video"

const COLORS = [[230, 30, 30], [30, 160, 60], [40, 70, 220]] as const
const frame = ([r, g, b]: readonly number[], width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: { r: r!, g: g!, b: b! } } }).png().toBuffer()

/** Play a recording in the browser: its duration, and the top-left colour at each time. */
async function play(bytes: Buffer, times: number[]) {
  const browser = chromium.launch()
  const b = await browser
  try {
    const page = await renderer(b)
    return await page.evaluate(async ({ data, times }) => {
      const video = document.createElement("video")
      video.muted = true
      video.src = URL.createObjectURL(new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], { type: "video/webm" }))
      await new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = () => reject(new Error(video.error?.message ?? "video error")) })
      const canvas = document.createElement("canvas")
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      const ctx = canvas.getContext("2d")!
      const colors: number[][] = []
      for (const t of times) {
        // "seeked" can fire before the new frame reaches the element, so drawImage would read the old one. Also
        // wait for the frame to be presented (a seek that lands on the frame already shown presents nothing).
        const presented = new Promise((resolve) => { video.requestVideoFrameCallback(resolve); setTimeout(resolve, 500) })
        await new Promise((resolve) => { video.onseeked = resolve; video.currentTime = t })
        await presented
        ctx.drawImage(video, 0, 0)
        colors.push([...ctx.getImageData(4, 4, 1, 1).data.slice(0, 3)])
      }
      return { duration: video.duration, width: video.videoWidth, height: video.videoHeight, colors }
    }, { data: bytes.toString("base64"), times })
  } finally {
    await closeRenderer()
    await b.close()
  }
}

const near = (a: number[], b: readonly number[]) => a.every((v, i) => Math.abs(v - b[i]!) < 24)

test("encodeRecording writes a WebM that plays each frame for its delay and holds the last one", async () => {
  const browser = await chromium.launch()
  let rec
  try {
    const frames = await Promise.all(COLORS.map(async (c) => ({ png: await frame(c, 161, 91), delay: 300 })))
    frames[2]!.delay = 900
    rec = await encodeRecording(browser, frames, { scale: 1, format: "webm" })
  } finally {
    await closeRenderer()
    await browser.close()
  }
  assert.equal(rec.ext, "webm")
  assert.equal(rec.contentType, "video/webm")
  assert.deepEqual([rec.width, rec.height], [160, 90], "odd sizes round down to even")
  assert.equal(rec.bytes.subarray(0, 4).toString("hex"), "1a45dfa3")
  const played = await play(rec.bytes, [0.1, 0.4, 0.7, 1.4])
  assert.ok(Math.abs(played.duration - 1.5) < 0.05, `duration ${played.duration}`)
  assert.deepEqual([played.width, played.height], [160, 90])
  const expected = [COLORS[0], COLORS[1], COLORS[2], COLORS[2]]
  played.colors.forEach((c, i) => assert.ok(near(c, expected[i]!), `at sample ${i} saw ${c}, expected ${expected[i]}`))
})

test("recordingWriter scales frames and skips frames of another size", async () => {
  const browser = await chromium.launch()
  try {
    const writer = await recordingWriter(browser, { scale: 2, format: "webm" })
    await writer.add(await frame(COLORS[0], 200, 100), 100)
    await writer.add(await frame(COLORS[1], 120, 100), 100) // another size: skipped
    await writer.add(await frame(COLORS[2], 200, 100), 100)
    const rec = await writer.finish()
    assert.deepEqual([rec.ext, rec.width, rec.height], ["webm", 100, 50])
  } finally {
    await closeRenderer()
    await browser.close()
  }
})
