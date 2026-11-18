import { test } from "node:test"
import assert from "node:assert/strict"
import { GAP, layoutHome, MOUNT_PER_FRAME, PLAZA, stageTiles, visibleTiles, type Placement, type Rect } from "../src/components/canvas/home-layout"

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

const everything: Rect = { x: -1e6, y: -1e6, w: 2e6, h: 2e6 }
const SIZES = [3, 40, 400, 1000]

test("every item has exactly one tile, at any size of library", () => {
  for (const n of SIZES) {
    const layout = layoutHome(make(n))
    const all = visibleTiles(layout, everything)
    assert.equal(all.length, n, `${n} items`)
    assert.equal(new Set(all.map((t) => t.index)).size, n)
    assert.equal(new Set(all.map((t) => t.key)).size, n)
    assertNoOverlaps(all)
    assert.equal(visibleTiles(layout, plaza).length, 0)
  }
})

test("panning far in any direction shows no item twice, and past the content shows nothing", () => {
  for (const n of SIZES) {
    const layout = layoutHome(make(n))
    const view: Rect = { x: -720, y: -450, w: 1440, h: 900 }
    const seen = new Map<number, string>()
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1]] as const) {
      for (let step = 0; step < 200; step++) {
        const at = shift(view, dx * step * 300, dy * step * 300)
        const keys = visibleTiles(layout, at).map((t) => t.key)
        assert.equal(new Set(keys).size, keys.length, `${n} items: a view shows an item twice`)
        for (const t of visibleTiles(layout, at)) {
          const where = `${t.x},${t.y}`
          assert.equal(seen.get(t.index) ?? where, where, `${n} items: item ${t.index} is in two places`)
          seen.set(t.index, where)
        }
      }
      assert.equal(visibleTiles(layout, shift(view, dx * 1e5, dy * 1e5)).length, 0)
    }
  }
})

test("newest items sit nearest the centre, and the field grows wider than tall", () => {
  for (const n of [12, 80, 1000]) {
    const { tiles } = layoutHome(make(n))
    const dist = (t: Placement) => Math.hypot(t.x + t.w / 2, t.y + t.h / 2)
    assert.ok(dist(tiles[0]!) < dist(tiles[n - 1]!))
    const mean = (list: Placement[]) => list.reduce((s, t) => s + dist(t), 0) / list.length
    assert.ok(mean(tiles.slice(0, n / 4)) < mean(tiles.slice(-n / 4)), `${n} items: the newest quarter is nearer than the oldest`)
    if (n >= 80) {
      const w = Math.max(...tiles.map((t) => t.x + t.w)) - Math.min(...tiles.map((t) => t.x))
      const h = Math.max(...tiles.map((t) => t.y + t.h)) - Math.min(...tiles.map((t) => t.y))
      assert.ok(w > h, `${n} items: ${w} x ${h}`)
    }
  }
})

test("a new save moves only the tiles of the column it joins", () => {
  for (const n of [40, 400]) {
    const before = layoutHome(make(n))
    const items = [{ key: "new", aspect: 1.4 }, ...make(n)]
    const after = layoutHome(items, PLAZA, before.slots)
    assert.equal(after.tiles.length, n + 1)
    const added = after.tiles.find((t) => t.key === "new")!
    const was = new Map(before.tiles.map((t) => [t.key, t]))
    const moved = after.tiles.filter((t) => t.key !== "new" && (was.get(t.key)!.x !== t.x || was.get(t.key)!.y !== t.y))
    assert.ok(moved.every((t) => t.x === added.x), `${n} items: only the new tile's column moves`)
    assert.ok(moved.length < n / 4, `${n} items: ${moved.length} tiles moved`)
    assertNoOverlaps(after.tiles)
    // It sits next to the plaza, nearest the centre of its column.
    const column = after.tiles.filter((t) => t.x === added.x && Math.sign(t.y) === Math.sign(added.y))
    assert.ok(column.every((t) => Math.abs(added.y + added.h / 2) <= Math.abs(t.y + t.h / 2)))
  }
})

test("a new save lands beside the plaza, in view of the opening screen, however big the library", () => {
  const screen: Rect = { x: -640, y: -400, w: 1280, h: 800 }
  const inside = (t: Placement) => t.x >= screen.x && t.y >= screen.y && t.x + t.w <= screen.x + screen.w && t.y + t.h <= screen.y + screen.h
  const tall = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `item${i}`, aspect: 1.6 }))
  for (const plazaSize of [PLAZA, { w: 0, h: 0 }]) {
    for (const n of [10, 100, 400]) {
      let items = tall(n)
      let layout = layoutHome(items, plazaSize)
      // Five saves in a row, each laid out on the last.
      for (let s = 0; s < 5; s++) {
        items = [{ key: `new${s}`, aspect: [1.6, 0.8, 1.3, 2.4, 1][s]! }, ...items]
        layout = layoutHome(items, plazaSize, layout.slots)
        const added = layout.tiles.find((t) => t.key === `new${s}`)!
        assert.ok(inside(added), `${n} items, save ${s + 1}: at ${added.x}, ${added.y}`)
      }
      assertNoOverlaps(layout.tiles)
    }
  }
})

test("older items loaded later go to the edge and move nothing", () => {
  const before = layoutHome(make(100))
  const after = layoutHome(make(160), PLAZA, before.slots)
  for (const t of before.tiles) {
    const now = after.tiles[t.index]!
    assert.deepEqual([now.key, now.x, now.y], [t.key, t.x, t.y])
  }
  assertNoOverlaps(after.tiles)
})

test("an item that is gone leaves no hole: its column closes up", () => {
  const before = layoutHome(make(60))
  const items = make(60).filter((_, i) => i !== 5)
  const after = layoutHome(items, PLAZA, before.slots)
  assert.equal(after.tiles.length, 59)
  assertNoOverlaps(after.tiles)
  const gone = before.tiles[5]!
  // Its column, from the plaza outward: each tile starts one gap after the one before.
  const column = after.tiles
    .filter((t) => t.x === gone.x && Math.sign(t.y) === Math.sign(gone.y))
    .map((t) => (t.y > 0 ? { from: t.y, to: t.y + t.h } : { from: -(t.y + t.h), to: -t.y }))
    .sort((a, b) => a.from - b.from)
  for (let i = 1; i < column.length; i++) assert.ok(Math.abs(column[i]!.from - column[i - 1]!.to - GAP) < EPS)
})

test("a taller plaza passed in stays clear, and the 520-px card never touches a tile", () => {
  for (const h of [260, 420]) {
    for (const n of [9, 60]) {
      const layout = layoutHome(make(n), { w: PLAZA.w, h })
      const card: Rect = { x: -260, y: -h / 2, w: 520, h }
      assert.equal(visibleTiles(layout, card).length, 0, `${n} items, plaza ${h}`)
      if (n >= 60) assert.ok(visibleTiles(layout, { x: 264, y: -h / 2, w: 240, h }).length > 0, "beside the card, the field comes right up to it")
    }
  }
})

test("layout is deterministic", () => {
  assert.deepEqual(layoutHome(make(50)), layoutHome(make(50)))
  assert.deepEqual(layoutHome(make(9)), layoutHome(make(9)))
})

test("culling returns exactly the tiles that intersect the rect", () => {
  const layout = layoutHome(make(300))
  const rect: Rect = { x: 900, y: -1300, w: 1800, h: 1100 }
  const got = visibleTiles(layout, rect)
  assert.ok(got.length > 0)
  assert.deepEqual(new Set(got), new Set(layout.tiles.filter((t) => overlap(t, rect) > 0)))
})

test("staging holds back all but a frame's worth of new tiles, nearest the middle first, and keeps what is mounted", () => {
  const layout = layoutHome(make(1000))
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

test("a closed plaza leaves no hole: tiles meet at the origin", () => {
  const middle: Rect = { x: -100, y: -60, w: 200, h: 120 }
  for (const n of [10, 80]) {
    const layout = layoutHome(make(n), { w: 0, h: 0 })
    const all = visibleTiles(layout, { x: -3000, y: -3000, w: 6000, h: 6000 })
    assertNoOverlaps(all)
    const covered = visibleTiles(layout, middle).reduce((s, t) => s + overlap(t, middle), 0)
    assert.ok(covered > 0.7 * middle.w * middle.h, `${n} items: the middle is only ${Math.round((covered / (middle.w * middle.h)) * 100)}% covered`)
  }
})
