import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement, type RefObject } from "react"
import { useLocation, useSearch } from "wouter"
import { navigate as go, useHistoryState } from "wouter/use-browser-location"
import { AgentBanner } from "@/components/agent-banner"
import { SparklesIcon } from "@/components/icons"
import { EMPTY_SELECTION, pruneSelection, SelectionBar, selectionSize, toggleIn, togglePage, withPageView, type Selection } from "@/components/prompt-selection"
import { useDesktopState } from "@/hooks/use-desktop-state"
import { SavePagesButton } from "@/components/save-pages"
import { TokensPanel } from "@/components/tokens-panel"
import { TopBar } from "@/components/top-bar"
import { CaptureCard } from "@/components/canvas/capture-card"
import { DropOverlay } from "@/components/canvas/drop-overlay"
import { countOf, FilterDock } from "@/components/canvas/filter-dock"
import { GAP, layoutHome, PLAZA, stageTiles, visibleTiles, type HomeItem, type HomeLayout, type Placement, type Plaza, type Slot } from "@/components/canvas/home-layout"
import { boundsOf, useGalleryEditing } from "@/components/canvas/gallery-editing"
import { tilePosition, useGalleryPositions } from "@/components/canvas/gallery-positions"
import { useGalleryReflow } from "@/components/canvas/gallery-reflow"
import { frameGallery, GallerySiteLabels, gallerySitePins, placeSiteLabels, SITE_LABEL_ZOOM } from "@/components/canvas/gallery-site-labels"
import { InfiniteCanvas, type CanvasView, type InfiniteCanvasHandle, type WorldRect } from "@/components/canvas/infinite-canvas"
import type { GalleryTool } from "@/components/canvas/gallery-gestures"
import { ItemInspector, type PagePrompt } from "@/components/canvas/item-inspector"
import { CapturePill, isBusy, SiteScopeDetails, useSite, type SiteDetail } from "@/components/canvas/site-scope"
import { CanvasTile, HomeTile } from "@/components/canvas/tiles"
import { itemAspect, RELOAD_EVENT, reloadCanvas, type CanvasFilter, type CanvasItem, type SiteFilter } from "@/components/canvas/types"
import { ZoomControls } from "@/components/canvas/zoom-controls"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { api, type Filters, type LibraryTypeCounts, type Paged } from "@/lib/api"
import { parseProgress } from "@/lib/capture-progress"
import { useCollections } from "@/lib/collections"
import { masonryCols, useGridSize, useHomeView } from "@/lib/prefs"
import { backLabel, entry, landedByHistory, leaveSite, patchEntry, providePosition, type Entry } from "@/lib/scope"
import { cn } from "@/lib/utils"
import { Cursor02Icon, HandIcon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

const FILTERS: CanvasFilter[] = ["all", "websites", "pages", "sections", "animations", "images"]
const SITE_FILTERS: SiteFilter[] = ["all", "pages", "sections", "animations", "tokens"]
export const keyOf = (it: CanvasItem) => `${it.kind}:${it.id}`

// Each feed loads up to CAP items up front; the layout keeps placements when the feed refreshes.
const PAGE = 100
const CAP = 400

async function loadAll<T>(fetchPage: (cursor: string | null) => Promise<Paged<T>>) {
  const out: T[] = []
  let cursor: string | null = null
  do {
    const page: Paged<T> = await fetchPage(cursor)
    out.push(...page.items)
    cursor = page.nextCursor
  } while (cursor && out.length < CAP)
  return out
}

const createdAt = (it: CanvasItem) =>
  (it.kind === "page" ? it.page : it.kind === "section" ? it.section : it.kind === "animation" ? it.animation : it.kind === "image" ? it.image : it.reference).createdAt

const FEEDS: Record<CanvasFilter, (f: Filters) => Promise<CanvasItem[]>> = {
  websites: (f) => loadAll((c) => api.references(f, c, PAGE)).then((rs) => rs.map((reference): CanvasItem => ({ kind: "website", id: reference.id, reference }))),
  pages: (f) =>
    loadAll((c) => api.pages(f, c, PAGE)).then((ps) =>
      ps.filter((p) => p.desktopThumbKey || p.mobileThumbKey).map((page): CanvasItem => ({ kind: "page", id: page.id, page })),
    ),
  sections: (f) => loadAll((c) => api.sections(f, c, PAGE)).then((ss) => ss.map((section): CanvasItem => ({ kind: "section", id: section.id, section }))),
  animations: (f) => loadAll((c) => api.animations(f, c, PAGE)).then((as) => as.map((animation): CanvasItem => ({ kind: "animation", id: animation.id, animation }))),
  images: (f) => loadAll((c) => api.images(f, c, PAGE)).then((is) => is.map((image): CanvasItem => ({ kind: "image", id: image.id, image }))),
  // Animations stay out of All: hover recordings are small element crops that crowd the field as stills.
  all: (f) =>
    Promise.all([FEEDS.pages(f), FEEDS.sections(f), FEEDS.images(f)]).then((lists) => lists.flat().sort((a, b) => createdAt(b).localeCompare(createdAt(a)))),
}

// The last few feeds and counts, so Back to a place shows it at once while it refreshes, and each place's slots, so its
// items stay where they were when it refreshes or Back returns to it.
const feedCache = new Map<string, CanvasItem[]>()
const slotCache = new Map<string, Map<string, Slot>>()
const countCache = new Map<string, LibraryTypeCounts>()
function cache<T>(map: Map<string, T>, key: string, value: T) {
  map.delete(key)
  map.set(key, value)
  if (map.size > 12) map.delete(map.keys().next().value!)
}
window.addEventListener(RELOAD_EVENT, () => {
  feedCache.clear()
  countCache.clear()
})

/**
 * The current feed; items is null until the first load for this place (none when `filter` is null). Refetches on
 * RELOAD_EVENT and when `version` changes, keeping what it shows meanwhile.
 */
function useFeed(filter: CanvasFilter | null, q: string, site: string | null, version: string) {
  const key = `${site ?? ""}|${filter}|${q}`
  const [state, setState] = useState<{ key: string; items: CanvasItem[] | null; error?: string }>()
  useEffect(() => {
    if (!filter) return
    let latest = 0
    const load = () => {
      const n = ++latest
      FEEDS[filter]({ q: q || undefined, reference: site ?? undefined }).then(
        (items) => {
          if (n !== latest) return
          cache(feedCache, key, items)
          setState({ key, items })
        },
        (e: Error) => n === latest && setState((s) => ({ key, items: s?.key === key ? s.items : (feedCache.get(key) ?? null), error: e.message })),
      )
    }
    load()
    window.addEventListener(RELOAD_EVENT, load)
    return () => {
      latest = -1
      window.removeEventListener(RELOAD_EVENT, load)
    }
  }, [filter, q, site, key, version])
  if (!filter) return { items: [], error: undefined }
  return state?.key === key ? state : { items: feedCache.get(key) ?? null, error: undefined }
}

/** Counts for the dock: undefined while the first request is out, null if it failed. */
function useCounts(q: string, site: string | null, version: string) {
  const key = `${site ?? ""}|${q}`
  const [state, setState] = useState<{ key: string; counts: LibraryTypeCounts | null }>()
  useEffect(() => {
    let alive = true
    const load = () =>
      api.counts({ q: q || undefined, reference: site ?? undefined }).then(
        (c) => {
          if (!alive) return
          cache(countCache, key, c)
          setState({ key, counts: c })
        },
        () => alive && setState((s) => (s?.key === key ? s : { key, counts: countCache.get(key) ?? null })),
      )
    void load()
    window.addEventListener(RELOAD_EVENT, load)
    return () => {
      alive = false
      window.removeEventListener(RELOAD_EVENT, load)
    }
  }, [q, site, key, version])
  return state?.key === key ? state.counts : countCache.get(key)
}

/** Selecting for a prompt inside a site: pages and recordings can be picked. */
const pickable = (it: CanvasItem) => it.kind === "page" || it.kind === "animation"
const isPicked = (s: Selection, it: CanvasItem) => (it.kind === "page" ? s.pages.includes(it.id) : it.kind === "animation" ? s.animations.includes(it.id) : false)

/** A page a running capture hasn't saved yet. The one being captured and those behind it look the same, as on the capture card. */
type Pending = { label: string }
const PENDING_KEY = "pending:"
const siteKey = ({ domain, id }: { domain: string; id: string }) => domain ? `domain:${domain}` : `reference:${id}`
function homeItem(item: CanvasItem): HomeItem {
  const base = { key: keyOf(item), aspect: itemAspect(item) }
  switch (item.kind) {
    case "page": return { ...base, site: siteKey(item.page.reference) }
    case "section": return { ...base, site: siteKey(item.section.reference), parent: `page:${item.section.pageId}` }
    case "animation": return { ...base, site: siteKey(item.animation.reference), parent: item.animation.pageId ? `page:${item.animation.pageId}` : undefined }
    case "website": return { ...base, site: siteKey(item.reference) }
    case "image": return base
  }
}
const PendingTile = ({ p, style }: { p: Pending; style: CSSProperties }) => (
  <Skeleton aria-hidden className="pointer-events-none absolute rounded-md" style={style}>
    <span className="max-w-full truncate">{p.label}</span>
  </Skeleton>
)

/** What's still to come in a site that is capturing, as on the capture card: the page being captured, and how many are queued behind it when the total is known. */
function pendingOf(d: SiteDetail | null): Pending[] {
  const r = d?.reference
  // A capture whose agent went quiet is not working on a page: nothing to hold a place for.
  if (!r || !isBusy(r) || r.quietSince) return []
  const progress = parseProgress(r)
  const first: Pending =
    r.status === "paused" ? { label: "Paused" }
    : r.status === "queued" ? { label: "Queued" }
    : { label: progress?.path ?? "Starting…" }
  const queued = progress?.total ? progress.total - progress.n : 0
  return queued > 0 ? [first, { label: `${queued} more queued` }] : [first]
}

const at = (t: Pick<Placement, "x" | "y" | "w" | "h">) => ({ left: t.x, top: t.y, width: t.w, height: t.h })

/**
 * The tiles in (and near) view. Re-renders only when the visible rect or the items change, and reuses the element of
 * every tile that stays in view: a new rect then costs React the tiles that came into view, not all of them. A step of
 * a zoom that brings in hundreds mounts them over a few frames (see stageTiles).
 */
const Field = memo(function Field({
  layout,
  items,
  rect,
  onOpen,
  scoped,
  pick,
  pending,
  selected,
  moving,
  onGallerySelect,
}: {
  layout: HomeLayout
  items: CanvasItem[]
  rect: WorldRect
  onOpen: (item: CanvasItem) => void
  /** Inside a site. */
  scoped?: boolean
  /** Selecting for a prompt: what is picked. */
  pick?: Selection | null
  /** Slots after the items for pages a capture is still to save. */
  pending?: Pending[]
  selected: ReadonlySet<string>
  moving: readonly Placement[]
  onGallerySelect: (key: string, toggle: boolean) => void
}) {
  // `mounted` is the set of keys the last commit put on the canvas.
  const cache = useMemo(() => ({ elements: new Map<string, ReactElement>(), mounted: new Set<string>() }), [layout, items, onOpen, scoped, pick, pending, selected, moving, onGallerySelect])
  const [, nextFrame] = useState(0)
  const movingKeys = useMemo(() => new Set(moving.map((t) => t.key)), [moving])
  const wanted = moving.length ? layout.tiles.filter((t) => movingKeys.has(t.key) || (t.x < rect.x + rect.w && t.x + t.w > rect.x && t.y < rect.y + rect.h && t.y + t.h > rect.y)) : visibleTiles(layout, rect)
  // A new feed or layout mounts everything at once, as it always did: there is no view to keep smooth yet.
  const { tiles: staged, later } = cache.mounted.size ? stageTiles(wanted, cache.mounted, rect) : { tiles: wanted, later: false }
  const kept = new Map<string, ReactElement>()
  const tiles = staged.map((t) => {
    let el = cache.elements.get(t.key)
    if (!el) {
      const item = items[t.index]
      el = item ? (
        <HomeTile
          key={t.key}
          item={item}
          x={t.x}
          y={t.y}
          w={t.w}
          h={t.h}
          onOpen={onOpen}
          scoped={scoped}
          checked={pick && pickable(item) ? isPicked(pick, item) : undefined}
          dim={!!pick && !pickable(item)}
          galleryKey={pick ? undefined : t.key}
          selected={selected.has(t.key)}
          moving={movingKeys.has(t.key)}
          onGallerySelect={onGallerySelect}
        />
      ) : (
        <PendingTile key={t.key} p={pending![t.index - items.length]!} style={at(t)} />
      )
    }
    kept.set(t.key, el)
    return el
  })
  cache.elements = kept
  useLayoutEffect(() => {
    cache.mounted = new Set(kept.keys())
    if (!later) return
    const frame = requestAnimationFrame(() => nextFrame((n) => n + 1))
    return () => cancelAnimationFrame(frame)
  })
  return tiles
})

// Slots around the plaza: skeletons while loading, dashed placeholders when there's nothing to show yet.
const GHOST_ITEMS = [1.6, 0.8, 1.3, 1, 1.6, 0.75, 1.45, 1.6, 1.1, 0.9, 1.6, 1.25, 1.6, 0.8].map((aspect, i) => ({ key: `ghost${i}`, aspect }))
const Ghosts = memo(function Ghosts({ loading, plaza }: { loading: boolean; plaza: Plaza }) {
  // Laid out around the same measured plaza as the field, so they never cover the capture card.
  const ghosts = useMemo(() => layoutHome(GHOST_ITEMS, plaza).tiles, [plaza])
  return ghosts.map((t) =>
    loading ? (
      <Skeleton key={t.key} className="pointer-events-none absolute rounded-md" style={at(t)} />
    ) : (
      <div key={t.key} aria-hidden className="pointer-events-none absolute rounded-md border border-dashed border-ink-6" style={at(t)} />
    ),
  )
})

/** Zoom pill with its own state, so zooming re-renders only the pill. */
export function Zoom({ canvas, sink, tool, onToolChange, movable }: {
  canvas: RefObject<InfiniteCanvasHandle | null>
  sink: RefObject<((zoom: number) => void) | null>
  tool?: GalleryTool
  onToolChange?: (tool: GalleryTool) => void
  movable?: boolean
}) {
  const [zoom, setZoom] = useState(() => canvas.current?.getView().zoom ?? 1)
  useEffect(() => {
    sink.current = setZoom
    return () => {
      sink.current = null
    }
  }, [sink])
  return (
    <div className={cn("absolute right-6 bottom-6 z-50 flex gap-2", tool ? "max-lg:bottom-[88px] max-sm:right-4" : "max-sm:hidden")}>
      {tool && (
        <div role="group" aria-label="Canvas tools" className="flex h-10 items-center gap-0.5 rounded-full bg-control p-1 shadow-button max-sm:h-auto">
          {(["arrow", "hand"] as const).map((name) => (
            <button
              key={name}
              type="button"
              aria-label={name === "arrow" ? "Arrow" : "Hand"}
              aria-pressed={tool === name}
              aria-keyshortcuts={name === "arrow" ? "V" : "H"}
              title={name === "arrow" ? movable ? "Arrow (V) · Select or drag a tile edge" : "Arrow (V) · Select tiles" : "Hand (H) · Pan"}
              className="press grid size-8 place-items-center rounded-full text-ink-11 hover:bg-ink-3 hover:text-foreground aria-pressed:bg-ink-4 aria-pressed:text-foreground max-sm:size-11"
              onClick={() => onToolChange?.(name)}
            >
              <HugeiconsIcon icon={name === "arrow" ? Cursor02Icon : HandIcon} className="size-4" />
            </button>
          ))}
        </div>
      )}
      <ZoomControls
        className={tool ? "max-sm:hidden" : undefined}
        zoom={zoom}
        onZoom={(f) => canvas.current?.zoomBy(f, undefined, { animate: true })}
        onReset={() => canvas.current?.setZoom(1, undefined, { animate: true })}
        onRecenter={() => canvas.current?.recenter({ animate: true })}
      />
    </div>
  )
}

/**
 * What a canvas route shares: ?filter=, the inspector's ?open=<kind>:<id> (pushed so Back closes it, prev/next replace
 * it), the page title, and no trackpad-swipe bounce over the chrome. A replace keeps the entry's state (its saved
 * position and where Back goes).
 */
export function useCanvasRoute(title: string) {
  const search = useSearch()
  const [, navigate] = useLocation()
  const params = new URLSearchParams(search)
  const raw = params.get("filter") as CanvasFilter | null
  const filter: CanvasFilter = raw && FILTERS.includes(raw) ? raw : "all"
  const open = params.get("open")

  // Reads the live URL, so a change made after a delay (search typing) doesn't undo one made meanwhile.
  const setParams = useCallback(
    (patch: Record<string, string | null>, replace = true) => {
      const next = new URLSearchParams(location.search)
      for (const [k, v] of Object.entries(patch)) (v === null ? next.delete(k) : next.set(k, v))
      const qs = next.toString()
      navigate(`${location.pathname}${qs ? `?${qs}` : ""}`, { replace, state: replace ? history.state : ({ opened: true } satisfies Entry) })
    },
    [navigate],
  )

  useEffect(() => {
    document.title = `${title} · Snip`
    return () => {
      document.title = "Snip"
    }
  }, [title])

  // Trackpad swipes over the chrome must not bounce the page or navigate back.
  useEffect(() => {
    document.documentElement.classList.add("overscroll-none")
    return () => document.documentElement.classList.remove("overscroll-none")
  }, [])

  const onOpen = useCallback((item: CanvasItem) => setParams({ open: keyOf(item) }, false), [setParams])
  // An inspector this entry opened closes by going back to the entry before it; one opened by a link replaces.
  const close = () => (entry().opened ? history.back() : setParams({ open: null }))
  return { filter, open, params, navigate, setParams, onOpen, close }
}

/**
 * Home: an infinite canvas around the capture card, scoped to All saves or to one website (?site=). Inside a site the
 * same canvas shows that site's pages, sections or recordings, search searches the site, and the chrome names it: a
 * chip in search with its details, and a Back pill. Every place is a URL plus the canvas position kept in
 * its history entry, so leaving a site lands exactly where it was entered from.
 */
export function CanvasHome({ login }: { login: string }) {
  const search = useSearch()
  const params = new URLSearchParams(search)
  const site = params.get("site")
  const siteData = useSite(site)
  const detail = site ? siteData.detail : null
  const reference = detail?.reference
  const title = site ? (reference?.title || reference?.domain || "Website") : "All saves"
  const { filter: libraryFilter, open, setParams, onOpen, close } = useCanvasRoute(title)
  const rawFilter = params.get("filter") as SiteFilter | null
  const siteFilter: SiteFilter = rawFilter && SITE_FILTERS.includes(rawFilter) ? rawFilter : "pages"
  const filter: CanvasFilter | SiteFilter = site ? siteFilter : libraryFilter
  const feedFilter: CanvasFilter | null = filter === "tokens" ? null : filter

  // The query is in the URL (each place keeps its own); the field updates at once and the URL after a pause in typing.
  const q = params.get("q") ?? ""
  const [query, setQueryState] = useState(q)
  // The query this field last wrote or was given: a URL change from elsewhere (Back, a new scope) replaces the field.
  const [written, setWritten] = useState(q)
  // A draft still waiting to be written belongs to the scope it was typed in: entering or leaving a site drops it.
  const [draftSite, setDraftSite] = useState(site)
  if (q !== written || site !== draftSite) {
    setWritten(q)
    setQueryState(q)
    setDraftSite(site)
  }
  useEffect(() => {
    const t = setTimeout(() => {
      const next = query.trim()
      if (next === written) return
      setWritten(next)
      setParams({ q: next || null, open: null })
    }, 250)
    return () => clearTimeout(t)
  }, [query, written, setParams])
  const setQuery = useCallback((v: string) => setQueryState(v), [])

  const [view] = useHomeView()
  const [gridSize] = useGridSize()
  // A capture saving pages into this site refreshes what it shows.
  const version = reference ? `${reference.status}|${reference.pageCount}|${reference.animationCount}|${reference.captureRun}` : ""
  const counts = useCounts(q, site, version)
  const total = counts ? countOf(counts, "all") : null
  // Zoom and the caption wait for the counts, so the page doesn't flash them.
  const chrome = counts !== undefined
  const { items, error } = useFeed(feedFilter, q, site, version)
  // Only once the saves themselves have loaded: counts that answer first must not call a loading library empty.
  const firstRun = !site && !q && !!counts && counts.websites + total! === 0 && items?.length === 0
  const pending = useMemo(() => (site && !q && (filter === "pages" || filter === "all") ? pendingOf(detail) : []), [site, q, filter, detail])

  // ---- Selecting for a prompt, inside a site ----
  // Kept per site in the desktop app, as the website page did, so it survives the idle window being released.
  const [selecting, setSelecting] = useDesktopState(`snip:${site}:selecting`, false)
  const [sel, setSel] = useDesktopState<Selection>(`snip:${site}:selection`, EMPTY_SELECTION)
  useEffect(() => {
    if (detail) setSel((x) => pruneSelection(x, detail.pages, detail.animations))
  }, [detail])
  const picking = !!detail && (selecting || selectionSize(sel) > 0)
  const doneSelecting = useCallback(() => {
    setSelecting(false)
    setSel(EMPTY_SELECTION)
  }, [])
  const pick = useCallback((it: CanvasItem) => {
    if (it.kind === "page") setSel((x) => togglePage(x, it.id))
    else if (it.kind === "animation") setSel((x) => ({ ...x, animations: toggleIn(x.animations, it.id) }))
  }, [])
  const prompt = useMemo<PagePrompt | undefined>(
    () => (detail ? { views: sel.views ?? {}, onView: (pageId, v) => {
      setSel((x) => withPageView(x, pageId, v))
      if (v) setSelecting(true)
    } } : undefined),
    [detail, sel.views],
  )
  const tileOpen = picking ? pick : onOpen

  // The plaza hugs what it holds (a running capture, a message, the first-run prompt): its measured height, in 40-px
  // steps so small text changes don't relayout the field. Holding nothing, it closes and the tiles meet in the middle.
  const [plazaH, setPlazaH] = useState<number | null>(null)
  const measurePlaza = useCallback((el: HTMLDivElement | null) => {
    if (!el) return
    const ro = new ResizeObserver(() => setPlazaH(el.offsetHeight ? Math.max(PLAZA.h, Math.ceil((el.offsetHeight + 2 * GAP) / 40) * 40) : 0))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const plazaRect = useMemo(() => (plazaH ? { w: PLAZA.w, h: plazaH } : { w: 0, h: 0 }), [plazaH])
  const place = `${site ?? ""}|${feedFilter}|${q}`
  const free = view === "canvas" && !site && feedFilter === "all" && !q
  const storage = useGalleryPositions(free)
  const fixed = free && storage.loaded ? storage.positions : undefined
  const pendingSite = reference ? siteKey(reference) : undefined
  const layout = useMemo(() => {
    const next = layoutHome(
      [...(items ?? []).map(homeItem), ...pending.map((_, i) => ({ key: `${PENDING_KEY}${i}`, aspect: 16 / 10, site: pendingSite }))],
      plazaRect,
      free ? undefined : slotCache.get(place),
      fixed,
    )
    if (items && !free) cache(slotCache, place, new Map([...next.slots].filter(([key]) => !key.startsWith(PENDING_KEY))))
    return next
  }, [items, pending, plazaRect, place, pendingSite, free, fixed])
  const unseeded = useMemo(() => fixed ? layout.tiles.filter((t) => !fixed.has(t.key)) : [], [fixed, layout])
  useEffect(() => {
    if (free && plazaH !== null && items && unseeded.length) void storage.seed(unseeded.map((t) => tilePosition(t.key, t)))
  }, [free, plazaH, items, unseeded, storage.seed])
  const showingTiles = !free || ((storage.loaded || storage.failed) && plazaH !== null)
  const galleryTiles = useMemo(() => showingTiles ? layout.tiles.filter((t) => !t.key.startsWith(PENDING_KEY)) : [], [layout, showingTiles])
  const plazaBounds = useMemo(() => plazaH ? { x: -PLAZA.w / 2, y: -plazaH / 2, w: PLAZA.w, h: plazaH } : undefined, [plazaH])
  const editable = free && !picking && storage.loaded && !storage.failed && unseeded.length === 0
  const inspectTile = useCallback((key: string) => {
    const item = items?.find((t) => keyOf(t) === key)
    if (item) tileOpen(item)
  }, [items, tileOpen])
  const edit = useGalleryEditing(`${view}|${place}`, galleryTiles, plazaBounds, editable, storage, inspectTile)
  const newest = layout.tiles[0]
  const home = newest && !newest.key.startsWith(PENDING_KEY) && (Math.abs(newest.x + newest.w / 2) > 256 || Math.abs(newest.y + newest.h / 2) > 240)
    ? { x: newest.x + newest.w / 2, y: newest.y + newest.h / 2 }
    : undefined

  // What a pan must keep on the screen: the tiles (saved and still capturing), and the plaza while it holds something
  // (the capture card, a welcome, no results, a retry). Nothing while the feed first loads, so a saved view isn't moved
  // before its tiles are there.
  const content = useMemo(() => {
    if ((!items && !error) || !showingTiles) return undefined
    const rects: WorldRect[] = plazaBounds ? [...layout.tiles, plazaBounds] : layout.tiles
    return rects.length ? rects : undefined
  }, [items, error, layout, plazaBounds, showingTiles])

  const canvas = useRef<InfiniteCanvasHandle>(null)
  // A new place (scope, filter, search) lays the field out again around the plaza: bring the plaza back. Back or
  // Forward to an entry returns to where that entry was left.
  useEffect(() => {
    const saved = landedByHistory() ? entry().view : undefined
    if (saved) canvas.current?.setView(saved)
    else canvas.current?.recenter({ animate: true })
    // A site's canvas mounts once its detail has loaded.
  }, [site, filter, q, !site || !!detail])
  // Keep the entry's position current, so browser Back, ⌘[ and Forward all find it.
  const savePosition = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => {
    const stop = () => clearTimeout(savePosition.current)
    window.addEventListener("popstate", stop)
    const release = providePosition(() => {
      const view = canvas.current?.getView()
      return view && { x: view.x, y: view.y, zoom: view.zoom }
    })
    return () => {
      stop()
      window.removeEventListener("popstate", stop)
      release()
    }
  }, [])
  const zoomSink = useRef<((zoom: number) => void) | null>(null)
  const [labelView, setLabelView] = useState({ zoom: 0, height: 28 })
  const labelViewRef = useRef(labelView)
  const onViewChange = useCallback((v: CanvasView) => {
    zoomSink.current?.(v.zoom)
    const zoom = v.zoom < SITE_LABEL_ZOOM ? Math.round(v.zoom * 200) / 200 : 0
    const height = v.width < 640 ? 44 : 28
    if (zoom !== labelViewRef.current.zoom || height !== labelViewRef.current.height) {
      labelViewRef.current = { zoom, height }
      setLabelView(labelViewRef.current)
    }
    clearTimeout(savePosition.current)
    savePosition.current = setTimeout(() => patchEntry({ view: { x: v.x, y: v.y, zoom: v.zoom } }), 300)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat) return
      const t = e.target as HTMLElement | null
      if (t?.closest?.("input, textarea, select, [contenteditable]")) return
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [data-popup-open]')) return
      if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        if (edit.selected.size) edit.select(null, false)
        else if (picking) doneSelecting()
        else if (site) leaveSite()
        return
      }
      if (view !== "canvas" || !feedFilter || !canvas.current || edit.moving.length || picking || open) return
      const key = e.key.toLowerCase()
      if (free && (e.metaKey || e.ctrlKey) && !e.altKey && key === "z") {
        if (storage.step(e.shiftKey)) e.preventDefault()
      } else if (!e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && key === "f") {
        frameGallery(canvas.current, boundsOf(edit.selectedTiles))
        e.preventDefault()
      } else if (e.altKey && !e.ctrlKey && !e.metaKey && key.startsWith("arrow")) {
        const by = (e.shiftKey ? 48 : 16) / canvas.current.getView().zoom
        if (edit.nudge({ x: key === "arrowleft" ? -by : key === "arrowright" ? by : 0, y: key === "arrowup" ? -by : key === "arrowdown" ? by : 0 })) e.preventDefault()
      }
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [site, picking, doneSelecting, view, feedFilter, free, edit, open, storage])

  const list = items ?? []
  // Each feed stops at CAP items. Say so, or a big library looks like it lost its older saves.
  const inFilter = counts && feedFilter ? countOf(counts, feedFilter) : 0
  const caption =
    firstRun || q || !total ? undefined
    : list.length >= CAP && list.length < inFilter ? `Showing the newest ${list.length} of ${inFilter}. Search to find older saves.`
    : site ? undefined
    : `${total} saved`
  const index = open ? list.findIndex((it) => keyOf(it) === open) : -1
  // A page asked for by link (an old /r/:id?tab=…&page= link, or Tokens with a page open) may be outside this feed:
  // the site's own pages have it.
  const sitePage = index < 0 && detail ? detail.pages.find((p) => `page:${p.id}` === open) : undefined
  const openItem: CanvasItem | undefined =
    index >= 0 ? list[index]
    : sitePage && detail ? { kind: "page", id: sitePage.id, page: { ...sitePage, reference: { id: detail.reference.id, title: detail.reference.title, domain: detail.reference.domain, favicon: detail.reference.favicon } } }
    : undefined
  // The open item left the list (deleted from the inspector, or filtered away): close, so ?open= and the
  // history entry don't outlive it. In a site, only once its pages are known.
  const closeRef = useRef(close)
  closeRef.current = close
  useEffect(() => {
    if (open && items && !openItem && (!site || detail)) closeRef.current()
  }, [open, items, openItem, site, detail])

  const { collections } = useCollections()
  const historyState = useHistoryState() as Entry | null
  const backTo = backLabel(historyState?.back, (id) => collections.find((c) => c.id === id)?.name)
  const back = site ? { label: backTo, onBack: leaveSite } : undefined
  const domain = reference?.domain
  const busy = !!reference && isBusy(reference)
  const emptyText: Record<SiteFilter, string> = {
    all: "Nothing captured from this site yet.",
    pages: "No pages captured yet.",
    sections: "No sections found on this site's pages.",
    animations: "No recordings from this site.",
    tokens: "",
  }
  const messages = useMemo(
    () =>
      error ? (
        <p className="flex items-center gap-2 text-xs text-ink-11" role="alert">
          Couldn't load your saves.
          <button type="button" data-no-pan onClick={reloadCanvas} className="tactile press h-7 rounded-full px-3 text-xs">
            Try again
          </button>
        </p>
      ) : items?.length === 0 && q ? (
        <div className="flex flex-col items-center gap-1 text-center" role="status">
          <p className="text-sm text-foreground">{site ? `Nothing in ${domain ?? "this site"} matches “${q}”` : `No matches for “${q}”`}</p>
          <p className="text-xs text-ink-11">
            {site ? (
              <>
                It may be on another site.{" "}
                <button type="button" data-no-pan onClick={() => go(`/?q=${encodeURIComponent(q)}`)} className="underline decoration-ink-7 underline-offset-2 hover:text-foreground">
                  Search all saves
                </button>
                {" or "}
              </>
            ) : (
              "Try a different word, or "
            )}
            <button type="button" data-no-pan onClick={() => setQuery("")} className="underline decoration-ink-7 underline-offset-2 hover:text-foreground">
              clear the search
            </button>
            .
          </p>
        </div>
      ) : site && items?.length === 0 && !pending.length && detail && siteFilter !== "tokens" ? (
        <p className="text-sm text-ink-11" role="status">
          {emptyText[siteFilter]}
        </p>
      ) : null,
    [site, error, items, q, domain, setQuery, pending.length, detail, siteFilter],
  )
  const plaza = useMemo(
    () => (
      <div ref={measurePlaza} className={cn("absolute top-0 left-0 flex w-max -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-4", free && "z-10")}>
        {!site && <CaptureCard firstRun={firstRun} compact={!firstRun} />}
        {messages}
      </div>
    ),
    [site, firstRun, messages, measurePlaza, free],
  )
  const ghosts = useMemo(
    () => (!showingTiles || !items || (items.length === 0 && !q && !site) ? <Ghosts loading={!showingTiles || (!items && !error)} plaza={plazaRect} /> : null),
    [items, q, site, error, plazaRect, showingTiles],
  )
  const pickState = picking ? sel : null
  const { field, selected, moving } = edit
  useGalleryReflow(place, items && showingTiles ? galleryTiles : null, field)
  const far = labelView.zoom > 0
  const sitePins = useMemo(() => far && items ? gallerySitePins(galleryTiles, items) : [], [far, items, galleryTiles])
  const siteLabels = useMemo(() => sitePins.length && !moving.length
    ? placeSiteLabels(sitePins, plazaBounds ? [...layout.tiles, plazaBounds] : layout.tiles, labelView.zoom, labelView.height)
    : [], [sitePins, layout.tiles, labelView, plazaBounds, moving.length])
  const frameSite = useCallback((area: WorldRect) => {
    if (canvas.current) frameGallery(canvas.current, area, true)
  }, [])
  const keyboardSelect = useCallback((key: string, toggle: boolean) => {
    if (toggle || edit.gallery.tool === "arrow") edit.select(key, toggle)
  }, [edit.gallery.tool, edit.select])
  const renderWorld = useCallback(
    // The plaza comes first so the capture card is the first stop when tabbing into the canvas.
    (rect: WorldRect) => (
      <>
        {plaza}
        <div ref={field} className="peer group/field">
          <div>
            {items && showingTiles && <Field layout={layout} items={items} rect={rect} onOpen={tileOpen} scoped={!!site} pick={pickState} pending={pending} selected={selected} moving={moving} onGallerySelect={keyboardSelect} />}
          </div>
          {moving.map((t) => (
            <div key={t.key} aria-hidden style={at(t)} className="pointer-events-none absolute hidden [translate:var(--landing-at)] rounded-md bg-ink-8/30 group-data-collision/field:block" />
          ))}
        </div>
        {siteLabels.length > 0 && <GallerySiteLabels labels={siteLabels} zoom={labelView.zoom} height={labelView.height} visible={rect} onFrame={frameSite} />}
        {ghosts}
      </>
    ),
    [items, layout, tileOpen, site, pickState, pending, ghosts, plaza, field, selected, moving, keyboardSelect, showingTiles, siteLabels, labelView, frameSite],
  )

  const tokens = reference?.tokens ?? null
  const selectedPages = detail ? detail.pages.filter((p) => sel.pages.includes(p.id)) : []
  const setPageCollections = (pageIds: string[], cid: string, member: boolean) =>
    siteData.update((d) => ({
      ...d,
      pages: d.pages.map((p) => (pageIds.includes(p.id) ? { ...p, collectionIds: member ? [...new Set([...p.collectionIds, cid])] : p.collectionIds.filter((x) => x !== cid) } : p)),
    }))

  return (
    // overflow-clip, not hidden: a hidden box still scrolls to reveal a focused tile, which would shift the whole page.
    <div className="relative h-svh overflow-clip overscroll-none bg-background">
      {/* Chrome first in the DOM so Tab reaches it before hundreds of tiles; z-50 keeps it over the drop scrim (z-40). */}
      <TopBar
        floating
        login={login}
        query={query}
        onQuery={setQuery}
        scope={site ? {
          domain: domain ?? "Website",
          icon: reference?.favicon ?? null,
          details: reference ? <SiteScopeDetails key={site} site={siteData} onChange={reloadCanvas} /> : undefined,
          onLeave: leaveSite,
        } : undefined}
        back={back}
        actions={
          detail ? (
            <button
              type="button"
              aria-pressed={picking}
              title={picking ? "Done selecting" : "Select pages, recordings or tokens for a prompt"}
              onClick={() => (picking ? doneSelecting() : setSelecting(true))}
              className="press flex h-10 items-center gap-1.5 rounded-full bg-control/90 pr-3.5 pl-3 text-xs font-medium shadow-button backdrop-blur-md hover:bg-control-hover active:scale-[0.97] aria-pressed:bg-ink-4"
            >
              <SparklesIcon className="size-3.5 text-ink-10" />
              <span className="max-md:sr-only">{picking ? "Selecting" : "Select"}</span>
            </button>
          ) : undefined
        }
      />
      <div className="pointer-events-none absolute inset-x-0 top-16 z-50 flex flex-col items-center gap-2 px-4 max-sm:top-28">
        {reference && reference.status !== "ready" && (
          <div className="pointer-events-auto max-w-full">
            <CapturePill r={reference} onChange={() => void siteData.reload()} />
          </div>
        )}
        <div className="pointer-events-auto w-full max-w-xl empty:hidden">
          <AgentBanner />
        </div>
      </div>
      {/* The dock is the way to every board and filter: it never waits on the counts, which fill in when they arrive. */}
      {site ? (
        <FilterDock<SiteFilter>
          className="absolute bottom-6 left-1/2 z-50 -translate-x-1/2"
          value={siteFilter}
          onChange={(f) => setParams({ filter: f === "pages" ? null : f, open: null })}
          counts={counts ?? null}
          site={domain ?? "this site"}
          canAdd
        />
      ) : (
        <FilterDock<CanvasFilter>
          className="absolute bottom-6 left-1/2 z-50 -translate-x-1/2"
          value={libraryFilter}
          onChange={(f) => setParams({ filter: f === "all" ? null : f, open: null })}
          counts={counts ?? null}
          canAdd
          glow={firstRun}
        />
      )}
      {chrome && (
        <>
          {view === "canvas" && feedFilter && <Zoom canvas={canvas} sink={zoomSink} tool={edit.gallery.tool} onToolChange={edit.gallery.onToolChange} movable={free} />}
          {view === "canvas" && caption && (
            <p className={cn("absolute left-6 z-50 flex h-10 max-w-[calc(50vw-320px)] items-center rounded-full bg-control px-4 text-2xs text-ink-11 shadow-button max-lg:hidden", site ? "bottom-[72px]" : "bottom-6")}>{caption}</p>
          )}
        </>
      )}
      {picking && detail && (
        <div data-selection-bar className="absolute bottom-[88px] left-1/2 z-50 flex max-w-[calc(100vw-32px)] -translate-x-1/2 items-center gap-2 max-sm:bottom-[148px]">
          {selectedPages.length > 0 && <SavePagesButton pages={selectedPages} onChange={setPageCollections} className="h-10 px-3.5 shadow-card" />}
          <SelectionBar reference={detail.reference} pages={detail.pages} animations={detail.animations} selection={sel} onChange={setSel} onDone={doneSelecting} />
        </div>
      )}

      {site && !detail ? (
        // Until the site itself has loaded, every view (canvas, grid, Tokens) shows its state: loading, failed or gone.
        <div className="absolute inset-0 grid place-items-center px-4 text-center">
          {siteData.error ? (
            <div className="grid justify-items-center gap-3" role="alert">
              <p className="text-sm text-ink-12">{siteData.missing ? "This website doesn't exist" : "Couldn't load this website"}</p>
              <p className="text-xs text-ink-11">{siteData.missing ? "It may have been deleted." : "Check your connection and try again."}</p>
              <div className="flex gap-2">
                {!siteData.missing && (
                  <button type="button" onClick={() => void siteData.reload()} className="tactile press h-8 rounded-full px-3.5 text-xs">
                    Try again
                  </button>
                )}
                <button type="button" onClick={leaveSite} className="tactile press h-8 rounded-full px-3.5 text-xs">
                  Back to {backTo}
                </button>
              </div>
            </div>
          ) : (
            <Spinner className="size-5 text-muted-foreground" />
          )}
        </div>
      ) : site && filter === "tokens" ? (
        <div className="absolute inset-0 overflow-y-auto overscroll-none px-4 pt-24 pb-32 sm:px-6">
          <section aria-label={`Design tokens of ${domain ?? "this site"}`} className="mx-auto flex max-w-5xl flex-col gap-6 rounded-3xl bg-card p-5 shadow-card sm:p-6">
            {tokens ? (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-sm font-medium">Design tokens</h2>
                  {!sel.tokens && (
                    <button
                      type="button"
                      onClick={() => {
                        setSelecting(true)
                        setSel((x) => ({ ...x, tokens: true }))
                      }}
                      className="tactile press flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium"
                    >
                      <SparklesIcon className="size-3.5 text-ink-10" />
                      Add tokens to prompt
                    </button>
                  )}
                </div>
                <TokensPanel tokens={tokens} />
              </>
            ) : (
              <p className="py-10 text-center text-sm text-ink-11" role="status">
                {busy ? "Design tokens appear when the first page is captured." : "No design tokens were captured for this site."}
              </p>
            )}
          </section>
        </div>
      ) : view === "grid" ? (
        <div className="absolute inset-0 overflow-y-auto overscroll-none px-4 pt-20 pb-28 sm:px-6">
          {firstRun || (items?.length === 0 && !q && !site) ? (
            <CaptureCard firstRun={firstRun} className="mt-[12vh]" />
          ) : (
            <div className="flex flex-col gap-4">
              {!site && <CaptureCard compact />}
              {(messages || caption) && <div className="flex flex-col items-center gap-2 text-2xs text-ink-10">{messages ?? caption}</div>}
              {!items ? (
                <div className={cn(masonryCols[gridSize], "gap-4 [&>*]:mb-4")}>
                  {GHOST_ITEMS.map((g) => (
                    <Skeleton key={g.key} className="rounded-md" style={{ aspectRatio: g.aspect }} />
                  ))}
                </div>
              ) : (
                <div className={cn(masonryCols[gridSize], "gap-4 [&>*]:mb-4 [&>*]:break-inside-avoid")}>
                  {items.map((it) => (
                    <div key={keyOf(it)} style={{ aspectRatio: itemAspect(it) }} className={cn(picking && !pickable(it) && "opacity-35")}>
                      <CanvasTile item={it} onOpen={tileOpen} scoped={!!site} checked={picking && pickable(it) ? isPicked(sel, it) : undefined} />
                    </div>
                  ))}
                  {pending.map((p, i) => (
                    <div key={`${PENDING_KEY}${i}`} className="relative" style={{ aspectRatio: 16 / 10 }}>
                      <PendingTile p={p} style={{ inset: 0 }} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
      <InfiniteCanvas
        ref={canvas}
        tiled
        className="absolute inset-0"
        aria-label={`${title}. Drag or use the arrow keys to move, plus and minus to zoom, 0 to recenter.`}
        home={home}
        onViewChange={onViewChange}
        content={content}
        gallery={{ ...edit.gallery, enabled: !open && !picking }}
      >
        {renderWorld}
      </InfiniteCanvas>
      )}
      {free && storage.failed && (
        <div role="status" className="absolute right-6 bottom-[74px] z-40 flex items-center gap-2 rounded-full bg-control py-1 pr-1 pl-3 text-xs text-ink-11 shadow-button">
          Couldn’t load saved positions.
          <button type="button" className="press h-7 rounded-full px-3 hover:bg-ink-3" onClick={() => void storage.refresh()}>Try again</button>
        </div>
      )}
      {/* Fades from the ground so the chrome floats over the field. */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 z-10 h-20 bg-linear-to-b from-background to-transparent" />
      <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-24 bg-linear-to-t from-background to-transparent" />
      <DropOverlay />
      {openItem && (
        <ItemInspector
          item={openItem}
          onClose={close}
          position={index >= 0 ? { index, total: list.length } : undefined}
          onPrev={index > 0 ? () => setParams({ open: keyOf(list[index - 1]!) }) : undefined}
          onNext={index >= 0 && index < list.length - 1 ? () => setParams({ open: keyOf(list[index + 1]!) }) : undefined}
          prompt={site ? prompt : undefined}
        />
      )}
    </div>
  )
}
