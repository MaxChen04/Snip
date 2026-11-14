import { test } from "node:test"
import assert from "node:assert/strict"
import { cullRect, FAR_ZOOM } from "../src/components/canvas/cull"

const VIEW = { w: 1280, h: 800 }
/** The world rect on screen at zoom k with the world's origin `tx`, `ty` screen px from the top left. */
const onScreen = (k: number, tx: number, ty: number) => ({ x: -tx / k, y: -ty / k, w: VIEW.w / k, h: VIEW.h / k })
const area = (r: { w: number; h: number }) => r.w * r.h

// What every canvas mounted at every zoom before there was a tiled one: a quarter-screen margin on a grid of about
// 256 screen px.
function legacy(k: number, tx: number, ty: number) {
  const step = 256 * 2 ** Math.max(0, Math.round(Math.log2(1 / k)))
  const m = (Math.max(VIEW.w, VIEW.h) * 0.25) / k
  const x = Math.floor((-tx / k - m) / step) * step
  const y = Math.floor((-ty / k - m) / step) * step
  return { x, y, w: Math.ceil(((VIEW.w - tx) / k + m) / step) * step - x, h: Math.ceil(((VIEW.h - ty) / k + m) / step) * step - y }
}

test("the rect always covers what is on screen", () => {
  for (const tiled of [false, true])
    for (const k of [0.25, 0.3, 0.49, 0.5, 0.7, 1, 1.5, 2])
      for (const [tx, ty] of [[0, 0], [-1234.5, 777.7], [900, -4000], [-50000, 50000]] as const) {
        const r = cullRect({ tx, ty, k, ...VIEW }, tiled)
        const s = onScreen(k, tx, ty)
        assert.ok(r.x <= s.x && r.y <= s.y && r.x + r.w >= s.x + s.w && r.y + r.h >= s.y + s.h, `tiled ${tiled}, zoom ${k} at ${tx},${ty}`)
      }
})

test("the margin leaves room for a few frames of panning at every zoom", () => {
  for (const tiled of [false, true])
    for (const k of [0.25, 0.4, 0.5, 1, 2]) {
      const r = cullRect({ tx: -600, ty: 300, k, ...VIEW }, tiled)
      const s = onScreen(k, -600, 300)
      // In screen px: at least 100 on every side.
      for (const gap of [(s.x - r.x) * k, (s.y - r.y) * k, (r.x + r.w - s.x - s.w) * k, (r.y + r.h - s.y - s.h) * k]) assert.ok(gap >= 100, `tiled ${tiled}, zoom ${k}: ${gap}`)
    }
})

test("a canvas that is not tiled mounts what it always did, at every zoom", () => {
  for (const k of [0.25, 0.3, 0.49, 0.5, 0.75, 1, 1.5, 2]) assert.deepEqual(cullRect({ tx: -321, ty: 456, k, ...VIEW }), legacy(k, -321, 456), `zoom ${k}`)
})

test("a tiled canvas is the same at normal zoom and mounts far less far out", () => {
  for (const k of [0.5, 0.75, 1, 1.5, 2]) assert.deepEqual(cullRect({ tx: -321, ty: 456, k, ...VIEW }, true), legacy(k, -321, 456), `zoom ${k}`)
  for (const k of [0.25, 0.3, 0.4, 0.49]) {
    const ratio = area(cullRect({ tx: -321, ty: 456, k, ...VIEW }, true)) / area(legacy(k, -321, 456))
    assert.ok(ratio < 0.7, `zoom ${k}: ${ratio}`)
  }
})

test("far out, a tiled canvas mounts little more than the screen itself", () => {
  for (let k = 0.25; k < FAR_ZOOM; k *= 1.05)
    for (const tx of [0, -333, -777]) {
      const mounted = area(cullRect({ tx, ty: tx, k, ...VIEW }, true))
      assert.ok(mounted < 2.6 * area(onScreen(k, tx, tx)), `zoom ${k}: ${mounted / area(onScreen(k, tx, tx))}x the screen`)
    }
})

test("small moves keep the same rect, so children do not re-render", () => {
  for (const tiled of [false, true])
    for (const k of [0.25, 1]) {
      const a = cullRect({ tx: -1000, ty: -1000, k, ...VIEW }, tiled)
      const b = cullRect({ tx: -1010, ty: -1010, k, ...VIEW }, tiled)
      assert.deepEqual(a, b)
    }
})
