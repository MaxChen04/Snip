import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { GalleryGestures, GalleryHit, GalleryTool } from "./gallery-gestures"
import { movementSolver, type Point } from "./gallery-placement"
import { tilePosition, type useGalleryPositions } from "./gallery-positions"
import type { Placement, Rect } from "./home-layout"

const EMPTY: ReadonlySet<string> = new Set()
const touches = (a: Rect, b: Rect) => a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y

export function boundsOf(tiles: readonly Rect[]): Rect | undefined {
  if (!tiles.length) return
  const x = Math.min(...tiles.map((t) => t.x))
  const y = Math.min(...tiles.map((t) => t.y))
  return { x, y, w: Math.max(...tiles.map((t) => t.x + t.w)) - x, h: Math.max(...tiles.map((t) => t.y + t.h)) - y }
}

const edge = (p: Point, r: Rect) => Math.min(p.x - r.x, p.y - r.y, r.x + r.w - p.x, r.y + r.h - p.y)

export function useGalleryEditing(
  viewKey: string,
  tiles: readonly Placement[],
  plaza: Rect | undefined,
  canMove: boolean,
  storage: ReturnType<typeof useGalleryPositions>,
  onInspect: (key: string) => void,
) {
  const [tool, onToolChange] = useState<GalleryTool>("arrow")
  const [selection, setSelection] = useState<{ key: string; tiles: ReadonlySet<string> }>()
  const selected = selection?.key === viewKey ? selection.tiles : EMPTY
  const selectedTiles = useMemo(() => tiles.filter((t) => selected.has(t.key)), [tiles, selected])
  const groupBounds = selectedTiles.length > 1 ? boundsOf(selectedTiles) : undefined
  const [moving, setMoving] = useState<readonly Placement[]>([])
  const field = useRef<HTMLDivElement>(null)
  const drag = useRef<{ tiles: Placement[]; solve: (raw: Point) => Point; raw: Point; landing: Point }>(undefined)
  const correction = useRef<{ keys: string[]; x: number; y: number }>(undefined)
  const stopSettling = useRef<(() => void) | undefined>(undefined)
  const changeSelection = useCallback((ids: ReadonlySet<string>) => setSelection({ key: viewKey, tiles: ids }), [viewKey])
  const select = useCallback((id: string | null, toggle: boolean) => {
    if (id === null) {
      if (!toggle) changeSelection(EMPTY)
      return
    }
    setSelection((prior) => {
      const next = new Set(toggle && prior?.key === viewKey ? prior.tiles : EMPTY)
      if (toggle && next.has(id)) next.delete(id)
      else next.add(id)
      return { key: viewKey, tiles: next }
    })
  }, [viewKey, changeSelection])
  const updateDrag = (raw: Point) => {
    const d = drag.current, el = field.current
    if (!d || !el) return
    d.raw = raw
    d.landing = d.solve(raw)
    el.style.setProperty("--drag-at", `${raw.x}px ${raw.y}px`)
    el.style.setProperty("--landing-at", `${d.landing.x}px ${d.landing.y}px`)
    el.toggleAttribute("data-collision", d.landing !== raw)
  }
  const startDrag = (hit: NonNullable<GalleryHit>) => {
    if (!canMove) return
    const batch = hit.kind === "group" || selected.has(hit.id) ? selectedTiles : tiles.filter((t) => hit.id === t.key)
    if (!batch.length) return
    const keys = new Set(batch.map((t) => t.key))
    const others: Rect[] = tiles.filter((t) => !keys.has(t.key))
    if (plaza) others.push(plaza)
    drag.current = { tiles: batch, solve: movementSolver(batch, others), raw: { x: 0, y: 0 }, landing: { x: 0, y: 0 } }
    updateDrag({ x: 0, y: 0 })
    setMoving(batch)
  }
  const commit = (batch: readonly Placement[], point: Point) => {
    if (!point.x && !point.y) return false
    return storage.move(batch.map((t) => tilePosition(t.key, t)), batch.map((t) => tilePosition(t.key, { x: t.x + point.x, y: t.y + point.y })))
  }
  const nudge = (point: Point) => {
    if (!canMove || !selectedTiles.length) return false
    const others: Rect[] = tiles.filter((t) => !selected.has(t.key))
    if (plaza) others.push(plaza)
    commit(selectedTiles, movementSolver(selectedTiles, others)(point))
    return true
  }
  const finishDrag = (drop: boolean) => {
    const d = drag.current
    if (!d) return
    drag.current = undefined
    field.current?.removeAttribute("data-collision")
    if (drop && commit(d.tiles, d.landing)) {
      const keys = d.tiles.map((t) => t.key)
      if (keys.some((key) => !selected.has(key))) changeSelection(new Set(keys))
      if (d.raw !== d.landing) correction.current = { keys, x: d.raw.x - d.landing.x, y: d.raw.y - d.landing.y }
    }
    setMoving([])
  }
  useLayoutEffect(() => {
    const change = correction.current
    correction.current = undefined
    const el = field.current
    if (!change || !el || matchMedia("(prefers-reduced-motion: reduce)").matches) return
    stopSettling.current?.()
    const easing = getComputedStyle(document.documentElement).getPropertyValue("--spring-ease").trim()
    const animations = change.keys.flatMap((key) => {
      const tile = el.querySelector<HTMLElement>(`[data-gallery-tile="${CSS.escape(key)}"]`)
      return tile ? [tile.animate(
        [{ translate: `${change.x}px ${change.y}px` }, { translate: "0px 0px" }],
        { duration: 150, easing },
      )] : []
    })
    if (!animations.length) return
    el.setAttribute("data-settling", "")
    const clear = () => {
      if (stopSettling.current !== cancel) return
      stopSettling.current = undefined
      el.removeAttribute("data-settling")
    }
    const cancel = () => {
      animations.forEach((a) => a.cancel())
      clear()
    }
    stopSettling.current = cancel
    void Promise.allSettled(animations.map((a) => a.finished)).then(clear)
  }, [tiles, moving])
  useLayoutEffect(() => () => stopSettling.current?.(), [])

  const gallery: GalleryGestures = {
    tool, canMove, viewKey, onToolChange,
    onSelect: select,
    onInspect,
    onMoveStart: startDrag,
    onMove: updateDrag,
    onMoveEnd: finishDrag,
    onMarquee: (rect, add) => {
      const next = new Set(add ? selected : EMPTY)
      for (const t of tiles) if (touches(rect, t)) next.add(t.key)
      changeSelection(next)
    },
    hit: (point, zoom, prior) => {
      const band = 7 / zoom
      const linger = 3 / zoom
      const tile = tiles.find((t) => edge(point, t) >= 0)
      if (tile) {
        const extra = prior?.kind === "rim" && prior.id === tile.key ? linger : 0
        if (canMove && edge(point, tile) <= Math.min(band + extra, Math.min(tile.w, tile.h) / (extra ? 3 : 4))) {
          return { kind: "rim", id: tile.key }
        }
        return { kind: "tile", id: tile.key }
      }
      if (canMove && groupBounds && Math.abs(edge(point, groupBounds)) <= band + (prior?.kind === "group" ? linger : 0)) return { kind: "group" }
      return null
    },
  }
  return { gallery, field, moving, selected, selectedTiles, select, nudge }
}
