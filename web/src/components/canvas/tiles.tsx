import { memo, useRef, useState, type CSSProperties, type FocusEvent, type PointerEvent, type Ref } from "react"
import { Link } from "wouter"
import { ArrowUpRightIcon } from "@/components/icons"
import { captureLabel } from "@/components/capture-controls"
import { SiteIcon } from "@/components/site-icon"
import { fileUrl } from "@/lib/api"
import { cn } from "@/lib/utils"
import { isVideoKey, type RefSummary } from "../../../shared/types"
import type { CanvasItem } from "@/components/canvas/types"

/** Where an item came from, for the hover chip. Uploaded images have none. */
function source(item: CanvasItem): { domain: string; icon: string | null; path?: string; href: string } | null {
  const named = (ref: RefSummary, path: string, href: string) => ({ domain: ref.domain, icon: ref.favicon, path: path === "/" ? undefined : path.replace(/^\//, ""), href })
  switch (item.kind) {
    case "page":
      return named(item.page.reference, item.page.path, item.page.url)
    case "section":
      return named(item.section.reference, item.section.path, item.section.url)
    case "animation":
      return { domain: item.animation.reference.domain, icon: item.animation.reference.favicon, path: item.animation.label ?? undefined, href: `https://${item.animation.reference.domain}` }
    case "website":
      return { domain: item.reference.domain, icon: item.reference.favicon, href: item.reference.url }
    case "image":
      return null
  }
}

/** A tile's accessible name. */
export function tileLabel(item: CanvasItem) {
  switch (item.kind) {
    case "page":
      return item.page.title || `${item.page.reference.domain}${item.page.path}`
    case "section":
      return `${item.section.label} · ${item.section.reference.domain}`
    case "animation":
      return `${item.animation.kind === "scroll" ? "Scroll" : "Hover"} recording · ${item.animation.label || item.animation.reference.domain}`
    case "image":
      return item.image.title || "Image"
    case "website":
      return item.reference.title || item.reference.domain
  }
}

const img = "size-full object-cover"
// A function, not a component: hundreds of tiles each skip a fiber for it. `fit` is the whole object-fit and position.
const thumb = (src: string | null | undefined, fit = "object-cover") =>
  src ? <img src={fileUrl(src)} alt="" loading="lazy" decoding="async" draggable={false} className={`size-full ${fit}`} /> : null

/** A recording's still; its video plays while the tile is hovered or focused. */
function AnimationMedia({ a, live }: { a: Extract<CanvasItem, { kind: "animation" }>["animation"]; live: boolean }) {
  // Hover recordings are small element crops: letterbox them instead of upscaling.
  const small = a.kind === "hover" && a.width < 480
  const fit = small ? "object-contain p-4" : "object-top"
  const stillFit = small ? fit : "object-cover object-top"
  const still = a.meta?.frames[0]?.key ?? (isVideoKey(a.gifKey) ? null : a.gifKey)
  return (
    <>
      {still ? (
        thumb(still, stillFit)
      ) : (
        <video src={fileUrl(a.gifKey)} muted playsInline preload="metadata" className={cn(img, fit)} />
      )}
      {live && isVideoKey(a.gifKey) && <video src={fileUrl(a.gifKey)} autoPlay muted loop playsInline className={cn(img, fit, "absolute inset-0")} />}
    </>
  )
}

function Media({ item, live }: { item: CanvasItem; live: boolean }) {
  switch (item.kind) {
    case "page":
      return thumb(item.page.desktopThumbKey ?? item.page.mobileThumbKey, "object-cover object-top")
    case "section":
      return thumb(item.section.key, "object-cover object-top")
    case "animation":
      return <AnimationMedia a={item.animation} live={live} />
    case "image":
      return thumb(item.image.thumbKey)
    case "website": {
      const r = item.reference
      const cover = r.coverKey ?? r.previewKeys[0]
      const status = r.status === "ready" ? null : (captureLabel(r, true) ?? (r.status === "failed" ? "Capture failed" : r.status === "queued" ? "Queued" : "Capturing"))
      return (
        <>
          {cover ? (
            thumb(cover, "object-cover object-top")
          ) : (
            <span className="grid size-full place-items-center bg-ink-2">
              <SiteIcon domain={r.domain} icon={r.favicon} className="size-6 rounded-md" />
            </span>
          )}
          {status && <span className="absolute top-2 left-2 rounded-full bg-control px-2 py-0.5 text-2xs text-ink-11 shadow-button">{status}</span>}
        </>
      )
    }
  }
}

/**
 * One saved item as a canvas tile. It fills its parent; the caller positions and sizes it.
 * Click opens it (onOpen), except websites, which go to their page unless onOpen is given.
 */
export const CanvasTile = memo(function CanvasTile({
  item,
  onOpen,
  selected,
  dimmed,
  draggable,
  tabIndex,
  className,
  faceStyle,
}: {
  item: CanvasItem
  onOpen?: (item: CanvasItem) => void
  /** Board selection: a dark ring. */
  selected?: boolean
  /** Doesn't match the board's filter: faded, still usable. */
  dimmed?: boolean
  /** Native drag carrying `application/x-snip-item` ({ kind, id }). Off, images and links don't drag, so the canvas pans. */
  draggable?: boolean
  /** -1 when a wrapper takes focus instead (the board canvas's selectable items). */
  tabIndex?: number
  className?: string
  /** Inline style for the tile face (the board's per-item look: radius, clip, blur, flip). */
  faceStyle?: CSSProperties
}) {
  const [live, setLive] = useState(false)
  const src = source(item)
  const name = tileLabel(item)
  const face = cn(
    // ink-3, not surface-top: a quiet placeholder until the image loads, and letterboxing that stays dark in dark mode.
    "relative block size-full cursor-pointer overflow-hidden rounded-md bg-ink-3 shadow-card transition-[scale,opacity,box-shadow] duration-150 ease-out active:scale-[0.99] motion-reduce:active:scale-100",
    selected && "ring-2 ring-ink-12 ring-offset-2 ring-offset-background",
  )
  const inner = (
    <>
      <Media item={item} live={live} />
      <span className="pointer-events-none absolute inset-0 bg-black/0 transition-colors duration-150 ease-out group-hover:bg-black/[0.03]" />
    </>
  )
  return (
    <div
      className={cn("group relative size-full select-none", dimmed && "opacity-35", className)}
      draggable={draggable || undefined}
      onDragStart={draggable ? (e) => e.dataTransfer.setData("application/x-snip-item", JSON.stringify({ kind: item.kind, id: item.id })) : undefined}
      onPointerEnter={(e) => e.pointerType === "mouse" && setLive(true)}
      onPointerLeave={() => setLive(false)}
      onFocus={() => setLive(true)}
      onBlur={() => setLive(false)}
    >
      {item.kind === "website" && !onOpen ? (
        <Link href={`/r/${item.id}`} aria-label={name} draggable={false} tabIndex={tabIndex} className={face} style={faceStyle}>
          {inner}
        </Link>
      ) : (
        <button type="button" aria-label={name} tabIndex={tabIndex} onClick={() => onOpen?.(item)} className={cn(face, "text-left")} style={faceStyle}>
          {inner}
        </button>
      )}
      {/* Mounted only while hovered or focused: hundreds of tiles each carrying a hidden chip and favicon
          doubled the DOM and image requests when zoomed out. */}
      {src && live && (
        <div className="pointer-events-none absolute inset-x-2 bottom-2 flex motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 motion-safe:duration-200">
          <SourceChip src={src} />
        </div>
      )}
    </div>
  )
})

/** The hover chip: where an item came from, with a link to it. Shared by every kind of tile. */
function SourceChip({ src, ref, onLeave }: { src: NonNullable<ReturnType<typeof source>>; ref?: Ref<HTMLAnchorElement>; onLeave?: (e: PointerEvent | FocusEvent) => void }) {
  return (
    <a
      ref={ref}
      href={src.href}
      target="_blank"
      rel="noreferrer"
      tabIndex={-1}
      draggable={false}
      title={`Open ${src.domain}`}
      onPointerLeave={onLeave}
      onBlur={onLeave}
      className="tactile press pointer-events-auto flex h-7 max-w-full items-center gap-1.5 rounded-full pr-2.5 pl-1.5 text-2xs font-medium"
    >
      <SiteIcon domain={src.domain} icon={src.icon} />
      <span className="truncate">
        {src.domain}
        {src.path && <span className="text-ink-10"> / {src.path}</span>}
      </span>
      <ArrowUpRightIcon className="size-3 shrink-0 text-ink-10" />
    </a>
  )
}

// The home tile's face. `in-data-far` is set on the canvas's world layer while zoomed far out (see FAR_ZOOM): there a
// tile is a few dozen px wide, so its three blurred shadows, hover wash and transitions are paid for and unseen.
const HOME_FACE =
  "absolute cursor-pointer overflow-hidden rounded-md bg-ink-3 text-left shadow-card select-none transition-[scale,opacity,box-shadow] duration-150 ease-out active:scale-[0.99] motion-reduce:active:scale-100 " +
  "after:pointer-events-none after:absolute after:inset-0 after:bg-black/0 after:transition-colors after:duration-150 after:ease-out hover:after:bg-black/[0.03] " +
  "in-data-far:shadow-[0_0_0_1px_var(--ink-5)] in-data-far:transition-none in-data-far:after:hidden in-data-far:rounded-none in-data-far:overflow-visible"

/**
 * A tile of the home field. It positions itself and is a link or button holding just its image: two DOM elements
 * (the hover chip is mounted only for the tile under the pointer or focus), so a zoomed-out field of a thousand tiles
 * stays light. Repeated copies of the block are clickable but neither focusable nor announced: otherwise Tab never
 * ends (each focus pans to the next copy) and screen readers read every item many times.
 */
export const HomeTile = memo(function HomeTile({
  item,
  x,
  y,
  w,
  h,
  copy,
  onOpen,
}: {
  item: CanvasItem
  /** Position and size in world px. */
  x: number
  y: number
  w: number
  h: number
  /** A repeat of the block, not the origin copy. */
  copy: boolean
  /** Click opens it (onOpen), except websites, which go to their page unless onOpen is given. */
  onOpen?: (item: CanvasItem) => void
}) {
  const [live, setLive] = useState(false)
  const face = useRef<HTMLElement>(null)
  const chip = useRef<HTMLAnchorElement>(null)
  const name = tileLabel(item)
  // Pointer or focus moving between the tile and its chip (a sibling element) keeps the chip.
  const leave = (e: PointerEvent | FocusEvent) => {
    const to = e.relatedTarget as Node | null
    if (!to || !(face.current?.contains(to) || chip.current?.contains(to))) setLive(false)
  }
  const shared = {
    "aria-label": name,
    "aria-hidden": copy || undefined,
    tabIndex: copy ? -1 : undefined,
    style: { left: x, top: y, width: w, height: h },
    className: HOME_FACE,
    onPointerEnter: (e: PointerEvent) => e.pointerType === "mouse" && setLive(true),
    onPointerLeave: leave,
    onFocus: () => setLive(true),
    onBlur: leave,
  }
  // Called, not rendered as <Media />: one fewer element and fiber for each of hundreds of tiles.
  const media = Media({ item, live })
  const tile =
    item.kind === "website" && !onOpen ? (
      <Link ref={face as Ref<HTMLAnchorElement>} href={`/r/${item.id}`} draggable={false} {...shared}>
        {media}
      </Link>
    ) : (
      <button ref={face as Ref<HTMLButtonElement>} type="button" onClick={() => onOpen?.(item)} {...shared}>
        {media}
      </button>
    )
  const src = live ? source(item) : null
  if (!src) return tile
  return (
    <>
      {tile}
      <div className="pointer-events-none absolute in-data-far:hidden" style={{ left: x, top: y, width: w, height: h }}>
        <div className="absolute inset-x-2 bottom-2 flex motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 motion-safe:duration-200">
          <SourceChip src={src} ref={chip} onLeave={leave} />
        </div>
      </div>
    </>
  )
})
