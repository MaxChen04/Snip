import { memo } from "react"
import { SiteIcon } from "@/components/site-icon"
import { boundsOf } from "./gallery-editing"
import { MAX_ZOOM, type InfiniteCanvasHandle, type WorldRect } from "./infinite-canvas"
import { SITE_GAP, type Placement } from "./home-layout"
import type { CanvasItem } from "./types"

export const SITE_LABEL_ZOOM = 0.3

export function frameGallery(canvas: InfiniteCanvasHandle, area: WorldRect | undefined, animate = false) {
  if (!area) return canvas.recenter()
  const { width, height } = canvas.getView()
  const zoom = Math.min(MAX_ZOOM, (width * 0.86) / area.w, (height * 0.74) / area.h)
  canvas.setView({ x: area.x + area.w / 2, y: area.y + area.h / 2, zoom }, { animate })
}

type SitePin = {
  key: string
  name: string
  domain: string
  icon: string | null
  count: number
  anchorX: number
  width: number
  area: WorldRect
}

const apart = (a: WorldRect, b: WorldRect) => Math.hypot(
  Math.max(0, a.x - b.x - b.w, b.x - a.x - a.w),
  Math.max(0, a.y - b.y - b.h, b.y - a.y - a.h),
)

export function gallerySitePins(tiles: readonly Placement[], items: readonly CanvasItem[]): SitePin[] {
  const sites = new Map<string, { name: string; domain: string; icon: string | null; tiles: Placement[] }>()
  for (const tile of tiles) {
    const item = items[tile.index]
    if (!item || item.kind === "image") continue
    const r = item.kind === "website" ? item.reference : item.kind === "page" ? item.page.reference : item.kind === "section" ? item.section.reference : item.animation.reference
    const key = r.domain || r.id
    const existing = sites.get(key)
    if (existing) existing.tiles.push(tile)
    else sites.set(key, { name: r.title || r.domain || "Website", domain: r.domain, icon: r.favicon, tiles: [tile] })
  }
  const pins: SitePin[] = []
  for (const [key, { name, domain, icon, tiles }] of sites) {
    const remaining = new Set(tiles)
    let main: Placement[] = []
    for (const start of remaining) {
      remaining.delete(start)
      const cluster = [start]
      for (const tile of cluster) {
        for (const other of remaining) {
          if (apart(tile, other) > SITE_GAP) continue
          remaining.delete(other)
          cluster.push(other)
        }
      }
      if (cluster.length > main.length) main = cluster
    }
    const top = main.reduce((a, b) => b.y < a.y ? b : a)
    const area = boundsOf(main)!
    pins.push({ key, name, domain, icon, count: main.length, anchorX: top.x + top.w / 2, width: Math.min(164, Math.max(64, 44 + name.length * 7)), area })
  }
  return pins.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
}

type Label = SitePin & { box: WorldRect; width: number }
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
const intersects = (a: WorldRect, b: WorldRect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y

function clearOffset(lo: number, hi: number, preferred: number, blocked: [number, number][]) {
  if (blocked.every(([a, b]) => preferred <= a || preferred >= b)) return preferred
  let best: number | undefined
  let start = lo
  const check = (end: number) => {
    const candidate = clamp(preferred, start, end)
    if (best === undefined || Math.abs(candidate - preferred) < Math.abs(best - preferred)) best = candidate
  }
  for (const [a, b] of blocked.sort(([x], [y]) => x - y)) {
    if (b <= start) continue
    if (a >= start) check(Math.min(a, hi))
    start = b
    if (start > hi) return best
  }
  check(hi)
  return best
}

export function placeSiteLabels(pins: readonly SitePin[], tiles: readonly WorldRect[], zoom: number, height: number): Label[] {
  const obstacles = [...tiles]
  const labels: Label[] = []
  const gap = 5 / zoom
  for (const pin of pins) {
    const { area, anchorX } = pin
    const width = height === 44 ? Math.min(180, Math.ceil(pin.width * 1.2)) : pin.width
    const w = width / zoom, h = height / zoom
    const rails = [
      { axis: "x", fixed: area.y - h - gap, desired: anchorX - w / 2 },
      { axis: "y", fixed: area.x - w - gap, desired: area.y },
      { axis: "y", fixed: area.x + area.w + gap, desired: area.y },
      { axis: "x", fixed: area.y + area.h + gap, desired: anchorX - w / 2 },
    ] as const
    let best: WorldRect | undefined
    let distance = Infinity
    for (const { axis, fixed, desired } of rails) {
      const horizontal = axis === "x"
      const side = horizontal ? "y" : "x"
      const length = horizontal ? w : h
      const depth = horizontal ? h : w
      const lo = area[axis] - length / 2
      const hi = lo + (horizontal ? area.w : area.h)
      const preferred = clamp(desired, lo, hi)
      const blocked: [number, number][] = []
      for (const other of obstacles) {
        if (fixed >= other[side] + (horizontal ? other.h : other.w) + gap || fixed + depth <= other[side] - gap) continue
        const a = other[axis] - length - gap
        const b = other[axis] + (horizontal ? other.w : other.h) + gap
        if (a < hi && b > lo) blocked.push([a, b])
      }
      const offset = clearOffset(lo, hi, preferred, blocked)
      if (offset === undefined) continue
      const box = horizontal ? { x: offset, y: fixed, w, h } : { x: fixed, y: offset, w, h }
      if (fixed === rails[0].fixed && horizontal && offset === preferred) {
        best = box
        break
      }
      const score = Math.hypot(box.x + w / 2 - anchorX, box.y + h / 2 - area.y)
      if (score < distance) {
        best = box
        distance = score
      }
    }
    if (best) {
      obstacles.push(best)
      labels.push({ ...pin, width, box: best })
    }
  }
  return labels
}

export const GallerySiteLabels = memo(function GallerySiteLabels({ labels, zoom, height, visible, onFrame }: {
  labels: readonly Label[]
  zoom: number
  height: number
  visible: WorldRect
  onFrame: (area: WorldRect, animate: boolean) => void
}) {
  return labels.filter(({ box }) => intersects(box, visible)).map(({ key, name, domain, icon, box, width, area }) => (
    <button
      key={key}
      type="button"
      data-no-pan
      aria-label={`Frame ${name} cluster`}
      title={domain && domain !== name ? `${name} · ${domain}` : name}
      onClick={(event) => onFrame(area, event.detail > 0)}
      className="tactile press absolute z-20 flex items-center gap-1.5 rounded-full px-2 text-xs text-foreground peer-data-reflowing:hidden peer-data-settling:hidden"
      style={{
        left: box.x,
        top: box.y,
        width,
        height,
        fontSize: height === 44 ? 15 : undefined,
        transformOrigin: "top left",
        transform: `scale(${1 / zoom})`,
      }}
    >
      <SiteIcon domain={domain} icon={icon} className="size-3.5 shrink-0" />
      <span className="truncate">{name}</span>
    </button>
  ))
})
