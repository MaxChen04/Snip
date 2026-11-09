import { useState, type Ref } from "react"
import { toast } from "sonner"
import { FolderPlusIcon, GridIcon, LayersIcon, Trash2Icon, type Icon } from "@/components/icons"
import { CollectionPicker } from "@/components/collection-picker"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

const action =
  "press flex h-8 items-center gap-1.5 rounded-full px-3 text-xs text-primary-foreground hover:bg-primary-foreground/12 focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-primary-foreground/60 disabled:opacity-50 data-popup-open:bg-primary-foreground/12 [&_svg]:size-3.5"

function Action({ icon: Glyph, label, shortcut, onClick, disabled }: { icon: Icon; label: string; shortcut?: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-keyshortcuts={shortcut} title={shortcut ? `${label} (${shortcut})` : undefined} className={action}>
      <Glyph />
      {label}
    </button>
  )
}

/**
 * The dark pill over a board selection. It lives in screen space (so it never scales with zoom); the board
 * positions it through `ref`.
 */
export function SelectionToolbar({
  ref,
  count,
  canShare,
  inBoards,
  onToggleBoard,
  onGroup,
  onMakeBoard,
  onRemove,
  className,
}: {
  ref?: Ref<HTMLDivElement>
  count: number
  /** False when only notes are selected: they live on one board, so Make board and Add to board don't apply. */
  canShare: boolean
  /** Boards every selected item is already on. */
  inBoards: string[]
  onToggleBoard: (boardId: string, on: boolean) => Promise<void>
  onGroup: () => void
  onMakeBoard: () => void
  onRemove: () => void
  className?: string
}) {
  const [checked, setChecked] = useState(inBoards)
  const toggle = async (cid: string, on: boolean) => {
    const before = checked
    setChecked(on ? [...before, cid] : before.filter((x) => x !== cid))
    try {
      await onToggleBoard(cid, on)
    } catch (e) {
      setChecked(before)
      toast.error((e as Error).message)
    }
  }
  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label={`${count} selected`}
      data-no-pan
      className={cn("flex h-10 items-center gap-0.5 rounded-full bg-primary py-1 pr-1 pl-3.5 shadow-menu", className)}
    >
      <span className="pr-2 text-xs whitespace-nowrap text-primary-foreground/60 tabular-nums">{count} selected</span>
      <Action icon={GridIcon} label="Group" shortcut="G" onClick={onGroup} />
      <Action icon={LayersIcon} label="Make board" onClick={onMakeBoard} disabled={!canShare} />
      <Popover onOpenChange={(open) => open && setChecked(inBoards)}>
        <PopoverTrigger disabled={!canShare} className={action}>
          <FolderPlusIcon />
          Add to board
        </PopoverTrigger>
        <PopoverContent side="top" sideOffset={10} className="w-80 p-2">
          <CollectionPicker className="max-h-72" selected={checked} onToggle={(cid, on) => void toggle(cid, on)} />
        </PopoverContent>
      </Popover>
      <span aria-hidden className="mx-1 h-4 w-px bg-primary-foreground/20" />
      <button type="button" aria-label="Remove from board" aria-keyshortcuts="Delete" title="Remove from board" onClick={onRemove} className={cn(action, "size-8 justify-center px-0 text-primary-foreground/70")}>
        <Trash2Icon />
      </button>
    </div>
  )
}
