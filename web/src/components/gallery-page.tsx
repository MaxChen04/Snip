import { useEffect, useState } from "react"
import { Link, useSearch } from "wouter"
import { AlertCircleIcon, ArrowDownUpIcon, CheckIcon, GlobeIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"
import { AddReferenceDialog } from "@/components/add-reference-dialog"
import { GifTile } from "@/components/reference-page"
import { ActionCircle, TopBar, type View } from "@/components/top-bar"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { useInfinite } from "@/hooks/use-infinite"
import { api, fileUrl, type AnimationWithRef, type Filters, type PageWithRef, type Reference, type Sort } from "@/lib/api"
import { useCollections } from "@/lib/collections"
import { masonryCols, readPref, useGridSize, writePref } from "@/lib/prefs"
import { cn } from "@/lib/utils"

const SORT_LABEL: Record<Sort, string> = { newest: "Newest", oldest: "Oldest", name: "Name" }

export function GalleryPage({ login }: { login: string }) {
  const params = new URLSearchParams(useSearch())
  const [view, setView] = useState<View>(() => (params.get("view") as View) || readPref("rs.view", "websites"))
  const [sort, setSort] = useState<Sort>(() => readPref("rs.sort", "newest"))
  const [collection, setCollection] = useState<string | undefined>(() => params.get("collection") ?? undefined)
  const [query, setQuery] = useState("")
  const [q, setQ] = useState("")
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setQ(query.trim()), 250)
    return () => clearTimeout(t)
  }, [query])

  useEffect(() => {
    const url = new URL(location.href)
    url.searchParams.delete("view")
    if (collection) url.searchParams.set("collection", collection)
    else url.searchParams.delete("collection")
    history.replaceState(null, "", url)
  }, [collection])

  const effectiveSort: Sort = view === "websites" ? sort : sort === "name" ? "newest" : sort
  const filters: Filters = { q, collection, sort: effectiveSort }

  return (
    <div className="min-h-svh">
      <TopBar
        login={login}
        view={view}
        onView={(v) => {
          setView(v)
          writePref("rs.view", v)
        }}
        query={query}
        onQuery={setQuery}
        onAdd={() => setAdding(true)}
      />
      <AddReferenceDialog
        key={collection ?? "all"}
        open={adding}
        onOpenChange={setAdding}
        defaultCollection={collection}
        onAdded={() => {
          setAdding(false)
          window.dispatchEvent(new Event("rs:reload"))
        }}
      />

      <CollectionStrip active={collection} onSelect={setCollection} />

      {collection ? (
        <CollectionHeader id={collection} onDeleted={() => setCollection(undefined)} onAdd={() => setAdding(true)} />
      ) : null}

      <div className="flex items-center gap-3 px-4 pt-4 pb-5 sm:px-6">
        <h1 className="hidden text-lg font-medium sm:block">{q ? `“${q}”` : collection ? "" : { websites: "All websites", pages: "All pages", animations: "All animations" }[view]}</h1>
        <div className="ml-auto flex items-center gap-2">
          {/* Mobile view switcher (the pill nav is hidden on small screens) */}
          <div className="flex rounded-full bg-fill-2 p-0.5 sm:hidden">
            {(["websites", "pages", "animations"] as View[]).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={cn("h-7 rounded-full px-2.5 text-2xs font-medium text-muted-foreground capitalize", view === v && "bg-background text-foreground shadow-xs")}
              >
                {v}
              </button>
            ))}
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="outline" size="sm" className="rounded-full" />}>
              {SORT_LABEL[effectiveSort]} <ArrowDownUpIcon data-icon="inline-end" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
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

      <div className="px-4 pb-24 sm:px-6">
        {view === "websites" && <WebsitesGrid filters={filters} onAdd={() => setAdding(true)} />}
        {view === "pages" && <PagesGrid filters={filters} />}
        {view === "animations" && <AnimationsGrid filters={filters} />}
      </div>
    </div>
  )
}

// ---------- Collections ----------

function CollectionStrip({ active, onSelect }: { active?: string; onSelect: (id?: string) => void }) {
  const { collections, refresh } = useCollections()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState("")

  const create = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return setCreating(false)
    try {
      const { id } = await api.createCollection(name.trim())
      await refresh()
      setName("")
      setCreating(false)
      onSelect(id)
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  const chip = "h-8 shrink-0 rounded-full px-3.5 text-xs font-medium ring-1 ring-border transition-colors"
  return (
    <div className="flex gap-2 overflow-x-auto px-4 py-1 sm:px-6 [scrollbar-width:none]">
      <button onClick={() => onSelect(undefined)} className={cn(chip, !active ? "bg-foreground text-background ring-transparent" : "hover:bg-fill-2")}>
        Everything
      </button>
      {collections.map((c) => (
        <button
          key={c.id}
          onClick={() => onSelect(c.id)}
          className={cn(chip, "flex items-center gap-1.5", active === c.id ? "bg-foreground text-background ring-transparent" : "hover:bg-fill-2")}
        >
          {c.name}
          <span className={cn("text-2xs", active === c.id ? "text-background/60" : "text-muted-foreground")}>{c.referenceCount}</span>
        </button>
      ))}
      {creating ? (
        <form onSubmit={create}>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={create}
            onKeyDown={(e) => e.key === "Escape" && setCreating(false)}
            placeholder="Collection name"
            className={cn(chip, "w-44 bg-transparent outline-none focus:ring-2 focus:ring-primary")}
          />
        </form>
      ) : (
        <button onClick={() => setCreating(true)} className={cn(chip, "flex items-center gap-1 border-dashed text-muted-foreground hover:bg-fill-2 hover:text-foreground")}>
          <PlusIcon className="size-3.5" /> New collection
        </button>
      )}
    </div>
  )
}

function CollectionHeader({ id, onDeleted, onAdd }: { id: string; onDeleted: () => void; onAdd: () => void }) {
  const { collections, refresh } = useCollections()
  const c = collections.find((x) => x.id === id)
  if (!c) return null
  return (
    <div className="flex flex-col items-center gap-3 px-4 pt-10 pb-2 text-center">
      <div>
        <h1 className="text-2xl font-medium">{c.name}</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          {c.referenceCount} {c.referenceCount === 1 ? "reference" : "references"}
        </p>
      </div>
      <div className="mt-2 flex items-start gap-6">
        <ActionCircle icon={<PlusIcon />} label="Add" onClick={onAdd} />
        <ActionCircle
          icon={<PencilIcon />}
          label="Rename"
          onClick={async () => {
            const next = prompt("Rename collection", c.name)
            if (next?.trim()) {
              await api.renameCollection(c.id, next.trim())
              await refresh()
            }
          }}
        />
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
  return <div className={cn(masonryCols[grid], "gap-4 [&>*]:mb-4 [&>*]:break-inside-avoid")}>{children}</div>
}

function GridFooter({ loading, done, count, sentinel, empty }: { loading: boolean; done: boolean; count: number; sentinel: React.RefObject<HTMLDivElement | null>; empty: React.ReactNode }) {
  if (!loading && done && count === 0) return <>{empty}</>
  return (
    <div ref={sentinel} className="flex justify-center py-8">
      {loading && count > 0 && <Spinner className="text-muted-foreground" />}
    </div>
  )
}

function SkeletonGrid() {
  return (
    <Masonry>
      {Array.from({ length: 10 }, (_, i) => (
        <Skeleton key={i} className={cn("w-full rounded-sm", ["aspect-[4/5]", "aspect-[16/10]", "aspect-square"][i % 3])} />
      ))}
    </Masonry>
  )
}

/** Image tile with metadata revealed on hover, Cosmos-style. */
function Tile({ href, children, title, subtitle, overlay }: { href: string; children: React.ReactNode; title: string; subtitle?: string; overlay?: React.ReactNode }) {
  return (
    <Link href={href} className="group relative block overflow-hidden rounded-sm bg-fill-1">
      {children}
      {overlay}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 translate-y-1 bg-gradient-to-t from-black/60 via-black/25 to-transparent px-3 pt-10 pb-2.5 opacity-0 transition-all duration-200 group-hover:translate-y-0 group-hover:opacity-100">
        <div className="truncate text-xs font-medium text-white">{title}</div>
        {subtitle && <div className="truncate text-2xs text-white/75">{subtitle}</div>}
      </div>
    </Link>
  )
}

function WebsitesGrid({ filters, onAdd }: { filters: Filters; onAdd: () => void }) {
  const list = useInfinite<Reference>((cursor) => api.references(filters, cursor), [filters.q, filters.collection, filters.sort])
  useReloadEvent(list.reload)

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
      <Masonry>
        {list.items.map((r) => (
          <Tile
            key={r.id}
            href={`/r/${r.id}`}
            title={r.title || r.domain}
            subtitle={[r.domain, r.pageCount > 1 && `${r.pageCount} pages`, r.animationCount > 0 && `${r.animationCount} GIFs`].filter(Boolean).join(" · ")}
            overlay={<StatusOverlay r={r} />}
          >
            {r.coverKey ? (
              <img src={fileUrl(r.coverKey)} alt={r.title ?? r.domain} loading="lazy" className="aspect-[16/10] w-full object-cover object-top" />
            ) : (
              <div className="aspect-[16/10] w-full" />
            )}
          </Tile>
        ))}
      </Masonry>
      <GridFooter
        {...list}
        count={list.items.length}
        empty={
          <Empty className="py-24">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <GlobeIcon />
              </EmptyMedia>
              <EmptyTitle>{filters.q || filters.collection ? "Nothing here yet" : "Start your shelf"}</EmptyTitle>
              <EmptyDescription>
                {filters.q || filters.collection ? "Try another search, or add a reference to this collection." : "Paste a website you like and your capture agent does the rest."}
              </EmptyDescription>
            </EmptyHeader>
            {!filters.q && (
              <Button onClick={onAdd} className="rounded-full bg-foreground text-background hover:bg-foreground/85">
                <PlusIcon data-icon="inline-start" /> Add reference
              </Button>
            )}
          </Empty>
        }
      />
    </>
  )
}

function StatusOverlay({ r }: { r: Reference }) {
  if (r.status === "ready") return null
  return (
    <div className="absolute inset-0 grid place-items-center bg-background/75 backdrop-blur-sm">
      <div className="flex max-w-[80%] flex-col items-center gap-2 text-center">
        {r.status === "failed" ? <AlertCircleIcon className="size-5 text-destructive-foreground" /> : <Spinner className="size-5 text-muted-foreground" />}
        <span className="text-xs font-medium">{r.domain}</span>
        <span className="text-2xs text-muted-foreground">
          {r.status === "failed" ? (r.error ?? "Capture failed") : (r.progress ?? (r.status === "queued" ? "Queued" : "Capturing"))}
        </span>
      </div>
    </div>
  )
}

function PagesGrid({ filters }: { filters: Filters }) {
  const list = useInfinite<PageWithRef>((cursor) => api.pages(filters, cursor), [filters.q, filters.collection, filters.sort])
  useReloadEvent(list.reload)
  if (list.loading && !list.items.length) return <SkeletonGrid />
  return (
    <>
      <Masonry>
        {list.items.map((p) => (
          <Tile key={p.id} href={`/r/${p.referenceId}?page=${p.id}`} title={p.title || p.path} subtitle={`${p.reference.domain}${p.path}`}>
            <img src={fileUrl(p.desktopThumbKey)} alt={p.title ?? p.path} loading="lazy" className="aspect-[16/10] w-full object-cover object-top" />
          </Tile>
        ))}
      </Masonry>
      <GridFooter {...list} count={list.items.length} empty={<EmptyNote text="No pages captured yet." />} />
    </>
  )
}

function AnimationsGrid({ filters }: { filters: Filters }) {
  const list = useInfinite<AnimationWithRef>((cursor) => api.animations(filters, cursor), [filters.q, filters.collection, filters.sort])
  useReloadEvent(list.reload)
  if (list.loading && !list.items.length) return <SkeletonGrid />
  return (
    <>
      <Masonry>
        {list.items.map((a) => (
          <Tile
            key={a.id}
            href={`/r/${a.referenceId}?tab=animations`}
            title={a.label || a.reference.title || a.reference.domain}
            subtitle={`${a.kind === "scroll" ? "Scroll" : "Hover"} · ${a.reference.domain}`}
          >
            <GifTile a={a} bare />
          </Tile>
        ))}
      </Masonry>
      <GridFooter {...list} count={list.items.length} empty={<EmptyNote text="No animations captured yet." />} />
    </>
  )
}

function EmptyNote({ text }: { text: string }) {
  return <p className="py-24 text-center text-sm text-muted-foreground">{text}</p>
}
