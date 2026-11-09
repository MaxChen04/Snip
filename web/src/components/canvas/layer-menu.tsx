/**
 * LayerMenu: the board's dark right-click menu for the items it acts on, with a live preview card for each action.
 * Basics / Pro tabs on a sliding pill, rows below (icon, name, shortcut). Hover or ↑ ↓ moves a soft highlight; the
 * preview card rides beside the highlighted row and plays a small blue loop of that action on a dotted grid.
 *  · Resize, Rotate, Opacity, Round corners, Blur open a ruler under the row: drag it (or wheel), tap a preset,
 *    ← → nudge (Shift = 10), Enter keeps, Esc puts it back. The board applies the value live (onAdjust).
 *  · Everything else is one onAction call; the board applies it, closes the menu and says so in the toast.
 *  · Whatever is in effect gets a blue ✓ (or its value, like 25°). ← → switch tabs when no ruler is open.
 * Driven by props: the board owns the items, the history and the toast text. Under 640px the preview card is left
 * out. The CSS is scoped under .lmn (kit-shield first, so Tailwind's preflight doesn't leak in); the colours are
 * fixed, dark in light and dark mode alike. LayerFrame and LayerLock are the canvas side: the blue selection frame
 * with its handles, and the lock badge (their CSS ships with the menu, which the board always mounts).
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent } from "react"
import { createPortal } from "react-dom"
import {
  AlignLeftIcon,
  AutoLayoutIcon,
  BlurIcon,
  CheckIcon,
  CopyIcon,
  CropIcon,
  FlipIcon,
  GroupIcon,
  HideIcon,
  InfoIcon,
  LockIcon,
  MaskIcon,
  OpacityIcon,
  OutlineIcon,
  ResizeIcon,
  RotateIcon,
  RoundCornersIcon,
  UploadIcon,
  type Icon,
} from "@/components/icons"

// ---------------------------------------------------------------- the actions
export type AdjustId = "resize" | "rotate" | "opacity" | "round" | "blur"
export type LayerActionId = AdjustId | "crop" | "flip" | "dup" | "align" | "group" | "hide" | "lock" | "mask" | "outline" | "auto" | "export"
type Row = { id: LayerActionId; label: string; description: string; icon: Icon; shortcut?: string }

export const LAYER_TABS: { label: string; items: Row[] }[] = [
  { label: "Basics", items: [
    { id: "resize", label: "Resize", shortcut: "K", icon: ResizeIcon, description: "Scale it from 25% to 160%, or drag a corner." },
    { id: "crop", label: "Crop", shortcut: "C", icon: CropIcon, description: "Trim the edges and keep only the part you want." },
    { id: "rotate", label: "Rotate", shortcut: "⇧R", icon: RotateIcon, description: "Pick any angle: drag the ruler, tap a preset or use the handle above the layer." },
    { id: "flip", label: "Flip", shortcut: "⇧H", icon: FlipIcon, description: "Mirror the layer left to right." },
    { id: "dup", label: "Duplicate", shortcut: "⌘D", icon: CopyIcon, description: "Place an exact copy right next to it." },
    { id: "align", label: "Align left", shortcut: "⌥A", icon: AlignLeftIcon, description: "Line up the left edges of the selection, or with its group's edge." },
    { id: "opacity", label: "Opacity", shortcut: "5", icon: OpacityIcon, description: "Fade it anywhere from 0 to 100%." },
    { id: "round", label: "Round corners", icon: RoundCornersIcon, description: "Set the corner radius, 0 to 40px." },
    { id: "group", label: "Group", shortcut: "⌘G", icon: GroupIcon, description: "Bundle layers so they move as one." },
    { id: "hide", label: "Hide", shortcut: "⇧⌘H", icon: HideIcon, description: "Fade it almost out of sight; it stays on the board." },
    { id: "lock", label: "Lock", shortcut: "⇧⌘L", icon: LockIcon, description: "Freeze it so nothing moves it by accident." },
  ] },
  { label: "Pro", items: [
    { id: "mask", label: "Mask", shortcut: "⌘M", icon: MaskIcon, description: "Show the layer only inside a shape." },
    { id: "blur", label: "Blur", icon: BlurIcon, description: "Soften it like a lens out of focus, 0 to 20px." },
    { id: "outline", label: "Outline", icon: OutlineIcon, description: "Draw a clean stroke around the edge." },
    { id: "auto", label: "Auto layout", shortcut: "⇧A", icon: AutoLayoutIcon, description: "Space the selection evenly and keep it in a row." },
    { id: "export", label: "Export", shortcut: "⇧⌘E", icon: UploadIcon, description: "Download the original file." },
  ] },
]
const ROWS = LAYER_TABS.flatMap((t, tab) => t.items.map((it, i) => ({ ...it, tab, i })))
export const layerLabel = (id: LayerActionId) => ROWS.find((r) => r.id === id)!.label

/** The actions you set an amount for (a ruler opens under the row), in the ruler's units. */
export const LAYER_ADJ: Record<AdjustId, { min: number; max: number; unit: string; def: number; presets: number[] }> = {
  rotate: { min: -180, max: 180, unit: "°", def: 0, presets: [-90, -45, 0, 45, 90] },
  resize: { min: 25, max: 160, unit: "%", def: 100, presets: [50, 75, 100, 125, 150] },
  opacity: { min: 0, max: 100, unit: "%", def: 100, presets: [0, 25, 50, 75, 100] },
  round: { min: 0, max: 40, unit: "px", def: 6, presets: [0, 6, 12, 24, 40] },
  blur: { min: 0, max: 20, unit: "px", def: 0, presets: [0, 2, 4, 8, 16] },
}
export const isAdjust = (id: LayerActionId): id is AdjustId => id in LAYER_ADJ
/** Rows that switch on and off (a menuitemcheckbox with the ✓). */
const TOGGLES = new Set<LayerActionId>(["crop", "flip", "align", "group", "hide", "lock", "mask", "outline", "auto"])

/** The action a key press is the shortcut for, if any ("⇧⌘L" is Shift+⌘/Ctrl+L; letters and digits by position). */
export function layerShortcut(e: KeyboardEvent): LayerActionId | null {
  for (const r of ROWS) {
    if (!r.shortcut) continue
    const key = r.shortcut.slice(-1)
    const code = /\d/.test(key) ? `Digit${key}` : `Key${key}`
    if (e.code === code && e.shiftKey === r.shortcut.includes("⇧") && (e.metaKey || e.ctrlKey) === r.shortcut.includes("⌘") && e.altKey === r.shortcut.includes("⌥")) return r.id
  }
  return null
}

/** What the menu acts on, as it is now. */
export type LayerTarget = {
  /** Ruler values in the ruler's units: resize %, rotate °, opacity %, round px, blur px. */
  values: Record<AdjustId, number>
  /** On/off rows in effect (the ✓). Amount rows are "in effect" when off their default. */
  on: Partial<Record<LayerActionId, boolean>>
  /** Refuses everything but Lock (the board says so). */
  locked: boolean
  /** Replace a row's line on the preview card. */
  notes?: Partial<Record<LayerActionId, string>>
}

// preview scenes, drawn in the accent colour (A) and its tint (F); u = this menu's id prefix
const box = (A: string, F: string, extra = "") => `<rect x="48" y="15" width="40" height="32" rx="1" fill="${F}" stroke="${A}" stroke-width="1.5" ${extra}/>`
const SCENES: Record<LayerActionId, (A: string, F: string, u: string) => string> = {
  resize: (A, F) => `<rect x="48" y="17" width="30" height="24" rx="1" fill="none" stroke="#4a4a50" stroke-dasharray="3 2"/><rect class="k-rs" x="48" y="17" width="30" height="24" rx="1" fill="${F}" stroke="${A}" stroke-width="1.5"/><rect class="k-rsh" x="75" y="38" width="6" height="6" rx="1" fill="#fff" stroke="${A}"/>`,
  crop: (A, F) => `<rect x="44" y="13" width="48" height="36" fill="${F}" stroke="#3a3a3f"/><rect class="k-crop" x="44" y="13" width="48" height="36" fill="none" stroke="${A}" stroke-width="1.6" stroke-dasharray="4 2"/>`,
  rotate: (A, F) => `<g class="a k-rot">${box(A, F)}<circle cx="68" cy="11" r="2.5" fill="#fff" stroke="${A}"/></g>`,
  flip: (A, F) => `<path d="M68 6v50" stroke="#55555b" stroke-dasharray="2 2"/><g class="a k-flip"><path d="M50 46 L66 16 L66 46Z" fill="${F}" stroke="${A}" stroke-width="1.5" stroke-linejoin="round"/></g>`,
  dup: (A, F) => `<g transform="translate(-6,-4)">${box(A, F)}</g><g class="a k-dup"><g transform="translate(-6,-4)">${box(A, F)}</g></g>`,
  align: (A, F) => `<path d="M34 6v50" stroke="${A}" stroke-width="1.5"/><rect class="k-al" style="--o:30px" x="36" y="12" width="56" height="10" rx="2" fill="${F}" stroke="${A}" stroke-width="1.3"/><rect class="k-al" style="--o:12px;animation-delay:.08s" x="36" y="26" width="36" height="10" rx="2" fill="${F}" stroke="${A}" stroke-width="1.3"/><rect class="k-al" style="--o:44px;animation-delay:.16s" x="36" y="40" width="46" height="10" rx="2" fill="${F}" stroke="${A}" stroke-width="1.3"/>`,
  opacity: (A) => `<rect x="48" y="15" width="40" height="32" rx="1" fill="none" stroke="${A}" stroke-width="1.5"/><rect class="k-op" x="49" y="16" width="38" height="30" fill="${A}"/>`,
  round: (A, F) => `<rect class="k-rnd" x="48" y="13" width="40" height="36" rx="1" fill="${F}" stroke="${A}" stroke-width="1.5"/>`,
  group: (A, F) => `<rect class="k-grpb" x="40" y="9" width="56" height="44" rx="3" fill="none" stroke="${A}" stroke-width="1.4" stroke-dasharray="3 2"/><rect class="k-grp" style="--gx:-10px;--gy:-5px" x="45" y="14" width="20" height="16" rx="2" fill="${F}" stroke="${A}" stroke-width="1.4"/><rect class="k-grp" style="--gx:10px;--gy:5px" x="71" y="32" width="20" height="16" rx="2" fill="${F}" stroke="${A}" stroke-width="1.4"/>`,
  hide: (A, F) => `<g class="k-hide">${box(A, F)}</g>`,
  lock: (A, F) => `${box(A, F)}<g transform="translate(60,20)"><rect x="2" y="10" width="14" height="11" rx="2.5" fill="${A}"/><path class="k-shk" d="M5 10V7a4 4 0 0 1 8 0v3" fill="none" stroke="${A}" stroke-width="2"/></g>`,
  mask: (A, _F, u) => `<rect x="44" y="11" width="48" height="40" fill="none" stroke="#4a4a50" stroke-dasharray="3 2"/><clipPath id="${u}mc"><circle class="k-mask" cx="68" cy="31" r="4"/></clipPath><g clip-path="url(#${u}mc)"><rect x="44" y="11" width="48" height="40" fill="${A}"/><path d="M44 42 58 30 68 38 80 26 92 36V51H44z" fill="#9fd0ff"/></g><circle class="k-mask" cx="68" cy="31" r="4" fill="none" stroke="${A}" stroke-width="1.4"/>`,
  blur: (A) => `<g class="k-blur"><rect x="48" y="15" width="40" height="32" rx="2" fill="${A}"/><circle cx="60" cy="27" r="5" fill="#bfe1ff"/></g>`,
  outline: (A, F) => `<rect class="k-ol" x="50" y="17" width="36" height="28" rx="2" fill="${F}" stroke="#fff" stroke-width="0"/><rect x="50" y="17" width="36" height="28" rx="2" fill="none" stroke="${A}" stroke-width="1.3"/>`,
  auto: (A, F) => `<rect x="28" y="16" width="80" height="30" rx="4" fill="none" stroke="#4a4a50" stroke-dasharray="3 2"/><rect class="k-gap" style="--g:-6px" x="34" y="21" width="18" height="20" rx="2" fill="${F}" stroke="${A}" stroke-width="1.3"/><rect x="59" y="21" width="18" height="20" rx="2" fill="${F}" stroke="${A}" stroke-width="1.3"/><rect class="k-gap" style="--g:6px" x="84" y="21" width="18" height="20" rx="2" fill="${F}" stroke="${A}" stroke-width="1.3"/>`,
  export: (A, F) => `${box(A, F, 'y="21" height="28"')}<g class="k-exp"><path d="M68 34V10" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/><path d="m62 15 6-6 6 6" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></g>`,
}

const TICK = 6, ADJ_H = 112, ROW = 37
const ACCENT = "#2d9cff"
const TINT = "rgba(45,156,255,0.28)" // the accent at .28
const VARS = {
  "--lmn-panel": "#232325", "--lmn-well": "#1a1a1b", "--lmn-tab": "#2f2f32", "--lmn-row": "#2f2f32", "--lmn-ink": "#ececef", "--lmn-text": "#d9d9dd",
  "--lmn-mute": "#9b9ba1", "--lmn-icon": "#a8a8ae", "--lmn-accent": ACCENT, "--lmn-toast": "#111111", "--lmn-speed": "2.2s",
  "--lmn-font": '"Inter Variable", Inter, system-ui, -apple-system, sans-serif',
} as CSSProperties
const LOCKED = "Layer is locked"

// ---------------------------------------------------------------- component
export function LayerMenu({
  open,
  at,
  session,
  focus,
  target,
  toast,
  onAction,
  onAdjust,
  onUndo,
  onClose,
}: {
  open: boolean
  /** Where it was opened (the click point); the menu is clamped to the viewport. */
  at: { clientX: number; clientY: number }
  /** Changes every time the menu is opened, so an open ruler from the last time is put away. */
  session: number
  /** Open on this row (and its ruler): the keyboard shortcut that opened the menu. */
  focus?: LayerActionId
  target: LayerTarget
  /** The black toast; a new id shows it again. undo: false leaves out the Undo button. */
  toast: { text: string; id: number; undo?: boolean } | null
  /** An on/off or one-shot row was picked (also a ruler row on a locked target, for the board to refuse). */
  onAction: (id: LayerActionId) => void
  /** A ruler: opened ("start"), moved, kept ("end") or put back ("cancel", value = where it started). */
  onAdjust: (id: AdjustId, value: number, phase: "start" | "change" | "end" | "cancel") => void
  onUndo: () => void
  onClose: () => void
}) {
  const uid = "lmn" + useId().replace(/[^a-zA-Z0-9]/g, "")
  const menuRef = useRef<HTMLDivElement>(null), listRef = useRef<HTMLDivElement>(null), hlRef = useRef<HTMLSpanElement>(null)
  const peekRef = useRef<HTMLDivElement>(null), thumbRef = useRef<HTMLSpanElement>(null)
  const [W, setW] = useState(() => window.innerWidth)
  const narrow = W < 640
  const [tab, setTab] = useState(0)
  const [cur, setCur] = useState(0)
  const [adj, setAdj] = useState<{ i: number; id: AdjustId; open: boolean } | null>(null)
  const adjRef = useRef(adj)
  adjRef.current = adj
  // The ruler's value while one is open (shown at once; the board catches up through onAdjust), and where it started.
  const [val, setVal] = useState(0)
  const valRef = useRef(0)
  const snap = useRef<number | null>(null)
  const [tapeDrag, setTapeDrag] = useState(false)
  const [shown, setShown] = useState(false)
  const items = LAYER_TABS[tab]!.items
  const props = useRef({ onAdjust, onClose, target })
  props.current = { onAdjust, onClose, target }

  useEffect(() => {
    const resize = () => setW(window.innerWidth)
    window.addEventListener("resize", resize)
    return () => window.removeEventListener("resize", resize)
  }, [])

  // ---------------- the ruler
  /** Put the ruler away; a moved value is kept (one Undo step on the board) unless revert puts it back. */
  const closeAdj = (revert = false) => {
    const a = adjRef.current, from = snap.current
    snap.current = null
    if (from === null || !a) return
    props.current.onAdjust(a.id, revert ? from : valRef.current, revert ? "cancel" : "end")
    setAdj({ ...a, open: false })
    setTimeout(() => setAdj((b) => (b && !b.open && b.i === a.i ? null : b)), 280)
  }
  const setValue = (id: AdjustId, v: number) => {
    const A = LAYER_ADJ[id]
    v = Math.max(A.min, Math.min(A.max, Math.round(v)))
    if (snap.current === null || v === valRef.current) return
    valRef.current = v
    setVal(v)
    props.current.onAdjust(id, v, "change")
  }
  const openAdj = (i: number, id: AdjustId) => {
    closeAdj()
    const v = props.current.target.values[id]
    snap.current = valRef.current = v
    setVal(v)
    setAdj({ i, id, open: false })
    // Two frames, so it mounts closed and then slides open; not if it was put away meanwhile.
    requestAnimationFrame(() => requestAnimationFrame(() => setAdj((a) => (a && a.i === i && snap.current !== null ? { ...a, open: true } : a))))
    props.current.onAdjust(id, v, "start")
  }

  const closeMenu = () => {
    closeAdj()
    props.current.onClose()
  }
  const pickTab = (t: number) => {
    if (t === tab) return
    closeAdj()
    setAdj(null)
    setTab(t)
    setCur(0)
    if (listRef.current) listRef.current.scrollTop = 0
  }
  const focusRow = (i: number) => {
    const n = (i + items.length) % items.length
    if (adj && adj.i !== n) closeAdj()
    setCur(n)
  }
  const apply = (i: number, t = tab) => {
    const it = LAYER_TABS[t]!.items[i]
    if (!it) return
    setCur(i)
    if (isAdjust(it.id) && !target.locked) {
      if (adj && adj.i === i && adj.open) return closeAdj()
      return openAdj(i, it.id)
    }
    onAction(it.id)
  }

  // ---------------- opening and closing: focus in, focus back, the ruler from last time put away
  const back = useRef<HTMLElement | null>(null)
  const jump = useRef(false)
  useLayoutEffect(() => {
    if (!open) return
    closeAdj()
    setShown(false)
    const row = focus && ROWS.find((r) => r.id === focus)
    if (row) {
      setTab(row.tab)
      setCur(row.i)
      if (isAdjust(row.id) && !props.current.target.locked) openAdj(row.i, row.id)
    }
    // A fresh open lands at the click point; only a menu already open slides there.
    const menu = menuRef.current!
    if (!back.current) {
      menu.style.transitionProperty = "opacity, transform"
      void menu.offsetWidth // style the new spot now, without the slide
      menu.style.transitionProperty = ""
      jump.current = true // and the preview card's
      back.current = document.activeElement instanceof HTMLElement ? document.activeElement : document.body
    }
    menu.focus({ preventScroll: true })
  }, [open, session])
  useEffect(() => {
    if (open) return
    closeAdj()
    const el = back.current
    back.current = null
    const a = document.activeElement
    if (el?.isConnected && (!a || a === document.body || menuRef.current?.contains(a))) el.focus({ preventScroll: true })
  }, [open])

  // ---------------- the toast: shows for 3.2s per message
  useEffect(() => {
    if (!toast) return
    setShown(true)
    const t = setTimeout(() => setShown(false), 3200)
    return () => clearTimeout(t)
  }, [toast])

  // ---------------- layout: highlight, scroll, preview card, scroll indicator (measured after each render)
  const listH = Math.min(items.length * ROW + (adj ? ADJ_H : 0), 8.2 * ROW)
  useLayoutEffect(() => {
    const list = listRef.current, hl = hlRef.current
    if (!list || !hl) return
    const row = list.querySelector<HTMLElement>(`[data-i="${cur}"]`)
    if (!row) return
    hl.style.transform = `translateY(${row.offsetTop}px)`
    const below = adj && adj.i === cur ? ADJ_H : 0
    if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop
    else if (row.offsetTop + ROW + below > list.scrollTop + listH) list.scrollTop = row.offsetTop + ROW + below - listH
    const sync = () => {
      const th = thumbRef.current
      if (!th) return
      const h = listH, sh = list.scrollHeight
      th.style.display = sh > h + 1 ? "block" : "none"
      const t = Math.max(24, (h * h) / sh)
      th.style.height = t + "px"
      th.style.top = (list.scrollTop / (sh - h || 1)) * (h - t) + "px"
      const peek = peekRef.current, menu = menuRef.current
      if (peek && menu) {
        const m = menu.getBoundingClientRect(), r = row.getBoundingClientRect(), ph = peek.offsetHeight
        let y = r.top + r.height / 2 - 30
        y = Math.max(m.top, Math.min(y, m.bottom - ph))
        peek.style.left = (m.left - 146 >= 0 ? m.left - 146 : m.right + 10) + "px"
        if (jump.current) peek.style.transitionProperty = "opacity"
        peek.style.transform = `translateY(${y}px)`
        if (jump.current) {
          void peek.offsetWidth
          peek.style.transitionProperty = ""
          jump.current = false
        }
      }
    }
    sync()
    const t = setTimeout(sync, 300)
    list.onscroll = sync
    return () => clearTimeout(t)
  })

  // ---------------- keys, a press outside, the canvas moving under it
  useEffect(() => {
    if (!open) return
    const inside = (t: EventTarget | null) => t instanceof Element && !!t.closest(".lmn-menu, .lmn-peek, .lmn-toast")
    const key = (e: KeyboardEvent) => {
      const a = adjRef.current
      const accel = layerShortcut(e)
      if (accel) {
        e.preventDefault()
        const r = ROWS.find((x) => x.id === accel)!
        if (r.tab !== tab) pickTab(r.tab)
        apply(r.i, r.tab)
      } else if (e.key === "ArrowDown") {
        e.preventDefault()
        focusRow(cur + 1)
      } else if (e.key === "ArrowUp") {
        e.preventDefault()
        focusRow(cur - 1)
      } else if (a && a.open && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
        e.preventDefault()
        setValue(a.id, valRef.current + (e.key === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 10 : 1))
      } else if (a && a.open && (e.key === "Enter" || e.key === "Escape")) {
        e.preventDefault()
        closeAdj(e.key === "Escape")
      } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault()
        pickTab(Math.max(0, Math.min(LAYER_TABS.length - 1, tab + (e.key === "ArrowRight" ? 1 : -1))))
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault()
        apply(cur)
      } else if (e.key === "Escape" || e.key === "Tab") {
        e.preventDefault()
        closeMenu()
      }
    }
    // A press outside closes it, and the click it makes does nothing else (it doesn't open what's under it).
    const down = (e: PointerEvent) => {
      if (inside(e.target) || e.button === 2) return // a right-click reopens it where it lands
      closeMenu()
      const swallow = (ev: MouseEvent) => {
        ev.preventDefault()
        ev.stopPropagation()
      }
      window.addEventListener("click", swallow, { capture: true, once: true })
      window.addEventListener("pointerup", () => setTimeout(() => window.removeEventListener("click", swallow, true)), { once: true })
    }
    const menu = (e: MouseEvent) => !e.defaultPrevented && !inside(e.target) && closeMenu()
    const wheel = (e: WheelEvent) => !inside(e.target) && closeMenu()
    window.addEventListener("keydown", key)
    window.addEventListener("pointerdown", down, true)
    window.addEventListener("contextmenu", menu)
    window.addEventListener("wheel", wheel, { passive: true })
    window.addEventListener("resize", closeMenu)
    return () => {
      window.removeEventListener("keydown", key)
      window.removeEventListener("pointerdown", down, true)
      window.removeEventListener("contextmenu", menu)
      window.removeEventListener("wheel", wheel)
      window.removeEventListener("resize", closeMenu)
    }
  })

  const startTape = (e: RPointerEvent<HTMLDivElement>, id: AdjustId) => {
    e.preventDefault()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    setTapeDrag(true)
    const x0 = e.clientX, v0 = valRef.current
    el.onpointermove = (ev) => setValue(id, v0 - Math.round((ev.clientX - x0) / TICK))
    el.onpointerup = el.onpointercancel = () => {
      el.onpointermove = null
      setTapeDrag(false)
    }
  }

  // ---------------- geometry: at the click point, kept on screen
  const menuW = narrow ? Math.min(284, W - 32) : 284
  const menuX = Math.max(8, Math.min(at.clientX + 4, W - menuW - 8))
  const menuY = Math.max(8, Math.min(at.clientY - 20, window.innerHeight - 380))
  const it = items[cur]
  const valueOf = (id: AdjustId) => (adj?.id === id && snap.current !== null ? val : target.values[id])
  const isOn = (id: LayerActionId) => (isAdjust(id) ? valueOf(id) !== LAYER_ADJ[id].def : !!target.on[id])
  const scene = it ? SCENES[it.id](ACCENT, TINT, uid) : ""
  const grid = `<defs><pattern id="${uid}g" width="10" height="10" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r=".7" fill="#4a4a50"/></pattern></defs><rect width="136" height="62" fill="url(#${uid}g)"/>`
  const activeId = adj?.open ? `${uid}-ruler` : it && `${uid}-${it.id}`

  return createPortal(
    <div className="lmn" style={VARS} data-no-pan>
      <style>{CSS}</style>
      {!narrow && it && (
        <div ref={peekRef} className={`lmn-peek${open ? "" : " shut"}`} aria-hidden>
          <h6>
            <InfoIcon size={11} strokeWidth={1.8} />
            {it.label}
          </h6>
          <div className="lmn-pv">
            <svg key={tab + "-" + cur} viewBox="0 0 136 62" className="lmn-fade" dangerouslySetInnerHTML={{ __html: grid + scene }} />
          </div>
          <p>{target.notes?.[it.id] ?? it.description}</p>
        </div>
      )}

      <div
        ref={menuRef}
        className={`lmn-menu${open ? "" : " shut"}`}
        style={{ left: menuX, top: menuY, width: menuW }}
        role={open ? "menu" : undefined}
        aria-label="Layer"
        aria-activedescendant={open ? activeId : undefined}
        aria-hidden={!open}
        inert={!open}
        tabIndex={-1}
      >
        <div className="lmn-tabs">
          <span className="lmn-pill" style={{ width: `calc(${100 / LAYER_TABS.length}% - ${6 / LAYER_TABS.length}px)`, transform: `translateX(${tab * 100}%)` }} />
          {LAYER_TABS.map((t, i) => (
            <button key={t.label} type="button" tabIndex={-1} role="menuitemradio" aria-checked={i === tab} className={i === tab ? "on" : ""} onClick={() => pickTab(i)}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="lmn-listwrap" style={{ height: listH }}>
          <div className="lmn-list" ref={listRef}>
            <span className="lmn-hl" ref={hlRef} />
            {items.map((x, i) => {
              const A = isAdjust(x.id) ? LAYER_ADJ[x.id] : null
              const on = isOn(x.id)
              const Glyph = x.icon
              return [
                <div
                  key={x.id}
                  id={`${uid}-${x.id}`}
                  data-i={i}
                  role={TOGGLES.has(x.id) ? "menuitemcheckbox" : "menuitem"}
                  aria-checked={TOGGLES.has(x.id) ? on : undefined}
                  aria-keyshortcuts={x.shortcut?.replace("⇧", "Shift+").replace("⌘", "Meta+").replace("⌥", "Alt+")}
                  className={`lmn-item${i === cur ? " on" : ""}${on ? (A ? " valued" : " applied") : ""}`}
                  // Moves only: a row sliding under a still pointer (the list scrolling to a ruler) doesn't take the highlight.
                  onMouseMove={(e) => i !== cur && (e.movementX || e.movementY) && focusRow(i)}
                  onClick={() => apply(i)}
                >
                  <Glyph size={18} strokeWidth={1.8} />
                  <span>{x.label}</span>
                  <kbd>{x.shortcut || ""}</kbd>
                  {A && (
                    <span className="v">
                      {valueOf(x.id as AdjustId)}
                      {A.unit}
                    </span>
                  )}
                  <span className="tick">
                    <CheckIcon size={11} strokeWidth={3.2} />
                  </span>
                </div>,
                adj && adj.i === i && A ? (
                  <div key={x.id + "-adj"} className={`lmn-adj${adj.open ? " open" : ""}`}>
                    <div className="lmn-adj-top">
                      <span className="val">
                        {val}
                        {A.unit}
                      </span>
                      <button type="button" tabIndex={-1} onClick={() => setValue(adj.id, A.def)}>
                        Reset
                      </button>
                    </div>
                    <div
                      id={`${uid}-ruler`}
                      role="slider"
                      aria-label={x.label}
                      aria-valuemin={A.min}
                      aria-valuemax={A.max}
                      aria-valuenow={val}
                      aria-valuetext={`${val}${A.unit}`}
                      className="lmn-ruler"
                      onPointerDown={(e) => startTape(e, adj.id)}
                      onWheel={(e) => setValue(adj.id, valRef.current + Math.sign(e.deltaY || e.deltaX))}
                    >
                      <div className={`tape${tapeDrag ? " drag" : ""}`} style={{ width: (A.max - A.min) * TICK + 2, transform: `translateX(${-(val - A.min) * TICK}px)` }} />
                      <i />
                    </div>
                    <div className="lmn-pre">
                      {A.presets.map((p) => (
                        <button
                          key={p}
                          type="button"
                          tabIndex={-1}
                          className={val === p ? "on" : ""}
                          onClick={(e) => {
                            e.currentTarget.blur()
                            setValue(adj.id, p)
                          }}
                        >
                          {p}
                          {A.unit}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null,
              ]
            })}
          </div>
          <span className="lmn-thumb" ref={thumbRef} />
        </div>
      </div>

      <div className={`lmn-toast${toast && shown ? "" : " shut"}`} style={narrow ? { left: 16, bottom: 88 } : undefined} role="status">
        <span>{toast?.text}</span>
        {toast?.undo !== false && (
          <button
            type="button"
            onClick={() => {
              setShown(false)
              onUndo()
            }}
          >
            Undo
          </button>
        )}
      </div>
    </div>,
    document.body,
  )
}

// ---------------------------------------------------------------- the canvas side
/**
 * The blue frame around a selected item, inside its wrapper (so it turns with it). `handles` adds the four corner
 * handles (resize) and the round one above (rotate); without them it is the lighter frame of a multiple selection.
 * Sizes stay constant on screen through --lmn-k (1 / zoom), which the board sets.
 */
export function LayerFrame({ handles, onResize, onRotate }: { handles?: boolean; onResize?: (e: RPointerEvent, corner: 0 | 1 | 2 | 3) => void; onRotate?: (e: RPointerEvent) => void }) {
  return (
    <div className={`lmn-sel${handles ? "" : " multi"}`} data-no-drag aria-hidden>
      {handles && (
        <>
          <b className="lmn-rh" title="Drag to rotate" onPointerDown={onRotate} />
          {([0, 1, 2, 3] as const).map((n) => (
            <i key={n} className={`h${n}`} onPointerDown={(e) => onResize?.(e, n)} />
          ))}
        </>
      )}
    </div>
  )
}

/** The small black badge on a locked item. */
export const LayerLock = () => (
  <span className="lmn-lock" aria-hidden>
    <LockIcon size={13} strokeWidth={2.2} color="#fff" />
  </span>
)

// ---------------------------------------------------------------- styles
const CSS = `/* kit-shield: undo Tailwind preflight inside the component (Kit) */
:where(.lmn) { line-height: normal; color: CanvasText; tab-size: 8; font-feature-settings: normal; font-variation-settings: normal; -webkit-text-size-adjust: auto; -webkit-tap-highlight-color: initial; }
:where(.lmn) :where(*), :where(.lmn) :where(*)::before, :where(.lmn) :where(*)::after { box-sizing: revert; margin: revert; padding: revert; border-width: revert; border-style: revert; border-color: revert; outline-color: revert; }
:where(.lmn) :where(img, svg, video, canvas) { display: revert; vertical-align: revert; }
:where(.lmn) :where(img, video) { max-width: revert; height: revert; }
:where(.lmn) :where(button) { font: revert; letter-spacing: revert; color: revert; border-radius: revert; background-color: revert; opacity: revert; appearance: revert; }
:where(.lmn) :where(h6, p) { font-size: revert; font-weight: revert; }

.lmn, .lmn * { box-sizing: border-box; }
.lmn * { margin: 0; }
.lmn { position: fixed; left: 0; top: 0; width: 0; height: 0; z-index: 50; color: var(--lmn-ink); font-family: var(--lmn-font); -webkit-font-smoothing: antialiased; line-height: 1.2; text-align: left; }
.lmn button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; border-radius: 0; letter-spacing: inherit; }

/* the canvas side: selection frame, handles, lock badge (k = 1 / zoom keeps them screen-sized) */
.lmn-sel { --k: var(--lmn-k, 1); position: absolute; inset: calc(-5px * var(--k)); border: calc(1.5px * var(--k)) solid ${ACCENT}; border-radius: calc(4px * var(--k)); pointer-events: none; animation: lmn-in .2s; }
.lmn-sel.multi { border-color: rgba(45,156,255,.45); }
@keyframes lmn-in { from { opacity: 0; } }
.lmn-sel i { position: absolute; width: calc(8px * var(--k)); height: calc(8px * var(--k)); background: #fff; border: calc(1.5px * var(--k)) solid ${ACCENT}; border-radius: calc(2px * var(--k)); pointer-events: auto; touch-action: none; }
.lmn-sel .h0 { left: calc(-5px * var(--k)); top: calc(-5px * var(--k)); cursor: nwse-resize; } .lmn-sel .h1 { right: calc(-5px * var(--k)); top: calc(-5px * var(--k)); cursor: nesw-resize; }
.lmn-sel .h2 { left: calc(-5px * var(--k)); bottom: calc(-5px * var(--k)); cursor: nesw-resize; } .lmn-sel .h3 { right: calc(-5px * var(--k)); bottom: calc(-5px * var(--k)); cursor: nwse-resize; }
.lmn-rh { position: absolute; left: 50%; top: calc(-34px * var(--k)); width: calc(12px * var(--k)); height: calc(12px * var(--k)); margin-left: calc(-6px * var(--k)); border-radius: 50%; background: #fff; border: calc(1.5px * var(--k)) solid ${ACCENT}; pointer-events: auto; cursor: grab; touch-action: none; }
.lmn-rh::after { content: ''; position: absolute; left: 50%; top: calc(10px * var(--k)); width: calc(1.5px * var(--k)); height: calc(19px * var(--k)); margin-left: calc(-.75px * var(--k)); background: ${ACCENT}; }
.lmn-lock { position: absolute; right: 8px; top: 8px; width: 24px; height: 24px; border-radius: 7px; background: #111; display: flex; align-items: center; justify-content: center; pointer-events: none; }

/* the menu */
.lmn-menu { position: fixed; background: var(--lmn-panel); border-radius: 18px; padding: 6px; transform-origin: top left; transition: opacity .18s, transform .22s cubic-bezier(.3,.7,.2,1), left .3s cubic-bezier(.3,.7,.2,1), top .3s cubic-bezier(.3,.7,.2,1); z-index: 5; outline: none; }
.lmn-menu.shut { opacity: 0; transform: scale(.96); pointer-events: none; }
.lmn-tabs { position: relative; display: flex; background: var(--lmn-well); border-radius: 12px; padding: 3px; }
.lmn-pill { position: absolute; top: 3px; bottom: 3px; left: 3px; background: var(--lmn-tab); border-radius: 10px; transition: transform .32s cubic-bezier(.3,.7,.2,1); }
.lmn-tabs button { position: relative; flex: 1; height: 34px; color: var(--lmn-mute); font-size: 14.5px; font-weight: 500; transition: color .2s; }
.lmn-tabs button.on { color: var(--lmn-ink); }
.lmn-listwrap { position: relative; margin-top: 6px; overflow: hidden; transition: height .3s cubic-bezier(.3,.7,.2,1); }
.lmn-list { position: relative; height: 100%; overflow-y: auto; scrollbar-width: none; padding-right: 12px; }
.lmn-list::-webkit-scrollbar { display: none; }
.lmn-hl { position: absolute; left: 0; right: 12px; top: 0; height: 37px; background: var(--lmn-row); border-radius: 10px; transition: transform .22s cubic-bezier(.3,.7,.2,1); pointer-events: none; }
.lmn-item { position: relative; display: flex; align-items: center; gap: 12px; height: 37px; padding: 0 10px; border-radius: 10px; cursor: pointer; font-size: 14.5px; font-weight: 500; color: var(--lmn-text); transition: color .15s; user-select: none; }
.lmn-item > svg { width: 18px; height: 18px; flex: none; color: var(--lmn-icon); transition: color .15s; }
.lmn-item.on { color: #fff; } .lmn-item.on > svg { color: #fff; }
.lmn-item kbd { margin-left: auto; font: 500 11.5px var(--lmn-font); color: #6f6f75; }
.lmn-item .v { display: none; margin-left: auto; font-size: 12.5px; font-weight: 600; color: var(--lmn-accent); font-variant-numeric: tabular-nums; }
.lmn-item .tick { margin-left: auto; width: 18px; height: 18px; border-radius: 50%; background: var(--lmn-accent); display: none; align-items: center; justify-content: center; animation: lmn-pop .28s cubic-bezier(.3,1.6,.5,1); }
.lmn-item .tick svg { width: 11px; height: 11px; color: #fff; }
.lmn-item.applied .tick { display: flex; } .lmn-item.applied kbd { display: none; }
.lmn-item.valued .v { display: block; } .lmn-item.valued kbd { display: none; }
@keyframes lmn-pop { from { transform: scale(.3); opacity: 0; } }
.lmn-thumb { position: absolute; right: 1px; top: 0; width: 5px; border-radius: 3px; background: #4a4a4f; display: none; }

/* the ruler under a row */
.lmn-adj { height: 0; overflow: hidden; transition: height .28s cubic-bezier(.3,.7,.2,1); padding: 0 10px; }
.lmn-adj.open { height: 112px; }
.lmn-adj-top { display: flex; align-items: baseline; justify-content: space-between; padding-top: 4px; }
.lmn-adj .val { font-size: 22px; font-weight: 600; letter-spacing: -.02em; color: #fff; font-variant-numeric: tabular-nums; }
.lmn-adj-top button { color: #8d8d93; font-size: 12.5px; font-weight: 500; padding: 4px 0; }
.lmn-adj-top button:hover { color: #fff; }
.lmn-ruler { position: relative; height: 28px; margin-top: 4px; overflow: hidden; cursor: ew-resize; touch-action: none; -webkit-mask-image: linear-gradient(90deg, transparent, #000 22%, #000 78%, transparent); mask-image: linear-gradient(90deg, transparent, #000 22%, #000 78%, transparent); }
.lmn-ruler .tape { position: absolute; top: 0; bottom: 0; left: 50%; transition: transform .25s cubic-bezier(.3,.7,.2,1); background: repeating-linear-gradient(90deg, #5c5c63 0 1px, transparent 1px 6px) left bottom / 100% 9px no-repeat, repeating-linear-gradient(90deg, #a3a3aa 0 1.5px, transparent 1.5px 60px) left bottom / 100% 18px no-repeat; }
.lmn-ruler .tape.drag { transition: none; }
.lmn-ruler i { position: absolute; left: 50%; bottom: 0; width: 2px; height: 24px; margin-left: -.5px; background: var(--lmn-accent); border-radius: 1px; }
.lmn-pre { display: flex; margin-top: 8px; }
.lmn-pre button { flex: 1; height: 24px; color: #8d8d93; font-size: 12px; font-weight: 500; font-variant-numeric: tabular-nums; }
.lmn-pre button:hover { color: #fff; }
.lmn-pre button.on { color: var(--lmn-accent); }

/* the preview card */
.lmn-peek { position: fixed; top: 0; width: 136px; background: var(--lmn-panel); border-radius: 14px; padding: 9px 9px 11px; transition: transform .26s cubic-bezier(.3,.7,.2,1), opacity .18s; z-index: 4; }
.lmn-peek.shut { opacity: 0; pointer-events: none; }
.lmn-peek h6 { display: flex; align-items: center; gap: 5px; font-size: 10.5px; font-weight: 500; letter-spacing: .06em; text-transform: uppercase; color: var(--lmn-mute); height: 16px; }
.lmn-peek h6 svg { width: 11px; height: 11px; }
.lmn-pv { margin: 7px -9px 0; height: 62px; position: relative; overflow: hidden; }
.lmn-pv svg { position: absolute; inset: 0; width: 100%; height: 100%; }
.lmn-peek p { margin-top: 8px; font-size: 12px; line-height: 1.38; color: #cfcfd4; font-weight: 400; min-height: 50px; }
.lmn-fade { animation: lmn-fade .22s ease; }
@keyframes lmn-fade { from { opacity: 0; transform: translateY(3px); } }

/* the toast */
.lmn-toast { position: fixed; left: 24px; bottom: 24px; display: flex; align-items: center; gap: 14px; background: var(--lmn-toast); color: #fff; border-radius: 12px; padding: 10px 12px 10px 14px; font-size: 13px; font-weight: 500; transition: opacity .2s, transform .25s; z-index: 6; }
.lmn-toast.shut { opacity: 0; transform: translateY(8px); pointer-events: none; }
.lmn-toast button { background: #2a2a2d; color: #fff; font-size: 12.5px; font-weight: 600; border-radius: 8px; padding: 6px 10px; }

/* preview loops */
.lmn-pv .a { transform-box: fill-box; transform-origin: center; }
.lmn-pv svg * { animation-duration: var(--lmn-speed); animation-timing-function: ease-in-out; animation-iteration-count: infinite; }
@keyframes lmn-rs { 0%,15% { width: 30px; height: 24px; } 50%,70% { width: 44px; height: 34px; } 100% { width: 30px; height: 24px; } }
.lmn-pv .k-rs { animation-name: lmn-rs; }
@keyframes lmn-rsh { 0%,15% { transform: translate(0,0); } 50%,70% { transform: translate(14px,10px); } 100% { transform: translate(0,0); } }
.lmn-pv .k-rsh { animation-name: lmn-rsh; }
@keyframes lmn-crop { 0%,15% { x: 44px; y: 13px; width: 48px; height: 36px; } 50%,70% { x: 52px; y: 19px; width: 32px; height: 24px; } 100% { x: 44px; y: 13px; width: 48px; height: 36px; } }
.lmn-pv .k-crop { animation-name: lmn-crop; }
@keyframes lmn-rot { 0%,15% { transform: rotate(0); } 50%,70% { transform: rotate(28deg); } 100% { transform: rotate(0); } }
.lmn-pv .k-rot { animation-name: lmn-rot; }
@keyframes lmn-flip { 0%,15% { transform: scaleX(1); } 50%,70% { transform: scaleX(-1); } 100% { transform: scaleX(1); } }
.lmn-pv .k-flip { animation-name: lmn-flip; }
@keyframes lmn-dup { 0%,15% { transform: translate(0,0); opacity: 0; } 50%,75% { transform: translate(14px,8px); opacity: 1; } 100% { transform: translate(0,0); opacity: 0; } }
.lmn-pv .k-dup { animation-name: lmn-dup; }
@keyframes lmn-al { 0%,15% { transform: translateX(var(--o)); } 50%,75% { transform: translateX(0); } 100% { transform: translateX(var(--o)); } }
.lmn-pv .k-al { animation-name: lmn-al; }
@keyframes lmn-op { 0%,15% { fill-opacity: .9; } 50%,70% { fill-opacity: .18; } 100% { fill-opacity: .9; } }
.lmn-pv .k-op { animation-name: lmn-op; }
@keyframes lmn-rnd { 0%,15% { rx: 1px; } 50%,70% { rx: 16px; } 100% { rx: 1px; } }
.lmn-pv .k-rnd { animation-name: lmn-rnd; }
@keyframes lmn-shk { 0%,20% { transform: translateY(-6px); } 45%,75% { transform: translateY(0); } 100% { transform: translateY(-6px); } }
.lmn-pv .k-shk { animation-name: lmn-shk; }
@keyframes lmn-hide { 0%,20% { opacity: 1; } 45%,75% { opacity: .12; } 100% { opacity: 1; } }
.lmn-pv .k-hide { animation-name: lmn-hide; }
@keyframes lmn-grp { 0%,15% { transform: translate(var(--gx),var(--gy)); } 50%,75% { transform: translate(0,0); } 100% { transform: translate(var(--gx),var(--gy)); } }
.lmn-pv .k-grp { animation-name: lmn-grp; }
@keyframes lmn-grpb { 0%,40% { opacity: 0; } 55%,75% { opacity: 1; } 90%,100% { opacity: 0; } }
.lmn-pv .k-grpb { animation-name: lmn-grpb; }
@keyframes lmn-mask { 0%,15% { r: 4px; } 50%,70% { r: 24px; } 100% { r: 4px; } }
.lmn-pv .k-mask { animation-name: lmn-mask; }
@keyframes lmn-blur { 0%,15% { filter: blur(0); } 50%,70% { filter: blur(4px); } 100% { filter: blur(0); } }
.lmn-pv .k-blur { animation-name: lmn-blur; }
@keyframes lmn-ol { 0%,15% { stroke-width: 0; } 50%,70% { stroke-width: 5px; } 100% { stroke-width: 0; } }
.lmn-pv .k-ol { animation-name: lmn-ol; }
@keyframes lmn-gap { 0%,15% { transform: translateX(var(--g)); } 50%,75% { transform: translateX(0); } 100% { transform: translateX(var(--g)); } }
.lmn-pv .k-gap { animation-name: lmn-gap; }
@keyframes lmn-exp { 0%,10% { transform: translate(0,0); opacity: 0; } 25% { opacity: 1; } 60%,75% { transform: translate(0,-10px); opacity: 1; } 100% { transform: translate(0,-14px); opacity: 0; } }
.lmn-pv .k-exp { animation-name: lmn-exp; }
@media (prefers-reduced-motion: reduce) { .lmn-pv svg * { animation: none !important; } .lmn-menu, .lmn-peek, .lmn-hl, .lmn-pill, .lmn-listwrap, .lmn-adj, .lmn-ruler .tape, .lmn-toast { transition-duration: 0s !important; } }
`
