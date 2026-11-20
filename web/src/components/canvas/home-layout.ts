export const COLUMN = 240
export const GAP = 16
export const SITE_GAP = 72
const PITCH = COLUMN + GAP
export const PLAZA = { w: 528, h: 260 }
export type Plaza = { w: number; h: number }

export type Rect = { x: number; y: number; w: number; h: number }
/** A tile in world px. `index` points into the items passed to layoutHome; `key` is the item's. */
export type Placement = Rect & { key: string; index: number }
export type Slot = Rect & { site?: string }
export type HomeLayout = {
  tiles: Placement[]
  slots: Map<string, Slot>
}

export type HomeItem = { key: string; aspect: number; site?: string; parent?: string }

const touchesPlaza = (x: number, plaza: Plaza) =>
  plaza.w > 0 && plaza.h > 0 && Math.abs(x + COLUMN / 2) < plaza.w / 2 + COLUMN / 2 + GAP

/** The closest valid top edge in a column. */
function nearestTop(blocked: [number, number][], target: number): number {
  blocked.sort((a, b) => a[0] - b[0])
  let bottom = -Infinity
  let top = -Infinity
  for (const [lo, hi] of blocked) {
    if (lo >= bottom) {
      if (target < bottom) return bottom - target <= target - top ? bottom : top
      if (target <= lo) return target
      top = lo
    }
    bottom = Math.max(bottom, hi)
  }
  if (target >= bottom) return target
  return bottom - target <= target - top ? bottom : top
}

/** Pack each site together. Subsequent feeds fill gaps near their own site (or parent), without shifting saved tiles. */
export function layoutHome(items: HomeItem[], plaza: Plaza = PLAZA, keep?: ReadonlyMap<string, Slot>, fixed?: ReadonlyMap<string, { x: number; y: number }>): HomeLayout {
  const slots = new Map<string, Slot>()
  const columns = new Map<number, Slot[]>()
  const anchors = new Map<string | undefined, Slot>()
  const groups = new Map<string | undefined, HomeItem[]>()
  const byKey = new Map<string, HomeItem>()
  const children = new Map<string, HomeItem[]>()
  const put = (key: string, tile: Slot) => {
    slots.set(key, tile)
    const c = Math.round((tile.x + COLUMN / 2) / PITCH)
    const column = columns.get(c) ?? []
    column.push(tile)
    columns.set(c, column)
    if (!anchors.has(tile.site)) anchors.set(tile.site, tile)
  }
  for (const item of items) {
    if (byKey.has(item.key)) continue
    byKey.set(item.key, item)
    if (item.parent) {
      const family = children.get(item.parent) ?? []
      family.push(item)
      children.set(item.parent, family)
    }
  }
  for (const item of byKey.values()) {
    const pos = fixed?.get(item.key)
    if (pos) put(item.key, { ...pos, site: item.site, w: COLUMN, h: COLUMN / item.aspect })
  }
  for (const [key, prior] of keep ?? []) {
    const item = byKey.get(key)
    if (!item || slots.has(key) || item.site !== prior.site || prior.h !== COLUMN / item.aspect) continue
    if (touchesPlaza(prior.x, plaza) && prior.y < plaza.h / 2 + GAP && prior.y + prior.h > -plaza.h / 2 - GAP) continue
    put(key, prior)
  }
  for (const item of byKey.values()) {
    if (slots.has(item.key)) continue
    const group = groups.get(item.site) ?? []
    group.push(item)
    groups.set(item.site, group)
  }

  const place = ({ key, aspect, site, parent }: HomeItem) => {
    if (slots.has(key)) return
    const previous = keep?.get(key)
    const familyTile = children.get(parent ?? key)?.find((item) => item.site === site && slots.has(item.key))
    const relative = (parent ? slots.get(parent) : undefined) ?? (familyTile ? slots.get(familyTile.key) : undefined)
    const h = COLUMN / aspect
    const anchor = previous && previous.site === site ? { ...previous, h }
      : relative && relative.site === site ? relative : anchors.get(site)
    const cx = anchor ? anchor.x + COLUMN / 2 : 0
    const cy = anchor ? anchor.y + anchor.h / 2 : 0
    const start = Math.round(cx / PITCH)
    let best = Infinity
    let bestX = 0
    let bestY = 0
    const tryColumn = (c: number) => {
      const dx = ((c * PITCH - cx) / 1.3) ** 2
      if (dx > best) return false
      const x = c * PITCH - COLUMN / 2
      const target = cy - h / 2
      const reach = Math.sqrt(best - dx)
      const blocked: [number, number][] = []
      if (touchesPlaza(x, plaza)) blocked.push([-plaza.h / 2 - GAP - h, plaza.h / 2 + GAP])
      for (let other = c - 1; other <= c + 1; other++) {
        for (const tile of columns.get(other) ?? []) {
          const gap = tile.site === site ? GAP : SITE_GAP
          const lo = tile.y - gap - h
          const hi = tile.y + tile.h + gap
          if (lo < target + reach && hi > target - reach && Math.abs(tile.x - x) < COLUMN + gap) blocked.push([lo, hi])
        }
      }
      const y = nearestTop(blocked, target)
      const distance = dx + (y - target) ** 2
      if (distance < best) {
        best = distance
        bestX = x
        bestY = y
      }
      return true
    }
    tryColumn(start)
    for (let step = 1; ; step++) {
      const left = tryColumn(start - step)
      const right = tryColumn(start + step)
      if (!left && !right) break
    }
    put(key, { site, x: bestX, y: bestY, w: COLUMN, h })
  }
  for (const group of groups.values()) {
    for (const item of group) {
      if (slots.has(item.key)) continue
      const family = item.parent ?? item.key
      const parent = byKey.get(family)
      if (parent && parent.site === item.site) place(parent)
      place(item)
      for (const child of children.get(family) ?? []) if (child.site === item.site) place(child)
    }
  }

  const seen = new Set<string>()
  const tiles = items.flatMap(({ key }, index): Placement[] => {
    if (seen.has(key)) return []
    seen.add(key)
    const { x, y, w, h } = slots.get(key)!
    return [{ key, index, x, y, w, h }]
  })
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
