import { memo } from "react"
import { SiteIcon } from "@/components/site-icon"
import { boundsOf } from "./gallery-editing"
import { MAX_ZOOM, MIN_ZOOM, type InfiniteCanvasHandle, type WorldRect } from "./infinite-canvas"
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
  x: number
  y: number
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
    pins.push({ key, name, domain, icon, count: main.length, x: top.x + top.w / 2, y: top.y, width: Math.min(164, Math.max(64, 44 + name.length * 7)), area })
  }
  const shown: SitePin[] = []
  for (const pin of pins.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))) {
    const covers = (other: SitePin) => Math.abs(pin.y - other.y) * MIN_ZOOM < 40
      && Math.abs(pin.x - other.x) * MIN_ZOOM < (pin.width + other.width) / 2 + 6
    if (!shown.some(covers)) shown.push(pin)
  }
  return shown
}

export const GallerySiteLabels = memo(function GallerySiteLabels({ pins, visible, onFrame }: {
  pins: readonly SitePin[]
  visible: WorldRect
  onFrame: (area: WorldRect) => void
}) {
  return pins.filter(({ x, y, width }) => x + width / MIN_ZOOM >= visible.x && x - width / MIN_ZOOM <= visible.x + visible.w
    && y >= visible.y && y - 40 / MIN_ZOOM <= visible.y + visible.h).map(({ key, name, domain, icon, x, y, width, area }) => (
    <button
      key={key}
      type="button"
      data-no-pan
      aria-label={`Frame ${name} cluster`}
      title={domain && domain !== name ? `${name} · ${domain}` : name}
      onClick={() => onFrame(area)}
      className="tactile press absolute z-20 flex h-7 items-center gap-1.5 rounded-full px-2 text-xs text-foreground max-sm:h-9"
      style={{
        left: x,
        top: y,
        width,
        transformOrigin: "bottom center",
        transform: "translate(-50%, calc(-100% - 16px)) scale(calc(1 / var(--gallery-zoom, 1)))",
      }}
    >
      <SiteIcon domain={domain} icon={icon} className="size-3.5 shrink-0" />
      <span className="truncate">{name}</span>
    </button>
  ))
})
