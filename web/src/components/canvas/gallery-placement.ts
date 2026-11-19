import { GAP, type Rect } from "./home-layout"

export type Point = { x: number; y: number }
type Interval = [number, number]

const obstacle = (from: Rect, to: Rect): Rect => ({
    x: to.x - from.x - from.w - GAP,
    y: to.y - from.y - from.h - GAP,
    w: from.w + to.w + 2 * GAP,
    h: from.h + to.h + 2 * GAP,
})

const CELL = 256

export function movementSolver(moving: readonly Rect[], others: readonly Rect[]) {
  const cells = new Map<string, Rect[]>()
  const visit = (x: number, y: number, w: number, h: number, each: (key: string) => void) => {
    for (let i = Math.floor(x / CELL); i <= Math.floor((x + w) / CELL); i++) {
      for (let j = Math.floor(y / CELL); j <= Math.floor((y + h) / CELL); j++) each(`${i}:${j}`)
    }
  }
  for (const r of others) visit(r.x, r.y, r.w, r.h, (key) => {
    let group = cells.get(key)
    if (!group) cells.set(key, group = [])
    group.push(r)
  })
  return (raw: Point) => {
    for (let radius = 0; ; radius = radius === 0 ? GAP : radius * 2) {
      const near: Rect[] = []
      const pad = GAP + radius
      for (const t of moving) {
        const x = t.x + raw.x - pad
        const y = t.y + raw.y - pad
        const w = t.w + pad * 2
        const h = t.h + pad * 2
        const neighbors = new Set<Rect>()
        if (radius >= CELL) {
          for (const r of others) neighbors.add(r)
        } else {
          visit(x, y, w, h, (key) => { for (const r of cells.get(key) ?? []) neighbors.add(r) })
        }
        for (const r of neighbors) if (r.x < x + w && r.x + r.w > x && r.y < y + h && r.y + r.h > y) near.push(obstacle(t, r))
      }
      const result = settleTranslation(raw, near)
      if (result === raw || Math.hypot(result.x - raw.x, result.y - raw.y) <= radius) return result
    }
  }
}

function closestOnLine(edges: Interval[], at: number) {
  edges.sort((a, b) => a[0] - b[0])
  let lo = -Infinity
  let hi = -Infinity
  for (const [start, end] of edges) {
    if (start >= hi) {
      if (lo < at && at < hi) break
      if (start >= at) return at
      lo = start
    }
    hi = Math.max(hi, end)
  }
  if (lo >= at || at >= hi) return at
  return at - lo <= hi - at ? lo : hi
}

export function settleTranslation(raw: Point, obstacles: readonly Rect[]): Point {
  const crosses = (at: number, from: number, size: number) => from < at && at < from + size
  const vertical: Interval[] = []
  const horizontal: Interval[] = []
  let blocked = false
  for (const r of obstacles) {
    const x = crosses(raw.x, r.x, r.w)
    const y = crosses(raw.y, r.y, r.h)
    if (x) vertical.push([r.y, r.y + r.h])
    if (y) horizontal.push([r.x, r.x + r.w])
    blocked ||= x && y
  }
  if (!blocked) return raw
  const y = closestOnLine(vertical, raw.y)
  const x = closestOnLine(horizontal, raw.x)
  let best = Math.abs(raw.x - x) < Math.abs(raw.y - y) ? { x, y: raw.y } : { x: raw.x, y }
  let distance = Math.hypot(best.x - raw.x, best.y - raw.y)
  const near = obstacles.filter((r) => r.x < raw.x + distance && r.x + r.w > raw.x - distance && r.y < raw.y + distance && r.y + r.h > raw.y - distance)
  const candidates = new Set(near.flatMap((r) => [r.x, r.x + r.w]))
  for (const x of candidates) {
    if (Math.abs(x - raw.x) >= distance || x === raw.x) continue
    const intervals: Interval[] = []
    for (const r of near) if (crosses(x, r.x, r.w)) intervals.push([r.y, r.y + r.h])
    const y = closestOnLine(intervals, raw.y)
    const length = Math.hypot(x - raw.x, y - raw.y)
    if (length < distance) {
      distance = length
      best = { x, y }
    }
  }
  return best
}
