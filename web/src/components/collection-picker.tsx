import { useState } from "react"
import { CheckIcon, PlusIcon, SearchIcon } from "lucide-react"
import { toast } from "sonner"
import { api, fileUrl, type Collection } from "@/lib/api"
import { useCollections } from "@/lib/collections"
import { cn } from "@/lib/utils"

/** Square cover for a collection: newest reference cover, or a soft 2x2 placeholder. */
export function CollectionThumb({ c, className }: { c?: Collection; className?: string }) {
  const key = c?.coverKeys[0]
  return key ? (
    <img src={fileUrl(key)} alt="" className={cn("size-9 shrink-0 rounded-lg object-cover object-top ring-1 ring-border", className)} />
  ) : (
    <span className={cn("grid size-9 shrink-0 grid-cols-2 gap-0.5 overflow-hidden rounded-lg bg-fill-1 p-1", className)}>
      {[0, 1, 2, 3].map((i) => (
        <span key={i} className="rounded-[3px] bg-fill-3" />
      ))}
    </span>
  )
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** "2 websites · 5 pages", leaving out whichever is zero. */
export function collectionCountLabel(c: Pick<Collection, "referenceCount" | "pageCount">) {
  const parts = [c.referenceCount && plural(c.referenceCount, "website", "websites"), c.pageCount && plural(c.pageCount, "page", "pages")].filter(Boolean)
  return parts.length ? parts.join(" · ") : "Empty"
}

export function CheckCircle({ on }: { on: boolean }) {
  return (
    <span
      className={cn(
        "grid size-5 shrink-0 place-items-center rounded-full ring-1 ring-fill-4 transition-colors",
        on && "bg-foreground text-background ring-foreground",
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

  const row = "flex w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left transition-colors hover:bg-fill-1"
  return (
    <div className={cn("flex min-h-0 flex-col gap-2", className)}>
      {collections.length > 4 && (
        <label className="flex h-9 shrink-0 items-center gap-2 rounded-full px-3 ring-1 ring-border focus-within:ring-2 focus-within:ring-ring/30">
          <SearchIcon className="size-3.5 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search collections…"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
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
              className="h-8 min-w-0 flex-1 rounded-lg bg-fill-1 px-2.5 text-sm outline-none focus:ring-2 focus:ring-ring/30"
            />
            <button type="submit" className="h-8 rounded-full bg-foreground px-3 text-xs font-medium text-background">
              Create
            </button>
          </form>
        ) : (
          <button type="button" onClick={() => (q.trim() ? void create() : setCreating(true))} className={row}>
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-fill-1">
              <PlusIcon className="size-4" />
            </span>
            <span className="grid min-w-0 flex-1">
              <span className="truncate text-sm font-medium">{q.trim() ? `Create “${q.trim()}”` : "New collection"}</span>
              <span className="text-2xs text-muted-foreground">Group references by project or mood</span>
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
                <span className="text-2xs text-muted-foreground">{collectionCountLabel(c)}</span>
              </span>
              <CheckCircle on={on} />
            </button>
          )
        })}
      </div>
    </div>
  )
}
