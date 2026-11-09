// Home canvas layout: masonry columns around a clear plaza at the world origin, newest items nearest the centre.
// With enough items one block repeats in every direction (a torus); only the origin copy keeps the plaza clear.
// Pure and free of `@/` imports: web/tests/canvas-layout.test.ts runs it under node.

export const COLUMN = 240
export const GAP = 16
const PITCH = COLUMN + GAP
/**
 * Default clear area centred on the origin, for the mascot and the 520-px capture card. Columns straddle the origin
 * (centres at ±128, ±384, …), so only the two inner ones stop at the plaza and the next ones clear the card by 4 px.
 * canvas-home passes the measured height, so the plaza grows only while a capture shows its landing row.
 */
export const PLAZA = { w: 528, h: 260 }
export type Plaza = { w: number; h: number }
/** From this many items the block repeats in every direction; below it the items form one cluster. */
export const REPEAT_FROM = 16
/** Rings grow wider than tall, like a screen. */
const X_STRETCH = 1.5
/** Columns either side of the origin the finite cluster may use (15 items never reach it). */
const CLUSTER_COLS = 12

export type Rect = { x: number; y: number; w: number; h: number }
/** A tile in world px. `index` points into the items passed to layoutHome; `key` is unique per copy. */
export type Placement = { key: string; index: number; x: number; y: number; w: number; h: number }
export type HomeLayout = {
  tiles: Placement[]
  /** Tiles that fill the plaza in every copy but the origin one. */
  fill: Placement[]
  /** Size of the repeating block, or null for one finite cluster. */
  period: { w: number; h: number } | null
}

type Column = { c: number; hole: boolean; top: number; bottom: number; used: number; up: number[]; down: number[] }

/** Centre x of column c. */
const cx = (c: number) => (c + 0.5) * PITCH

/** Columns c in [from, to); those under the plaza start beyond it. */
function columns(from: number, to: number, plaza: Plaza): Column[] {
  const out: Column[] = []
  for (let c = from; c < to; c++) {
    const hole = Math.abs(cx(c)) - COLUMN / 2 < plaza.w / 2
    out.push({ c, hole, top: hole ? -plaza.h / 2 - GAP : -GAP / 2, bottom: hole ? plaza.h / 2 + GAP : GAP / 2, used: 0, up: [], down: [] })
  }
  return out
}

/**
 * Greedy ring fill: each item goes to the column end (above or below) whose tile centre would sit nearest the origin.
 * With caps, a column takes no more than its cap while another has room.
 */
function fill(heights: number[], cols: Column[], cap?: (col: Column) => number) {
  heights.forEach((h, i) => {
    let best: { col: Column; down: boolean; d: number } | null = null
    for (const col of cols) {
      if (cap && col.used + h + GAP > cap(col)) continue
      const x = cx(col.c) / X_STRETCH
      for (const down of [false, true]) {
        const d = Math.hypot(x, down ? col.bottom + h / 2 : col.top - h / 2)
        if (!best || d < best.d) best = { col, down, d }
      }
    }
    if (!best) {
      // Nothing has room: the roomiest column takes it, and the block grows to fit.
      const col = cols.reduce((a, b) => (cap!(b) - b.used > cap!(a) - a.used ? b : a))
      const x = cx(col.c) / X_STRETCH
      best = { col, down: Math.hypot(x, col.bottom + h / 2) < Math.hypot(x, col.top - h / 2), d: 0 }
    }
    const { col, down } = best
    if (down) {
      col.down.push(i)
      col.bottom += h + GAP
    } else {
      col.up.push(i)
      col.top -= h + GAP
    }
    col.used += h + GAP
  })
}

/** Placements for filled columns, each column's tile heights multiplied by scale(col). */
function place(keys: string[], heights: number[], cols: Column[], plaza: Plaza, scale: (col: Column) => number): Placement[] {
  const out: Placement[] = []
  for (const col of cols) {
    const f = scale(col)
    const x = cx(col.c) - COLUMN / 2
    let y = col.hole ? plaza.h / 2 + GAP : GAP / 2
    for (const index of col.down) {
      const h = heights[index]! * f
      out.push({ key: keys[index]!, index, x, y, w: COLUMN, h })
      y += h + GAP
    }
    y = col.hole ? -plaza.h / 2 - GAP : -GAP / 2
    for (const index of col.up) {
      const h = heights[index]! * f
      y -= h
      out.push({ key: keys[index]!, index, x, y, w: COLUMN, h })
      y -= GAP
    }
  }
  return out.sort((a, b) => a.index - b.index)
}

export function layoutHome(items: { key: string; aspect: number }[], plaza: Plaza = PLAZA): HomeLayout {
  const keys = items.map((it) => it.key)
  const heights = items.map((it) => COLUMN / it.aspect)
  // The plaza sits in its columns like one more item: its height plus the gap below it.
  const HOLE = plaza.h + GAP

  if (items.length < REPEAT_FROM) {
    const cols = columns(-CLUSTER_COLS, CLUSTER_COLS, plaza)
    fill(heights, cols)
    return { tiles: place(keys, heights, cols, plaza, () => 1), fill: [], period: null }
  }

  // A block about 1.6:1, an even number of columns so it is symmetric about the origin, at least four so the plaza
  // has columns beside it.
  const plazaCols = columns(-CLUSTER_COLS, CLUSTER_COLS, plaza).filter((col) => col.hole).length
  const total = heights.reduce((s, h) => s + h + GAP, 0) + plazaCols * HOLE
  const raw = Math.max(4, Math.round(Math.sqrt((total * 1.6) / PITCH)))
  const n = raw + (raw % 2)
  const cols = columns(-n / 2, n / 2, plaza)
  const target = Math.max(Math.ceil(total / n), HOLE + Math.max(...heights) + GAP)
  const fixed = (col: Column) => (col.hole ? HOLE : 0)
  fill(heights, cols, (col) => target - fixed(col))

  // Every column must wrap at the same height. Shorter columns stretch their tiles (tiles crop with object-cover)
  // rather than their gaps, so the gaps stay even.
  // ponytail: a column left with one short tile stretches it a lot; rebalance columns if that shows up in practice.
  const H = Math.max(...cols.map((col) => col.used + fixed(col)))
  const scale = (col: Column) => {
    const count = col.up.length + col.down.length
    const natural = col.used - count * GAP
    return natural > 0 ? (H - fixed(col) - count * GAP) / natural : 1
  }
  const tiles = place(keys, heights, cols, plaza, scale)

  // Other copies fill the plaza: in each of its columns, the oldest items stretched to exactly its height.
  const holeFill: Placement[] = []
  let next = 0
  for (const col of cols.filter((col) => col.hole)) {
    const pick = (k: number) => items.length - 1 - ((next + k) % items.length)
    let k = 0
    let sum = 0
    while (k === 0 || sum + (k - 1) * GAP < plaza.h) sum += heights[pick(k++)]!
    // One fewer may land closer to the plaza height than one more.
    const fewer = sum - heights[pick(k - 1)]!
    if (k > 1 && plaza.h - (fewer + (k - 2) * GAP) < sum + (k - 1) * GAP - plaza.h) {
      k--
      sum = fewer
    }
    const f = (plaza.h - (k - 1) * GAP) / sum
    let y = -plaza.h / 2
    for (let m = 0; m < k; m++) {
      const index = pick(m)
      const h = heights[index]! * f
      holeFill.push({ key: `fill${col.c}:${keys[index]}`, index, x: cx(col.c) - COLUMN / 2, y, w: COLUMN, h })
      y += h + GAP
    }
    next += k
  }

  return { tiles, fill: holeFill, period: { w: n * PITCH, h: H } }
}

const intersects = (a: Rect, x: number, y: number, w: number, h: number) => x < a.x + a.w && x + w > a.x && y < a.y + a.h && y + h > a.y

/** Tiles (with copies of a repeating block) that intersect a world rect, origin copy first, newest first within a copy. */
export function visibleTiles(layout: HomeLayout, r: Rect): Placement[] {
  const { tiles, fill, period } = layout
  if (!period) return tiles.filter((t) => intersects(r, t.x, t.y, t.w, t.h))

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const t of [...tiles, ...fill]) {
    minX = Math.min(minX, t.x)
    minY = Math.min(minY, t.y)
    maxX = Math.max(maxX, t.x + t.w)
    maxY = Math.max(maxY, t.y + t.h)
  }
  const copies: [number, number][] = []
  for (let i = Math.floor((r.x - maxX) / period.w); i <= Math.ceil((r.x + r.w - minX) / period.w); i++)
    for (let j = Math.floor((r.y - maxY) / period.h); j <= Math.ceil((r.y + r.h - minY) / period.h); j++) copies.push([i, j])
  copies.sort((a, b) => Math.abs(a[0]) + Math.abs(a[1]) - Math.abs(b[0]) - Math.abs(b[1]))

  const out: Placement[] = []
  for (const [i, j] of copies) {
    const dx = i * period.w
    const dy = j * period.h
    for (const t of i === 0 && j === 0 ? tiles : [...tiles, ...fill]) {
      if (intersects(r, t.x + dx, t.y + dy, t.w, t.h)) out.push({ ...t, key: `${t.key}@${i},${j}`, x: t.x + dx, y: t.y + dy })
    }
  }
  return out
}
