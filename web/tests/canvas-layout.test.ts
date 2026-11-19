import { test } from "node:test"
import assert from "node:assert/strict"
import { GAP, layoutHome, MOUNT_PER_FRAME, PLAZA, SITE_GAP, stageTiles, visibleTiles, type HomeItem, type Placement, type Rect } from "../src/components/canvas/home-layout"

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

const closed = { w: 0, h: 0 }
const distance = (a: Rect, b: Rect) => Math.hypot(a.x + a.w / 2 - b.x - b.w / 2, a.y + a.h / 2 - b.y - b.h / 2)
const page = (key: string, site: string): HomeItem => ({ key, site, aspect: 1.6 })

test("interleaved feed entries form compact site groups with wider whitespace between them", () => {
  const items = ["a", "b", "c", "d"].flatMap((suffix) => ["alpha", "beta", "gamma"].map((site) => page(`${site}:${suffix}`, site)))
  const { slots, tiles } = layoutHome(items, closed)
  assert.deepEqual(tiles.map((t) => t.key), items.map((i) => i.key), "paint and keyboard order still follow the feed")
  for (const a of slots.values()) for (const b of slots.values()) {
    if (a.site !== b.site) assert.equal(overlap({ x: a.x - SITE_GAP, y: a.y - SITE_GAP, w: a.w + 2 * SITE_GAP, h: a.h + 2 * SITE_GAP }, b), 0)
    else assert.ok(distance(a, b) <= 512, "a four-page group stays within two tile pitches")
  }
})

test("refreshes prepend and append without moving any existing site or tile", () => {
  const items = make(80).map((item, i) => ({ ...item, site: String(i % 8) }))
  const before = layoutHome(items)
  const next = [
    page("fresh", "1"),
    ...items.slice().reverse(),
    page("old sibling", "2"),
    page("a new site", "9"),
    items[0]!,
  ]
  const after = layoutHome(next, PLAZA, before.slots)
  for (const [key, slot] of before.slots) assert.deepEqual(after.slots.get(key), slot)
  assert.equal(after.tiles.length, items.length + 3, "duplicate input cannot create a second tile")
  assertNoOverlaps(after.tiles)
})

test("sections and recordings prefer their page, including when the page arrives later", () => {
  const related = [
    { ...page("section", "alpha"), parent: "parent" },
    { ...page("recording", "alpha"), parent: "parent" },
  ]
  const siblings = Array.from({ length: 10 }, (_, i) => page(`sibling ${i}`, "alpha"))
  const parent = page("parent", "alpha")
  const layout = layoutHome([...siblings, ...related, parent], closed)
  for (const child of related) {
    assert.ok(distance(layout.slots.get(child.key)!, layout.slots.get(parent.key)!) <= 256)
  }
  const filtered = layoutHome([related[0]!, ...siblings, related[1]!], closed)
  assert.ok(distance(filtered.slots.get("section")!, filtered.slots.get("recording")!) <= 256)
  assert.equal(filtered.slots.has("parent"), false, "a filtered-out page never gets a tile")
  const before = layoutHome([related[0]!, ...siblings], closed)
  const after = layoutHome([parent, related[1]!, related[0]!, ...siblings], closed, before.slots)
  assert.deepEqual(after.slots.get("section"), before.slots.get("section"))
  assert.ok(distance(after.slots.get("section")!, after.slots.get("parent")!) < 430, "the late parent fills the nearest free space without displacing siblings")
  assertNoOverlaps(after.tiles)
})

test("a changed aspect updates only that tile, retaining its location where it fits", () => {
  const items = [page("one", "alpha"), page("two", "alpha"), page("three", "beta")]
  const before = layoutHome(items, closed)
  const after = layoutHome([{ ...items[0]!, aspect: 2.4 }, ...items.slice(1)], closed, before.slots)
  assert.deepEqual(after.slots.get("one"), { ...before.slots.get("one"), h: 100 })
  const larger = layoutHome([{ ...items[0]!, aspect: 0.4 }, ...items.slice(1)], closed, after.slots)
  assert.equal(larger.slots.get("one")!.h, 600)
  for (const item of items.slice(1)) assert.deepEqual(larger.slots.get(item.key), before.slots.get(item.key))
  assertNoOverlaps(larger.tiles)
})

test("loading a page of older tiles leaves existing coordinates unchanged", () => {
  const before = layoutHome(make(100))
  const after = layoutHome(make(160), PLAZA, before.slots)
  for (const t of before.tiles) {
    const now = after.tiles[t.index]!
    assert.deepEqual([now.key, now.x, now.y], [t.key, t.x, t.y])
  }
  assertNoOverlaps(after.tiles)
})

test("removing a tile leaves its neighbours stable and available space can be reused", () => {
  const before = layoutHome(make(60))
  const items = make(60).filter((_, i) => i !== 5)
  const after = layoutHome(items, PLAZA, before.slots)
  assert.equal(after.tiles.length, 59)
  assertNoOverlaps(after.tiles)
  for (const [key, slot] of after.slots) assert.deepEqual(slot, before.slots.get(key))
  const replacement = layoutHome([...items, { ...make(6)[5]!, key: "replacement" }], PLAZA, after.slots)
  assert.deepEqual(replacement.slots.get("replacement"), before.slots.get("item5"))
})

test("a taller plaza passed in stays clear, and the 520-px card never touches a tile", () => {
  for (const h of [260, 420]) {
    for (const n of [9, 60]) {
      const layout = layoutHome(make(n), { w: PLAZA.w, h })
      const card: Rect = { x: -260, y: -h / 2, w: 520, h }
      assert.equal(visibleTiles(layout, card).length, 0, `${n} items, plaza ${h}`)
      if (n >= 60) assert.ok(visibleTiles(layout, { x: 264 + GAP, y: -h / 2, w: 368, h }).length > 0, "there are still tiles beside the card")
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
