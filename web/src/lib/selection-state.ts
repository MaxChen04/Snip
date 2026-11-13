// What the user has picked for the copied prompt on a reference page. Kept free of components so tests can load it.

import type { PageView } from "../../shared/selection"

export interface Selection {
  pages: string[]
  animations: string[]
  tokens: boolean
  /** The view each page was picked in from the page viewer (viewport, theme, sections). Pages picked from the grid have none. */
  views?: Record<string, PageView>
}
export const EMPTY_SELECTION: Selection = { pages: [], animations: [], tokens: false }
export const selectionSize = (s: Selection) => s.pages.length + s.animations.length + (s.tokens ? 1 : 0)
export const toggleIn = (xs: string[], id: string) => (xs.includes(id) ? xs.filter((x) => x !== id) : [...xs, id])

/** Put a page in the selection with this view, or take it out (null). */
export function withPageView(s: Selection, pageId: string, view: PageView | null): Selection {
  const views = { ...s.views }
  if (view) views[pageId] = view
  else delete views[pageId]
  return { ...s, pages: view ? (s.pages.includes(pageId) ? s.pages : [...s.pages, pageId]) : s.pages.filter((x) => x !== pageId), views }
}

/** Toggling a page from the grid drops any view it was picked in. */
export const togglePage = (s: Selection, pageId: string): Selection =>
  s.pages.includes(pageId) ? withPageView(s, pageId, null) : { ...s, pages: [...s.pages, pageId] }

/**
 * Drop ids the current capture no longer has. A recapture replaces every page and animation id, so a selection
 * saved before it would otherwise count items that can't be copied.
 */
export function pruneSelection(s: Selection, pages: { id: string }[], animations: { id: string }[]): Selection {
  const pageIds = new Set(pages.map((p) => p.id))
  const animationIds = new Set(animations.map((a) => a.id))
  const keep = s.pages.filter((id) => pageIds.has(id))
  const keepAnimations = s.animations.filter((id) => animationIds.has(id))
  if (keep.length === s.pages.length && keepAnimations.length === s.animations.length) return s
  return { ...s, pages: keep, animations: keepAnimations, views: Object.fromEntries(Object.entries(s.views ?? {}).filter(([id]) => pageIds.has(id))) }
}
