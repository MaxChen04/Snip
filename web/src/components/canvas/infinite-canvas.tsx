import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from "react"
import { cullRect, FAR_ZOOM } from "@/components/canvas/cull"
import { settled, springStep } from "@/lib/spring"
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
  /** Jump to a view getView() returned: its world centre and zoom. */
  setView(view: { x: number; y: number; zoom: number }): void
  screenToWorld(clientX: number, clientY: number): { x: number; y: number }
  getView(): CanvasView
}

export const MIN_ZOOM = 0.25
/** The share of the screen the content still covers at the far end of a pan (see `content`). */
const KEEP_IN_VIEW = 0.25
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
 * 0 recenters. Keyboard focus moving to a child that is out of view pans to it.
 *
 * Drags, wheel pans and pinches follow the input 1:1, with a rubber band past the content's edge or the zoom range. On
 * release a pan glides on, and anything left past the limits springs back. Zoom controls, recenter and a mouse wheel's
 * notch move on the same spring (see lib/spring). Reduced motion: no glide, no rubber band, no spring.
 */
export function InfiniteCanvas({
  children,
  home = { x: 0, y: 0, zoom: 1 },
  onViewChange,
  content,
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
  /**
   * Where there is something to see. However far a pan, a fling, a zoom or a saved view goes, the view stops where one
   * of these rects still covers a quarter of the screen's width or height (KEEP_IN_VIEW), so the user is never lost in
   * empty space.
   */
  content?: readonly WorldRect[]
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
  const contentRef = useRef(content)
  contentRef.current = content

  // One object of imperative helpers, created once; they read only refs.
  const api = useRef<ReturnType<typeof makeApi> | null>(null)
  function makeApi() {
    let frame = 0
    let anim = 0
    let raster = 0
    let idle = 0
    // Zoom an animation is heading to, so repeated zoom clicks compound from it rather than from mid-flight.
    let targetK: number | null = null
    // While the user holds the view past its limits (a drag or wheel past the content's edge, a pinch past the zoom
    // range) or a spring carries it, flush leaves it there; otherwise flush keeps it inside.
    let free = false
    // A drag's, wheel pan's or pinch's own centre and zoom, before the resistance at the limits.
    let raw: { x: number; y: number; k: number } | null = null
    // Where the last pinch or wheel zoom was centred, so a zoom pulled past the range springs back around it.
    let anchor: { x: number; y: number } | null = null
    // The spring's velocity, kept when it retargets: the centre in world px per ms, the zoom in log units per ms.
    const vel = { x: 0, y: 0, z: 0 }

    const getView = (): CanvasView => {
      const { tx, ty, k, w, h } = view.current
      return { x: (w / 2 - tx) / k, y: (h / 2 - ty) / k, zoom: k, width: w, height: h }
    }

    const place = (x: number, y: number, k: number) => {
      const v = view.current
      v.k = k
      v.tx = v.w / 2 - x * k
      v.ty = v.h / 2 - y * k
    }

    /** The nearest centre, at zoom k, from which some content rect still reaches KEEP_IN_VIEW into the screen: that rect, grown by the rest. */
    const limit = (x: number, y: number, k: number) => {
      const rects = contentRef.current
      if (!rects?.length) return { x, y }
      const v = view.current
      const mx = (v.w * (0.5 - KEEP_IN_VIEW)) / k
      const my = (v.h * (0.5 - KEEP_IN_VIEW)) / k
      let best = { x, y, d: Infinity }
      for (const r of rects) {
        const px = Math.min(r.x + r.w + mx, Math.max(r.x - mx, x))
        const py = Math.min(r.y + r.h + my, Math.max(r.y - my, y))
        const d = (px - x) ** 2 + (py - y) ** 2
        if (d < best.d) best = { x: px, y: py, d }
        if (!d) break
      }
      return best
    }

    const flush = () => {
      cancelAnimationFrame(frame)
      frame = 0
      if (!free) {
        const c = getView()
        const k = clampZoom(c.zoom)
        const p = limit(c.x, c.y, k)
        place(p.x, p.y, k)
      }
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

    /** New input takes the view where it is: any spring or glide stops, and its velocity with it. */
    const stop = () => {
      targetK = null
      cancelAnimationFrame(anim)
      clearTimeout(idle)
      vel.x = vel.y = vel.z = 0
    }

    const local = (p: Around) => {
      const box = viewport.current!.getBoundingClientRect()
      return { x: p.clientX - box.left, y: p.clientY - box.top }
    }

    /**
     * Spring to a centre and zoom. With an anchor (a screen point) the world point under it stays put while the zoom
     * springs, as a zoom around the pointer should. Ends inside the limits: a target past them springs on to the edge.
     */
    const springTo = (x: number, y: number, k: number, around?: { x: number; y: number }) => {
      cancelAnimationFrame(anim)
      const v = view.current
      free = true
      targetK = k
      const held = around && { sx: around.x, sy: around.y, wx: (around.x - v.tx) / v.k, wy: (around.y - v.ty) / v.k }
      if (held) {
        x = held.wx - (held.sx - v.w / 2) / k
        y = held.wy - (held.sy - v.h / 2) / k
      }
      let last = performance.now()
      const step = (now: number) => {
        const dt = Math.min(64, now - last)
        last = now
        const c = getView()
        const [dz, vz] = springStep(Math.log(c.zoom / k), vel.z, dt)
        vel.z = vz
        const nk = k * Math.exp(dz)
        let rest = settled(dz, vz, 0.001)
        if (held) {
          place(held.wx - (held.sx - v.w / 2) / nk, held.wy - (held.sy - v.h / 2) / nk, nk)
        } else {
          const [dx, vx] = springStep(c.x - x, vel.x, dt)
          const [dy, vy] = springStep(c.y - y, vel.y, dt)
          vel.x = vx
          vel.y = vy
          rest &&= settled(dx * nk, vx * nk) && settled(dy * nk, vy * nk)
          place(x + dx, y + dy, nk)
        }
        if (!rest) {
          flush()
          anim = requestAnimationFrame(step)
          return
        }
        place(x, y, k)
        targetK = null
        vel.x = vel.y = vel.z = 0
        const p = limit(x, y, k)
        if (p.x !== x || p.y !== y) return springTo(p.x, p.y, k)
        free = false
        flush()
        sharpen()
      }
      anim = requestAnimationFrame(step)
    }

    /** Move to a centre world point and zoom, at once or on the spring. */
    const go = (cx: number, cy: number, k: number, animate = false) => {
      stop()
      k = clampZoom(k)
      const p = limit(cx, cy, k)
      if (animate && !reducedMotion()) return springTo(p.x, p.y, k)
      free = false
      place(p.x, p.y, k)
      flush()
      sharpen()
    }

    const zoomTo = (k: number, around?: Around, opts?: Animate) => {
      const v = view.current
      const p = around ? local(around) : { x: v.w / 2, y: v.h / 2 }
      const next = clampZoom(k)
      // A zoom that retargets the running spring keeps its velocity, so clicks in a row compound smoothly.
      if (opts?.animate && !reducedMotion()) return springTo(0, 0, next, p)
      stop()
      free = false
      v.tx = p.x - (p.x - v.tx) * (next / v.k)
      v.ty = p.y - (p.y - v.ty) * (next / v.k)
      v.k = next
      flush()
      sharpen()
    }

    // ---- Direct manipulation: drag, wheel pan, pinch ----
    // The view follows the input 1:1 inside the limits, and with growing resistance past them (rubber band).
    const band = (d: number, size: number) => Math.sign(d) * size * (1 - 1 / ((Math.abs(d) * 0.55) / size + 1))
    const softZoom = (k: number) => (k > MAX_ZOOM ? MAX_ZOOM * (k / MAX_ZOOM) ** 0.3 : k < MIN_ZOOM ? MIN_ZOOM * (k / MIN_ZOOM) ** 0.3 : k)

    /** Start (or keep) following the input from where the view is now. */
    const hold = () => {
      stop()
      if (!raw) {
        const c = getView()
        raw = { x: c.x, y: c.y, k: c.zoom }
      }
      free = !reducedMotion()
    }
    const show = () => {
      const r = raw!
      if (!free) {
        // Reduced motion: no rubber band, the view stops at the limits.
        r.k = clampZoom(r.k)
        Object.assign(r, limit(r.x, r.y, r.k))
      }
      const v = view.current
      const k = softZoom(r.k)
      const p = limit(r.x, r.y, k)
      // The pull is at most a fifth of the screen, so some content stays in view however hard it is pulled.
      place(p.x + band(r.x - p.x, (v.w * 0.2) / k), p.y + band(r.y - p.y, (v.h * 0.2) / k), k)
      schedule()
    }
    /** Pan by screen px. */
    const drag = (dx: number, dy: number) => {
      hold()
      const k = view.current.k
      raw!.x -= dx / k
      raw!.y -= dy / k
      show()
    }
    /** Zoom by a factor around one screen point, moving it to another (a pinch's midpoint moves as it zooms). */
    const pinch = (factor: number, from: { x: number; y: number }, to = from) => {
      hold()
      const v = view.current
      const wx = (from.x - v.tx) / v.k
      const wy = (from.y - v.ty) / v.k
      raw!.k *= factor
      const k = softZoom(raw!.k)
      raw!.x = wx - (to.x - v.w / 2) / k
      raw!.y = wy - (to.y - v.h / 2) / k
      anchor = to
      show()
      sharpen()
    }

    /**
     * The input let go, with its velocity in screen px per ms. Past the limits the view springs back; inside them it
     * glides on and slows down, and springs back from the edge if it reaches it.
     */
    const release = (vx = 0, vy = 0) => {
      raw = null
      clearTimeout(idle)
      cancelAnimationFrame(frame)
      frame = 0
      if (reducedMotion()) {
        free = false
        return flush()
      }
      const c = getView()
      const k = clampZoom(c.zoom)
      if (k !== c.zoom) return springTo(0, 0, k, anchor ?? { x: c.width / 2, y: c.height / 2 })
      const p = limit(c.x, c.y, k)
      if (p.x !== c.x || p.y !== c.y) {
        vel.x = -vx / k
        vel.y = -vy / k
        return springTo(p.x, p.y, k)
      }
      if (Math.hypot(vx, vy) < 0.3) {
        free = false
        return flush()
      }
      glide(vx, vy)
    }
    /** After a wheel pan or pinch, the input has let go once its events stop. */
    const releaseSoon = () => {
      clearTimeout(idle)
      idle = window.setTimeout(() => release(), 120)
    }

    const glide = (vx: number, vy: number) => {
      free = true
      let last = performance.now()
      const step = (now: number) => {
        const dt = Math.min(48, now - last)
        last = now
        const v = view.current
        v.tx += vx * dt
        v.ty += vy * dt
        const decay = 0.95 ** (dt / 16)
        vx *= decay
        vy *= decay
        const c = getView()
        const p = limit(c.x, c.y, c.zoom)
        if (p.x !== c.x || p.y !== c.y) {
          // At the edge: the spring takes over with the glide's speed, and bounces back.
          vel.x = -vx / c.zoom
          vel.y = -vy / c.zoom
          return springTo(p.x, p.y, c.zoom)
        }
        flush()
        if (Math.hypot(vx, vy) > 0.02) anim = requestAnimationFrame(step)
        else free = false
      }
      anim = requestAnimationFrame(step)
    }

    /** Keyboard pans: immediate, and stopped at the limits. */
    const nudge = (dx: number, dy: number) => {
      stop()
      raw = null
      free = false
      view.current.tx += dx
      view.current.ty += dy
      schedule()
    }

    const handle: InfiniteCanvasHandle = {
      panTo: (x, y, opts) => go(x, y, view.current.k, opts?.animate),
      zoomBy: (factor, around, opts) => zoomTo((targetK ?? view.current.k) * factor, around, opts),
      setZoom: zoomTo,
      recenter: (opts) => go(homeRef.current.x, homeRef.current.y, homeRef.current.zoom ?? 1, opts?.animate),
      setView: (v) => go(v.x, v.y, v.zoom, false),
      screenToWorld: (clientX, clientY) => {
        const p = local({ clientX, clientY })
        const { tx, ty, k } = view.current
        return { x: (p.x - tx) / k, y: (p.y - ty) / k }
      },
      getView,
    }
    return { handle, flush, stop, local, drag, pinch, release, releaseSoon, nudge, cancel: () => cancelAnimationFrame(frame) }
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

  // New content (the feed loaded or changed) brings a view left outside it back to its edge.
  useLayoutEffect(() => {
    if (content?.length) a.flush()
  }, [a, content])

  // Wheel and Safari's gesture events need non-passive listeners to stop the page zooming or swiping back.
  useEffect(() => {
    const el = viewport.current!
    let gesturing = false
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      if (gesturing && e.ctrlKey) return // Safari pinch: the gesture events have it
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? view.current.h : 1
      if (e.ctrlKey || e.metaKey) {
        const d = e.deltaY * unit
        const factor = Math.exp(-Math.max(-50, Math.min(50, d)) * 0.01)
        // A mouse wheel's notch zooms on the spring (each notch retargets it); a trackpad pinch's small steps follow
        // the fingers, and spring back once they stop past the zoom range.
        if (e.deltaMode !== 0 || Math.abs(d) >= 40) return a.handle.zoomBy(factor, e, { animate: true })
        a.pinch(factor, a.local(e))
      } else a.drag(-e.deltaX * unit, -e.deltaY * unit)
      a.releaseSoon()
    }
    let gestureScale = 1
    type GestureEvent = UIEvent & { scale: number; clientX: number; clientY: number }
    const onGestureStart = (e: Event) => {
      e.preventDefault()
      gestureScale = 1
      gesturing = true
    }
    const onGestureEnd = () => {
      gesturing = false
      a.release()
    }
    const onGestureChange = (e: Event) => {
      e.preventDefault()
      if (pointers.current.size > 1) return // touch pinch: the pointer handlers have it
      const g = e as GestureEvent
      a.pinch(g.scale / gestureScale, a.local(g))
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
      a.drag(e.clientX - prev.x, e.clientY - prev.y)
      const now = performance.now()
      g.samples = [...g.samples.filter((s) => now - s.t < 100), { t: now, x: e.clientX, y: e.clientY }]
    } else {
      // Keep the world point under the old midpoint under the new one: zoom and pan in one step.
      const next = pinchState()
      a.pinch(next.dist / (g.dist || next.dist), g.mid, next.mid)
      Object.assign(g, next)
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
    if (pointers.current.size > 1) return
    // A press that never panned may have stopped a spring part way: let it finish.
    if (!g.panning) return a.release()
    g.panning = false
    delete viewport.current!.dataset.panning
    // The click that ends a pan must not open the tile under the pointer. Click fires before any timer.
    swallowClick.current = true
    setTimeout(() => (swallowClick.current = false))
    const [first, last] = [g.samples[0], g.samples.at(-1)]
    if (e.type === "pointerup" && first && last && last.t > first.t && performance.now() - last.t < 60) {
      // At least a frame's worth of time, and at most 2 px/ms (a ~640-px glide): a burst of moves in a few ms
      // otherwise reads as a huge velocity and throws the canvas thousands of px.
      const dt = Math.max(16, last.t - first.t)
      const vx = (last.x - first.x) / dt
      const vy = (last.y - first.y) / dt
      const cap = Math.min(1, 2 / Math.hypot(vx, vy))
      a.release(vx * cap, vy * cap)
    } else a.release()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!inside(e) || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || within(e.target, OWN_KEYS)) return
    const step = e.shiftKey ? 320 : 80
    const pans: Record<string, [number, number]> = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }
    if (pans[e.key]) a.nudge(...pans[e.key]!)
    else if (e.key === "+" || e.key === "=") a.handle.zoomBy(1.25, undefined, { animate: true })
    else if (e.key === "-" || e.key === "_") a.handle.zoomBy(1 / 1.25, undefined, { animate: true })
    else if (e.key === "0") a.handle.recenter({ animate: true })
    else return
    e.preventDefault()
  }

  // Tabbing to a child that is out of view, or under the floating chrome at the top and bottom, brings it to the centre.
  // Only along the axis on which it is out, and never for a child that is in view: the capture card is nearly as wide as
  // a phone, so centring its field (or a button beside it) used to shift the whole card off the screen.
  const onFocus = (e: React.FocusEvent) => {
    const el = e.target as HTMLElement
    if (el === viewport.current || !inside(e) || !el.matches(":focus-visible")) return
    const r = el.getBoundingClientRect()
    const box = viewport.current!.getBoundingClientRect()
    const pad = 80
    const outX = r.left < box.left || r.right > box.right
    const outY = r.top < box.top + pad || r.bottom > box.bottom - pad
    if (!outX && !outY) return
    const p = a.handle.screenToWorld(r.left + r.width / 2, r.top + r.height / 2)
    const now = a.handle.getView()
    a.handle.panTo(outX ? p.x : now.x, outY ? p.y : now.y)
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
