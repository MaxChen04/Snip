import type { CanvasView, WorldRect } from "./infinite-canvas"

export type GalleryTool = "arrow" | "hand"
export type Point = { x: number; y: number }
export type GalleryHit = { kind: "tile" | "rim"; id: string } | { kind: "group" } | null

export interface GalleryGestures {
  tool: GalleryTool
  canMove: boolean
  viewKey: string
  enabled?: boolean
  onToolChange(tool: GalleryTool): void
  hit(world: Point, zoom: number, previous: GalleryHit): GalleryHit
  onSelect(id: string | null, toggle: boolean): void
  onInspect(id: string): void
  onMoveStart(hit: NonNullable<GalleryHit>): void
  onMove(delta: Point): void
  onMoveEnd(commit: boolean): void
  onMarquee(rect: WorldRect, add: boolean): void
}

export const WHEEL_QUIET_MS = 150
type WheelMode = "pan" | "zoom"
type WheelPacket = Pick<WheelEvent, "ctrlKey" | "shiftKey" | "deltaMode" | "deltaX" | "deltaY">
type CameraMotion = { kind: "pan"; x: number; y: number } | { kind: "zoom"; factor: number }

export function galleryWheelLock() {
  let mode: WheelMode | null = null
  let time = 0
  let nativeScale: number | null = null
  const reset = () => {
    mode = null
    nativeScale = null
  }
  const expire = (now: number) => {
    if (mode && now - time >= WHEEL_QUIET_MS) reset()
  }
  const claim = (next: WheelMode, now: number) => {
    expire(now)
    mode ??= next
    time = now
    return mode === next
  }
  return {
    reset,
    expire,
    wheel(e: WheelPacket, w: number, h: number, now: number): CameraMotion | undefined {
      const scaleX = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? w : 1
      const scaleY = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? h : 1
      if (e.ctrlKey) {
        if (!e.deltaY || !claim("zoom", now) || nativeScale !== null) return
        return { kind: "zoom", factor: Math.exp(-Math.max(-80, Math.min(80, e.deltaY * scaleY)) * 0.005) }
      }
      if ((!e.deltaX && !e.deltaY) || !claim("pan", now)) return
      if (e.shiftKey && !e.deltaX) return { kind: "pan", x: -e.deltaY * scaleX, y: 0 }
      return { kind: "pan", x: -e.deltaX * scaleX, y: -e.deltaY * scaleY }
    },
    gesture(kind: "gesturestart" | "gesturechange" | "gestureend", scale: number, now: number) {
      expire(now)
      if (kind === "gestureend") {
        if (mode) time = now
        nativeScale = null
        return
      }
      if (!claim("zoom", now)) return
      if (kind === "gesturestart") {
        nativeScale = 1
        return
      }
      if (!Number.isFinite(scale) || scale <= 0) return
      const factor = scale / (nativeScale ?? 1)
      nativeScale = scale
      return factor
    },
    quietAt: () => mode === null ? null : time + WHEEL_QUIET_MS,
  }
}

type Camera = {
  getView(): CanvasView
  stop(): void
  release(vx?: number, vy?: number): void
  restore(view: CanvasView): void
  drag(dx: number, dy: number): void
  pinch(factor: number, from: Point, to?: Point): void
  screenToWorld(clientX: number, clientY: number): Point
}

type Press = {
  id: number
  touch: boolean
  start: Point
  last: Point
  view: CanvasView
  hit: GalleryHit
  toggle: boolean
  plain: boolean
  world: Point
  action: "tile" | "move" | "pan" | "marquee" | "touch"
  stage: "armed" | "primed" | "dragging"
  samples: { t: number; x: number; y: number }[]
  delta?: Point
}
type Pinch = { ids: [number, number]; view: CanvasView; mid: Point; distance: number }
type NativeGesture = Event & { scale: number; clientX: number; clientY: number }

const point = (e: PointerEvent): Point => ({ x: e.clientX, y: e.clientY })
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)
const rect = (a: Point, b: Point): WorldRect => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) })
const TILE = "[data-gallery-tile]"
const OVERLAY = '[role="dialog"], [role="alertdialog"], [role="menu"], [data-popup-open]'
const within = (target: EventTarget | null, selector: string) => target instanceof Element && !!target.closest(selector)

export function attachGalleryGestures(
  el: HTMLElement,
  marquee: HTMLElement,
  getConfig: () => GalleryGestures,
  camera: Camera,
  noPan: string,
  ownKeys: string,
) {
  const wheel = galleryWheelLock()
  const touches = new Map<number, Point>()
  let press: Press | null = null
  let pinch: Pinch | null = null
  let hover: Point | null = null
  let hit: GalleryHit = null
  let space = false
  let prime = 0
  let quiet = 0
  let edge = 0
  let settle = 0
  let edgeTime = 0
  let suppressClick = false
  let clickTimer = 0
  let lastClick: string | null = null
  let lastTap: { id: string; point: Point; at: number } | null = null
  let inspect: string | null = null

  const enabled = () => getConfig().enabled !== false
  const owns = () => press !== null || touches.size > 0
  const carrying = () => press?.action === "move" && press.stage === "dragging"
  const tool = () => space ? "hand" : getConfig().tool
  const local = (p: Point): Point => {
    const r = el.getBoundingClientRect()
    return { x: p.x - r.left, y: p.y - r.top }
  }
  const at = (p: Point) => camera.screenToWorld(p.x, p.y)
  const setHit = (p: Point, previous: GalleryHit) => {
    const { hit: lookup, canMove } = getConfig()
    const found = lookup(at(p), camera.getView().zoom, canMove ? previous : null)
    if (!canMove && found?.kind === "group") return null
    if (!canMove && found?.kind === "rim") return { kind: "tile" as const, id: found.id }
    return found
  }

  const cursor = () => {
    el.toggleAttribute("data-gallery-pressed", !!press)
    if (!enabled()) {
      delete el.dataset.galleryCursor
      return
    }
    const drag = press && !press.touch ? press : null
    const rim = hit?.kind === "rim" || hit?.kind === "group"
    el.dataset.galleryCursor = touches.size ? "arrow"
      : drag?.action === "move" || (drag?.action === "pan" && drag.stage === "dragging") ? "grabbing"
      : drag ? (drag.action === "pan" ? "grab" : "arrow")
      : tool() === "hand" || rim ? "grab" : "arrow"
  }

  const paint = () => {
    if (press?.action !== "marquee" || press.stage !== "dragging") {
      marquee.hidden = true
      return
    }
    const r = rect(local(press.start), local(press.last))
    marquee.hidden = false
    Object.assign(marquee.style, { left: r.x + "px", top: r.y + "px", width: r.w + "px", height: r.h + "px" })
  }
  const syncMove = () => {
    if (!press || !carrying()) return
    const world = at(press.last)
    const delta = { x: world.x - press.world.x, y: world.y - press.world.y }
    if (delta.x === press.delta?.x && delta.y === press.delta.y) return
    press.delta = delta
    getConfig().onMove(delta)
  }
  const refresh = () => {
    if (carrying()) syncMove()
    if (!owns()) hit = hover && enabled() && tool() === "arrow" ? setHit(hover, hit) : null
    cursor()
  }

  const stopEdge = () => {
    cancelAnimationFrame(edge)
    edge = 0
    edgeTime = 0
  }
  const autoPan = (time: number) => {
    if (!press || !carrying()) return stopEdge()
    const p = local(press.last)
    const { width, height } = camera.getView()
    const speed = (position: number, size: number) => {
      const zone = Math.min(48, size / 3)
      if (!zone) return 0
      const ratio = Math.min(1, Math.max(0, (zone - Math.min(position, size - position)) / zone))
      return (position < size / 2 ? 1 : -1) * ratio ** 2 * 0.8
    }
    const dt = edgeTime ? Math.min(32, time - edgeTime) : 16
    edgeTime = time
    const dx = speed(p.x, width) * dt
    const dy = speed(p.y, height) * dt
    if (dx || dy) camera.drag(dx, dy)
    edge = requestAnimationFrame(autoPan)
  }

  const clearWheel = () => {
    clearTimeout(quiet)
    wheel.reset()
  }
  const wheelIdle = () => {
    const end = wheel.quietAt()
    if (end === null) return
    clearTimeout(quiet)
    quiet = window.setTimeout(() => {
      wheel.expire(performance.now())
      if (wheel.quietAt() === null) camera.release()
      else wheelIdle()
    }, Math.max(1, end - performance.now()))
  }
  const origin = (e: MouseEvent | NativeGesture) => Number.isFinite(e.clientX) && Number.isFinite(e.clientY)
    ? local({ x: e.clientX, y: e.clientY })
    : { x: el.clientWidth / 2, y: el.clientHeight / 2 }
  const onWheel = (e: WheelEvent) => {
    e.preventDefault()
    if (owns() && (!carrying() || press?.touch)) return
    const { width, height } = camera.getView()
    const now = performance.now()
    const pending = wheel.quietAt()
    const motion = wheel.wheel(e, width, height, now)
    if (motion && pending !== null && now >= pending) camera.stop()
    if (motion?.kind === "pan") camera.drag(motion.x, motion.y)
    if (motion?.kind === "zoom") camera.pinch(motion.factor, origin(e))
    wheelIdle()
  }
  const onGesture = (event: Event) => {
    event.preventDefault()
    if (owns() && (!carrying() || press?.touch)) return
    const e = event as NativeGesture
    const now = performance.now()
    const pending = wheel.quietAt()
    const factor = wheel.gesture(e.type as "gesturestart" | "gesturechange" | "gestureend", e.scale, now)
    if (pending !== null && now >= pending && e.type !== "gestureend") camera.stop()
    if (factor !== undefined && factor !== 1) camera.pinch(factor, origin(e))
    wheelIdle()
  }

  const suppress = () => {
    suppressClick = true
    clearTimeout(clickTimer)
    clickTimer = window.setTimeout(() => { suppressClick = false }, 0)
  }
  const onClick = (e: MouseEvent) => {
    if (!suppressClick || e.detail === 0) return
    e.preventDefault()
    e.stopPropagation()
  }
  const onDoubleClick = (e: MouseEvent) => {
    if (!enabled() || !inspect || tool() !== "arrow" || owns() || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return
    const id = inspect
    inspect = lastClick = null
    e.preventDefault()
    e.stopPropagation()
    getConfig().onInspect(id)
  }

  const clearPress = () => {
    clearTimeout(prime)
    stopEdge()
    const ended = press
    press = null
    paint()
    return ended
  }
  const pinchGeometry = ([a, b]: [number, number]) => {
    const p = touches.get(a)!
    const q = touches.get(b)!
    return { mid: local({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }), distance: distance(p, q) }
  }
  const onDown = (e: PointerEvent) => {
    if (!enabled() || e.button !== 0 || within(e.target, noPan)) return
    const p = point(e)
    if (owns()) {
      if ((!press?.touch && !touches.size) || e.pointerType !== "touch") return
      touches.set(e.pointerId, p)
      el.setPointerCapture(e.pointerId)
      if (press?.touch && touches.size === 2) {
        lastTap = null
        const view = camera.getView()
        const ended = clearPress()!
        if (ended.action === "move") getConfig().onMoveEnd(false)
        camera.stop()
        const ids: [number, number] = [ended.id, e.pointerId]
        pinch = { ids, view, ...pinchGeometry(ids) }
      }
      return
    }
    cancelAnimationFrame(settle)
    clearWheel()
    camera.stop()
    inspect = null
    const touch = e.pointerType === "touch"
    const hand = tool() === "hand"
    const tile = (e.target as Element).closest<HTMLElement>(TILE)
    const found = touch
      ? tile?.dataset.galleryTile ? { kind: "tile" as const, id: tile.dataset.galleryTile } : null
      : hand ? null : setHit(p, hit)
    const action = touch ? "touch" : hand ? "pan" : !found ? "marquee" : found.kind === "tile" ? "tile" : "move"
    press = {
      id: e.pointerId, touch, start: p, last: p, view: camera.getView(), world: at(p), hit: found,
      action, stage: "armed", samples: [], toggle: e.shiftKey || e.metaKey,
      plain: !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey,
    }
    if (touch) touches.set(e.pointerId, p)
    else hover = p
    el.setPointerCapture(e.pointerId)
    if (touch && found && found.kind !== "group" && getConfig().canMove) {
      prime = window.setTimeout(() => {
        if (press?.action !== "touch" || press.stage !== "armed") return
        press.action = "move"
        press.stage = "primed"
        getConfig().onMoveStart(found)
      }, 350)
    }
    cursor()
  }
  const onMove = (e: PointerEvent) => {
    const p = point(e)
    if (touches.has(e.pointerId)) {
      touches.set(e.pointerId, p)
      if (pinch && pinch.ids.includes(e.pointerId)) {
        const next = pinchGeometry(pinch.ids)
        camera.pinch(next.distance && pinch.distance ? next.distance / pinch.distance : 1, pinch.mid, next.mid)
        Object.assign(pinch, next)
        return
      }
    } else if (!owns() && e.pointerType !== "touch") {
      hover = within(e.target, noPan) ? null : p
      refresh()
      return
    }
    const g = press
    if (!g || g.id !== e.pointerId) return
    if (!g.touch) hover = p
    if (g.stage !== "dragging") {
      if (distance(p, g.start) < 4) return
      clearTimeout(prime)
      const primed = g.stage === "primed"
      g.stage = "dragging"
      if (g.action === "touch") g.action = "pan"
      if (g.action === "move") {
        if (!primed) getConfig().onMoveStart(g.hit!)
        edge = requestAnimationFrame(autoPan)
      }
      window.getSelection()?.removeAllRanges()
      cursor()
    }
    if (g.action === "pan") {
      camera.drag(p.x - g.last.x, p.y - g.last.y)
      const now = performance.now()
      g.samples = [...g.samples.filter((sample) => now - sample.t < 100), { ...p, t: now }]
    }
    g.last = p
    if (g.action === "move") syncMove()
    if (g.action === "marquee") paint()
  }
  const onLeave = () => {
    hover = null
    refresh()
  }
  const containsPoint = (p: Point) => {
    const r = el.getBoundingClientRect()
    return p.x >= r.left && p.x < r.right && p.y >= r.top && p.y < r.bottom
  }

  const onUp = (e: PointerEvent) => {
    const touch = touches.delete(e.pointerId)
    if (pinch?.ids.includes(e.pointerId)) {
      pinch = null
      camera.release()
    }
    if (touch) suppress()
    if (press?.id !== e.pointerId) return refresh()
    if (distance(point(e), press.last)) onMove(e)
    const g = clearPress()!
    suppress()
    if (!g.touch) hover = containsPoint(point(e)) ? point(e) : null
    const cfg = getConfig()
    if (g.stage !== "dragging") {
      if (g.stage === "primed") cfg.onMoveEnd(false)
      const id = g.hit && g.hit.kind !== "group" ? g.hit.id : null
      if (g.action !== "pan" && g.hit?.kind !== "group") cfg.onSelect(id, id !== null && g.toggle)
      inspect = g.plain && !g.touch && id === lastClick ? id : null
      lastClick = g.plain && !g.touch ? id : null
      camera.release()
      if (g.touch && id && g.action === "touch") {
        const next = { id, point: point(e), at: performance.now() }
        const double = lastTap?.id === id && next.at - lastTap.at <= 320 && distance(next.point, lastTap.point) <= 24
        lastTap = double ? null : next
        if (double) cfg.onInspect(id)
      } else lastTap = null
    } else {
      lastClick = null
      lastTap = null
      if (g.action === "move") {
        cfg.onMoveEnd(true)
        clearWheel()
        settle = requestAnimationFrame(() => camera.release())
      } else if (g.action === "marquee") {
        cfg.onMarquee(rect(at(g.start), at(g.last)), g.toggle)
        camera.release()
      } else if (g.action === "pan") {
        const a = g.samples[0]
        const b = g.samples.at(-1)
        if (a && b && b.t > a.t && performance.now() - b.t < 60) {
          const dt = Math.max(16, b.t - a.t)
          const vx = (b.x - a.x) / dt
          const vy = (b.y - a.y) / dt
          const cap = Math.min(1, 2 / Math.hypot(vx, vy))
          camera.release(vx * cap, vy * cap)
        } else camera.release()
      } else camera.release()
    }
    refresh()
  }

  const cancel = (previousConfig = getConfig()) => {
    const hadWheel = wheel.quietAt() !== null
    clearWheel()
    const canceled = clearPress()
    const restore = pinch?.view ?? canceled?.view
    pinch = null
    lastClick = inspect = null
    lastTap = null
    if (canceled?.action === "move" && canceled.stage !== "armed") previousConfig.onMoveEnd(false)
    if (restore) camera.restore(restore)
    else if (hadWheel) camera.release()
    refresh()
  }
  const onCancel = (e: PointerEvent) => {
    const touch = touches.delete(e.pointerId)
    if (e.pointerId === press?.id || pinch?.ids.includes(e.pointerId)) cancel()
    else if (touch) refresh()
  }
  const onContext = (e: MouseEvent) => {
    if (touches.size || (e as PointerEvent).pointerType === "touch") e.preventDefault()
  }
  const onKey = (e: KeyboardEvent) => {
    if (!enabled() || e.defaultPrevented) return
    const unmodified = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey
    if (e.key === "Escape" && unmodified && owns()) {
      e.preventDefault()
      if (!e.repeat) cancel()
      return
    }
    if ((press || pinch) && (
      (e.altKey && e.key.startsWith("Arrow") && !e.metaKey && !e.ctrlKey) ||
      (within(e.target, TILE) && (e.key === "Enter" || (e.key === " " && e.shiftKey)))
    )) {
      e.preventDefault()
      return
    }
    if (!unmodified || within(e.target, ownKeys) || document.querySelector(OVERLAY)) return
    if (e.key === " " && (e.target === document.body || e.target === el || (e.target instanceof Element && el.contains(e.target) && within(e.target, TILE)))) {
      e.preventDefault()
      space = true
      refresh()
    } else if (!e.repeat && (e.key.toLowerCase() === "v" || e.key.toLowerCase() === "h")) {
      e.preventDefault()
      getConfig().onToolChange(e.key.toLowerCase() === "v" ? "arrow" : "hand")
    }
  }
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.key !== " " || !space) return
    e.preventDefault()
    space = false
    refresh()
  }
  const onBlur = () => {
    space = false
    hover = null
    touches.clear()
    cancel()
  }

  const listeners = {
    pointerdown: onDown, pointermove: onMove, pointerup: onUp, pointercancel: onCancel, lostpointercapture: onCancel,
    pointerleave: onLeave, gesturestart: onGesture, gesturechange: onGesture, gestureend: onGesture,
    wheel: onWheel, contextmenu: onContext, click: onClick, dblclick: onDoubleClick,
  } satisfies Partial<{ [K in keyof HTMLElementEventMap]: (e: HTMLElementEventMap[K]) => void }> & Record<string, (e: never) => void>
  for (const [name, fn] of Object.entries(listeners)) el.addEventListener(name, fn as EventListener, { passive: false, capture: name === "click" || name === "dblclick" })
  window.addEventListener("keydown", onKey, true)
  window.addEventListener("keyup", onKeyUp, true)
  window.addEventListener("blur", onBlur)
  refresh()
  return {
    owns: () => press !== null || pinch !== null,
    carrying,
    refresh,
    reconfigure(previous: GalleryGestures, next: GalleryGestures) {
      if (previous.viewKey !== next.viewKey || (previous.enabled !== false && next.enabled === false) || (previous.canMove && !next.canMove)) {
        hit = null
        if (next.enabled === false) space = false
        cancel(previous)
      } else refresh()
    },
    dispose() {
      clearTimeout(prime)
      clearTimeout(quiet)
      clearTimeout(clickTimer)
      cancelAnimationFrame(settle)
      stopEdge()
      for (const [name, fn] of Object.entries(listeners)) el.removeEventListener(name, fn as EventListener, name === "click" || name === "dblclick")
      window.removeEventListener("keydown", onKey, true)
      window.removeEventListener("keyup", onKeyUp, true)
      window.removeEventListener("blur", onBlur)
    },
  }
}
