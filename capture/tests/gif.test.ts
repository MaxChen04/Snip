import { test } from "node:test"
import assert from "node:assert/strict"
import sharp from "sharp"
import { encodeGif, gifWriter } from "../src/gif"

const COLORS = [[230, 30, 30], [30, 160, 60], [40, 70, 220]] as const
/** A test frame: a solid colour with a white square, so each frame has a palette and some detail. */
const frame = ([r, g, b]: readonly number[], width = 80, height = 60) =>
  sharp({ create: { width, height, channels: 3, background: { r: r!, g: g!, b: b! } } })
    .composite([{ input: { create: { width: 20, height: 20, channels: 3, background: "#ffffff" } }, left: 10, top: 10 }])
    .png()
    .toBuffer()

test("gifWriter splices native frames into one looping animation with each frame's delay", async () => {
  const writer = gifWriter({ scale: 2 })
  for (const [i, color] of COLORS.entries()) await writer.add(await frame(color), 100 * (i + 1))
  await writer.add(await frame(COLORS[0], 90, 60), 100) // a different size is skipped, as before
  const gif = writer.finish()
  assert.deepEqual([gif.width, gif.height], [40, 30])
  const meta = await sharp(gif.bytes, { animated: true }).metadata()
  assert.deepEqual([meta.format, meta.pages, meta.pageHeight, meta.loop, meta.delay], ["gif", 3, 30, 0, [100, 200, 300]])
  for (const [i, expected] of COLORS.entries()) {
    const { data } = await sharp(gif.bytes, { page: i }).raw().toBuffer({ resolveWithObject: true })
    const corner = [...data.subarray(0, 3)] // top-left pixel is the frame's colour, outside the white square
    assert.ok(corner.every((v, c) => Math.abs(v - expected[c]!) < 12), `frame ${i} shows ${corner}, expected ${expected}`)
  }
})

test("encodeGif produces the same bytes as streaming the frames into gifWriter", async () => {
  const frames = await Promise.all(COLORS.map(async (color, i) => ({ png: await frame(color), delay: 40 * (i + 1) })))
  const writer = gifWriter()
  for (const f of frames) await writer.add(f.png, f.delay)
  assert.ok(writer.finish().bytes.equals((await encodeGif(frames)).bytes))
})
