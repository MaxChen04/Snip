import { useState } from "react"
import { CheckIcon, PlusIcon, SearchIcon } from "@/components/icons"
import { toast } from "sonner"
import { api, fileUrl, type Collection } from "@/lib/api"
import { useCollections } from "@/lib/collections"
import { cn } from "@/lib/utils"

/** Square cover for a collection: newest reference cover, or a soft 2x2 placeholder. */
export function CollectionThumb({ c, className }: { c?: Collection; className?: string }) {
  const key = c?.coverKeys[0]
  return key ? (
    <img src={fileUrl(key)} alt="" className={cn("size-9 shrink-0 rounded-md object-cover object-top shadow-button", className)} />
  ) : (
    <span className={cn("grid size-9 shrink-0 grid-cols-2 gap-0.5 overflow-hidden rounded-md bg-ink-3 p-1", className)}>
      {[0, 1, 2, 3].map((i) => (
        <span key={i} className="rounded-[2px] bg-ink-5" />
      ))}
    </span>
  )
}

export function CheckCircle({ on }: { on: boolean }) {
  return (
    <span
      className={cn(
        "grid size-[18px] shrink-0 place-items-center rounded-sm ring-[1.5px] ring-ink-6 ring-inset transition-[background-color,box-shadow] duration-150 ease-out",
        on && "bg-ink-12 text-ink-1 ring-0",
      )}
    >
      {on && <CheckIcon className="size-3" strokeWidth={3} />}
    </span>
  )
}

/**
 * Cosmos "save to" list: search, a "New collection" row and one row per collection with a
 * round check. Selection is controlled so it works both before a reference exists (add flow)
 * and for live membership toggles.
 */
export function CollectionPicker({
  selected,
  onToggle,
  className,
}: {
  selected: string[]
  onToggle: (id: string, on: boolean) => void
  className?: string
}) {
  const { collections, refresh } = useCollections()
  const [q, setQ] = useState("")
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState("")
  const shown = collections.filter((c) => c.name.toLowerCase().includes(q.trim().toLowerCase()))

  const create = async () => {
    const n = (name || q).trim()
    if (!n) return setCreating(false)
    try {
      const { id } = await api.createCollection(n)
      await refresh()
      onToggle(id, true)
      setName("")
      setQ("")
      setCreating(false)
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  const row = "flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left transition-colors duration-150 ease-out hover:bg-ink-3"
  return (
    <div className={cn("flex min-h-0 flex-col gap-2", className)}>
      {collections.length > 4 && (
        <label className="well flex h-8 shrink-0 items-center gap-2 rounded-lg px-2.5">
          <SearchIcon className="size-3.5 text-ink-9" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search collections…"
            className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-ink-10"
          />
        </label>
      )}
      <div className="-mx-2 min-h-0 overflow-y-auto px-2">
        {creating ? (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void create()
            }}
            className={cn(row, "hover:bg-transparent")}
          >
            <CollectionThumb />
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation()
                  setCreating(false)
                }
              }}
              placeholder="Collection name"
              className="well h-8 min-w-0 flex-1 rounded-lg px-2.5 text-xs outline-none focus:bg-ink-4"
            />
            <button type="submit" className="press h-8 rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground shadow-primary hover:bg-(--primary-hover)">
              Create
            </button>
          </form>
        ) : (
          <button type="button" onClick={() => (q.trim() ? void create() : setCreating(true))} className={row}>
            <span className="tactile grid size-9 shrink-0 place-items-center rounded-md">
              <PlusIcon className="size-4 text-ink-11" />
            </span>
            <span className="grid min-w-0 flex-1">
              <span className="truncate text-sm font-medium">{q.trim() ? `Create “${q.trim()}”` : "New collection"}</span>
              <span className="text-2xs text-ink-11">Group references by project or mood</span>
            </span>
          </button>
        )}
        {shown.map((c) => {
          const on = selected.includes(c.id)
          return (
            <button key={c.id} type="button" role="checkbox" aria-checked={on} onClick={() => onToggle(c.id, !on)} className={row}>
              <CollectionThumb c={c} />
              <span className="grid min-w-0 flex-1">
                <span className="truncate text-sm font-medium">{c.name}</span>
                <span className="text-2xs text-muted-foreground">
                  {c.referenceCount} {c.referenceCount === 1 ? "reference" : "references"}
                </span>
              </span>
              <CheckCircle on={on} />
            </button>
          )
        })}
      </div>
    </div>
  )
}
