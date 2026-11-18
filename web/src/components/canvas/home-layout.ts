// Home canvas layout: masonry columns around a clear plaza at the world origin, newest items nearest the centre. Every
// item has exactly one tile; the space around the content is empty.
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
/** Rings grow wider than tall, like a screen. */
const X_STRETCH = 1.5

export type Rect = { x: number; y: number; w: number; h: number }
/** A tile in world px. `index` points into the items passed to layoutHome; `key` is the item's. */
export type Placement = { key: string; index: number; x: number; y: number; w: number; h: number }
/** Where an item went: its column, and whether below the plaza's row (down) or above it. */
export type Slot = { c: number; down: boolean }
export type HomeLayout = {
  tiles: Placement[]
  /** Each item's slot, to pass back to the next layout of the same place so the items keep their places. */
  slots: Map<string, Slot>
}

type Column = { c: number; hole: boolean; top: number; bottom: number; up: number[]; down: number[] }

/** Centre x of column c. */
const cx = (c: number) => (c + 0.5) * PITCH

/**
 * Each item goes to the column end (above or below the plaza's row) whose tile centre would sit nearest the origin, so
 * the field grows outward in rings and the newest items, laid out first, sit nearest the plaza. Within a column the
 * newest is nearest the plaza.
 *
 * `keep` is the last layout's slots for this place. Items in it stay in their column; only new ones are placed. An item
 * saved since goes into the inner end of one of the middle columns, so it is beside the plaza, and moves that column's
 * older tiles out by one; older items
 * (another page of the feed) go to the outer ends, which moves nothing. Without `keep` the layout depends only on the
 * items, in order.
 */
export function layoutHome(items: { key: string; aspect: number }[], plaza: Plaza = PLAZA, keep?: ReadonlyMap<string, Slot>): HomeLayout {
  const heights = items.map((it) => COLUMN / it.aspect)
  const cols = new Map<number, Column>()
  const column = (c: number) => {
    let col = cols.get(c)
    if (!col) {
      const hole = Math.abs(cx(c)) - COLUMN / 2 < plaza.w / 2
      col = { c, hole, top: hole ? -plaza.h / 2 - GAP : -GAP / 2, bottom: hole ? plaza.h / 2 + GAP : GAP / 2, up: [], down: [] }
      cols.set(c, col)
    }
    return col
  }
  const put = (i: number, col: Column, down: boolean) => {
    const h = heights[i]! + GAP
    if (down) {
      col.down.push(i)
      col.bottom += h
    } else {
      col.up.push(i)
      col.top -= h
    }
  }

  const fresh: number[] = []
  let oldestKept = -1
  items.forEach((it, i) => {
    const slot = keep?.get(it.key)
    if (!slot) return fresh.push(i)
    put(i, column(slot.c), slot.down)
    oldestKept = i
  })
  // The nearest end is never further out than the columns the field already uses plus one either side.
  let reach = Math.max(1, ...[...cols.keys()].map((c) => Math.abs(c) + 2))
  for (const i of fresh) {
    const h = heights[i]!
    // An item newer than ones already placed lands at the inner end of its column, next to the plaza: it goes where
    // that spot is nearest the centre (the middle columns), the shortest such column first. Older items land at the
    // outer ends, where that end is nearest the centre.
    const inner = i < oldestKept
    let best: { col: Column; down: boolean; d: number; len: number } | null = null
    for (let c = -reach; c < reach; c++) {
      const col = column(c)
      const x = cx(c) / X_STRETCH
      for (const down of [false, true]) {
        const start = col.hole ? plaza.h / 2 + GAP : GAP / 2
        const end = down ? col.bottom : -col.top
        const d = Math.round(Math.hypot(x, inner ? start + h / 2 : end + h / 2))
        if (!best || d < best.d || (d === best.d && end < best.len)) best = { col, down, d, len: end }
      }
    }
    put(i, best!.col, best!.down)
    reach = Math.max(reach, Math.abs(best!.col.c) + 2)
  }

  const tiles: Placement[] = []
  const slots = new Map<string, Slot>()
  for (const col of cols.values()) {
    const x = cx(col.c) - COLUMN / 2
    for (const down of [true, false]) {
      let y = col.hole ? (down ? plaza.h / 2 + GAP : -plaza.h / 2 - GAP) : down ? GAP / 2 : -GAP / 2
      for (const index of (down ? col.down : col.up).sort((a, b) => a - b)) {
        const h = heights[index]!
        if (!down) y -= h
        tiles.push({ key: items[index]!.key, index, x, y, w: COLUMN, h })
        y += down ? h + GAP : -GAP
        slots.set(items[index]!.key, { c: col.c, down })
      }
    }
  }
  tiles.sort((a, b) => a.index - b.index)

  return { tiles, slots }
}

/** The tiles that intersect a world rect, newest first. */
export function visibleTiles(layout: HomeLayout, r: Rect): Placement[] {
  return layout.tiles.filter((t) => t.x < r.x + r.w && t.x + t.w > r.x && t.y < r.y + r.h && t.y + t.h > r.y)
}

/** The most tiles a render mounts that were not mounted before (see stageTiles). */
export const MOUNT_PER_FRAME = 100

/**
 * One step of a zoom can bring hundreds of tiles into view: one notch of a mouse wheel took the real library from 135
 * mounted tiles to 318, then 406, then 866. Mounting a tile (React's render and commit, then style, layout and paint)
 * costs the main thread about 0.13 ms in a build and 0.23 ms in development, so the last 549 of those were one 59 ms
 * frame in a build. So of the `wanted` tiles this returns every one that is mounted already and at most `limit` new
 * ones, nearest the middle of the rect first, in the order of `wanted`; `later` says some were held back for the next
 * frame. Tiles that left `wanted` are simply gone.
 */
export function stageTiles(wanted: Placement[], mounted: ReadonlySet<string>, r: Rect, limit = MOUNT_PER_FRAME): { tiles: Placement[]; later: boolean } {
  const fresh = wanted.filter((t) => !mounted.has(t.key))
  if (fresh.length <= limit) return { tiles: wanted, later: false }
  const cx = r.x + r.w / 2
  const cy = r.y + r.h / 2
  const away = (t: Placement) => Math.hypot(t.x + t.w / 2 - cx, t.y + t.h / 2 - cy)
  const admitted = new Set(fresh.sort((a, b) => away(a) - away(b)).slice(0, limit))
  return { tiles: wanted.filter((t) => mounted.has(t.key) || admitted.has(t)), later: true }
}
