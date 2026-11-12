import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from "react"
import { cullRect, FAR_ZOOM } from "@/components/canvas/cull"
import { cn } from "@/lib/utils"

/** A rectangle in world px. */
export type WorldRect = { x: number; y: number; w: number; h: number }
/** x and y are the world point at the viewport's centre; width and height are the viewport's size in screen px. */
export type CanvasView = { x: number; y: number; zoom: number; width: number; height: number }
type Around = { clientX: number; clientY: number }
type Animate = { animate?: boolean }

export interface InfiniteCanvasHandle {
  /** Centre the viewport on a world point. */
  panTo(worldX: number, worldY: number, opts?: Animate): void
  /** Multiply the zoom, keeping the world point under `around` (default: the viewport centre) still. */
  zoomBy(factor: number, around?: Around, opts?: Animate): void
  setZoom(zoom: number, around?: Around, opts?: Animate): void
  /** Back to the home view (the `home` prop). */
  recenter(opts?: Animate): void
  screenToWorld(clientX: number, clientY: number): { x: number; y: number }
  getView(): CanvasView
}

export const MIN_ZOOM = 0.25
export const MAX_ZOOM = 2

const clampZoom = (k: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k))
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches
// Presses on these never pan, so typing, selecting and form buttons keep working.
const NO_PAN = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [data-no-pan], form button'
// Keys inside these belong to the control (caret moves, radio and menu arrows).
const OWN_KEYS = `${NO_PAN}, [role="radiogroup"], [role="tablist"], [role="menu"], [role="listbox"], [role="slider"], [role="toolbar"]`
const within = (target: EventTarget | null, selector: string) => target instanceof Element && !!target.closest(selector)

/**
 * A pan and zoom viewport. Children render in world space; the world layer moves with a CSS transform written
 * straight to the DOM, so panning never re-renders. `children` receives the visible world rect (with a margin,
 * snapped to a grid; see cullRect) and re-renders only when that rect changes, which is when to cull.
 *
 * Drag anywhere to pan (mouse, touch, pen; a 3–6 px threshold keeps clicks working and the click ending a pan is
 * swallowed). Wheel pans, ctrl/⌘+wheel and pinch zoom around the pointer. With focus: arrows pan, +/- zoom,
 * 0 recenters. Keyboard focus moving to an off-screen child pans to it.
 */
export function InfiniteCanvas({
  children,
  home = { x: 0, y: 0, zoom: 1 },
  onViewChange,
  inertia = true,
  tiled = false,
  className,
  "aria-label": label,
  ref,
}: {
  children: (visible: WorldRect) => ReactNode
  /** The first view and the one recenter() returns to: world point at the centre, and zoom (default 1). */
  home?: { x: number; y: number; zoom?: number }
  /** Called once per frame while the view changes. */
  onViewChange?: (view: CanvasView) => void
  /** Glide a little after a fling. Always off under prefers-reduced-motion. */
  inertia?: boolean
  /**
   * The children are many light tiles that mount and unmount as the view moves (the home gallery), not a few hundred
   * heavy items that stay mounted (a board). The canvas then differs in three ways, all measured with 200 to 1,000
   * tiles:
   * - The world is not pinned to a compositor layer with will-change: transform and re-rasterized after each zoom.
   *   Pinned, the layer keeps the raster scale it had before the zoom, so tiles that mount while panning at 25% are
   *   rasterized for 100% (4.5 s of raster time for drags that take 0.56 s without), and the first step of a zoom-in
   *   stalls for 0.8 s instead of 0.2. For a board the pin is what keeps zooming in smooth (no frame over 17 ms, against
   *   330 ms without).
   * - Below FAR_ZOOM the margin and the grid of the mounted rect are about half as wide (see cullRect). A board would
   *   only mount its items again sooner, which costs more than it saves.
   * - Below FAR_ZOOM the world carries a `data-far` attribute, so tiles can drop detail with CSS (`in-data-far:`)
   *   without re-rendering.
   */
  tiled?: boolean
  className?: string
  "aria-label"?: string
  ref?: Ref<InfiniteCanvasHandle>
}) {
  const viewport = useRef<HTMLDivElement>(null)
  const world = useRef<HTMLDivElement>(null)
  // Screen = world * k + t, in px relative to the viewport's top left.
  const view = useRef({ tx: 0, ty: 0, k: home.zoom ?? 1, w: 0, h: 0 })
  const [visible, setVisible] = useState<WorldRect>(() => ({ x: home.x - 1200, y: home.y - 800, w: 2400, h: 1600 }))
  const homeRef = useRef(home)
  homeRef.current = home
  const tiledRef = useRef(tiled)
  tiledRef.current = tiled
  const onViewRef = useRef(onViewChange)
  onViewRef.current = onViewChange

  // One object of imperative helpers, created once; they read only refs.
  const api = useRef<ReturnType<typeof makeApi> | null>(null)
  function makeApi() {
    let frame = 0
    let tween = 0
    let glide = 0
    let raster = 0
    // Zoom an animation is heading to, so repeated zoom clicks compound from it rather than from mid-flight.
    let targetK: number | null = null

    const getView = (): CanvasView => {
      const { tx, ty, k, w, h } = view.current
      return { x: (w / 2 - tx) / k, y: (h / 2 - ty) / k, zoom: k, width: w, height: h }
    }

    const flush = () => {
      cancelAnimationFrame(frame)
      frame = 0
      const { tx, ty, k } = view.current
      if (world.current) world.current.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${k})`
      if (tiledRef.current) world.current?.toggleAttribute("data-far", k < FAR_ZOOM)
      const next = cullRect(view.current, tiledRef.current)
      setVisible((r) => (r.x === next.x && r.y === next.y && r.w === next.w && r.h === next.h ? r : next))
      onViewRef.current?.(getView())
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(flush)
    }

    // will-change keeps the world on one GPU layer but rasterizes it at the zoom it started with. Dropping and
    // restoring it after zooming settles re-rasterizes, so text and images stay sharp.
    const sharpen = () => {
      if (tiledRef.current) return
      clearTimeout(raster)
      raster = window.setTimeout(() => {
        const el = world.current
        if (!el) return
        el.style.willChange = "auto"
        requestAnimationFrame(() => (el.style.willChange = "transform"))
      }, 200)
    }

    const stop = () => {
      targetK = null
      cancelAnimationFrame(tween)
      cancelAnimationFrame(glide)
    }

    const local = (p: Around) => {
      const box = viewport.current!.getBoundingClientRect()
      return { x: p.clientX - box.left, y: p.clientY - box.top }
    }

    const panBy = (dx: number, dy: number) => {
      view.current.tx += dx
      view.current.ty += dy
      schedule()
    }

    const zoomAt = (k: number, sx: number, sy: number) => {
      const v = view.current
      const next = clampZoom(k)
      v.tx = sx - (sx - v.tx) * (next / v.k)
      v.ty = sy - (sy - v.ty) * (next / v.k)
      v.k = next
      schedule()
      sharpen()
    }

    /** Move to a centre world point and zoom, optionally with a short ease-out. */
    const go = (cx: number, cy: number, k: number, animate = false) => {
      stop()
      const v = view.current
      k = clampZoom(k)
      targetK = animate && !reducedMotion() ? k : null
      const set = (x: number, y: number, z: number) => {
        v.k = z
        v.tx = v.w / 2 - x * z
        v.ty = v.h / 2 - y * z
        flush()
      }
      if (!animate || reducedMotion()) {
        set(cx, cy, k)
        sharpen()
        return
      }
      const from = getView()
      const t0 = performance.now()
      const step = (now: number) => {
        const p = Math.min(1, (now - t0) / 320)
        const e = 1 - (1 - p) ** 4
        set(from.x + (cx - from.x) * e, from.y + (cy - from.y) * e, from.zoom + (k - from.zoom) * e)
        if (p < 1) tween = requestAnimationFrame(step)
        else {
          targetK = null
          sharpen()
        }
      }
      tween = requestAnimationFrame(step)
    }

    const zoomTo = (k: number, around?: Around, opts?: Animate) => {
      const v = view.current
      const p = around ? local(around) : { x: v.w / 2, y: v.h / 2 }
      if (!opts?.animate) return zoomAt(k, p.x, p.y)
      // Animate toward the centre that keeps `around` still at the new zoom.
      const next = clampZoom(k)
      const wx = (p.x - v.tx) / v.k
      const wy = (p.y - v.ty) / v.k
      go(wx - (p.x - v.w / 2) / next, wy - (p.y - v.h / 2) / next, next, true)
    }

    const fling = (vx: number, vy: number) => {
      let last = performance.now()
      const step = (now: number) => {
        const dt = Math.min(48, now - last)
        last = now
        panBy(vx * dt, vy * dt)
        const decay = 0.95 ** (dt / 16)
        vx *= decay
        vy *= decay
        if (Math.hypot(vx, vy) > 0.02) glide = requestAnimationFrame(step)
      }
      glide = requestAnimationFrame(step)
    }

    const handle: InfiniteCanvasHandle = {
      panTo: (x, y, opts) => go(x, y, view.current.k, opts?.animate),
      zoomBy: (factor, around, opts) => zoomTo((targetK ?? view.current.k) * factor, around, opts),
      setZoom: zoomTo,
      recenter: (opts) => go(homeRef.current.x, homeRef.current.y, homeRef.current.zoom ?? 1, opts?.animate),
      screenToWorld: (clientX, clientY) => {
        const p = local({ clientX, clientY })
        const { tx, ty, k } = view.current
        return { x: (p.x - tx) / k, y: (p.y - ty) / k }
      },
      getView,
    }
    return { handle, flush, schedule, stop, local, panBy, zoomAt, fling, cancel: () => cancelAnimationFrame(frame) }
  }
  api.current ??= makeApi()
  const a = api.current

  useImperativeHandle(ref, () => a.handle, [a])

  // Size: centre the home point on the first measure, then keep the centre point still on resize.
  useLayoutEffect(() => {
    const el = viewport.current!
    const measure = () => {
      const v = view.current
      const centre = v.w ? a.handle.getView() : { x: homeRef.current.x, y: homeRef.current.y }
      v.w = el.clientWidth
      v.h = el.clientHeight
      v.tx = v.w / 2 - centre.x * v.k
      v.ty = v.h / 2 - centre.y * v.k
      a.flush()
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => {
      ro.disconnect()
      a.stop()
      a.cancel()
    }
  }, [a])

  // Wheel and Safari's gesture events need non-passive listeners to stop the page zooming or swiping back.
  useEffect(() => {
    const el = viewport.current!
    let gesturing = false
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      if (gesturing && e.ctrlKey) return // Safari pinch: the gesture events have it
      a.stop()
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? view.current.h : 1
      if (e.ctrlKey || e.metaKey) {
        const p = a.local(e)
        a.zoomAt(view.current.k * Math.exp(-Math.max(-50, Math.min(50, e.deltaY * unit)) * 0.01), p.x, p.y)
      } else a.panBy(-e.deltaX * unit, -e.deltaY * unit)
    }
    let gestureScale = 1
    type GestureEvent = UIEvent & { scale: number; clientX: number; clientY: number }
    const onGestureStart = (e: Event) => {
      e.preventDefault()
      gestureScale = 1
      gesturing = true
    }
    const onGestureEnd = () => (gesturing = false)
    const onGestureChange = (e: Event) => {
      e.preventDefault()
      if (pointers.current.size > 1) return // touch pinch: the pointer handlers have it
      const g = e as GestureEvent
      const p = a.local(g)
      a.zoomAt((view.current.k * g.scale) / gestureScale, p.x, p.y)
      gestureScale = g.scale
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    el.addEventListener("gesturestart", onGestureStart)
    el.addEventListener("gesturechange", onGestureChange)
    el.addEventListener("gestureend", onGestureEnd)
    return () => {
      el.removeEventListener("wheel", onWheel)
      el.removeEventListener("gesturestart", onGestureStart)
      el.removeEventListener("gesturechange", onGestureChange)
      el.removeEventListener("gestureend", onGestureEnd)
    }
  }, [a])

  // Pointer gestures: one pointer pans once it moves past the threshold, two pinch.
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const gesture = useRef({ panning: false, startX: 0, startY: 0, dist: 0, mid: { x: 0, y: 0 }, samples: [] as { t: number; x: number; y: number }[] })
  const swallowClick = useRef(false)

  const startPan = () => {
    const el = viewport.current!
    gesture.current.panning = true
    // Captured pointers keep panning over the chrome and outside the window; the tile under them gets no click.
    for (const id of pointers.current.keys()) el.setPointerCapture(id)
    el.dataset.panning = ""
    window.getSelection()?.removeAllRanges()
  }
  const pinchState = () => {
    const [p, q] = [...pointers.current.values()]
    return { dist: Math.hypot(q!.x - p!.x, q!.y - p!.y), mid: a.local({ clientX: (p!.x + q!.x) / 2, clientY: (p!.y + q!.y) / 2 }) }
  }

  // React bubbles events from portals (a card's menu, say) through here; only the canvas's own DOM counts.
  const inside = (e: React.SyntheticEvent) => e.currentTarget.contains(e.target as Node)

  const onPointerDown = (e: React.PointerEvent) => {
    if (!inside(e) || (e.pointerType === "mouse" && e.button !== 0 && e.button !== 1) || within(e.target, NO_PAN)) return
    a.stop()
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const g = gesture.current
    if (pointers.current.size === 1) {
      Object.assign(g, { panning: false, startX: e.clientX, startY: e.clientY, samples: [] })
      if (e.button === 1) {
        e.preventDefault() // no autoscroll
        startPan()
      }
    } else if (pointers.current.size === 2) {
      Object.assign(g, pinchState())
      startPan()
    }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const prev = pointers.current.get(e.pointerId)
    if (!prev) return
    // A mouse released outside the canvas before a pan began never sent us its pointerup.
    if (e.pointerType === "mouse" && e.buttons === 0) return onPointerUp(e)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const g = gesture.current
    if (pointers.current.size === 1) {
      if (!g.panning) {
        if (Math.hypot(e.clientX - g.startX, e.clientY - g.startY) < (e.pointerType === "mouse" ? 3 : 6)) return
        startPan()
      }
      a.panBy(e.clientX - prev.x, e.clientY - prev.y)
      const now = performance.now()
      g.samples = [...g.samples.filter((s) => now - s.t < 100), { t: now, x: e.clientX, y: e.clientY }]
    } else {
      const next = pinchState()
      const v = view.current
      const k = clampZoom((v.k * next.dist) / (g.dist || next.dist))
      // Keep the world point under the old midpoint under the new one: zoom and pan in one step.
      v.tx = next.mid.x - ((g.mid.x - v.tx) / v.k) * k
      v.ty = next.mid.y - ((g.mid.y - v.ty) / v.k) * k
      v.k = k
      Object.assign(g, next)
      a.schedule()
    }
  }

  const onPointerUp = (e: React.PointerEvent) => {
    if (!pointers.current.delete(e.pointerId)) return
    const g = gesture.current
    if (pointers.current.size === 1) {
      // Pinch became a one-finger pan: continue from the remaining finger.
      const [p] = [...pointers.current.values()]
      Object.assign(g, { startX: p!.x, startY: p!.y, samples: [] })
      return
    }
    if (pointers.current.size > 1 || !g.panning) return
    g.panning = false
    delete viewport.current!.dataset.panning
    // The click that ends a pan must not open the tile under the pointer. Click fires before any timer.
    swallowClick.current = true
    setTimeout(() => (swallowClick.current = false))
    const [first, last] = [g.samples[0], g.samples.at(-1)]
    if (inertia && e.type === "pointerup" && first && last && last.t > first.t && performance.now() - last.t < 60 && !reducedMotion()) {
      // At least a frame's worth of time, and at most 2 px/ms (a ~640-px glide): a burst of moves in a few ms
      // otherwise reads as a huge velocity and throws the canvas thousands of px.
      const dt = Math.max(16, last.t - first.t)
      const vx = (last.x - first.x) / dt
      const vy = (last.y - first.y) / dt
      const speed = Math.hypot(vx, vy)
      const cap = Math.min(1, 2 / speed)
      if (speed > 0.3) a.fling(vx * cap, vy * cap)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!inside(e) || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || within(e.target, OWN_KEYS)) return
    const step = e.shiftKey ? 320 : 80
    const v = view.current
    const pans: Record<string, [number, number]> = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }
    if (pans[e.key]) a.panBy(...pans[e.key]!)
    else if (e.key === "+" || e.key === "=") a.zoomAt(v.k * 1.25, v.w / 2, v.h / 2)
    else if (e.key === "-" || e.key === "_") a.zoomAt(v.k / 1.25, v.w / 2, v.h / 2)
    else if (e.key === "0") a.handle.recenter()
    else return
    e.preventDefault()
  }

  // Tabbing to a child outside the viewport (or under the floating chrome) brings it to the centre.
  const onFocus = (e: React.FocusEvent) => {
    const el = e.target as HTMLElement
    if (el === viewport.current || !inside(e) || !el.matches(":focus-visible")) return
    const r = el.getBoundingClientRect()
    const box = viewport.current!.getBoundingClientRect()
    const pad = 80
    if (r.left >= box.left + pad && r.right <= box.right - pad && r.top >= box.top + pad && r.bottom <= box.bottom - pad) return
    const p = a.handle.screenToWorld(r.left + r.width / 2, r.top + r.height / 2)
    a.handle.panTo(p.x, p.y)
  }

  return (
    <div
      ref={viewport}
      tabIndex={0}
      role="region"
      aria-roledescription="canvas"
      aria-label={label}
      aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight + - 0"
      className={cn(
        "relative cursor-grab touch-none overflow-clip overscroll-none outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--focus-ring)] data-panning:cursor-grabbing data-panning:select-none",
        className,
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onClickCapture={(e) => {
        if (!swallowClick.current) return
        swallowClick.current = false
        e.preventDefault()
        e.stopPropagation()
      }}
      // Images and links drag natively by default, which would cancel the pan. Only explicit draggables may.
      onDragStart={(e) => !within(e.target, '[draggable="true"]') && e.preventDefault()}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
    >
      <div ref={world} className={cn("absolute top-0 left-0 origin-top-left", !tiled && "will-change-transform")}>
        {children(visible)}
      </div>
    </div>
  )
}
