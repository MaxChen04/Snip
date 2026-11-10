import { memo, useState, type CSSProperties } from "react"
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
const Img = ({ src, className }: { src: string | null | undefined; className?: string }) =>
  src ? <img src={fileUrl(src)} alt="" loading="lazy" decoding="async" draggable={false} className={cn(img, className)} /> : null

/** A recording's still; its video plays while the tile is hovered or focused. */
function AnimationMedia({ a, live }: { a: Extract<CanvasItem, { kind: "animation" }>["animation"]; live: boolean }) {
  // Hover recordings are small element crops: letterbox them instead of upscaling.
  const small = a.kind === "hover" && a.width < 480
  const fit = small ? "object-contain p-4" : "object-top"
  const still = a.meta?.frames[0]?.key ?? (isVideoKey(a.gifKey) ? null : a.gifKey)
  return (
    <>
      {still ? (
        <Img src={still} className={fit} />
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
      return <Img src={item.page.desktopThumbKey ?? item.page.mobileThumbKey} className="object-top" />
    case "section":
      return <Img src={item.section.key} className="object-top" />
    case "animation":
      return <AnimationMedia a={item.animation} live={live} />
    case "image":
      return <Img src={item.image.thumbKey} />
    case "website": {
      const r = item.reference
      const cover = r.coverKey ?? r.previewKeys[0]
      const status = r.status === "ready" ? null : (captureLabel(r, true) ?? (r.status === "failed" ? "Capture failed" : r.status === "queued" ? "Waiting for your Mac" : "Capturing"))
      return (
        <>
          {cover ? (
            <Img src={cover} className="object-top" />
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
  dimmed,
  tabIndex,
  faceStyle,
}: {
  item: CanvasItem
  onOpen?: (item: CanvasItem) => void
  /** Doesn't match the board's filter: faded, still usable. */
  dimmed?: boolean
  /** -1 when a wrapper takes focus instead (the board canvas's selectable items). */
  tabIndex?: number
  /** Inline style for the tile face (the board's per-item look: radius, clip, blur, flip). */
  faceStyle?: CSSProperties
}) {
  const [live, setLive] = useState(false)
  const src = source(item)
  const name = tileLabel(item)
  // ink-3, not surface-top: a quiet placeholder until the image loads, and letterboxing that stays dark in dark mode.
  const face = "relative block size-full cursor-pointer overflow-hidden rounded-md bg-ink-3 shadow-card transition-[scale,opacity,box-shadow] duration-150 ease-out active:scale-[0.99] motion-reduce:active:scale-100"
  const inner = (
    <>
      <Media item={item} live={live} />
      <span className="pointer-events-none absolute inset-0 bg-black/0 transition-colors duration-150 ease-out group-hover:bg-black/[0.03]" />
    </>
  )
  return (
    <div
      className={cn("group relative size-full select-none", dimmed && "opacity-35")}
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
          <a
            href={src.href}
            target="_blank"
            rel="noreferrer"
            tabIndex={-1}
            draggable={false}
            title={`Open ${src.domain}`}
            className="tactile press pointer-events-auto flex h-7 max-w-full items-center gap-1.5 rounded-full pr-2.5 pl-1.5 text-2xs font-medium"
          >
            <SiteIcon domain={src.domain} icon={src.icon} />
            <span className="truncate">
              {src.domain}
              {src.path && <span className="text-ink-10"> / {src.path}</span>}
            </span>
            <ArrowUpRightIcon className="size-3 shrink-0 text-ink-10" />
          </a>
        </div>
      )}
    </div>
  )
})
