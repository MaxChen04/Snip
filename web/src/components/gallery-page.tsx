import { useEffect, useState } from "react"
import { Link, useLocation, useSearch } from "wouter"
import { AlertCircleIcon, ArrowUpRightIcon, BookmarkIcon, CheckIcon, ChevronDownIcon, CornerDownLeftIcon, GlobeIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"
import { useAddFlow } from "@/components/add-flow"
import { CollectionPicker, CollectionThumb } from "@/components/collection-picker"
import { GifTile } from "@/components/reference-page"
import { SiteIcon } from "@/components/site-icon"
import { ActionCircle, TopBar, type View } from "@/components/top-bar"
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Folder, FOLDER_SCALE, type FolderSize } from "@/components/ui/folder"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { useInfinite } from "@/hooks/use-infinite"
import { api, fileUrl, type AnimationWithRef, type Filters, type PageWithRef, type Reference, type Sort } from "@/lib/api"
import { useCollections } from "@/lib/collections"
import { masonryCols, readPref, useGridSize, writePref, type GridSize } from "@/lib/prefs"
import { cn } from "@/lib/utils"

const SORT_LABEL: Record<Sort, string> = { newest: "Newest", oldest: "Oldest", name: "A–Z" }
const NOUN: Record<View, [string, string]> = { websites: ["website", "websites"], pages: ["page", "pages"], animations: ["animation", "animations"] }

export function GalleryPage({ login }: { login: string }) {
  const search = useSearch()
  const [, navigate] = useLocation()
  const params = new URLSearchParams(search)
  const collection = params.get("collection") ?? undefined
  const setCollection = (id?: string) => navigate(id ? `/?collection=${id}` : "/", { replace: true })

  const [view, setView] = useState<View>(() => (params.get("view") as View) || readPref("rs.view", "websites"))
  const [sort, setSort] = useState<Sort>(() => readPref("rs.sort", "newest"))
  const [query, setQuery] = useState("")
  const [q, setQ] = useState("")
  const [count, setCount] = useState<number | null>(null)

  useEffect(() => {
    const t = setTimeout(() => setQ(query.trim()), 250)
    return () => clearTimeout(t)
  }, [query])

  const changeView = (v: View) => {
    setView(v)
    writePref("rs.view", v)
  }
  const effectiveSort: Sort = view === "websites" ? sort : sort === "name" ? "newest" : sort
  const filters: Filters = { q, collection, sort: effectiveSort }

  return (
    <div className="min-h-svh">
      <TopBar login={login} view={view} onView={changeView} query={query} onQuery={setQuery} collection={collection} />

      <CollectionStrip active={collection} onSelect={setCollection} />
      {collection ? <CollectionHeader id={collection} onDeleted={() => setCollection(undefined)} /> : null}

      <div className="flex items-center gap-3 px-4 pt-5 pb-4 sm:px-6">
        <p className="hidden text-xs text-muted-foreground sm:block">
          {q ? <>Results for <span className="text-foreground">“{q}”</span></> : count !== null && `${count}${count >= 30 ? "+" : ""} ${NOUN[view][count === 1 ? 0 : 1]}`}
        </p>
        <div className="ml-auto flex items-center gap-2">
          <div className="flex rounded-full bg-fill-1 p-0.5 sm:hidden">
            {(["websites", "pages", "animations"] as View[]).map((v) => (
              <button
                key={v}
                onClick={() => changeView(v)}
                className={cn("h-7 rounded-full px-2.5 text-2xs font-medium text-muted-foreground capitalize", view === v && "bg-background text-foreground shadow-xs ring-1 ring-border")}
              >
                {v}
              </button>
            ))}
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger className="flex h-8 items-center gap-1 rounded-full px-3 text-xs font-medium text-muted-foreground hover:bg-fill-1 hover:text-foreground data-popup-open:bg-fill-1">
              {SORT_LABEL[effectiveSort]} <ChevronDownIcon className="size-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="rounded-2xl p-1.5">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Sort by</DropdownMenuLabel>
                {(["newest", "oldest", ...(view === "websites" ? ["name"] : [])] as Sort[]).map((s) => (
                  <DropdownMenuItem
                    key={s}
                    onClick={() => {
                      setSort(s)
                      writePref("rs.sort", s)
                    }}
                  >
                    <CheckIcon className={cn(effectiveSort !== s && "invisible")} /> {SORT_LABEL[s]}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="px-4 pb-28 sm:px-6">
        {view === "websites" && <WebsitesGrid filters={filters} onCount={setCount} />}
        {view === "pages" && <PagesGrid filters={filters} onCount={setCount} />}
        {view === "animations" && <AnimationsGrid filters={filters} onCount={setCount} />}
      </div>
    </div>
  )
}

// ---------- Collections ----------

function CollectionStrip({ active, onSelect }: { active?: string; onSelect: (id?: string) => void }) {
  const { collections } = useCollections()
  const { newCollection } = useAddFlow()
  const chip = "flex h-9 shrink-0 items-center gap-2 rounded-full pr-3.5 text-xs font-medium transition-colors"
  const on = "bg-foreground text-background"
  const off = "bg-fill-1 text-foreground hover:bg-fill-2"
  return (
    <div className="flex gap-1.5 overflow-x-auto px-4 py-1 sm:px-6 [scrollbar-width:none]">
      <button onClick={() => onSelect(undefined)} className={cn(chip, "pl-3.5", !active ? on : off)}>
        Everything
      </button>
      {collections.map((c) => (
        <button key={c.id} onClick={() => onSelect(c.id)} className={cn(chip, "pl-1", active === c.id ? on : off)}>
          <CollectionThumb c={c} className="size-7 rounded-full ring-0 [&>span]:rounded-full" />
          {c.name}
          <span className={cn("tabular-nums", active === c.id ? "text-background/55" : "text-muted-foreground")}>{c.referenceCount}</span>
        </button>
      ))}
      <button onClick={newCollection} className={cn(chip, "pl-3 text-muted-foreground ring-1 ring-border ring-inset hover:bg-fill-1 hover:text-foreground")}>
        <PlusIcon className="size-3.5" /> New collection
      </button>
    </div>
  )
}

function CollectionHeader({ id, onDeleted }: { id: string; onDeleted: () => void }) {
  const { collections, refresh } = useCollections()
  const { addReference } = useAddFlow()
  const [editing, setEditing] = useState(false)
  const c = collections.find((x) => x.id === id)
  if (!c) return null

  const rename = async (name: string) => {
    setEditing(false)
    if (!name.trim() || name.trim() === c.name) return
    await api.renameCollection(c.id, name.trim())
    await refresh()
  }

  return (
    <div className="flex flex-col items-center gap-4 px-4 pt-10 pb-2 text-center">
      {c.coverKeys.length > 0 && (
        <div className="flex -space-x-3">
          {c.coverKeys.map((k, i) => (
            <img
              key={k}
              src={fileUrl(k)}
              alt=""
              className="size-12 rounded-xl object-cover object-top shadow-sm ring-2 ring-background"
              style={{ transform: `rotate(${(i - (c.coverKeys.length - 1) / 2) * 6}deg)` }}
            />
          ))}
        </div>
      )}
      <div>
        {editing ? (
          <input
            autoFocus
            defaultValue={c.name}
            onBlur={(e) => void rename(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur()
              if (e.key === "Escape") setEditing(false)
            }}
            className="w-64 rounded-lg bg-fill-1 text-center text-2xl font-medium outline-none"
          />
        ) : (
          <h1 className="text-2xl font-medium tracking-tight">{c.name}</h1>
        )}
        <p className="mt-1 text-xs text-muted-foreground">
          {c.referenceCount} {c.referenceCount === 1 ? "reference" : "references"}
        </p>
      </div>
      <div className="flex items-start gap-6">
        <ActionCircle icon={<PlusIcon />} label="Add" onClick={() => addReference(c.id)} />
        <ActionCircle icon={<PencilIcon />} label="Rename" onClick={() => setEditing(true)} />
        <ActionCircle
          icon={<Trash2Icon />}
          label="Delete"
          onClick={async () => {
            if (!confirm(`Delete collection "${c.name}"? References stay in your library.`)) return
            await api.deleteCollection(c.id)
            await refresh()
            onDeleted()
          }}
        />
      </div>
    </div>
  )
}

// ---------- Grids ----------

function useReloadEvent(reload: () => void) {
  useEffect(() => {
    window.addEventListener("rs:reload", reload)
    return () => window.removeEventListener("rs:reload", reload)
  }, [reload])
}

export function Masonry({ children }: { children: React.ReactNode }) {
  const [grid] = useGridSize()
  return <div className={cn(masonryCols[grid], "gap-4 lg:gap-5 [&>*]:mb-4 lg:[&>*]:mb-5 [&>*]:break-inside-avoid")}>{children}</div>
}

function GridFooter({ loading, done, count, sentinel, empty }: { loading: boolean; done: boolean; count: number; sentinel: React.RefObject<HTMLDivElement | null>; empty: React.ReactNode }) {
  if (!loading && done && count === 0) return <>{empty}</>
  return (
    <div ref={sentinel} className="flex justify-center py-10">
      {loading && count > 0 && <Spinner className="text-muted-foreground" />}
      {done && count > 0 && <span className="size-1.5 rounded-full bg-fill-3" aria-hidden />}
    </div>
  )
}

function SkeletonGrid() {
  return (
    <Masonry>
      {Array.from({ length: 12 }, (_, i) => (
        <Skeleton key={i} className={cn("w-full rounded-md", ["aspect-[16/10]", "aspect-[4/5]", "aspect-[16/11]", "aspect-square"][i % 4])} />
      ))}
    </Masonry>
  )
}

/** Captionless image tile. Hover reveals a source chip (bottom) and optional actions (top right). */
function Tile({
  href,
  children,
  label,
  domain,
  external,
  actions,
  overlay,
}: {
  href: string
  children: React.ReactNode
  label: string
  domain: string
  external?: string
  actions?: React.ReactNode
  overlay?: React.ReactNode
}) {
  return (
    <div className="group relative">
      <Link href={href} className="block overflow-hidden rounded-md bg-fill-1 ring-1 ring-black/5 transition-[box-shadow] group-hover:shadow-md dark:ring-white/5">
        {children}
        {overlay}
        <span className="pointer-events-none absolute inset-0 rounded-md bg-black/0 transition-colors group-hover:bg-black/[0.04]" />
      </Link>
      <div className="pointer-events-none absolute inset-x-2 bottom-2 flex translate-y-1 justify-start opacity-0 transition-all duration-200 group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:translate-y-0 group-focus-within:opacity-100">
        <a
          href={external ?? `https://${domain}`}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="pointer-events-auto flex h-7 max-w-full items-center gap-1.5 rounded-full bg-background/95 pr-2.5 pl-1.5 text-2xs font-medium text-foreground shadow-sm ring-1 ring-black/5 backdrop-blur hover:bg-background"
          title={label}
        >
          <SiteIcon domain={domain} />
          <span className="truncate">{label}</span>
          <ArrowUpRightIcon className="size-3 shrink-0 text-muted-foreground" />
        </a>
      </div>
      {actions && (
        <div className="absolute top-2 right-2 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 has-[[data-popup-open]]:opacity-100">
          {actions}
        </div>
      )}
    </div>
  )
}

/** Quick "save to collection" from any tile, toggling membership live. */
function SaveButton({ r }: { r: Reference }) {
  const { refresh } = useCollections()
  const [ids, setIds] = useState(r.collectionIds)
  const saved = ids.length > 0
  return (
    <Popover>
      <PopoverTrigger
        className={cn(
          "flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium shadow-sm ring-1 ring-black/5 backdrop-blur",
          saved ? "bg-foreground text-background" : "bg-background/95 text-foreground hover:bg-background",
        )}
      >
        <BookmarkIcon className={cn("size-3.5", saved && "fill-current")} />
        {saved ? "Saved" : "Save"}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 rounded-3xl p-3">
        <CollectionPicker
          className="max-h-72"
          selected={ids}
          onToggle={async (cid, on) => {
            setIds((s) => (on ? [...s, cid] : s.filter((x) => x !== cid)))
            try {
              await api.setMembership(r.id, cid, on)
              await refresh()
            } catch (err) {
              setIds((s) => (on ? s.filter((x) => x !== cid) : [...s, cid]))
              toast.error((err as Error).message)
            }
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

function useCountReport(n: number, loading: boolean, onCount: (n: number | null) => void) {
  useEffect(() => onCount(loading && n === 0 ? null : n), [n, loading, onCount])
}

function WebsitesGrid({ filters, onCount }: { filters: Filters; onCount: (n: number | null) => void }) {
  const list = useInfinite<Reference>((cursor) => api.references(filters, cursor), [filters.q, filters.collection, filters.sort])
  useReloadEvent(list.reload)
  useCountReport(list.items.length, list.loading, onCount)

  // Poll while any capture is in flight.
  const busy = list.items.some((r) => r.status === "queued" || r.status === "capturing")
  useEffect(() => {
    if (!busy) return
    const t = setInterval(() => void list.refreshHead(), 4000)
    return () => clearInterval(t)
  }, [busy, list.refreshHead])

  if (list.loading && !list.items.length) return <SkeletonGrid />
  return (
    <>
      <FolderGrid>
        {list.items.map((r) => (
          <FolderTile key={r.id} r={r} />
        ))}
      </FolderGrid>
      <GridFooter {...list} count={list.items.length} empty={filters.q || filters.collection ? <EmptyNote filtered={!!filters.q} collection={filters.collection} /> : <Welcome />} />
    </>
  )
}

const FOLDER_SIZE: Record<GridSize, FolderSize> = { s: "sm", m: "md", l: "lg" }

function FolderGrid({ children }: { children: React.ReactNode }) {
  const [grid] = useGridSize()
  const w = Math.round(321 * FOLDER_SCALE[FOLDER_SIZE[grid]])
  return (
    <div className="grid justify-items-center gap-x-6 gap-y-12" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${w}px, 1fr))` }}>
      {children}
    </div>
  )
}

/** A website as a folder of its page screenshots. Hovering fans the pages out. */
function FolderTile({ r }: { r: Reference }) {
  const [grid] = useGridSize()
  const [hovered, setHovered] = useState(false)
  const images = (r.previewKeys.length ? r.previewKeys : r.coverKey ? [r.coverKey] : []).map(fileUrl)
  const ready = r.status === "ready"
  return (
    <div className="group relative flex flex-col items-center" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      <Link
        href={`/r/${r.id}`}
        aria-label={r.title || r.domain}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
        className={cn("rounded-3xl outline-none focus-visible:ring-2 focus-visible:ring-ring/40", !ready && "opacity-70")}
      >
        <Folder images={images} hovered={hovered} size={FOLDER_SIZE[grid]} />
      </Link>
      <div className="mt-3 flex max-w-full items-center gap-1.5 px-2">
        <SiteIcon domain={r.domain} />
        <Link href={`/r/${r.id}`} className="truncate text-sm font-medium">
          {r.title || r.domain}
        </Link>
      </div>
      <FolderMeta r={r} />
      {ready && (
        <div className="absolute top-0 right-0 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 has-[[data-popup-open]]:opacity-100">
          <SaveButton r={r} />
        </div>
      )}
    </div>
  )
}

function FolderMeta({ r }: { r: Reference }) {
  if (r.status === "failed") {
    return (
      <span className="mt-1 flex max-w-[90%] items-center gap-1 text-2xs text-destructive-foreground" title={r.error ?? undefined}>
        <AlertCircleIcon className="size-3 shrink-0" />
        <span className="truncate">{r.error ?? "Capture failed"}</span>
      </span>
    )
  }
  if (r.status !== "ready") {
    const m = r.progress?.match(/(\d+)\/(\d+)/)
    const pct = m ? Math.min(100, (Number(m[1]) / Number(m[2])) * 100) : r.status === "queued" ? 4 : 12
    return (
      <div className="mt-1.5 flex flex-col items-center gap-1">
        <div className="h-1 w-28 overflow-hidden rounded-full bg-fill-3">
          <div className="h-full rounded-full bg-foreground transition-[width] duration-700" style={{ width: `${pct}%` }} />
        </div>
        <span className="text-2xs text-muted-foreground">{r.status === "queued" ? "Waiting for capture agent" : m ? `${m[1]} of ${m[2]} pages` : "Capturing"}</span>
      </div>
    )
  }
  return (
    <span className="mt-0.5 text-2xs text-muted-foreground">
      {r.domain} · {r.pageCount} {r.pageCount === 1 ? "page" : "pages"}
      {r.animationCount > 0 && ` · ${r.animationCount} ${r.animationCount === 1 ? "GIF" : "GIFs"}`}
    </span>
  )
}

function PagesGrid({ filters, onCount }: { filters: Filters; onCount: (n: number | null) => void }) {
  const list = useInfinite<PageWithRef>((cursor) => api.pages(filters, cursor), [filters.q, filters.collection, filters.sort])
  useReloadEvent(list.reload)
  useCountReport(list.items.length, list.loading, onCount)
  if (list.loading && !list.items.length) return <SkeletonGrid />
  return (
    <>
      <Masonry>
        {list.items.map((p) => (
          <Tile key={p.id} href={`/r/${p.referenceId}?page=${p.id}`} label={`${p.reference.domain}${p.path === "/" ? "" : p.path}`} domain={p.reference.domain} external={p.url}>
            <img src={fileUrl(p.desktopThumbKey)} alt={p.title ?? p.path} loading="lazy" className="aspect-[16/10] w-full object-cover object-top" />
          </Tile>
        ))}
      </Masonry>
      <GridFooter {...list} count={list.items.length} empty={<EmptyNote filtered={!!filters.q} collection={filters.collection} />} />
    </>
  )
}

function AnimationsGrid({ filters, onCount }: { filters: Filters; onCount: (n: number | null) => void }) {
  const list = useInfinite<AnimationWithRef>((cursor) => api.animations(filters, cursor), [filters.q, filters.collection, filters.sort])
  useReloadEvent(list.reload)
  useCountReport(list.items.length, list.loading, onCount)
  if (list.loading && !list.items.length) return <SkeletonGrid />
  return (
    <>
      <Masonry>
        {list.items.map((a) => (
          <Tile
            key={a.id}
            href={`/r/${a.referenceId}?tab=animations`}
            label={`${a.kind === "scroll" ? "Scroll" : "Hover"} · ${a.label || a.reference.domain}`}
            domain={a.reference.domain}
          >
            <GifTile a={a} bare />
          </Tile>
        ))}
      </Masonry>
      <GridFooter {...list} count={list.items.length} empty={<EmptyNote filtered={!!filters.q} collection={filters.collection} />} />
    </>
  )
}

const EXAMPLES = ["linear.app", "stripe.com", "vercel.com", "rauno.me"]

/** First-run empty state: a big fake URL bar that opens the add flow, plus one-click examples. */
function Welcome() {
  const { addReference } = useAddFlow()
  return (
    <div className="mx-auto flex max-w-lg flex-col items-center gap-6 py-20 text-center sm:py-28">
      <div className="grid grid-cols-3 gap-1.5 opacity-80" aria-hidden>
        {["h-10", "h-14", "h-8", "h-12", "h-8", "h-14"].map((h, i) => (
          <span key={i} className={cn("w-12 rounded-md bg-fill-2", h, i % 2 && "bg-fill-3")} />
        ))}
      </div>
      <div className="space-y-1.5">
        <h2 className="text-2xl font-medium tracking-tight">Start your shelf</h2>
        <p className="text-sm text-muted-foreground">Paste a website. Your capture agent saves screenshots, styles and motion.</p>
      </div>
      <button
        onClick={() => addReference()}
        className="flex h-14 w-full items-center gap-3 rounded-2xl bg-fill-1 px-4 text-left text-base text-muted-foreground ring-1 ring-transparent transition-all hover:bg-background hover:shadow-sm hover:ring-border"
      >
        <GlobeIcon className="size-5" />
        <span className="flex-1">Paste a website URL</span>
        <kbd className="grid size-7 place-items-center rounded-lg bg-background ring-1 ring-border">
          <CornerDownLeftIcon className="size-3.5" />
        </kbd>
      </button>
      <div className="flex flex-wrap justify-center gap-1.5">
        <span className="h-7 content-center pr-1 text-2xs text-muted-foreground">Try</span>
        {EXAMPLES.map((d) => (
          <button key={d} onClick={() => addReference(undefined, d)} className="flex h-7 items-center gap-1.5 rounded-full bg-fill-1 pr-2.5 pl-1 text-2xs font-medium hover:bg-fill-2">
            <SiteIcon domain={d} className="size-5 rounded-full" />
            {d}
          </button>
        ))}
      </div>
    </div>
  )
}

function EmptyNote({ filtered, collection }: { filtered: boolean; collection?: string }) {
  const { addReference } = useAddFlow()
  return (
    <div className="flex flex-col items-center gap-3 py-24 text-center">
      <p className="text-sm font-medium">{filtered ? "No matches" : "Nothing here yet"}</p>
      <p className="max-w-xs text-xs text-muted-foreground">{filtered ? "Try a different word, or clear the search." : "Captured pages and animations show up here."}</p>
      {!filtered && (
        <button onClick={() => addReference(collection)} className="mt-1 flex h-9 items-center gap-1.5 rounded-full bg-foreground px-4 text-xs font-medium text-background hover:bg-foreground/85">
          <PlusIcon className="size-3.5" /> Add reference
        </button>
      )}
    </div>
  )
}
