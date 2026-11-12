import { memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { flushSync } from "react-dom"
import { Link, useLocation, useSearch } from "wouter"
import { toast } from "sonner"
import { useAddFlow } from "@/components/add-flow"
import { AgentBanner } from "@/components/agent-banner"
import { collectionCountLabel } from "@/components/collection-picker"
import { GlobeIcon, LayersIcon, MoreHorizontalIcon, StickyNoteIcon, Trash2Icon } from "@/components/icons"
import { notify } from "@/components/notify"
import { TopBar } from "@/components/top-bar"
import { at, autoPlace, bounds, centred, fitFrame, FRAME_PAD, frameAt, inRow, intersects, moveOnBoard, readingOrder, rowAt, type Box, type Placed } from "@/components/canvas/board-layout"
import { Zoom } from "@/components/canvas/canvas-home"
import { DropOverlay } from "@/components/canvas/drop-overlay"
import { FilterDock } from "@/components/canvas/filter-dock"
import { frameCountLabel, GroupFrame } from "@/components/canvas/group-frame"
import { InfiniteCanvas, type CanvasView, type InfiniteCanvasHandle } from "@/components/canvas/infinite-canvas"
import { ItemInspector } from "@/components/canvas/item-inspector"
import { isAdjust, LAYER_ADJ, layerLabel, LayerFrame, LayerLock, LayerMenu, layerShortcut, type AdjustId, type LayerActionId, type LayerTarget } from "@/components/canvas/layer-menu"
import { SelectionToolbar } from "@/components/canvas/selection-toolbar"
import { StickyNote } from "@/components/canvas/sticky-note"
import { CanvasTile, tileLabel } from "@/components/canvas/tiles"
import { filterOf, itemAspect, RELOAD_EVENT, type CanvasFilter, type CanvasItem } from "@/components/canvas/types"
import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Spinner } from "@/components/ui/spinner"
import { useDesktopState } from "@/hooks/use-desktop-state"
import { LIVE_POLL, usePoll } from "@/hooks/use-poll"
import { api, type BoardGroup, type BoardItem, type BoardItemKind, type BoardItemPlacement, type Collection, type LibraryTypeCounts, type SavedImage } from "@/lib/api"
import { useCollections } from "@/lib/collections"
import { cn } from "@/lib/utils"
import type { BoardItemStyle } from "../../../shared/types"

// ponytail: only the layer menu and the canvas handles are undoable (a 50-step history behind the toast's Undo).
// Everything else saves straight away; removing an item only takes it off the board.

/** A member (website, page, image) or note, where it sits and how it looks. `key` is `${kind}:${id}`. */
/** `z` is the stored stacking order; a board's nodes are kept sorted by it, bottom to top. */
type Node = Placed & { kind: BoardItemKind; id: string; z: number; item?: CanvasItem; text?: string; style: BoardItemStyle }
type Board = { collection: Collection; nodes: Node[]; groups: BoardGroup[] }

const FILTERS: CanvasFilter[] = ["all", "websites", "pages", "sections", "animations", "images"]
const DEFAULT_W: Record<BoardItemKind, number> = { reference: 232, page: 232, image: 232, note: 200 }
const NOTE_H = 0.8 // a note's height per unit of width
const NUDGE = 8
const BATCH = 200

const openKey = (it: CanvasItem) => `${it.kind}:${it.id}`
const chunks = <T,>(xs: T[]) => Array.from({ length: Math.ceil(xs.length / BATCH) }, (_, i) => xs.slice(i * BATCH, (i + 1) * BATCH))
const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
const dialogOpen = () => !!document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')
/** The z above every one of these. */
const above = (nodes: Node[]) => nodes.reduce((top, n) => Math.max(top, n.z), -1) + 1
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

function toItem(b: BoardItem): CanvasItem | undefined {
  if (b.kind === "reference" && b.reference) return { kind: "website", id: b.id, reference: b.reference }
  if (b.kind === "page" && b.page) return { kind: "page", id: b.id, page: b.page }
  if (b.kind === "image" && b.image) return { kind: "image", id: b.id, image: b.image }
}

function toNode(b: BoardItem, x: number, y: number): Node | undefined {
  const item = toItem(b)
  if (!item && b.kind !== "note") return
  const w = b.w ?? DEFAULT_W[b.kind]
  return { key: `${b.kind}:${b.id}`, kind: b.kind, id: b.id, item, text: b.text, x, y, z: b.z ?? 0, w, h: item ? w / itemAspect(item) : w * NOTE_H, groupId: b.groupId, style: b.style ?? {} }
}

const placement = (n: Node): BoardItemPlacement => ({
  kind: n.kind,
  id: n.id,
  x: Math.round(n.x),
  y: Math.round(n.y),
  z: n.z,
  w: n.w,
  groupId: n.groupId,
  style: Object.keys(n.style).length ? n.style : null,
})

// ---- The look (the layer menu): defaults are left out, so a plain item stores no style at all ----
const DEFAULTS: Required<BoardItemStyle> = { rot: 0, flip: false, op: 1, round: 6, blur: 0, crop: false, mask: false, outline: false, hidden: false, locked: false }
const restyle = (s: BoardItemStyle, patch: BoardItemStyle): BoardItemStyle => {
  const next: Record<string, unknown> = { ...s, ...patch }
  for (const k of Object.keys(next) as (keyof BoardItemStyle)[]) if (next[k] === DEFAULTS[k] || next[k] === undefined) delete next[k]
  return next
}
const FLAGS = { crop: "crop", flip: "flip", hide: "hidden", lock: "locked", mask: "mask", outline: "outline" } as const
const LOCKED = "Layer is locked"
const NO_TARGET: LayerTarget = { values: { resize: 100, rotate: 0, opacity: 100, round: 6, blur: 0 }, on: {}, locked: false }
const EASE = "cubic-bezier(.3,.7,.2,1)"
const FACE_MOTION = `border-radius .3s, clip-path .45s ${EASE}, filter .3s, transform .45s ${EASE}, scale .15s ease-out, opacity .15s, box-shadow .15s, rotate .2s ease-out`
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches
/** The tile face's (or note's) part of the look: corners, crop or mask, blur, flip. */
function faceStyle(s: BoardItemStyle): React.CSSProperties {
  return {
    borderRadius: s.round, // unset: the tile's rounded-md, the same 6px
    clipPath: s.mask ? "circle(42% at 50% 50%)" : s.crop ? `inset(12% 14% 12% 14% round ${s.round ?? DEFAULTS.round}px)` : undefined,
    filter: s.blur ? `blur(${s.blur}px)` : undefined,
    transform: s.flip ? "scaleX(-1)" : undefined,
    transition: reducedMotion() ? undefined : FACE_MOTION,
  }
}
/** The box a node covers once turned (rot). */
function turned(n: Node): Box {
  const a = ((n.style.rot ?? 0) * Math.PI) / 180
  if (!a) return n
  const [w, h] = [Math.abs(n.w * Math.cos(a)) + Math.abs(n.h * Math.sin(a)), Math.abs(n.w * Math.sin(a)) + Math.abs(n.h * Math.cos(a))]
  return { x: n.x + (n.w - w) / 2, y: n.y + (n.h - h) / 2, w, h }
}
/** What the layer menu shows for these nodes (the first is the one right-clicked). */
function targetOf(ns: Node[], groups: BoardGroup[]): LayerTarget {
  const [n] = ns
  const s = n!.style
  const all = (k: keyof BoardItemStyle) => ns.every((x) => x.style[k])
  const frame = ns.length === 1 ? groups.find((g) => g.id === n!.groupId) : undefined
  const left = ns.length > 1 ? Math.min(...ns.map((x) => x.x)) : frame ? frame.x + FRAME_PAD : null
  return {
    values: { resize: Math.round((n!.w / DEFAULT_W[n!.kind]) * 100), rotate: s.rot ?? 0, opacity: Math.round((s.op ?? 1) * 100), round: s.round ?? DEFAULTS.round, blur: s.blur ?? 0 },
    on: {
      crop: all("crop"), flip: all("flip"), hide: all("hidden"), lock: all("locked"), mask: all("mask"), outline: all("outline"),
      align: left !== null && ns.every((x) => Math.abs(x.x - left) < 0.5),
      group: !!n!.groupId && ns.every((x) => x.groupId === n!.groupId),
      auto: ns.length > 1 && at(ns, inRow(ns)),
    },
    locked: ns.some((x) => x.style.locked),
    notes: ns.some((x) => x.kind === "note") ? undefined : { dup: "Notes can be duplicated; saves appear once per board." },
  }
}

/** The file Export downloads: an image's original, a page's full screenshot, a website's cover, a note as text. */
function exportFile(n: Node): { href: string; name: string } | null {
  const slug = (s: string) => s.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "snip"
  const file = (key: string | null | undefined, name: string) => (key ? { href: `/files/${key}`, name: `${slug(name)}.${key.match(/\.(\w+)$/)?.[1] ?? "jpg"}` } : null)
  const it = n.item
  if (!it) return { href: URL.createObjectURL(new Blob([n.text ?? ""], { type: "text/plain" })), name: `${slug(n.text?.split("\n")[0]?.slice(0, 40) || "note")}.txt` }
  switch (it.kind) {
    case "image":
      return file(it.image.key, it.image.title || "image")
    case "page":
      return file(it.page.desktopKey ?? it.page.mobileKey, `${it.page.reference.domain}${it.page.path === "/" ? "" : it.page.path}`)
    case "section":
      return file(it.section.key, `${it.section.reference.domain}-${it.section.label}`)
    case "animation":
      return file(it.animation.gifKey, `${it.animation.reference.domain}-${it.animation.label ?? "recording"}`)
    case "website":
      return file(it.reference.coverKey ?? it.reference.previewKeys[0], it.reference.domain)
  }
}
const boardsOf = (it: CanvasItem) => (it.kind === "website" ? it.reference.collectionIds : it.kind === "page" ? it.page.collectionIds : it.kind === "image" ? it.image.collectionIds : [])
const haystack = (it: CanvasItem) =>
  `${tileLabel(it)} ${it.kind === "website" ? it.reference.url : it.kind === "page" ? it.page.url : ""}`.toLowerCase()

/** Put members on a board or take them off (notes are skipped: they belong to one board). */
async function setMembers(cid: string, nodes: Node[], on: boolean) {
  const ids = (k: BoardItemKind) => nodes.filter((n) => n.kind === k).map((n) => n.id)
  await Promise.all([
    ...ids("reference").map((r) => api.setMembership(r, cid, on)),
    ...chunks(ids("page")).map((c) => api.setPageMembership(cid, c, on)),
    ...chunks(ids("image")).map((c) => api.setImageMembership(cid, c, on)),
  ])
}

type Handlers = {
  open: (item: CanvasItem) => void
  noteEditing: (id: string, on: boolean) => void
  noteSave: (id: string, text: string) => void
  noteDelete: (id: string) => void
  titleDown: (e: React.PointerEvent, groupId: string) => void
  rename: (groupId: string, name: string | null) => void
  ungroup: (groupId: string) => void
  resize: (e: React.PointerEvent, key: string, corner: 0 | 1 | 2 | 3) => void
  rotate: (e: React.PointerEvent, key: string) => void
}

/**
 * One item on the board. The wrapper is the focus stop and the drag target, and turns (rot) and fades (op, hidden);
 * the tile or note inside fills it and carries the rest of the look. Selected: the blue frame, with handles when
 * it is the only one (and not locked, cropped or masked).
 */
const BoardNode = memo(function BoardNode({ node, selected, handles, dimmed, editing, h }: { node: Node; selected: boolean; handles: boolean; dimmed: boolean; editing: boolean; h: Handlers }) {
  const s = node.style
  const face = faceStyle(s)
  return (
    <div
      data-key={node.key}
      data-no-pan
      role="option"
      aria-selected={selected}
      aria-label={`${node.item ? tileLabel(node.item) : `Note: ${node.text?.slice(0, 80) || "empty"}`}${s.locked ? " (locked)" : ""}`}
      aria-keyshortcuts="Shift+F10"
      tabIndex={0}
      className="absolute rounded-md outline-none transition-[rotate,opacity] duration-[450ms,300ms] ease-[cubic-bezier(.3,.7,.2,1)] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-focus-ring in-data-dragging:transition-none motion-reduce:transition-none"
      style={{ left: node.x, top: node.y, width: node.w, height: node.h, rotate: s.rot ? `${s.rot}deg` : undefined, opacity: s.hidden ? 0.12 : s.op }}
    >
      {node.item ? (
        <CanvasTile item={node.item} onOpen={h.open} dimmed={dimmed} tabIndex={-1} faceStyle={face} />
      ) : (
        <StickyNote id={node.id} text={node.text ?? ""} selected={selected} editing={editing} onEditing={h.noteEditing} onSave={h.noteSave} onDelete={h.noteDelete} style={face} />
      )}
      {s.outline && <span aria-hidden className="pointer-events-none absolute inset-0" style={{ outline: "3px solid #111", outlineOffset: 3, borderRadius: s.round ?? DEFAULTS.round }} />}
      {selected && (
        <LayerFrame handles={handles && !s.locked && !s.crop && !s.mask} onResize={(e, corner) => h.resize(e, node.key, corner)} onRotate={(e) => h.rotate(e, node.key)} />
      )}
      {s.locked && <LayerLock />}
    </div>
  )
})

const pill = "flex h-10 items-center rounded-full bg-control/90 shadow-button backdrop-blur-md"
const iconButton = "press grid size-8 place-items-center rounded-full text-ink-11 hover:bg-ink-3 hover:text-foreground data-popup-open:bg-ink-3 [&_svg]:size-4"

/** Floating pill under the top bar: the board's name (click to rename), counts, Add note, Add website, more. */
function BoardHeader({ board, onRename, onAddNote, onAddWebsite, onDelete }: { board: Collection; onRename: (name: string) => void; onAddNote: () => void; onAddWebsite: () => void; onDelete: () => void }) {
  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  return (
    <div className={cn(pill, "absolute top-16 left-4 z-50 max-w-[calc(100%-2rem)] gap-2 py-1 pr-1 pl-1.5 sm:left-6")}>
      {editing ? (
        <input
          autoFocus
          defaultValue={board.name}
          aria-label="Board name"
          maxLength={120}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => {
            setEditing(false)
            const name = e.currentTarget.value.trim()
            if (name && name !== board.name) onRename(name)
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur()
            if (e.key === "Escape") {
              e.currentTarget.value = board.name
              e.currentTarget.blur()
            }
          }}
          className="well h-8 w-48 rounded-full px-3 text-xs outline-none"
        />
      ) : (
        <button type="button" onClick={() => setEditing(true)} aria-label={`${board.name}. Rename board`} className="press h-8 min-w-0 truncate rounded-full px-2.5 text-xs text-ink-12 hover:bg-ink-3">
          {board.name}
        </button>
      )}
      <span className="shrink-0 text-2xs whitespace-nowrap text-ink-10 max-sm:hidden">{collectionCountLabel(board)}</span>
      <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-ink-5" />
      <button type="button" onClick={onAddNote} aria-label="Add note" title="Add note" className={iconButton}>
        <StickyNoteIcon />
      </button>
      <button type="button" onClick={onAddWebsite} aria-label="Add website" title="Add website" className={iconButton}>
        <GlobeIcon />
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger aria-label="Board actions" className={iconButton}>
          <MoreHorizontalIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-44">
          <DropdownMenuItem variant="destructive" onClick={() => setDeleting(true)}>
            <Trash2Icon /> Delete board
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={deleting} onOpenChange={setDeleting}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete “{board.name}”?</DialogTitle>
            <DialogDescription>Its saves stay in All saves. Its notes and groups are deleted for good. This can't be undone.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button
              variant="destructive-confirm"
              onClick={() => {
                setDeleting(false)
                onDelete()
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/**
 * A board (/b/:id): its websites, pages, images and sticky notes on a free-form canvas. Drag to arrange (positions
 * save shortly after), Shift-drag to marquee-select, group into titled frames, filter to dim what doesn't match.
 */
export function BoardCanvas({ login, id }: { login: string; id: string }) {
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

  const [query, setQuery] = useDesktopState("snip:gallery:query", "")
  const q = useDeferredValue(query.trim().toLowerCase())
  const { collections, refresh } = useCollections()
  const { addReference } = useAddFlow()

  const [status, setStatus] = useState<"loading" | "missing" | "error" | "ready">("loading")
  const [board, setBoard] = useState<Board | null>(null)
  // The latest board for handlers; apply() keeps it current between renders so back-to-back changes compose.
  const live = useRef<Board | null>(null)
  const apply = (next: Board) => {
    live.current = next
    setBoard(next)
  }
  const [selected, setSelectedState] = useState<Set<string>>(() => new Set())
  const sel = useRef(selected)
  const setSelected = (next: Set<string>) => {
    sel.current = next
    setSelectedState(next)
  }
  const [editing, setEditing] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  // The layer menu: what it acts on (the right-clicked item first), where it opened, and its toast.
  type Menu = { open: boolean; at: { clientX: number; clientY: number }; session: number; keys: string[]; focus?: LayerActionId }
  const [menu, setMenu] = useState<Menu>({ open: false, at: { clientX: 0, clientY: 0 }, session: 0, keys: [] })
  const [said, setSaid] = useState<{ text: string; id: number; undo?: boolean } | null>(null)
  const say = (text: string, undo = true) => setSaid((t) => ({ text, id: (t?.id ?? 0) + 1, undo }))
  // Undo steps for the layer menu and the handles, newest last.
  const undos = useRef<(() => void | Promise<void>)[]>([])
  const remember = (undo: () => void | Promise<void>) => {
    undos.current.push(undo)
    if (undos.current.length > 50) undos.current.shift()
  }

  const canvas = useRef<InfiniteCanvasHandle>(null)
  const root = useRef<HTMLDivElement>(null)
  const marquee = useRef<HTMLDivElement>(null)
  const toolbar = useRef<HTMLDivElement>(null)
  const zoomSink = useRef<((zoom: number) => void) | null>(null)
  // Images dropped on the board, keyed `image:<id>`: where they go once the refetch brings them.
  const drops = useRef(new Map<string, { x: number; y: number }>())
  // The click that ends a drag or marquee must not open, toggle or clear anything.
  const swallow = useRef(false)
  const swallowClick = () => {
    swallow.current = true
    setTimeout(() => (swallow.current = false))
  }

  // ---- Saving: changed items and frames queue up and go out together ~400 ms after the last change ----
  // The queue only names what changed; what is saved is the board as it is when the save goes out.
  const pending = useRef({ items: new Set<string>(), groups: new Set<string>(), timer: 0 })
  // Settles when everything sent so far has been answered: a save waits for it, so changes reach the server in order,
  // and a load starts over when it changed meanwhile. Every request that changes the board goes through sent().
  const saving = useRef<Promise<unknown>>(Promise.resolve())
  const sent = <T,>(request: Promise<T>) => {
    saving.current = Promise.allSettled([saving.current, request])
    return request
  }
  const flush = useCallback(() => {
    clearTimeout(pending.current.timer)
    const before = saving.current
    return sent(
      (async () => {
        await before
        const p = pending.current
        const items = live.current?.nodes.filter((n) => p.items.has(n.key)).map(placement) ?? []
        const groups = live.current?.groups.filter((g) => p.groups.has(g.id)) ?? []
        p.items.clear()
        p.groups.clear()
        if (!items.length && !groups.length) return
        try {
          await Promise.all([
            ...chunks(items).map((c) => api.placeBoardItems(id, c)),
            ...groups.map((g) => api.updateBoardGroup(id, g.id, { x: Math.round(g.x), y: Math.round(g.y), w: Math.round(g.w), h: Math.round(g.h) })),
          ])
        } catch (e) {
          toast.error(`Couldn't save the layout. ${message(e)}`)
          window.dispatchEvent(new Event(RELOAD_EVENT)) // back to what's stored
        }
      })(),
    )
  }, [id])
  const queue = (nodes: Node[], frames: BoardGroup[] = []) => {
    const p = pending.current
    for (const n of nodes) p.items.add(n.key)
    for (const f of frames) p.groups.add(f.id)
    clearTimeout(p.timer)
    p.timer = window.setTimeout(() => void flush(), 400)
  }

  // ---- Loading: refetch on RELOAD_EVENT (captures, uploads, inspector changes); lay out newcomers once ----
  const latest = useRef(0)
  const load = useCallback(async () => {
    const n = ++latest.current
    let data
    let asked
    // A change sent after the board was asked for may be missing from the reply: ask again once it has been answered.
    do {
      asked = saving.current
      await asked
      try {
        data = await api.board(id)
      } catch (e) {
        if (n !== latest.current) return
        if (/not found/i.test(message(e))) setStatus("missing")
        else if (!live.current) setStatus("error")
        return
      }
      if (n !== latest.current) return
    } while (asked !== saving.current)
    // What is queued to save has not reached the server yet: there the board's own placement stands.
    const unsaved = new Map(live.current?.nodes.filter((x) => pending.current.items.has(x.key)).map((x) => [x.key, x]))
    const unsavedFrames = new Map(live.current?.groups.filter((g) => pending.current.groups.has(g.id)).map((g) => [g.id, g]))
    const placed: Node[] = []
    const fresh: Node[] = []
    for (const it of data.items) {
      const node = toNode(it, it.x ?? 0, it.y ?? 0)
      const own = node && unsaved.get(node.key)
      if (own) placed.push({ ...node, x: own.x, y: own.y, z: own.z, w: own.w, h: own.h, groupId: own.groupId, style: own.style })
      else if (node) (it.x === null || it.y === null ? fresh : placed).push(node)
    }
    const auto = fresh.filter((x) => !drops.current.has(x.key))
    autoPlace(placed, auto).forEach((p, i) => Object.assign(auto[i]!, p))
    for (const x of fresh) {
      const at = drops.current.get(x.key)
      if (at) Object.assign(x, at)
      drops.current.delete(x.key)
    }
    // The server sends items bottom to top; newcomers go on top. Sorting only moves what is queued to save.
    const top = above(placed)
    fresh.forEach((x, i) => (x.z = top + i))
    const nodes = [...placed, ...fresh].sort((a, b) => a.z - b.z)
    apply({ collection: data.collection, nodes, groups: data.groups.map((g) => unsavedFrames.get(g.id) ?? g) })
    const keys = new Set(nodes.map((x) => x.key))
    if ([...sel.current].some((k) => !keys.has(k))) setSelected(new Set([...sel.current].filter((k) => keys.has(k))))
    setStatus("ready")
    if (fresh.length) queue(fresh)
  }, [id])

  useEffect(() => {
    void load()
    const onReload = () => void load()
    window.addEventListener(RELOAD_EVENT, onReload)
    return () => {
      window.removeEventListener(RELOAD_EVENT, onReload)
      void flush()
    }
  }, [load, flush])

  const nodes = board?.nodes ?? []
  const groups = board?.groups ?? []
  // Websites still capturing (added from the header or pasted onto the board) refresh while they run: the capture
  // card that polls captures lives on the home canvas, not here. Steady while capturing, backing off while queued
  // or paused (a queued one may wait for a Mac that is off).
  const statuses = nodes.flatMap((x) => (x.item?.kind === "website" ? [x.item.reference.status] : []))
  const capturing = statuses.includes("capturing")
  usePoll(load, capturing || statuses.includes("queued") || statuses.includes("paused"), capturing ? LIVE_POLL : undefined)
  const collection = collections.find((c) => c.id === id) ?? board?.collection
  const title = collection?.name ?? "Board"
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

  // ---- Moving ----
  /** Move items and frames by dx, dy (world px), regroup, save. `front` brings the moved items to the top. */
  const commit = (keys: string[], frameIds: string[], dx: number, dy: number, front = true) => {
    const b = live.current
    if (!b) return
    const r = moveOnBoard(b.nodes, b.groups, new Set(keys), new Set(frameIds), dx, dy)
    const moved = new Set(r.movedItems.map((x) => x.key))
    const rest = r.items.filter((x) => !moved.has(x.key))
    // On top means a z above everything else; it is saved with the move.
    const raised = front ? r.movedItems.map((x, i) => ({ ...x, z: above(rest) + i })) : r.movedItems
    apply({ ...b, nodes: front ? [...rest, ...raised] : r.items, groups: r.frames })
    queue([...raised, ...r.leftBehind], r.movedFrames)
  }

  /** Follow a pointer that went down on items or a frame title; past a small threshold it drags them (or, with nothing it may move, calls `blocked`). */
  const beginDrag = (e: React.PointerEvent, all: string[], frameIds: string[], blocked?: () => void) => {
    const keys = unlocked(all) // locked items stay put
    const start = { x: e.clientX, y: e.clientY }
    const pointer = e.pointerId
    const zoom = canvas.current?.getView().zoom ?? 1
    const el = root.current!
    let moving: HTMLElement[] | null = null
    let d = { x: 0, y: 0 }
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointer) return
      const sx = ev.clientX - start.x
      const sy = ev.clientY - start.y
      if (!moving) {
        if (Math.hypot(sx, sy) < (ev.pointerType === "mouse" ? 3 : 6)) return
        if (!keys.length && !frameIds.length) blocked?.()
        const selectors = [...keys.map((k) => `[data-key="${CSS.escape(k)}"]`), ...frameIds.map((g) => `[data-frame="${CSS.escape(g)}"]`)]
        moving = selectors.length ? [...el.querySelectorAll<HTMLElement>(selectors.join(","))] : []
        for (const m of moving) if (m.dataset.key) m.style.zIndex = "1"
        el.dataset.dragging = ""
        window.getSelection()?.removeAllRanges()
      }
      // Transforms only while dragging, so nothing re-renders; state changes once, on release.
      d = { x: Math.round(sx / zoom), y: Math.round(sy / zoom) }
      for (const m of moving) m.style.translate = `${d.x}px ${d.y}px`
    }
    const end = (ev: PointerEvent) => {
      if (ev.pointerId !== pointer) return
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", end)
      window.removeEventListener("pointercancel", end)
      if (!moving) return
      swallowClick()
      // Commit first so the new left/top are in the DOM before the transforms come off: no flash back.
      // Bringing items to the front moves their DOM nodes, which drops focus; put it back.
      const focused = document.activeElement
      if (ev.type === "pointerup" && (d.x || d.y)) flushSync(() => commit(keys, frameIds, d.x, d.y))
      if (focused instanceof HTMLElement && focused !== document.activeElement && focused.isConnected) focused.focus({ preventScroll: true })
      for (const m of moving) {
        m.style.translate = ""
        m.style.zIndex = ""
      }
      delete el.dataset.dragging
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", end)
    window.addEventListener("pointercancel", end)
  }

  const onItemPointerDown = (e: React.PointerEvent) => {
    const t = e.target as Element
    if (!e.currentTarget.contains(t) || e.button !== 0 || t.closest("[data-no-drag]")) return
    const key = t.closest<HTMLElement>("[data-key]")?.dataset.key
    if (!key) return
    const modified = e.shiftKey || e.metaKey || e.ctrlKey
    // Pressing an unselected item selects it alone (modified clicks toggle on click instead).
    if (!sel.current.has(key) && !modified) setSelected(new Set([key]))
    beginDrag(e, sel.current.has(key) ? [...sel.current] : [key], [], () => say(LOCKED, false))
  }
  const unlocked = (keys: string[]) => {
    const locked = new Set(live.current?.nodes.filter((n) => n.style.locked).map((n) => n.key))
    return keys.filter((k) => !locked.has(k))
  }

  // ---- Marquee: Shift-drag on open canvas (or a frame's body) selects what it touches ----
  const onCanvasPointerDownCapture = (e: React.PointerEvent) => {
    const t = e.target as Element
    if (!e.shiftKey || e.button !== 0 || t.closest("[data-key], [data-no-pan]") || !live.current) return
    e.stopPropagation() // no pan
    const c = canvas.current!
    const box = root.current!.getBoundingClientRect()
    const start = { x: e.clientX, y: e.clientY }
    const from = c.screenToWorld(e.clientX, e.clientY)
    const base = sel.current
    const pointer = e.pointerId
    const m = marquee.current!
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointer) return
      Object.assign(m.style, {
        display: "block",
        left: `${Math.min(start.x, ev.clientX) - box.left}px`,
        top: `${Math.min(start.y, ev.clientY) - box.top}px`,
        width: `${Math.abs(ev.clientX - start.x)}px`,
        height: `${Math.abs(ev.clientY - start.y)}px`,
      })
      const to = c.screenToWorld(ev.clientX, ev.clientY)
      const rect = { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), w: Math.abs(to.x - from.x), h: Math.abs(to.y - from.y) }
      const next = new Set(base)
      for (const n of live.current!.nodes) if (intersects(n, rect)) next.add(n.key)
      if (next.size !== sel.current.size || [...next].some((k) => !sel.current.has(k))) setSelected(next)
    }
    const end = (ev: PointerEvent) => {
      if (ev.pointerId !== pointer) return
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", end)
      window.removeEventListener("pointercancel", end)
      m.style.display = "none"
      swallowClick()
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", end)
    window.addEventListener("pointercancel", end)
  }

  // ---- Selection actions ----
  const selectedNodes = nodes.filter((n) => selected.has(n.key))
  const members = selectedNodes.filter((n) => n.item)

  const removeNodes = async (keys: Set<string>) => {
    const b = live.current
    const gone = b?.nodes.filter((n) => keys.has(n.key) && !n.style.locked) ?? []
    if (b && !gone.length && b.nodes.some((n) => keys.has(n.key))) return say(LOCKED, false)
    if (!b || !gone.length) return
    const notes = gone.filter((n) => n.kind === "note")
    if (gone.length > 1 && !confirm(`Remove ${gone.length} items from this board?${notes.length ? " Notes are deleted." : ""} Everything else stays in All saves.`)) return
    const goneKeys = new Set(gone.map((n) => n.key))
    apply({ ...b, nodes: b.nodes.filter((n) => !goneKeys.has(n.key)) })
    setSelected(new Set([...sel.current].filter((k) => !goneKeys.has(k))))
    try {
      await sent(Promise.all([setMembers(id, gone, false), ...notes.map((n) => api.deleteBoardNote(id, n.id))]))
      void refresh().catch(() => {})
    } catch (e) {
      toast.error(message(e))
      void load()
    }
  }

  /** A frame around these items, saved; returns it. */
  const makeGroup = async (items: Node[], name: string, box: Box) => {
    const grouped = new Set(items.map((n) => n.key))
    await flush() // the server keeps stored positions; queued ones must land first
    const g = await sent(
      api.createBoardGroup(id, {
        name,
        x: Math.round(box.x),
        y: Math.round(box.y),
        w: Math.round(box.w),
        h: Math.round(box.h),
        items: items.map((n) => ({ kind: n.kind, id: n.id })),
      }),
    )
    const now = live.current!
    apply({ ...now, groups: [...now.groups, g], nodes: now.nodes.map((n) => (grouped.has(n.key) ? { ...n, groupId: g.id } : n)) })
    return g
  }
  const grouping = useRef(false) // one frame per press, however often G is hit while it is made
  const group = async () => {
    const b = live.current
    const items = b?.nodes.filter((n) => sel.current.has(n.key)) ?? []
    if (!b || !items.length || grouping.current) return
    if (items.some((n) => n.style.locked)) return say(LOCKED, false)
    grouping.current = true
    try {
      const g = await makeGroup(items, `Group ${b.groups.length + 1}`, fitFrame(items))
      setRenaming(g.id)
      return g
    } catch (e) {
      toast.error(message(e))
    } finally {
      grouping.current = false
    }
  }

  // ---- The layer menu and the canvas handles: each change is one undo step ----
  /** Undo for what is about to change: puts back every item's place, size, group and look, and every frame's box. */
  const snapshot = () => {
    const before = live.current!
    const prev = new Map(before.nodes.map((n) => [n.key, n]))
    const prevFrames = new Map(before.groups.map((g) => [g.id, g]))
    return () => {
      const b = live.current
      if (!b) return
      const gids = new Set(b.groups.map((g) => g.id))
      const nodes: Node[] = []
      const next = b.nodes.map((n) => {
        const p = prev.get(n.key)
        const groupId = p?.groupId && gids.has(p.groupId) ? p.groupId : null
        if (!p || (p.x === n.x && p.y === n.y && p.w === n.w && p.style === n.style && groupId === n.groupId)) return n
        const back = { ...n, x: p.x, y: p.y, w: p.w, h: p.h, style: p.style, groupId }
        nodes.push(back)
        return back
      })
      const frames: BoardGroup[] = []
      const groups = b.groups.map((g) => {
        const p = prevFrames.get(g.id)
        if (!p || (p.x === g.x && p.y === g.y && p.w === g.w && p.h === g.h)) return g
        const back = { ...g, x: p.x, y: p.y, w: p.w, h: p.h }
        frames.push(back)
        return back
      })
      apply({ ...b, nodes: next, groups })
      queue(nodes, frames)
    }
  }
  /** Change some items in place (look, size, position), regroup them like a drop would, save shortly after. */
  const change = (keys: string[], patch: (n: Node) => Partial<Node>) => {
    const b = live.current
    if (!b) return
    const ks = new Set(keys)
    apply({ ...b, nodes: b.nodes.map((n) => (ks.has(n.key) ? { ...n, ...patch(n) } : n)) })
    queue(nodesOf(keys)) // commit leaves out an item that was just locked
    commit(keys, [], 0, 0, false)
  }
  const setAmount = (keys: string[], aid: AdjustId, v: number) =>
    change(keys, (n) => {
      if (aid !== "resize") return { style: restyle(n.style, aid === "rotate" ? { rot: v } : aid === "opacity" ? { op: v / 100 } : aid === "round" ? { round: v } : { blur: v }) }
      const w = Math.round((DEFAULT_W[n.kind] * v) / 100)
      return { w, h: (n.h * w) / n.w }
    })

  const nodesOf = (keys: string[]) => keys.map((k) => live.current?.nodes.find((n) => n.key === k)).filter((n): n is Node => !!n)
  const closeMenu = () => setMenu((m) => (m.open ? { ...m, open: false } : m))
  /** Open the menu on an item: on the whole selection when the item is in it, else on the item, which becomes the selection. */
  const openMenu = (key: string, at: { clientX: number; clientY: number }, focus?: LayerActionId) => {
    const keys = sel.current.has(key) ? [key, ...[...sel.current].filter((k) => k !== key)] : [key]
    if (!sel.current.has(key)) setSelected(new Set([key]))
    setMenu((m) => ({ open: true, at, session: m.session + 1, keys, focus }))
  }
  /** The middle of an item on screen (where the keyboard opens the menu). */
  const middleOf = (key: string) => {
    const r = root.current?.querySelector(`[data-key="${CSS.escape(key)}"]`)?.getBoundingClientRect()
    return r ? { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 } : { clientX: innerWidth / 2, clientY: innerHeight / 2 }
  }

  /** An on/off or one-shot action from the menu (or its shortcut) on these items. */
  const runAction = async (aid: LayerActionId, keys: string[]) => {
    const b = live.current
    const targets = nodesOf(keys)
    if (!b || !targets.length) return
    if (aid !== "lock" && targets.some((n) => n.style.locked)) return say(LOCKED, false)
    if (isAdjust(aid)) return openMenu(keys[0]!, middleOf(keys[0]!), aid)
    closeMenu()
    const label = layerLabel(aid)
    if (aid in FLAGS) {
      const flag = FLAGS[aid as keyof typeof FLAGS]
      const on = !targets.every((n) => n.style[flag])
      const undo = snapshot()
      change(keys, (n) => ({ style: restyle(n.style, { [flag]: on }) }))
      remember(undo)
      return say(`${label} ${on ? "applied" : "removed"}`)
    }
    if (aid === "align" || aid === "auto") {
      let spots: { x: number; y: number }[]
      if (aid === "auto") {
        if (targets.length < 2) return say("Select two or more to lay them out in a row", false)
        spots = inRow(targets)
      } else {
        const frame = targets.length === 1 ? b.groups.find((g) => g.id === targets[0]!.groupId) : undefined
        if (targets.length < 2 && !frame) return say("Nothing to align to: select two or more, or put it in a group", false)
        const x = frame ? frame.x + FRAME_PAD : Math.min(...targets.map((n) => n.x))
        spots = targets.map((n) => ({ x, y: n.y }))
      }
      if (at(targets, spots)) return say(aid === "auto" ? "Already in an even row" : "Already lined up on the left", false)
      const to = new Map(targets.map((n, i) => [n.key, spots[i]!]))
      const undo = snapshot()
      change(keys, (n) => to.get(n.key)!)
      remember(undo)
      return say(`${label} applied`)
    }
    if (aid === "group") {
      const gid = targets[0]!.groupId
      const frame = b.groups.find((g) => g.id === gid)
      if (frame && targets.every((n) => n.groupId === gid)) {
        // Ungroup; undo frames the same items again.
        const members = b.nodes.filter((n) => n.groupId === gid)
        handlers.ungroup(frame.id)
        remember(() => makeGroup(members, frame.name, frame).then(() => {}))
        return say(`${label} removed`)
      }
      const undo = snapshot()
      const g = await group()
      if (!g) return
      remember(() => {
        handlers.ungroup(g.id)
        undo() // back into the frames they were in before
      })
      return say(`${label} applied`)
    }
    if (aid === "dup") {
      const notes = targets.filter((n) => n.kind === "note")
      if (!notes.length) return say("Notes can be duplicated; saves appear once per board.", false)
      try {
        const made = await Promise.all(
          notes.map(async (n) => {
            await flush() // the server puts a note above what it has stored; a queued order must land first
            const c = await sent(api.addBoardNote(id, { text: n.text ?? "", x: Math.round(n.x + 24), y: Math.round(n.y + 24), w: n.w, groupId: n.groupId }))
            return { ...toNode(c, c.x!, c.y!)!, style: n.style, h: n.h }
          }),
        )
        const now = live.current!
        apply({ ...now, nodes: [...now.nodes, ...made] })
        commit(made.map((n) => n.key), [], 0, 0, false) // saves the look, grows a frame to fit
        setSelected(new Set(made.map((n) => n.key)))
        remember(async () => {
          const gone = new Set(made.map((n) => n.key))
          const b2 = live.current!
          apply({ ...b2, nodes: b2.nodes.filter((n) => !gone.has(n.key)) })
          setSelected(new Set([...sel.current].filter((k) => !gone.has(k))))
          await sent(Promise.all(made.map((n) => api.deleteBoardNote(id, n.id))))
        })
        return say(notes.length < targets.length ? "Duplicated the notes; saves appear once per board" : `${label} applied`)
      } catch (e) {
        return toast.error(message(e))
      }
    }
    // Export: each item's best file, through the browser's download.
    const files = targets.map(exportFile).filter((f) => f !== null)
    if (!files.length) return say("Nothing to export yet", false)
    for (const f of files) {
      const a = document.createElement("a")
      a.href = f.href
      a.download = f.name
      a.click()
      if (f.href.startsWith("blob:")) setTimeout(() => URL.revokeObjectURL(f.href), 1000)
    }
    say(files.length === 1 ? `Saved ${files[0]!.name}` : `Saved ${files.length} files`, false)
  }

  // A ruler session: live changes save as they go (debounced); keeping it is one undo step, Esc puts it back.
  const ruler = useRef<{ from: number; undo: () => void } | null>(null)
  const onAdjust = (aid: AdjustId, v: number, phase: "start" | "change" | "end" | "cancel") => {
    if (phase === "start") {
      ruler.current = { from: v, undo: snapshot() }
      return
    }
    const r = ruler.current
    if (!r) return
    if (phase === "change") return setAmount(menu.keys, aid, v)
    ruler.current = null
    if (phase === "cancel") return r.undo()
    if (v === r.from) return
    remember(r.undo)
    say(`${layerLabel(aid)} · ${v}${LAYER_ADJ[aid].unit}`)
  }

  const undoLast = async () => {
    const step = undos.current.pop()
    try {
      await step?.()
    } catch (e) {
      toast.error(`Couldn't undo that. ${message(e)}`)
      void load()
    }
  }

  /** Drag a corner handle: resize keeping the aspect, the opposite corner staying put. */
  const startResize = (e: React.PointerEvent, key: string, corner: 0 | 1 | 2 | 3) => {
    e.preventDefault()
    e.stopPropagation()
    const n0 = nodesOf([key])[0]
    if (!n0) return
    if (n0.style.locked) return say(LOCKED, false)
    const zoom = canvas.current?.getView().zoom ?? 1
    const a = ((n0.style.rot ?? 0) * Math.PI) / 180
    const [x0, y0, left, top] = [e.clientX, e.clientY, corner === 0 || corner === 2, corner < 2]
    const [min, max] = [DEFAULT_W[n0.kind] * 0.25, DEFAULT_W[n0.kind] * 1.6]
    handleDrag(e, (ev) => {
      // Along the item's own x axis, so a turned item resizes the way its handles point.
      const d = ((ev.clientX - x0) * Math.cos(a) + (ev.clientY - y0) * Math.sin(a)) / zoom
      const w = Math.round(Math.max(min, Math.min(max, n0.w + (left ? -d : d))))
      const h = (n0.h * w) / n0.w
      change([key], () => ({ w, h, x: left ? n0.x + n0.w - w : n0.x, y: top ? n0.y + n0.h - h : n0.y }))
    }, () => {
      const n = nodesOf([key])[0]
      return n && n.w !== n0.w ? `Resized to ${Math.round((n.w / DEFAULT_W[n.kind]) * 100)}%` : null
    })
  }
  /** Drag the round handle above an item: rotate around its middle, Shift snaps to 15°. */
  const startRotate = (e: React.PointerEvent, key: string) => {
    e.preventDefault()
    e.stopPropagation()
    const n0 = nodesOf([key])[0]
    if (!n0) return
    if (n0.style.locked) return say(LOCKED, false)
    const r = (e.currentTarget as Element).closest("[data-key]")!.getBoundingClientRect()
    const [cx, cy] = [r.left + r.width / 2, r.top + r.height / 2]
    handleDrag(e, (ev) => {
      let deg = Math.round((Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180) / Math.PI + 90)
      if (ev.shiftKey) deg = Math.round(deg / 15) * 15
      deg = ((deg + 540) % 360) - 180
      change([key], (n) => ({ style: restyle(n.style, { rot: deg }) }))
    }, () => {
      const rot = nodesOf([key])[0]?.style.rot ?? 0
      return rot !== (n0.style.rot ?? 0) ? `${layerLabel("rotate")} · ${rot}°` : null
    })
  }
  /** Follow a handle drag; on release a change (done() says what it was) is one undo step. */
  const handleDrag = (e: React.PointerEvent, move: (ev: PointerEvent) => void, done: () => string | null) => {
    const undo = snapshot()
    const pointer = e.pointerId
    const el = root.current!
    el.dataset.dragging = ""
    closeMenu()
    const onMove = (ev: PointerEvent) => ev.pointerId === pointer && move(ev)
    const end = (ev: PointerEvent) => {
      if (ev.pointerId !== pointer) return
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", end)
      window.removeEventListener("pointercancel", end)
      delete el.dataset.dragging
      swallowClick()
      const text = done()
      if (!text) return
      remember(undo)
      say(text)
    }
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", end)
    window.addEventListener("pointercancel", end)
  }

  const makeBoard = async () => {
    const b = live.current
    const items = b?.nodes.filter((n) => sel.current.has(n.key)) ?? []
    if (!b || !items.some((n) => n.item)) return
    const name = `From ${b.collection.name}`
    const at = centred(items)
    const busy = toast.loading("Making a board…")
    try {
      const { id: cid } = await api.createCollection(name)
      const shared = items.filter((n) => n.item)
      await setMembers(cid, shared, true)
      await Promise.all([
        ...chunks(items.flatMap((n, i) => (n.item ? [{ ...placement(n), ...at[i]!, groupId: null }] : []))).map((c) => api.placeBoardItems(cid, c)),
        ...items.flatMap((n, i) => (n.kind === "note" ? [api.addBoardNote(cid, { text: n.text ?? "", ...at[i]!, z: n.z, w: n.w })] : [])),
      ])
      void refresh().catch(() => {})
      toast.dismiss(busy)
      notify(`Made “${name}”`, { action: { label: "Open", onClick: () => navigate(`/b/${cid}`) } })
    } catch (e) {
      toast.error(message(e), { id: busy })
    }
  }

  const toggleBoard = async (cid: string, on: boolean) => {
    await setMembers(cid, live.current?.nodes.filter((n) => n.item && sel.current.has(n.key)) ?? [], on)
    void refresh().catch(() => {})
    void load() // fresh board lists on each item; taken off this board, they leave the canvas
  }

  const addNote = async (at?: { x: number; y: number }) => {
    const v = canvas.current?.getView()
    const p = at ?? (v ? { x: v.x, y: v.y } : { x: 0, y: 0 })
    const w = DEFAULT_W.note
    const x = Math.round(p.x - w / 2)
    const y = Math.round(p.y - (w * NOTE_H) / 2)
    const frame = frameAt(live.current?.groups ?? [], p.x, p.y)
    try {
      await flush() // the server puts the note above what it has stored; a queued order must land first
      const it = await sent(api.addBoardNote(id, { text: "", x, y, groupId: frame?.id ?? null }))
      const node = toNode(it, x, y)!
      const b = live.current!
      apply({ ...b, nodes: [...b.nodes, node] })
      setSelected(new Set([node.key]))
      setEditing(node.id)
      if (frame) commit([node.key], [], 0, 0) // grow the frame to fit it
    } catch (e) {
      toast.error(message(e))
    }
  }

  const renameBoard = async (name: string) => {
    try {
      await sent(api.renameCollection(id, name))
      if (live.current) apply({ ...live.current, collection: { ...live.current.collection, name } })
      await refresh()
    } catch (e) {
      toast.error(message(e))
    }
  }

  const deleteBoard = async () => {
    try {
      const p = pending.current
      clearTimeout(p.timer)
      p.items.clear()
      p.groups.clear()
      await api.deleteCollection(id)
      await refresh().catch(() => {})
      notify(`Deleted board “${title}”`)
      navigate("/")
    } catch (e) {
      toast.error(message(e))
    }
  }

  // ---- Inspector: ?open=<kind>:<id>, pushed so Back closes it; prev/next walk the board in reading order ----
  const order = useMemo(() => readingOrder(nodes.filter((n) => n.item)), [nodes])
  const index = open ? order.findIndex((n) => openKey(n.item!) === open) : -1
  const openItem = index >= 0 ? order[index]!.item : undefined
  const pushed = useRef(false)
  const close = () => {
    if (pushed.current) {
      pushed.current = false
      history.back()
    } else setParams({ open: null })
  }

  // Stable callbacks for the memoised tiles, notes and frames; they call the latest closures.
  const act = useRef<Handlers>(null!)
  act.current = {
    open: (item) => {
      pushed.current = true
      setParams({ open: openKey(item) }, false)
    },
    noteEditing: (noteId, on) => {
      if (on && live.current?.nodes.some((n) => n.key === `note:${noteId}` && n.style.locked)) return say(LOCKED, false)
      setEditing((cur) => (on ? noteId : cur === noteId ? null : cur))
    },
    noteSave: (noteId, text) => {
      const b = live.current
      if (b) apply({ ...b, nodes: b.nodes.map((n) => (n.kind === "note" && n.id === noteId ? { ...n, text } : n)) })
      sent(api.updateBoardNote(id, noteId, text)).catch((e: unknown) => toast.error(`Couldn't save the note. ${message(e)}`))
    },
    noteDelete: (noteId) => void removeNodes(new Set([`note:${noteId}`])),
    titleDown: (e, gid) => {
      if (e.button !== 0 || (e.target as Element).closest("[data-no-drag]")) return
      beginDrag(e, live.current?.nodes.filter((n) => n.groupId === gid).map((n) => n.key) ?? [], [gid])
    },
    rename: (gid, name) => {
      setRenaming(null)
      const b = live.current
      if (!name || !b) return
      apply({ ...b, groups: b.groups.map((g) => (g.id === gid ? { ...g, name } : g)) })
      sent(api.updateBoardGroup(id, gid, { name })).catch((e: unknown) => {
        toast.error(message(e))
        void load()
      })
    },
    ungroup: (gid) => {
      const b = live.current
      if (!b) return
      apply({ ...b, groups: b.groups.filter((g) => g.id !== gid), nodes: b.nodes.map((n) => (n.groupId === gid ? { ...n, groupId: null } : n)) })
      sent(api.deleteBoardGroup(id, gid)).catch((e: unknown) => {
        toast.error(message(e))
        void load()
      })
    },
    resize: startResize,
    rotate: startRotate,
  }
  const handlers = useMemo<Handlers>(
    () => ({
      open: (item) => act.current.open(item),
      noteEditing: (noteId, on) => act.current.noteEditing(noteId, on),
      noteSave: (noteId, text) => act.current.noteSave(noteId, text),
      noteDelete: (noteId) => act.current.noteDelete(noteId),
      titleDown: (e, gid) => act.current.titleDown(e, gid),
      rename: (gid, name) => act.current.rename(gid, name),
      ungroup: (gid) => act.current.ungroup(gid),
      resize: (e, key, corner) => act.current.resize(e, key, corner),
      rotate: (e, key) => act.current.rotate(e, key),
    }),
    [],
  )

  // ---- Keyboard: on a focused item, arrows nudge and Enter opens; anywhere, ⌘A, Esc, Delete, G ----
  const onItemKeyDown = (e: React.KeyboardEvent) => {
    const t = e.target as Element
    if (!e.currentTarget.contains(t) || typing(t)) return
    const key = t.closest<HTMLElement>("[data-key]")?.dataset.key
    const node = key ? live.current?.nodes.find((n) => n.key === key) : undefined
    if (!node) return
    const step = e.shiftKey ? NUDGE * 10 : NUDGE
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }
    if (arrows[e.key] && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const moving = sel.current.has(node.key) ? [...sel.current] : [node.key]
      if (!sel.current.has(node.key)) setSelected(new Set(moving))
      // Stacking stays put: re-ordering would move the focused node and lose focus. Locked items stay put.
      if (unlocked(moving).length) commit(moving, [], ...arrows[e.key]!, false)
      else say(LOCKED, false)
    } else if (e.key === "Enter" || e.key === " ") {
      if (node.item) handlers.open(node.item)
      else handlers.noteEditing(node.id, true)
    } else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) openMenu(node.key, middleOf(node.key))
    else return
    e.preventDefault()
  }
  const shortcuts = useRef({ removeNodes, group, runAction })
  shortcuts.current = { removeNodes, group, runAction }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const b = live.current
      if (!b || typing(e.target) || dialogOpen()) return
      // The layer menu's shortcuts act on the selection (the focused item first).
      const layer = sel.current.size ? layerShortcut(e) : null
      const mod = e.metaKey || e.ctrlKey
      if (layer) {
        const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-key]")?.dataset.key
        const keys = focused && sel.current.has(focused) ? [focused, ...[...sel.current].filter((k) => k !== focused)] : [...sel.current]
        void shortcuts.current.runAction(layer, keys)
      } else if (e.altKey) return
      else if (mod && e.key.toLowerCase() === "a") setSelected(new Set(b.nodes.map((n) => n.key)))
      else if (mod) return
      else if (e.key === "Escape" && sel.current.size) setSelected(new Set())
      else if ((e.key === "Delete" || e.key === "Backspace") && sel.current.size) void shortcuts.current.removeNodes(sel.current)
      else if (e.key.toLowerCase() === "g" && sel.current.size) void shortcuts.current.group()
      else return
      e.preventDefault()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  // ---- Selection toolbar: screen space, placed over the selection's top edge as the view moves ----
  const selBox = useRef<Box | null>(null)
  const placeToolbar = useCallback((v: CanvasView) => {
    const el = toolbar.current
    const b = selBox.current
    if (!el || !b) return
    // Over the selection's top edge (and a lone item's rotate handle), kept on screen and below the board header.
    const half = el.offsetWidth / 2 + 12
    const x = Math.min(Math.max((b.x + b.w / 2 - v.x) * v.zoom + v.width / 2, half), v.width - half)
    const y = Math.max((b.y - v.y) * v.zoom + v.height / 2 - (sel.current.size === 1 ? 58 : 14), 160)
    el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, -100%)`
  }, [])
  const showToolbar = selected.size > 0 && !editing && !renaming && !openItem && !menu.open
  useLayoutEffect(() => {
    selBox.current = bounds(selectedNodes.map(turned))
    const v = canvas.current?.getView()
    if (v) placeToolbar(v)
  })
  const onViewChange = useCallback(
    (v: CanvasView) => {
      zoomSink.current?.(v.zoom)
      root.current?.style.setProperty("--lmn-k", String(1 / v.zoom)) // keeps the selection handles screen-sized
      placeToolbar(v)
    },
    [placeToolbar],
  )

  const onDropped = useCallback((images: SavedImage[], at: { clientX: number; clientY: number }) => {
    const p = canvas.current?.screenToWorld(at.clientX, at.clientY)
    if (!p) return
    const sizes = images.map((image) => ({ w: DEFAULT_W.image, h: DEFAULT_W.image / itemAspect({ kind: "image", id: image.id, image }) }))
    rowAt(p, sizes).forEach((spot, i) => drops.current.set(`image:${images[i]!.id}`, spot))
  }, [])

  // ---- Derived view state ----
  const dims = useMemo(() => {
    if (filter === "all" && !q) return null
    return new Set(nodes.filter((n) => n.item && ((filter !== "all" && filterOf[n.item.kind] !== filter) || (q && !haystack(n.item).includes(q)))).map((n) => n.key))
  }, [nodes, filter, q])
  // Boards hold websites, pages and images; sections and animations are 0 because nothing here would match them.
  const counts = useMemo<LibraryTypeCounts>(() => {
    const c = { websites: 0, pages: 0, sections: 0, animations: 0, images: 0 }
    for (const n of nodes) if (n.item) c[filterOf[n.item.kind] as "websites" | "pages" | "images"]++
    return c
  }, [nodes])
  const frameCounts = useMemo(() => new Map(groups.map((g) => [g.id, frameCountLabel(nodes.filter((n) => n.groupId === g.id).map((n) => n.kind))])), [groups, nodes])
  const home = useMemo(() => {
    const b = bounds([...nodes, ...groups])
    if (!b) return { x: 0, y: 0, zoom: 1 }
    const zoom = Math.max(0.25, Math.min(1, (window.innerWidth - 160) / b.w, (window.innerHeight - 280) / b.h))
    return { x: b.x + b.w / 2, y: b.y + b.h / 2, zoom }
  }, [nodes, groups])
  const empty = status === "ready" && nodes.length === 0
  const menuNodes = menu.keys.map((k) => nodes.find((n) => n.key === k)).filter((n): n is Node => !!n)
  const menuTarget = menuNodes.length ? targetOf(menuNodes, groups) : null

  const emptyState = (
    <div data-no-pan className="absolute top-0 left-0 flex w-[340px] -translate-x-1/2 -translate-y-1/2 cursor-default flex-col items-center gap-3 text-center">
      <span className="grid size-11 place-items-center rounded-full bg-ink-3">
        <LayersIcon className="size-5 text-ink-11" />
      </span>
      <div className="grid gap-1">
        <p className="text-base text-ink-12">This board is empty</p>
        <p className="text-xs text-pretty text-ink-11">
          Drop images here, paste a link, or add saves from{" "}
          <Link href="/" className="underline decoration-ink-7 underline-offset-2 hover:text-foreground">
            All saves
          </Link>
          .
        </p>
      </div>
      <div className="flex gap-2 pt-1">
        <button type="button" onClick={() => void addNote({ x: 0, y: 140 })} className="tactile press flex h-8 items-center gap-1.5 rounded-full px-3 text-xs [&_svg]:size-3.5">
          <StickyNoteIcon /> Add note
        </button>
        <button type="button" onClick={() => addReference(id)} className="press flex h-8 items-center gap-1.5 rounded-full bg-primary px-3 text-xs text-primary-foreground shadow-primary hover:bg-(--primary-hover) [&_svg]:size-3.5">
          <GlobeIcon /> Add website
        </button>
      </div>
    </div>
  )

  return (
    <div
      ref={root}
      className="relative h-svh overflow-clip overscroll-none bg-background"
      onClickCapture={(e) => {
        if (!swallow.current) return
        swallow.current = false
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      <TopBar floating login={login} query={query} onQuery={setQuery} boardId={id} />
      <div className="pointer-events-none absolute inset-x-0 top-16 z-50 flex justify-center">
        <div className="pointer-events-auto w-full max-w-xl">
          <AgentBanner />
        </div>
      </div>
      {status === "ready" && collection && (
        <BoardHeader board={collection} onRename={(n) => void renameBoard(n)} onAddNote={() => void addNote()} onAddWebsite={() => addReference(id)} onDelete={() => void deleteBoard()} />
      )}
      {status === "ready" && !empty && (
        <>
          <FilterDock className="absolute bottom-6 left-1/2 z-50 -translate-x-1/2" value={filter} onChange={(f) => setParams({ filter: f === "all" ? null : f, open: null })} counts={counts} boardId={id} />
          <Zoom canvas={canvas} sink={zoomSink} />
        </>
      )}
      {showToolbar && (
        <SelectionToolbar
          ref={toolbar}
          className="absolute top-0 left-0 z-50 in-data-dragging:invisible"
          count={selected.size}
          canShare={members.length > 0}
          inBoards={members.length ? members.map((n) => boardsOf(n.item!)).reduce((a, s) => a.filter((x) => s.includes(x))) : []}
          onToggleBoard={toggleBoard}
          onGroup={() => void group()}
          onMakeBoard={() => void makeBoard()}
          onRemove={() => void removeNodes(sel.current)}
        />
      )}

      {status === "ready" ? (
        <div
          className="absolute inset-0"
          onPointerDownCapture={onCanvasPointerDownCapture}
          onClick={(e) => {
            const t = e.target as Element
            if (!t.closest("[data-key], [data-no-pan]") && sel.current.size) setSelected(new Set())
          }}
          onDoubleClick={(e) => {
            const t = e.target as Element
            if (t.closest("[data-key], [data-no-pan]")) return
            void addNote(canvas.current?.screenToWorld(e.clientX, e.clientY))
          }}
        >
          <InfiniteCanvas
            ref={canvas}
            home={home}
            className="absolute inset-0"
            aria-label={`${title}. Drag or use the arrow keys to move, plus and minus to zoom, 0 to recenter. Shift-drag to select, double-click to add a note.`}
            onViewChange={onViewChange}
          >
            {(rect) => (
              <>
                {groups
                  .filter((g) => intersects(g, rect))
                  .map((g) => (
                    <GroupFrame
                      key={g.id}
                      group={g}
                      count={frameCounts.get(g.id)!}
                      autoRename={renaming === g.id}
                      onTitlePointerDown={handlers.titleDown}
                      onRename={handlers.rename}
                      onUngroup={handlers.ungroup}
                    />
                  ))}
                <div
                  role="listbox"
                  aria-label={`${title} items`}
                  aria-multiselectable
                  className="contents"
                  onPointerDown={onItemPointerDown}
                  onKeyDown={onItemKeyDown}
                  onContextMenu={(e) => {
                    const t = e.target as Element
                    const key = t.closest<HTMLElement>("[data-key]")?.dataset.key
                    if (!key || !e.currentTarget.contains(t) || typing(t)) return
                    e.preventDefault()
                    // A keyboard-made contextmenu can come without a point: use the item's middle.
                    openMenu(key, e.clientX || e.clientY ? { clientX: e.clientX, clientY: e.clientY } : middleOf(key))
                  }}
                  onClickCapture={(e) => {
                    // Shift/⌘-click toggles the selection without opening.
                    const key = (e.target as Element).closest<HTMLElement>("[data-key]")?.dataset.key
                    if (!key || !(e.shiftKey || e.metaKey || e.ctrlKey)) return
                    e.preventDefault()
                    e.stopPropagation()
                    const next = new Set(sel.current)
                    if (!next.delete(key)) next.add(key)
                    setSelected(next)
                  }}
                >
                  {nodes
                    .filter((n) => intersects(n, rect))
                    .map((n) => (
                      <BoardNode
                        key={n.key}
                        node={n}
                        selected={selected.has(n.key)}
                        handles={selected.size === 1}
                        dimmed={!!dims?.has(n.key)}
                        editing={n.kind === "note" && editing === n.id}
                        h={handlers}
                      />
                    ))}
                </div>
                {empty && emptyState}
              </>
            )}
          </InfiniteCanvas>
        </div>
      ) : (
        <div className="grid h-full place-items-center px-4 text-center">
          {status === "loading" ? (
            <Spinner className="size-5 text-muted-foreground" />
          ) : (
            <div className="grid justify-items-center gap-3" role="alert">
              <p className="text-sm text-ink-12">{status === "missing" ? "This board doesn't exist" : "Couldn't load this board"}</p>
              <p className="text-xs text-ink-11">{status === "missing" ? "It may have been deleted." : "Check your connection and try again."}</p>
              {status === "missing" ? (
                <Link href="/" className="tactile press flex h-8 items-center rounded-full px-3.5 text-xs">
                  Go to All saves
                </Link>
              ) : (
                <button type="button" onClick={() => void load()} className="tactile press h-8 rounded-full px-3.5 text-xs">
                  Try again
                </button>
              )}
            </div>
          )}
        </div>
      )}
      <div ref={marquee} aria-hidden className="pointer-events-none absolute z-40 hidden rounded-sm border border-ink-10 bg-ink-12/5" />
      {/* Fades from the ground so the chrome floats over the board. */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 z-10 h-[120px] bg-linear-to-b from-background to-transparent" />
      <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-[140px] bg-linear-to-t from-background to-transparent" />
      <DropOverlay boardId={id} onDropped={onDropped} />
      {status === "ready" && (
        <LayerMenu
          open={menu.open && !!menuTarget}
          at={menu.at}
          session={menu.session}
          focus={menu.focus}
          target={menuTarget ?? NO_TARGET}
          toast={said}
          onAction={(aid) => void runAction(aid, menu.keys)}
          onAdjust={onAdjust}
          onUndo={() => void undoLast()}
          onClose={closeMenu}
        />
      )}
      {openItem && (
        <ItemInspector
          item={openItem}
          onClose={close}
          position={{ index, total: order.length }}
          onPrev={index > 0 ? () => setParams({ open: openKey(order[index - 1]!.item!) }) : undefined}
          onNext={index < order.length - 1 ? () => setParams({ open: openKey(order[index + 1]!.item!) }) : undefined}
        />
      )}
    </div>
  )
}
