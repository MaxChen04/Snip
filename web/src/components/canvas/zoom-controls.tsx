import { MaximizeIcon, MinusIcon, PlusIcon } from "@/components/icons"
import { MAX_ZOOM, MIN_ZOOM } from "@/components/canvas/infinite-canvas"
import { cn } from "@/lib/utils"

const button = "press grid size-8 place-items-center rounded-full text-ink-11 hover:bg-ink-3 hover:text-foreground disabled:opacity-40 [&_svg]:size-4"

/** Bottom-right pill: zoom out, the zoom level (click for 100%), zoom in, recenter. */
export function ZoomControls({
  zoom,
  onZoom,
  onReset,
  onRecenter,
  className,
}: {
  zoom: number
  /** Multiply the zoom. */
  onZoom: (factor: number) => void
  /** Back to 100%. */
  onReset: () => void
  onRecenter: () => void
  className?: string
}) {
  const pct = Math.round(zoom * 100)
  return (
    <div className={cn("flex h-10 items-center gap-0.5 rounded-full bg-control p-1 shadow-button", className)}>
      <button type="button" aria-label="Zoom out" disabled={zoom <= MIN_ZOOM + 0.001} onClick={() => onZoom(1 / 1.25)} className={button}>
        <MinusIcon />
      </button>
      <button type="button" aria-label={`Zoom ${pct}%, reset to 100%`} onClick={onReset} className="press h-8 w-11 rounded-full text-center text-xs text-foreground tabular-nums hover:bg-ink-3">
        {pct}%
      </button>
      <button type="button" aria-label="Zoom in" disabled={zoom >= MAX_ZOOM - 0.001} onClick={() => onZoom(1.25)} className={button}>
        <PlusIcon />
      </button>
      <button type="button" aria-label="Recenter" onClick={onRecenter} className={cn(button, "[&_svg]:size-3.5")}>
        <MaximizeIcon />
      </button>
    </div>
  )
}
