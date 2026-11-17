import { navigate } from "wouter/use-browser-location"
import type { CanvasFilter } from "@/components/canvas/types"

/**
 * Where you are and how to get back. Every canvas place is a URL (scope, filter, search, open item), and each history
 * entry also keeps what the URL can't: the canvas position, and for a site scope the URL it was entered from. Back,
 * browser Back and ⌘[ all go through the browser's history, so they land on exactly the entry you left.
 */
export type CanvasPosition = { x: number; y: number; zoom: number }
export type Entry = {
  /** The canvas position when this entry was left. */
  view?: CanvasPosition
  /** The URL a site scope was entered from: Back returns there. */
  back?: string
  /** This entry opened the inspector, so closing it goes back rather than adding an entry. */
  opened?: boolean
}

export const entry = (): Entry => (history.state && typeof history.state === "object" ? (history.state as Entry) : {})

/** Merge into the current entry's state without navigating. */
export const patchEntry = (patch: Entry) => history.replaceState({ ...entry(), ...patch }, "")

// The URL the last Back or Forward landed on. A canvas restores its saved position only on that entry; anything
// else (a new filter, a new search, a new scope) lays the field out again around the centre.
let popped: string | null = null
window.addEventListener("popstate", () => {
  popped = location.href
})
export const landedByHistory = () => popped === location.href

// The canvas on screen, if any, says where it is when the user leaves for another entry.
let positionOf: (() => CanvasPosition) | null = null
export function providePosition(fn: () => CanvasPosition) {
  positionOf = fn
  return () => {
    if (positionOf === fn) positionOf = null
  }
}
export const rememberPosition = () => positionOf && patchEntry({ view: positionOf() })

/** A website's scope, optionally with one of its items open (`page:<id>`). */
export const siteHref = (id: string, open?: string) => `/?site=${encodeURIComponent(id)}${open ? `&open=${encodeURIComponent(open)}` : ""}`

/** Into a website's scope, remembering this place for Back. */
export function enterSite(id: string, open?: string) {
  rememberPosition()
  navigate(siteHref(id, open), { state: { back: location.pathname + location.search } satisfies Entry })
}

/** Back to where the scope was entered from; a scope opened from a link goes to All saves. */
export function leaveSite() {
  if (entry().back) history.back()
  else navigate("/")
}

const FILTER_NAMES: Record<CanvasFilter, string> = {
  all: "All saves",
  websites: "Websites",
  pages: "Pages",
  sections: "Sections",
  animations: "Animations",
  images: "Images",
}

/** What Back is called: the place it returns to. */
export function backLabel(back: string | undefined, boardName: (id: string) => string | undefined) {
  if (!back) return "All saves"
  const url = new URL(back, location.origin)
  const board = url.pathname.match(/^\/b\/([^/]+)/)
  if (board) return boardName(decodeURIComponent(board[1]!)) ?? "Board"
  if (url.searchParams.get("site")) return "Back"
  const q = url.searchParams.get("q")
  if (q) return `Search: ${q}`
  return FILTER_NAMES[url.searchParams.get("filter") as CanvasFilter] ?? "All saves"
}
