import { test } from "node:test"
import assert from "node:assert/strict"
import { at, autoPlace, bounds, centred, fitFrame, FRAME_PAD, FRAME_TITLE, inRow, intersects, moveOnBoard, readingOrder, ROW_GAP, type Box } from "../src/components/canvas/board-layout"

const SIZES = [145, 290, 232, 160, 116, 400, 145, 180].map((h, i) => ({ w: i % 3 === 2 ? 200 : 232, h }))
const sizes = (n: number) => Array.from({ length: n }, (_, i) => SIZES[i % SIZES.length]!)
const boxes = (pos: { x: number; y: number }[], s: { w: number; h: number }[]): Box[] => pos.map((p, i) => ({ w: s[i]!.w, h: s[i]!.h, ...p }))

function assertNoOverlaps(all: Box[]) {
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) assert.ok(!intersects(all[i]!, all[j]!), `${i} overlaps ${j}`)
}

test("auto-placement never overlaps what is already placed, or itself", () => {
  const placed: Box[] = [
    { x: -300, y: -200, w: 232, h: 145 },
    { x: 400, y: 50, w: 232, h: 600 },
    { x: 10, y: 900, w: 200, h: 160 },
  ]
  for (const n of [1, 5, 40]) {
    const s = sizes(n)
    const added = boxes(autoPlace(placed, s), s)
    assertNoOverlaps([...placed, ...added])
    assert.ok(added.every((b) => b.y > 900 + 160), "new items sit below existing content")
    assert.equal(Math.min(...added.map((b) => b.x)), -300, "lined up with the content's left edge")
  }
})

test("an empty board fills around the origin", () => {
  const s = sizes(9)
  const added = boxes(autoPlace([], s), s)
  assertNoOverlaps(added)
  const b = bounds(added)!
  assert.ok(Math.abs(b.x + b.w / 2) < 1 && Math.abs(b.y + b.h / 2) < 1)
})

test("auto-placement is deterministic", () => {
  const placed = [{ x: 0, y: 0, w: 232, h: 145 }]
  assert.deepEqual(autoPlace(placed, sizes(17)), autoPlace(placed, sizes(17)))
})

test("making a board keeps the selection's relative layout, centred on the origin", () => {
  const sel: Box[] = [
    { x: 1000, y: 500, w: 232, h: 145 },
    { x: 1256, y: 500, w: 232, h: 145 },
    { x: 1000, y: 700, w: 200, h: 160 },
  ]
  const next = centred(sel)
  for (let i = 1; i < sel.length; i++) {
    assert.equal(next[i]!.x - next[0]!.x, sel[i]!.x - sel[0]!.x)
    assert.equal(next[i]!.y - next[0]!.y, sel[i]!.y - sel[0]!.y)
  }
  const b = bounds(boxes(next, sel))!
  assert.ok(Math.abs(b.x + b.w / 2) <= 1 && Math.abs(b.y + b.h / 2) <= 1)
})

test("a frame fits its items with padding and a title row", () => {
  const f = fitFrame([
    { x: 0, y: 0, w: 100, h: 50 },
    { x: 120, y: 80, w: 100, h: 50 },
  ])
  assert.deepEqual(f, { x: -FRAME_PAD, y: -FRAME_PAD - FRAME_TITLE, w: 220 + FRAME_PAD * 2, h: 130 + FRAME_PAD * 2 + FRAME_TITLE })
})

test("moving items in and out of frames", () => {
  const frame = { id: "g", ...fitFrame([{ x: 0, y: 0, w: 232, h: 145 }]) }
  const items = [
    { key: "a", groupId: "g", x: 0, y: 0, w: 232, h: 145 },
    { key: "b", groupId: null, x: 600, y: 0, w: 232, h: 145 },
  ]
  // Dragging b onto the frame adds it, and the frame grows to fit it.
  let r = moveOnBoard(items, [frame], new Set(["b"]), new Set(), -500, 20)
  assert.equal(r.items[1]!.groupId, "g")
  assert.deepEqual(r.movedFrames[0], { id: "g", ...fitFrame([items[0]!, { ...items[1]!, x: 100, y: 20 }]) })
  // Dragging a out to open canvas takes it out of the frame; the frame stays put.
  r = moveOnBoard(items, [frame], new Set(["a"]), new Set(), 2000, 0)
  assert.equal(r.items[0]!.groupId, null)
  assert.equal(r.movedFrames.length, 0)
  // Dragging the frame moves its items with it and keeps them grouped.
  r = moveOnBoard(items, [frame], new Set(), new Set(["g"]), 50, 60)
  assert.deepEqual(r.items[0], { ...items[0]!, x: 50, y: 60 })
  assert.equal(r.items[1], items[1])
  assert.deepEqual(r.frames[0], { ...frame, x: frame.x + 50, y: frame.y + 60 })
})

test("reading order goes row by row, left to right", () => {
  const at = (key: string, x: number, y: number) => ({ key, x, y, w: 232, h: 145 })
  const order = readingOrder([at("d", 0, 400), at("b", 300, 10), at("a", 0, 0), at("c", 600, -20)])
  assert.deepEqual(order.map((b) => b.key), ["a", "b", "c", "d"])
})

test("auto layout lines a selection up in one even row, in its current order", () => {
  const sel: Box[] = [
    { x: 500, y: 40, w: 232, h: 145 },
    { x: -20, y: 300, w: 200, h: 160 },
    { x: 100, y: 10, w: 232, h: 290 },
  ]
  const row = inRow(sel)
  assert.deepEqual(row, [
    { x: -20 + 200 + ROW_GAP + 232 + ROW_GAP, y: 10 },
    { x: -20, y: 10 },
    { x: -20 + 200 + ROW_GAP, y: 10 },
  ])
  const placed = boxes(row, sel)
  assertNoOverlaps(placed)
  assert.ok(!at(sel, row), "not in a row before")
  assert.ok(at(placed, row) && at(placed, inRow(placed)), "a row stays put")
  assert.deepEqual(inRow([]), [])
})
