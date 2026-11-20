import assert from "node:assert/strict"
import { test } from "node:test"
import { galleryWheelLock } from "../src/components/canvas/gallery-gestures.ts"

const packet = (deltaX: number, deltaY: number, options: { ctrlKey?: boolean; shiftKey?: boolean; deltaMode?: number } = {}) =>
  ({ deltaX, deltaY, ctrlKey: false, shiftKey: false, deltaMode: 0, ...options })

test("wheel picks the first meaningful direction-independent mode and holds it through stray packets", () => {
  const lock = galleryWheelLock()
  const send = (t: number, x: number, y: number, ctrlKey = false) => lock.wheel(packet(x, y, { ctrlKey }), 900, 600, t)
  assert.equal(send(0, 0, 0), undefined)
  assert.equal(send(10, 5, 0, true), undefined)
  assert.equal(lock.quietAt(), null)
  assert.deepEqual(send(20, 0, 5), { kind: "pan", x: -0, y: -5 })
  assert.equal(send(140, 0, -20, true), undefined)
  assert.equal(lock.quietAt(), 290)
  assert.equal(send(260, 0, 0), undefined)
  assert.equal(lock.quietAt(), 290)
  assert.deepEqual(send(320, 0, -100, true), { kind: "zoom", factor: Math.exp(0.4) })
  assert.equal(send(440, 12, 5), undefined)
  assert.deepEqual(send(620, 12, 5), { kind: "pan", x: -12, y: -5 })
})

test("physical wheel units normalize per axis; Shift remaps only vertical input", () => {
  const lock = galleryWheelLock()
  assert.deepEqual(lock.wheel(packet(2, -3, { deltaMode: 1, shiftKey: true }), 800, 600, 0), { kind: "pan", x: -32, y: 48 })
  assert.deepEqual(lock.wheel(packet(1, -1, { deltaMode: 2 }), 800, 600, 20), { kind: "pan", x: -800, y: 600 })
  assert.deepEqual(lock.wheel(packet(0, -1, { deltaMode: 2, shiftKey: true }), 800, 600, 40), { kind: "pan", x: 800, y: 0 })
})

test("native pinch ratios are incremental and suppress duplicate Ctrl-wheel", () => {
  const lock = galleryWheelLock()
  lock.gesture("gesturestart", 1, 0)
  assert.equal(lock.wheel(packet(0, -20, { ctrlKey: true }), 800, 600, 10), undefined)
  assert.equal(lock.gesture("gesturechange", 1.25, 20), 1.25)
  assert.equal(lock.gesture("gesturechange", 1.5, 40), 1.2)
  lock.gesture("gestureend", 1.5, 60)
  assert.deepEqual(lock.wheel(packet(0, -20, { ctrlKey: true }), 800, 600, 80), { kind: "zoom", factor: Math.exp(0.1) })
  lock.reset()
  assert.deepEqual(lock.wheel(packet(0, -20), 800, 600, 81), { kind: "pan", x: -0, y: 20 })
})
