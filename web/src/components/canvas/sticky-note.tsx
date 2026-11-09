import { memo, useEffect, useRef, useState, type CSSProperties } from "react"
import { MoreHorizontalIcon, PencilIcon, Trash2Icon } from "@/components/icons"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

// A slight, stable tilt per note, so a board of them looks pinned up by hand.
const TILTS = [-2, -1, 1, 1.5]
const tilt = (id: string) => TILTS[[...id].reduce((n, c) => n + c.charCodeAt(0), 0) % TILTS.length]!

/**
 * A sticky note on a board. It fills its parent. Double-click (or Enter on the focused item, handled by the board)
 * edits it inline; typing saves shortly after it stops, and on the way out.
 */
export const StickyNote = memo(function StickyNote({
  id,
  text,
  selected,
  editing,
  onEditing,
  onSave,
  onDelete,
  style,
}: {
  id: string
  text: string
  selected?: boolean
  editing: boolean
  onEditing: (id: string, on: boolean) => void
  onSave: (id: string, text: string) => void
  onDelete: (id: string) => void
  /** The board's per-item look (radius, clip, blur, flip), on the note itself. */
  style?: CSSProperties
}) {
  const [value, setValue] = useState(text)
  const pending = useRef<string | null>(null)
  const timer = useRef(0)
  const save = useRef(() => {})
  save.current = () => {
    clearTimeout(timer.current)
    if (pending.current !== null) onSave(id, pending.current)
    pending.current = null
  }
  useEffect(() => () => save.current(), [])
  // A refetch brings the stored text; adopt it unless the user is typing.
  useEffect(() => {
    if (!editing && pending.current === null) setValue(text)
  }, [text, editing])

  // Back to the item, so the keyboard can carry on (blurring saves and ends editing).
  const stop = (el: HTMLElement) => el.closest<HTMLElement>("[data-key]")?.focus()

  return (
    <div
      onDoubleClick={() => onEditing(id, true)}
      style={{ rotate: editing ? "0deg" : `${tilt(id)}deg`, ...style }}
      className="group/note relative flex size-full flex-col rounded-md bg-note p-3 text-xs leading-snug text-note-ink shadow-card transition-[rotate] duration-200 ease-out motion-reduce:transition-none"
    >
      {editing ? (
        <textarea
          autoFocus
          data-no-drag
          aria-label="Note"
          value={value}
          maxLength={2000}
          placeholder="Write a note…"
          onFocus={(e) => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
          onChange={(e) => {
            setValue(e.target.value)
            pending.current = e.target.value
            clearTimeout(timer.current)
            timer.current = window.setTimeout(() => save.current(), 600)
          }}
          onBlur={() => {
            save.current()
            onEditing(id, false)
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) {
              e.preventDefault()
              e.stopPropagation()
              stop(e.currentTarget)
            }
          }}
          className="size-full resize-none bg-transparent outline-none placeholder:text-note-ink/50"
        />
      ) : (
        <p className={cn("min-h-0 flex-1 overflow-hidden break-words whitespace-pre-wrap", !value && "text-note-ink/50")}>{value || "Empty note"}</p>
      )}
      {!editing && (
        <DropdownMenu>
          <DropdownMenuTrigger
            data-no-drag
            aria-label="Note actions"
            className={cn(
              "press absolute top-1.5 right-1.5 grid size-7 place-items-center rounded-full text-note-ink/70 opacity-0 hover:bg-note-ink/10 hover:text-note-ink focus-visible:opacity-100 data-popup-open:opacity-100 group-hover/note:opacity-100 pointer-coarse:opacity-100",
              selected && "opacity-100",
            )}
          >
            <MoreHorizontalIcon className="size-4" />
          </DropdownMenuTrigger>
          {/* No focus return: "Edit" hands focus to the textarea. */}
          <DropdownMenuContent align="end" finalFocus={false} className="w-40">
            <DropdownMenuItem onClick={() => onEditing(id, true)}>
              <PencilIcon /> Edit
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={() => onDelete(id)}>
              <Trash2Icon /> Delete note
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
})
