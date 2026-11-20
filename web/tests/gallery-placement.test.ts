import assert from "node:assert/strict"
import { test } from "node:test"
import { movementSolver, settleTranslation } from "../src/components/canvas/gallery-placement.ts"
import { COLUMN, GAP, layoutHome } from "../src/components/canvas/home-layout.ts"

test("a raw clear drop is returned unchanged and a blocked diagonal uses the nearest clear corner", () => {
  const raw = { x: 0, y: 0 }
  assert.equal(settleTranslation(raw, [{ x: 2, y: 2, w: 4, h: 4 }]), raw)
  assert.deepEqual(settleTranslation(raw, [
    { x: -2, y: -30, w: 4, h: 60 },
    { x: -30, y: -2, w: 60, h: 4 },
  ]), { x: -2, y: -2 })
})

test("a group gets one correction in world space, leaving all obstacles and its internal spacing alone", () => {
  const moving = [{ x: -80, y: 0, w: 24, h: 24 }, { x: -120, y: 0, w: 24, h: 24 }]
  const solve = movementSolver(moving, [{ x: 150, y: 0, w: 24, h: 24 }, { x: 190, y: 0, w: 24, h: 24 }])
  assert.deepEqual(solve({ x: 0, y: 0 }), { x: 0, y: 0 })
  assert.deepEqual(solve({ x: 230, y: 1 }), { x: 230, y: 40 })
  assert.deepEqual(moving, [{ x: -80, y: 0, w: 24, h: 24 }, { x: -120, y: 0, w: 24, h: 24 }])
})

test("a saved off-column position stays fixed and is an obstacle for newly placed tiles", () => {
  const items = [{ key: "old", aspect: 2 }, { key: "new", aspect: 2 }]
  const fixed = new Map([["old", { x: 12.5, y: 17.5 }]])
  const layout = layoutHome(items, { w: 0, h: 0 }, undefined, fixed)
  const [a, b] = layout.tiles
  assert.deepEqual([a!.x, a!.y], [12.5, 17.5])
  assert.ok(Math.abs(a!.x - b!.x) >= COLUMN + GAP || Math.abs(a!.y - b!.y) >= a!.h + GAP)
})
