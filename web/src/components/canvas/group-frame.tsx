import { memo, useState } from "react"
import { GridIcon, MoreHorizontalIcon, PencilIcon } from "@/components/icons"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import type { BoardGroup, BoardItemKind } from "@/lib/api"
import { MAX_NAME } from "../../../shared/types"

const WORDS: [BoardItemKind, string][] = [
  ["page", "page"],
  ["reference", "site"],
  ["image", "image"],
  ["note", "note"],
]

/** "4 pages · 3 sites", leaving out whichever is zero. */
export function frameCountLabel(kinds: BoardItemKind[]) {
  const parts = WORDS.map(([k, word]) => {
    const n = kinds.filter((x) => x === k).length
    return n && `${n} ${word}${n === 1 ? "" : "s"}`
  }).filter(Boolean)
  return parts.length ? parts.join(" · ") : "Empty"
}

/**
 * A titled frame behind a group's items, in world space. Its title row is the drag handle (the board passes
 * onTitlePointerDown) and the rest of the frame pans the canvas. Double-click or Enter on the title renames it.
 */
export const GroupFrame = memo(function GroupFrame({
  group,
  count,
  autoRename,
  onTitlePointerDown,
  onRename,
  onUngroup,
}: {
  group: BoardGroup
  count: string
  /** Open with the title in edit mode (a group just made). */
  autoRename?: boolean
  onTitlePointerDown: (e: React.PointerEvent, groupId: string) => void
  /** Called with the new name, or null when editing ends without one. */
  onRename: (groupId: string, name: string | null) => void
  onUngroup: (groupId: string) => void
}) {
  const [editing, setEditing] = useState(!!autoRename)
  const done = (name: string | null) => {
    setEditing(false)
    const next = name?.trim()
    onRename(group.id, next && next !== group.name ? next : null)
  }
  return (
    <div
      data-frame={group.id}
      role="group"
      aria-label={`${group.name}, ${count}`}
      className="absolute rounded-xl bg-ink-3 shadow-[0_0_0_1px_rgb(var(--shadow-ink)/0.08)]"
      style={{ left: group.x, top: group.y, width: group.w, height: group.h }}
    >
      <div
        data-no-pan
        onPointerDown={(e) => onTitlePointerDown(e, group.id)}
        className="flex h-12 cursor-grab items-center gap-2 px-4 active:cursor-grabbing"
      >
        {editing ? (
          <input
            autoFocus
            data-no-drag
            defaultValue={group.name}
            aria-label="Group name"
            maxLength={MAX_NAME}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={(e) => done(e.currentTarget.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === "Enter") e.currentTarget.blur()
              if (e.key === "Escape") {
                e.currentTarget.value = group.name
                e.currentTarget.blur()
              }
            }}
            className="well h-7 min-w-0 flex-1 rounded-md px-2 text-xs text-ink-12 outline-none"
          />
        ) : (
          <button
            type="button"
            aria-label={`${group.name}. Press Enter to rename`}
            onDoubleClick={() => setEditing(true)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" && e.key !== "F2") return
              e.preventDefault()
              e.stopPropagation()
              setEditing(true)
            }}
            className="min-w-0 truncate rounded-sm text-xs text-ink-12 outline-offset-2"
          >
            {group.name}
          </button>
        )}
        {!editing && <span className="shrink-0 text-2xs text-ink-10">{count}</span>}
        <DropdownMenu>
          <DropdownMenuTrigger
            data-no-drag
            aria-label={`${group.name} actions`}
            className="press ml-auto grid size-7 shrink-0 place-items-center rounded-full text-ink-10 hover:bg-ink-4 hover:text-ink-12 data-popup-open:bg-ink-4"
          >
            <MoreHorizontalIcon className="size-4" />
          </DropdownMenuTrigger>
          {/* No focus return: "Rename" hands focus to the title field. */}
          <DropdownMenuContent align="end" finalFocus={false} className="w-40">
            <DropdownMenuItem onClick={() => setEditing(true)}>
              <PencilIcon /> Rename
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onUngroup(group.id)}>
              <GridIcon /> Ungroup
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
})
