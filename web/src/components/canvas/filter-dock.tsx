import { useState } from "react"
import { FileIcon, GlobeIcon, GridIcon, ImageIcon, LayersIcon, PlayIcon, PlusIcon, SectionsIcon, type Icon } from "@/components/icons"
import { BoardsList } from "@/components/canvas/boards-list"
import { CaptureForm } from "@/components/canvas/capture-card"
import type { CanvasFilter } from "@/components/canvas/types"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { LibraryTypeCounts } from "@/lib/api"
import { cn } from "@/lib/utils"

const FILTERS: { value: CanvasFilter; label: string; icon: Icon }[] = [
  { value: "all", label: "All", icon: GridIcon },
  { value: "websites", label: "Websites", icon: GlobeIcon },
  { value: "pages", label: "Pages", icon: FileIcon },
  { value: "sections", label: "Sections", icon: SectionsIcon },
  { value: "animations", label: "Animations", icon: PlayIcon },
  { value: "images", label: "Images", icon: ImageIcon },
]

export const countOf = (counts: LibraryTypeCounts, f: CanvasFilter) => (f === "all" ? counts.pages + counts.sections + counts.images : counts[f])

// Filters show their name beside the icon (from md up), so it reads as "show me Websites", not a row of mystery glyphs.
const filterButton = "press flex h-10 items-center gap-1.5 rounded-full px-2.5 text-xs text-ink-11 hover:bg-ink-3 hover:text-foreground max-md:w-10 max-md:justify-center max-md:px-0 [&_svg]:size-[18px] [&_svg]:shrink-0"
const button = "press grid size-10 place-items-center rounded-full text-ink-11 hover:bg-ink-3 hover:text-foreground [&_svg]:size-[18px]"
const tip = "h-8 gap-1.5 rounded-md bg-primary px-2.5 text-xs text-primary-foreground shadow-menu"

/** Arrow keys move between the dock's buttons (one tab stop, toolbar pattern). */
function rove(e: React.KeyboardEvent<HTMLElement>) {
  const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0
  if (!step) return
  const all = [...e.currentTarget.querySelectorAll<HTMLElement>("button")]
  const at = all.indexOf(document.activeElement as HTMLElement)
  // Portal events bubble through React even though the capture form is outside this toolbar.
  if (at < 0 || e.target !== document.activeElement) return
  all[(at + step + all.length) % all.length]?.focus()
  e.preventDefault()
}

/** Bottom-centre dock: add (+), what the canvas shows, and the boards popover. Tooltips carry the count. */
export function FilterDock({
  value,
  onChange,
  counts,
  boardId,
  canAdd,
  glow,
  className,
}: {
  value: CanvasFilter
  onChange: (f: CanvasFilter) => void
  /** For the tooltips and labels; null while loading. */
  counts: LibraryTypeCounts | null
  boardId?: string
  /** Show the + button: add a site (landing page or whole site) or upload images. */
  canAdd?: boolean
  /** Pulse the + button (an empty library): it is where everything starts. Stops while its popover is open. */
  glow?: boolean
  className?: string
}) {
  const [boards, setBoards] = useState(false)
  const [adding, setAdding] = useState(false)
  return (
    <div role="toolbar" aria-label="Filter saves" onKeyDown={rove} className={cn("flex h-[52px] items-center gap-1 rounded-full bg-control p-1.5 shadow-menu", className)}>
      {canAdd && (
        <>
          <Popover open={adding} onOpenChange={setAdding}>
            <Tooltip>
              <TooltipTrigger
                render={
                  <PopoverTrigger
                    render={
                      <button
                        type="button"
                        aria-label="Add a site or images"
                        tabIndex={-1}
                        className={cn(
                          "press grid size-10 place-items-center rounded-full bg-ink-3 text-foreground hover:bg-ink-4 data-popup-open:bg-ink-4 [&_svg]:size-[18px] [&_svg]:transition-transform [&_svg]:duration-200 data-popup-open:[&_svg]:rotate-45",
                          glow && !adding && "bg-ink-5 hover:bg-ink-6 motion-safe:animate-[plus-glow_2s_ease-in-out_infinite]",
                        )}
                      />
                    }
                  />
                }
              >
                <PlusIcon />
              </TooltipTrigger>
              <TooltipContent sideOffset={10} className={tip}>
                Add a site or images
              </TooltipContent>
            </Tooltip>
            <PopoverContent side="top" sideOffset={12} className="w-auto rounded-2xl p-2">
              <CaptureForm boardId={boardId} onDone={() => setAdding(false)} />
            </PopoverContent>
          </Popover>
          <span aria-hidden className="mx-1 h-5 w-px bg-ink-5" />
        </>
      )}
      {FILTERS.map(({ value: f, label, icon: Glyph }) => {
        // A board's "all" is its members: websites, pages and images (sections and animations aren't board members).
        const n = !counts ? null : boardId && f === "all" ? counts.websites + counts.pages + counts.images : countOf(counts, f)
        const on = value === f
        return (
          <Tooltip key={f}>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-pressed={on}
                  aria-label={n === null ? label : `${label}, ${n}`}
                  tabIndex={on ? 0 : -1}
                  onClick={() => onChange(f)}
                  className={cn(filterButton, on && "bg-primary text-primary-foreground hover:bg-(--primary-hover) hover:text-primary-foreground")}
                />
              }
            >
              <Glyph />
              <span className="max-md:hidden">{label}</span>
            </TooltipTrigger>
            <TooltipContent sideOffset={10} className={tip}>
              <span>{label}</span>
              {n !== null && <span className="text-ink-9 tabular-nums">{n}</span>}
            </TooltipContent>
          </Tooltip>
        )
      })}
      <span aria-hidden className="mx-1 h-5 w-px bg-ink-5" />
      <Popover open={boards} onOpenChange={setBoards}>
        <Tooltip>
          <TooltipTrigger render={<PopoverTrigger render={<button type="button" aria-label="Boards" tabIndex={-1} className={cn(button, "data-popup-open:bg-ink-3 data-popup-open:text-foreground")} />} />}>
            <LayersIcon />
          </TooltipTrigger>
          <TooltipContent sideOffset={10} className={tip}>
            Boards
          </TooltipContent>
        </Tooltip>
        <PopoverContent side="top" sideOffset={12} className="w-auto p-1.5">
          <BoardsList activeId={boardId} onNavigate={() => setBoards(false)} />
        </PopoverContent>
      </Popover>
    </div>
  )
}
