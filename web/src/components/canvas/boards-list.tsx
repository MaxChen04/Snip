import { useEffect, useState } from "react"
import { Link, useLocation } from "wouter"
import { toast } from "sonner"
import { CheckIcon, PlusIcon, SearchIcon } from "@/components/icons"
import { collectionCountLabel } from "@/components/collection-picker"
import { api, fileUrl } from "@/lib/api"
import { useCollections } from "@/lib/collections"
import { cn } from "@/lib/utils"
import { MAX_NAME } from "../../../shared/types"

const row =
  "flex h-14 w-full shrink-0 items-center gap-3 rounded-md px-2 text-left transition-colors duration-150 ease-out hover:bg-ink-3 focus-visible:-outline-offset-2"

/** Three covers fanned back to front; the newest sits in front. Missing ones are soft placeholders. */
function CoverStack({ keys }: { keys: (string | null | undefined)[] }) {
  const spots = ["left-3 top-0 bg-ink-3", "left-1.5 top-[5px] bg-ink-4", "left-0 top-2.5 bg-ink-5"]
  return (
    <span aria-hidden className="relative h-[38px] w-[52px] shrink-0">
      {spots.map((spot, i) => {
        const key = keys[2 - i]
        const cls = cn("absolute h-7 w-10 rounded-sm", spot, i === 2 ? "shadow-button" : "ring-1 ring-fill-3")
        return key ? <img key={i} src={fileUrl(key)} alt="" loading="lazy" className={cn(cls, "object-cover object-top")} /> : <span key={i} className={cls} />
      })}
    </span>
  )
}

/**
 * Popover content listing boards: search, "All saves", each board with stacked covers and a count,
 * a check on the active one, and "New board" (inline name, then navigates to /b/:id).
 * The caller supplies the Popover and trigger (filter dock Boards button, top bar board switcher);
 * this sets its own 360 px width, so give the PopoverContent `className="w-auto p-1.5"`.
 */
export function BoardsList({
  activeId,
  onNavigate,
}: {
  /** The board being viewed; undefined is "All saves". */
  activeId?: string
  /** Called after navigating, so the caller can close its popover. */
  onNavigate?: () => void
}) {
  const { collections, refresh } = useCollections()
  const [, navigate] = useLocation()
  const [q, setQ] = useState("")
  const [naming, setNaming] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [all, setAll] = useState<{ count: number; covers: (string | null)[] }>()

  useEffect(() => {
    let live = true
    Promise.all([api.counts(), api.pages({}, null, 3)]).then(
      ([c, p]) => live && setAll({ count: c.pages + c.sections + c.images, covers: p.items.map((x) => x.desktopThumbKey) }),
      () => {},
    )
    return () => {
      live = false
    }
  }, [])

  const needle = q.trim().toLowerCase()
  const shown = collections.filter((c) => c.name.toLowerCase().includes(needle))
  const showAll = "all saves".includes(needle)
  const canCreateQuery = !!needle && !collections.some((c) => c.name.toLowerCase() === needle)

  const go = (href: string) => {
    navigate(href)
    onNavigate?.()
  }
  const create = async (raw: string) => {
    const name = raw.trim()
    if (!name || busy) return
    setBusy(true)
    try {
      const { id } = await api.createCollection(name)
      await refresh()
      go(`/b/${id}`)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  // Up and down move between the search field and the rows.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-nav]")]
    const i = items.indexOf(document.activeElement as HTMLElement)
    const next = items[e.key === "ArrowDown" ? Math.min(i + 1, items.length - 1) : Math.max(i - 1, 0)]
    if (!next) return
    e.preventDefault()
    next.focus()
  }

  return (
    <div onKeyDown={onKeyDown} className="flex w-[min(360px,calc(100vw-2rem))] flex-col gap-1">
      {collections.length > 0 && (
        <label className="well flex h-9 shrink-0 items-center gap-2 rounded-md px-3">
          <SearchIcon className="size-3.5 shrink-0 text-ink-9" />
          <input
            data-nav
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || !needle) return
              e.preventDefault()
              if (shown[0]) go(`/b/${shown[0].id}`)
              else if (showAll) go("/")
            }}
            placeholder="Find a board"
            aria-label="Find a board"
            className="h-full min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-ink-10 pointer-coarse:text-base"
          />
        </label>
      )}

      <div className="-mx-1.5 flex max-h-[min(20rem,50svh)] flex-col overflow-y-auto px-1.5">
        {showAll && (
          <Link href="/" data-nav onClick={onNavigate} aria-current={!activeId ? "page" : undefined} className={cn(row, !activeId && "bg-ink-3")}>
            <CoverStack keys={all?.covers ?? []} />
            <span className="grid min-w-0 flex-1 gap-0.5">
              <span className="truncate text-xs text-ink-12">All saves</span>
              <span className="truncate text-2xs text-ink-10 tabular-nums">{all ? `${all.count} ${all.count === 1 ? "item" : "items"}` : " "}</span>
            </span>
            {!activeId && <CheckIcon className="size-4 shrink-0 text-ink-12" />}
          </Link>
        )}
        {shown.map((c) => {
          const on = c.id === activeId
          return (
            <Link key={c.id} href={`/b/${c.id}`} data-nav onClick={onNavigate} aria-current={on ? "page" : undefined} className={cn(row, on && "bg-ink-3")}>
              <CoverStack keys={c.coverKeys} />
              <span className="grid min-w-0 flex-1 gap-0.5">
                <span className="truncate text-xs text-ink-12">{c.name}</span>
                <span className="truncate text-2xs text-ink-10 tabular-nums">{collectionCountLabel(c)}</span>
              </span>
              {on && <CheckIcon className="size-4 shrink-0 text-ink-12" />}
            </Link>
          )
        })}
        {!collections.length ? (
          <p className="px-2.5 py-2 text-2xs text-pretty text-ink-10">No boards yet. Make one for a project or a mood, then add saves to it.</p>
        ) : (
          needle && !shown.length && !showAll && <p className="truncate px-2.5 py-2 text-2xs text-ink-10">No boards match “{q.trim()}”</p>
        )}
      </div>

      <hr className="mx-1 border-t-[0.5px] border-line" />

      {naming === null ? (
        <button type="button" data-nav onClick={() => (canCreateQuery ? void create(q) : setNaming(""))} className={cn(row, "h-10 gap-2 px-2.5 pointer-coarse:h-11")}>
          <PlusIcon className="size-4 shrink-0 text-ink-11" />
          <span className="truncate text-xs text-ink-12">{canCreateQuery ? `Create “${q.trim()}”` : "New board"}</span>
        </button>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void create(naming)
          }}
          className="flex h-10 items-center gap-2 px-1 pointer-coarse:h-11"
        >
          <input
            data-nav
            autoFocus
            value={naming}
            onChange={(e) => setNaming(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Escape") return
              e.stopPropagation()
              setNaming(null)
            }}
            placeholder="e.g. Pricing pages"
            aria-label="Board name"
            maxLength={MAX_NAME}
            className="well h-8 min-w-0 flex-1 rounded-md px-2.5 text-xs outline-none placeholder:text-ink-10 pointer-coarse:h-10 pointer-coarse:text-base"
          />
          <button
            type="submit"
            disabled={!naming.trim() || busy}
            className="press h-8 shrink-0 rounded-md bg-primary px-3 text-xs tracking-[-0.01em] text-primary-foreground shadow-primary hover:bg-(--primary-hover) disabled:opacity-60 pointer-coarse:h-10 dark:disabled:bg-ink-4 dark:disabled:text-ink-8 dark:disabled:opacity-100 dark:disabled:shadow-none"
          >
            {busy ? "Creating…" : "Create"}
          </button>
        </form>
      )}
    </div>
  )
}
