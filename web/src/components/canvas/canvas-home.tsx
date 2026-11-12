import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type RefObject } from "react"
import { useLocation, useSearch } from "wouter"
import { AgentBanner } from "@/components/agent-banner"
import { TopBar } from "@/components/top-bar"
import { CaptureCard } from "@/components/canvas/capture-card"
import { DropOverlay } from "@/components/canvas/drop-overlay"
import { countOf, FilterDock } from "@/components/canvas/filter-dock"
import { GAP, layoutHome, PLAZA, visibleTiles, type HomeLayout, type Placement } from "@/components/canvas/home-layout"
import { InfiniteCanvas, type CanvasView, type InfiniteCanvasHandle, type WorldRect } from "@/components/canvas/infinite-canvas"
import { ItemInspector } from "@/components/canvas/item-inspector"
import { HomeTile } from "@/components/canvas/tiles"
import { itemAspect, RELOAD_EVENT, reloadCanvas, type CanvasFilter, type CanvasItem } from "@/components/canvas/types"
import { ZoomControls } from "@/components/canvas/zoom-controls"
import { Skeleton } from "@/components/ui/skeleton"
import { useDesktopState } from "@/hooks/use-desktop-state"
import { api, type Filters, type LibraryTypeCounts, type Paged } from "@/lib/api"
import { useCollections } from "@/lib/collections"

const FILTERS: CanvasFilter[] = ["all", "websites", "pages", "sections", "animations", "images"]
const keyOf = (it: CanvasItem) => `${it.kind}:${it.id}`

// ponytail: each feed loads up to CAP items up front and is laid out once. Loading more as the user pans would
// reshuffle the repeating block under them; add it with a layout that appends instead of re-flowing.
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

/** The current feed; items is null until the first load for this filter, search and board. Refetches on RELOAD_EVENT. */
function useFeed(filter: CanvasFilter, q: string, boardId?: string) {
  const key = `${filter}|${q}|${boardId ?? ""}`
  const [state, setState] = useState<{ key: string; items: CanvasItem[] | null; error?: string }>()
  useEffect(() => {
    let latest = 0
    const load = () => {
      const n = ++latest
      FEEDS[filter]({ q: q || undefined, collection: boardId }).then(
        (items) => n === latest && setState({ key, items }),
        (e: Error) => n === latest && setState((s) => ({ key, items: s?.key === key ? s.items : null, error: e.message })),
      )
    }
    load()
    window.addEventListener(RELOAD_EVENT, load)
    return () => {
      latest = -1
      window.removeEventListener(RELOAD_EVENT, load)
    }
  }, [filter, q, boardId, key])
  return state?.key === key ? state : { items: null, error: undefined }
}

/** Counts for the dock: undefined while the first request is out, null if it failed. */
function useCounts(q: string, boardId?: string) {
  const [counts, setCounts] = useState<LibraryTypeCounts | null>()
  useEffect(() => {
    let alive = true
    const load = () =>
      api.counts({ q: q || undefined, collection: boardId }).then(
        (c) => alive && setCounts(c),
        () => alive && setCounts((c) => c ?? null),
      )
    void load()
    window.addEventListener(RELOAD_EVENT, load)
    return () => {
      alive = false
      window.removeEventListener(RELOAD_EVENT, load)
    }
  }, [q, boardId])
  return counts
}

const at = (t: Pick<Placement, "x" | "y" | "w" | "h">) => ({ left: t.x, top: t.y, width: t.w, height: t.h })

/**
 * The tiles in (and near) view. Re-renders only when the visible rect or the items change, and reuses the element of
 * every tile that stays in view: a new rect then costs React the tiles that came into view, not all of them.
 */
const Field = memo(function Field({ layout, items, rect, onOpen }: { layout: HomeLayout; items: CanvasItem[]; rect: WorldRect; onOpen?: (item: CanvasItem) => void }) {
  const cache = useMemo(() => ({ elements: new Map<string, ReactElement>() }), [layout, items, onOpen])
  const kept = new Map<string, ReactElement>()
  const tiles = visibleTiles(layout, rect).map((t) => {
    let el = cache.elements.get(t.key)
    if (!el) {
      // Repeated copies of the block are not tabbable or announced (see HomeTile).
      const copy = t.key.includes("@") && !t.key.endsWith("@0,0")
      el = <HomeTile key={t.key} item={items[t.index]!} x={t.x} y={t.y} w={t.w} h={t.h} copy={copy} onOpen={onOpen} />
    }
    kept.set(t.key, el)
    return el
  })
  cache.elements = kept
  return tiles
})

// Slots around the plaza: skeletons while loading, dashed placeholders when there's nothing to show yet.
const GHOST_ITEMS = [1.6, 0.8, 1.3, 1, 1.6, 0.75, 1.45, 1.6, 1.1, 0.9, 1.6, 1.25, 1.6, 0.8].map((aspect, i) => ({ key: `ghost${i}`, aspect }))
const Ghosts = memo(function Ghosts({ loading, plazaH }: { loading: boolean; plazaH: number }) {
  // Laid out around the same measured plaza as the field, so they never cover the capture card.
  const ghosts = useMemo(() => layoutHome(GHOST_ITEMS, { w: PLAZA.w, h: plazaH }).tiles, [plazaH])
  return ghosts.map((t) =>
    loading ? (
      <Skeleton key={t.key} className="pointer-events-none absolute rounded-md motion-reduce:animate-none" style={at(t)} />
    ) : (
      <div key={t.key} aria-hidden className="pointer-events-none absolute rounded-md border border-dashed border-ink-6" style={at(t)} />
    ),
  )
})

/** Zoom pill with its own state, so zooming re-renders only the pill. */
export function Zoom({ canvas, sink }: { canvas: RefObject<InfiniteCanvasHandle | null>; sink: RefObject<((zoom: number) => void) | null> }) {
  const [zoom, setZoom] = useState(() => canvas.current?.getView().zoom ?? 1)
  useEffect(() => {
    sink.current = setZoom
    return () => {
      sink.current = null
    }
  }, [sink])
  return (
    <ZoomControls
      className="absolute right-6 bottom-6 z-50 max-sm:hidden"
      zoom={zoom}
      onZoom={(f) => canvas.current?.zoomBy(f, undefined, { animate: true })}
      onReset={() => canvas.current?.setZoom(1, undefined, { animate: true })}
      onRecenter={() => canvas.current?.recenter({ animate: true })}
    />
  )
}

/** Home (All saves) and, until the board canvas lands, a board's material: an infinite canvas around the capture card. */
export function CanvasHome({ login, boardId }: { login: string; boardId?: string }) {
  const search = useSearch()
  const [location, navigate] = useLocation()
  const params = new URLSearchParams(search)
  const raw = params.get("filter") as CanvasFilter | null
  const filter: CanvasFilter = raw && FILTERS.includes(raw) ? raw : "all"
  const open = params.get("open")

  const setParams = (patch: Record<string, string | null>, replace = true) => {
    const next = new URLSearchParams(search)
    for (const [k, v] of Object.entries(patch)) (v === null ? next.delete(k) : next.set(k, v))
    const qs = next.toString()
    navigate(`${location}${qs ? `?${qs}` : ""}`, { replace })
  }
  const setParamsRef = useRef(setParams)
  setParamsRef.current = setParams

  const [query, setQuery] = useDesktopState("snip:gallery:query", "")
  const [q, setQ] = useState(query.trim())
  useEffect(() => {
    const t = setTimeout(() => setQ(query.trim()), 250)
    return () => clearTimeout(t)
  }, [query])

  const { collections } = useCollections()
  const board = boardId ? collections.find((c) => c.id === boardId) : undefined
  const title = boardId ? (board?.name ?? "Board") : "All saves"
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

  const counts = useCounts(q, boardId)
  const total = counts ? countOf(counts, "all") : null
  const firstRun = !q && !boardId && !!counts && counts.websites + total! === 0
  // The dock and zoom wait for the counts, so a first run doesn't flash them.
  const chrome = counts !== undefined && !firstRun
  const { items, error } = useFeed(filter, q, boardId)
  // The plaza hugs the capture card: its measured height, in 40-px steps so small text changes don't relayout the field.
  const [plazaH, setPlazaH] = useState(PLAZA.h)
  const measurePlaza = useCallback((el: HTMLDivElement | null) => {
    if (!el) return
    const ro = new ResizeObserver(() => setPlazaH(Math.max(PLAZA.h, Math.ceil((el.offsetHeight + 2 * GAP) / 40) * 40)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const layout = useMemo(
    () => layoutHome((items ?? []).map((it) => ({ key: keyOf(it), aspect: itemAspect(it) })), { w: PLAZA.w, h: plazaH }),
    [items, plazaH],
  )

  const canvas = useRef<InfiniteCanvasHandle>(null)
  // A new filter or search lays the field out again around the plaza: bring the plaza back.
  useEffect(() => canvas.current?.recenter({ animate: true }), [filter, q])
  const zoomSink = useRef<((zoom: number) => void) | null>(null)
  const onViewChange = useCallback((v: CanvasView) => zoomSink.current?.(v.zoom), [])

  // Inspector: ?open=<kind>:<id>, pushed so Back closes it; prev/next replace it.
  const pushed = useRef(false)
  const onOpen = useCallback((item: CanvasItem) => {
    pushed.current = true
    setParamsRef.current({ open: keyOf(item) }, false)
  }, [])
  const list = items ?? []
  // Each feed stops at CAP items. Say so, or a big library looks like it lost its older saves.
  const inFilter = counts && !boardId ? countOf(counts, filter) : 0
  const caption =
    firstRun || q || !total ? undefined
    : list.length >= CAP && list.length < inFilter ? `Showing the newest ${list.length} of ${inFilter}. Search to find older saves.`
    : `${total} saved`
  const index = open ? list.findIndex((it) => keyOf(it) === open) : -1
  const openItem = index >= 0 && list[index]!.kind !== "website" ? list[index] : undefined
  const close = () => {
    if (pushed.current) {
      pushed.current = false
      history.back()
    } else setParams({ open: null })
  }
  // The open item left the list (deleted from the inspector, or filtered away): close, so ?open= and the
  // history entry don't outlive it.
  const closeRef = useRef(close)
  closeRef.current = close
  useEffect(() => {
    if (open && items && !openItem) closeRef.current()
  }, [open, items, openItem])

  const plaza = useMemo(
    () => (
      <div ref={measurePlaza} className="absolute top-0 left-0 flex w-max -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-4">
        <CaptureCard boardId={boardId} firstRun={firstRun} caption={caption} />
        {error ? (
          <p className="flex items-center gap-2 text-xs text-ink-11" role="alert">
            Couldn't load your saves.
            <button type="button" onClick={reloadCanvas} className="tactile press h-7 rounded-full px-3 text-xs">
              Try again
            </button>
          </p>
        ) : items?.length === 0 && q ? (
          <div className="flex flex-col items-center gap-1 text-center" role="status">
            <p className="text-sm text-foreground">No matches for “{q}”</p>
            <p className="text-xs text-ink-11">
              Try a different word, or{" "}
              <button type="button" onClick={() => setQuery("")} className="underline decoration-ink-7 underline-offset-2 hover:text-foreground">
                clear the search
              </button>
              .
            </p>
          </div>
        ) : null}
      </div>
    ),
    [boardId, firstRun, q, caption, error, items, setQuery, measurePlaza],
  )
  const ghosts = useMemo(() => (!items || (items.length === 0 && !q) ? <Ghosts loading={!items && !error} plazaH={plazaH} /> : null), [items, q, error, plazaH])
  const tileOpen = filter === "websites" ? undefined : onOpen
  const renderWorld = useCallback(
    // The plaza comes first so the capture card is the first stop when tabbing into the canvas.
    (rect: WorldRect) => (
      <>
        {plaza}
        {items && <Field layout={layout} items={items} rect={rect} onOpen={tileOpen} />}
        {ghosts}
      </>
    ),
    [items, layout, tileOpen, ghosts, plaza],
  )

  return (
    // overflow-clip, not hidden: a hidden box still scrolls to reveal a focused tile, which would shift the whole page.
    <div className="relative h-svh overflow-clip overscroll-none bg-background">
      {/* Chrome first in the DOM so Tab reaches it before hundreds of tiles; z-50 keeps it over the drop scrim (z-40). */}
      <TopBar floating login={login} query={query} onQuery={setQuery} boardId={boardId} />
      <div className="pointer-events-none absolute inset-x-0 top-16 z-50 flex justify-center">
        <div className="pointer-events-auto w-full max-w-xl">
          <AgentBanner />
        </div>
      </div>
      {chrome && (
        <>
          <FilterDock
            className="absolute bottom-6 left-1/2 z-50 -translate-x-1/2"
            value={filter}
            onChange={(f) => setParams({ filter: f === "all" ? null : f, open: null })}
            counts={counts}
            boardId={boardId}
          />
          <Zoom canvas={canvas} sink={zoomSink} />
        </>
      )}

      <InfiniteCanvas
        ref={canvas}
        className="absolute inset-0"
        aria-label={`${title}. Drag or use the arrow keys to move, plus and minus to zoom, 0 to recenter.`}
        onViewChange={onViewChange}
      >
        {renderWorld}
      </InfiniteCanvas>
      {/* Fades from the ground so the chrome floats over the field. */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 z-10 h-20 bg-linear-to-b from-background to-transparent" />
      <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-24 bg-linear-to-t from-background to-transparent" />
      <DropOverlay boardId={boardId} />
      {openItem && (
        <ItemInspector
          item={openItem}
          onClose={close}
          position={{ index, total: list.length }}
          onPrev={index > 0 ? () => setParams({ open: keyOf(list[index - 1]!) }) : undefined}
          onNext={index < list.length - 1 ? () => setParams({ open: keyOf(list[index + 1]!) }) : undefined}
        />
      )}
    </div>
  )
}
