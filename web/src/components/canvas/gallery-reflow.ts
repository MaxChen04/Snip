import { useLayoutEffect, useRef, type RefObject } from "react"
import type { Placement } from "./home-layout"
import { SPRING } from "@/lib/spring"

type Field = { place: string; tiles: readonly Placement[]; nodes: HTMLElement[] }
const SPRING_TILE_LIMIT = 80

export function useGalleryReflow(place: string, tiles: readonly Placement[] | null, field: RefObject<HTMLDivElement | null>) {
  const prior = useRef<Field | null>(null)
  const cleanup = useRef<(() => void) | undefined>(undefined)
  useLayoutEffect(() => {
    if (!tiles || !field.current) return
    const el = field.current
    const stage = el.firstElementChild as HTMLElement | null
    if (!stage) return
    const nodes = Array.from(stage.querySelectorAll<HTMLElement>("[data-gallery-tile]"))
    const old = prior.current
    prior.current = { place, tiles, nodes }
    if (!old || old.place === place) return
    cleanup.current?.()
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return
    const from = new Map(old.tiles.map((t) => [t.key, t]))
    const to = new Map(tiles.map((t) => [t.key, t]))
    const track = (effects: Animation[], remove?: () => void) => {
      if (!effects.length) return
      el.setAttribute("data-reflowing", "")
      const clear = () => {
        remove?.()
        if (cleanup.current !== cancel) return
        cleanup.current = undefined
        el.removeAttribute("data-reflowing")
      }
      const cancel = () => {
        effects.forEach((a) => a.cancel())
        clear()
      }
      cleanup.current = cancel
      void Promise.allSettled(effects.map((a) => a.finished)).then(clear)
    }
    if (Math.max(nodes.length, old.nodes.length) <= SPRING_TILE_LIMIT) {
      const easing = getComputedStyle(document.documentElement).getPropertyValue("--spring-ease").trim()
      const effects: Animation[] = []
      for (const node of nodes) {
        const key = node.dataset.galleryTile!
        const a = from.get(key)
        const b = to.get(key)
        if (!a || !b || (a.x === b.x && a.y === b.y)) continue
        effects.push(node.animate([{ translate: `${a.x - b.x}px ${a.y - b.y}px` }, { translate: "0px 0px" }], { duration: SPRING.duration, easing }))
      }
      track(effects)
      return
    }
    const outgoing = document.createElement("div")
    outgoing.inert = true
    outgoing.setAttribute("aria-hidden", "true")
    outgoing.style.pointerEvents = "none"
    outgoing.style.position = "absolute"
    for (const node of old.nodes) {
      const a = from.get(node.dataset.galleryTile!)
      if (!a) continue
      const media = node.querySelector("img")
      if (!media?.complete || !media.naturalWidth) continue
      const image = media.cloneNode(false) as HTMLImageElement
      const tile = document.createElement("div")
      tile.className = "absolute overflow-hidden rounded-md bg-ink-3"
      Object.assign(tile.style, { left: `${a.x}px`, top: `${a.y}px`, width: `${a.w}px`, height: `${a.h}px` })
      tile.append(image)
      outgoing.append(tile)
    }
    el.append(outgoing)
    const exit = outgoing.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 150, easing: "ease-out" })
    const enter = stage.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, easing: "ease-out" })
    track([exit, enter], () => outgoing.remove())
  }, [place, tiles, field])
  useLayoutEffect(() => () => cleanup.current?.(), [])
}
