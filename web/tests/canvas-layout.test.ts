import { test } from "node:test"
import assert from "node:assert/strict"
import { layoutHome, MOUNT_PER_FRAME, PLAZA, stageTiles, visibleTiles, type Placement, type Rect } from "../src/components/canvas/home-layout"

const ASPECTS = [1.6, 1.6, 0.8, 1.3, 1, 2.4, 1.6, 0.6, 1.6, 1.2, 0.45, 3]
const make = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `item${i}`, aspect: ASPECTS[i % ASPECTS.length]! }))
const plaza: Rect = { x: -PLAZA.w / 2, y: -PLAZA.h / 2, w: PLAZA.w, h: PLAZA.h }
const shift = (r: Rect, dx: number, dy: number): Rect => ({ ...r, x: r.x + dx, y: r.y + dy })
const EPS = 0.01
const overlap = (a: Placement | Rect, b: Placement | Rect) =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) - EPS) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) - EPS)

function assertNoOverlaps(tiles: Placement[]) {
  for (let i = 0; i < tiles.length; i++)
    for (let j = i + 1; j < tiles.length; j++) assert.equal(overlap(tiles[i]!, tiles[j]!), 0, `${tiles[i]!.key} overlaps ${tiles[j]!.key}`)
}

test("a small library is one finite cluster with every item once", () => {
  const layout = layoutHome(make(10))
  assert.equal(layout.period, null)
  assert.equal(layout.tiles.length, 10)
  assert.deepEqual(new Set(layout.tiles.map((t) => t.index)).size, 10)
  assertNoOverlaps(visibleTiles(layout, { x: -1e5, y: -1e5, w: 2e5, h: 2e5 }))
  assert.equal(visibleTiles(layout, plaza).length, 0)
})

test("newest items sit nearest the centre", () => {
  for (const n of [12, 80]) {
    const { tiles } = layoutHome(make(n))
    const dist = (t: Placement) => Math.hypot(t.x + t.w / 2, t.y + t.h / 2)
    assert.ok(dist(tiles[0]!) < dist(tiles[n - 1]!))
  }
})

test("a large library repeats without overlaps across copies", () => {
  for (const n of [16, 37, 200]) {
    const layout = layoutHome(make(n))
    assert.ok(layout.period)
    const { w, h } = layout.period
    assertNoOverlaps(visibleTiles(layout, { x: -1.5 * w, y: -1.5 * h, w: 3 * w, h: 3 * h }))
  }
})

test("the plaza is empty in the origin copy and filled in the others", () => {
  const layout = layoutHome(make(60))
  const { w, h } = layout.period!
  assert.equal(visibleTiles(layout, plaza).length, 0)
  for (const [dx, dy] of [[w, 0], [0, h], [-w, -h]] as const) {
    const area = shift(plaza, dx, dy)
    const covered = visibleTiles(layout, area).reduce((s, t) => s + overlap(t, area), 0)
    assert.ok(covered > 0.6 * PLAZA.w * PLAZA.h, `plaza copy at ${dx},${dy} is only ${Math.round((covered / (PLAZA.w * PLAZA.h)) * 100)}% covered`)
  }
})

test("a taller plaza passed in stays clear, and the 520-px card never touches a tile", () => {
  for (const h of [260, 420]) {
    for (const n of [9, 60]) {
      const layout = layoutHome(make(n), { w: PLAZA.w, h })
      const card: Rect = { x: -260, y: -h / 2, w: 520, h }
      assert.equal(visibleTiles(layout, card).length, 0, `${n} items, plaza ${h}`)
      // Beside the card, the field comes right up to it: the outer columns run past the plaza's height.
      const beside = visibleTiles(layout, { x: 264, y: -h / 2, w: 240, h })
      if (layout.period) assert.ok(beside.length > 0)
    }
  }
})

test("every column of the block holds tiles, so copies leave no holes", () => {
  const layout = layoutHome(make(45))
  const { w } = layout.period!
  const xs = new Set(layout.tiles.map((t) => t.x))
  assert.equal(xs.size, Math.round(w / 256))
})

test("layout is deterministic", () => {
  assert.deepEqual(layoutHome(make(50)), layoutHome(make(50)))
  assert.deepEqual(layoutHome(make(9)), layoutHome(make(9)))
})

test("culling returns exactly the tiles that intersect the rect, with unique keys", () => {
  const layout = layoutHome(make(70))
  const { w, h } = layout.period!
  const rect: Rect = { x: 900, y: -1300, w: 1800, h: 1100 }
  const got = visibleTiles(layout, rect)
  const keys = got.map((t) => t.key)
  assert.equal(new Set(keys).size, keys.length)
  for (const t of got) assert.ok(overlap(t, rect) > 0, `${t.key} is outside the rect`)

  const expected = new Set<string>()
  for (let i = -4; i <= 4; i++)
    for (let j = -4; j <= 4; j++)
      for (const t of i === 0 && j === 0 ? layout.tiles : [...layout.tiles, ...layout.fill]) {
        const moved = { ...t, x: t.x + i * w, y: t.y + j * h }
        if (moved.x < rect.x + rect.w && moved.x + t.w > rect.x && moved.y < rect.y + rect.h && moved.y + t.h > rect.y) expected.add(`${t.key}@${i},${j}`)
      }
  assert.deepEqual(new Set(keys), expected)
})

test("staging holds back all but a frame's worth of new tiles, nearest the middle first, and keeps what is mounted", () => {
  const layout = layoutHome(make(200))
  const rect: Rect = { x: -8000, y: -5000, w: 16000, h: 10000 }
  const wanted = visibleTiles(layout, rect)
  assert.ok(wanted.length > 4 * MOUNT_PER_FRAME, `${wanted.length} tiles in the rect`)
  const dist = (t: Placement) => Math.hypot(t.x + t.w / 2 - (rect.x + rect.w / 2), t.y + t.h / 2 - (rect.y + rect.h / 2))

  // Some tiles are mounted already (the last view's), one more has left the view.
  const mounted = new Set([...wanted.slice(0, 40).map((t) => t.key), "gone"])
  const step = stageTiles(wanted, mounted, rect)
  assert.equal(step.later, true)
  assert.ok(wanted.slice(0, 40).every((t) => step.tiles.includes(t)), "every tile that stays in view stays mounted")
  assert.ok(!step.tiles.some((t) => t.key === "gone"))
  const added = step.tiles.filter((t) => !mounted.has(t.key))
  assert.equal(added.length, MOUNT_PER_FRAME)
  const held = wanted.filter((t) => !mounted.has(t.key) && !step.tiles.includes(t))
  assert.ok(Math.max(...added.map(dist)) <= Math.min(...held.map(dist)), "the tiles nearest the middle come first")
  assert.deepEqual(step.tiles, wanted.filter((t) => step.tiles.includes(t)), "the order of the tiles is kept")

  // The rest follow, a frame's worth at a time, until every tile in view is mounted.
  let now = new Set(step.tiles.map((t) => t.key))
  let frames = 1
  for (let next = stageTiles(wanted, now, rect); ; next = stageTiles(wanted, now, rect)) {
    assert.ok(next.tiles.filter((t) => !now.has(t.key)).length <= MOUNT_PER_FRAME)
    now = new Set(next.tiles.map((t) => t.key))
    frames++
    if (!next.later) break
    assert.ok(frames < 100, "staging ends")
  }
  assert.deepEqual([...now].sort(), wanted.map((t) => t.key).sort())
  assert.equal(frames, Math.ceil((wanted.length - 40) / MOUNT_PER_FRAME), "one frame per MOUNT_PER_FRAME new tiles")
})

test("staging mounts a step of fewer new tiles than the limit at once", () => {
  const layout = layoutHome(make(200))
  const rect: Rect = { x: -600, y: -400, w: 1200, h: 800 }
  const wanted = visibleTiles(layout, rect)
  const step = stageTiles(wanted, new Set(wanted.slice(10).map((t) => t.key)), rect)
  assert.deepEqual(step, { tiles: wanted, later: false })
})

test("a closed plaza leaves no hole: tiles meet at the origin, small library or repeating block", () => {
  const middle: Rect = { x: -100, y: -60, w: 200, h: 120 }
  for (const n of [10, 80]) {
    const layout = layoutHome(make(n), { w: 0, h: 0 })
    assert.equal(layout.fill.length, 0)
    const all = visibleTiles(layout, { x: -3000, y: -3000, w: 6000, h: 6000 })
    assertNoOverlaps(all)
    const covered = visibleTiles(layout, middle).reduce((s, t) => s + overlap(t, middle), 0)
    assert.ok(covered > 0.7 * middle.w * middle.h, `${n} items: the middle is only ${Math.round((covered / (middle.w * middle.h)) * 100)}% covered`)
  }
})
