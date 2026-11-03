import { useEffect, useState } from "react"
import { Link } from "wouter"
import {
  FolderIcon,
  LayersIcon,
  LogOutIcon,
  MoreHorizontalIcon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
  PencilIcon,
  GlobeIcon,
  FilmIcon,
  FileImageIcon,
  AlertCircleIcon,
} from "lucide-react"
import { toast } from "sonner"
import { Logo } from "@/App"
import { AddReferenceButton } from "@/components/add-reference-dialog"
import { GifTile } from "@/components/reference-page"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useInfinite } from "@/hooks/use-infinite"
import { api, fileUrl, type AnimationWithRef, type Filters, type PageWithRef, type Reference, type Sort } from "@/lib/api"
import { useCollections } from "@/lib/collections"
import { cn } from "@/lib/utils"

type View = "websites" | "pages" | "animations"

const readPref = <T extends string>(key: string, fallback: T): T => {
  try {
    return (localStorage.getItem(key) as T) || fallback
  } catch {
    return fallback
  }
}
const writePref = (key: string, v: string) => {
  try {
    localStorage.setItem(key, v)
  } catch {
    /* ignore */
  }
}

export function GalleryPage({ login }: { login: string }) {
  const [view, setView] = useState<View>(() => readPref("rs.view", "websites"))
  const [sort, setSort] = useState<Sort>(() => readPref("rs.sort", "newest"))
  const [collection, setCollection] = useState<string | undefined>(() => new URLSearchParams(location.search).get("collection") ?? undefined)
  const [query, setQuery] = useState("")
  const [q, setQ] = useState("")

  useEffect(() => {
    const t = setTimeout(() => setQ(query.trim()), 250)
    return () => clearTimeout(t)
  }, [query])

  useEffect(() => {
    const url = new URL(location.href)
    if (collection) url.searchParams.set("collection", collection)
    else url.searchParams.delete("collection")
    history.replaceState(null, "", url)
  }, [collection])

  const filters: Filters = { q, collection, sort: view === "websites" ? sort : sort === "name" ? "newest" : sort }

  return (
    <div className="flex min-h-svh">
      <CollectionsSidebar login={login} active={collection} onSelect={setCollection} />
      <main className="min-w-0 flex-1">
        <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-border bg-background/85 px-4 py-3 backdrop-blur-md sm:px-6">
          <Link href="/" className="flex items-center gap-2 md:hidden">
            <Logo className="size-6" />
          </Link>
          <div className="relative max-w-md flex-1">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder="Search references" className="pl-8" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <div className="ml-auto">
            <AddReferenceButton defaultCollection={collection} onAdded={() => window.dispatchEvent(new Event("rs:reload"))} />
          </div>
        </header>

        <div className="flex flex-wrap items-center gap-3 px-4 pt-5 pb-4 sm:px-6">
          <Tabs
            value={view}
            onValueChange={(v) => {
              setView(v as View)
              writePref("rs.view", v as string)
            }}
          >
            <TabsList>
              <TabsTrigger value="websites">
                <GlobeIcon /> Websites
              </TabsTrigger>
              <TabsTrigger value="pages">
                <FileImageIcon /> Pages
              </TabsTrigger>
              <TabsTrigger value="animations">
                <FilmIcon /> Animations
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <MobileCollectionPicker active={collection} onSelect={setCollection} />
          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Sort</span>
            <NativeSelect
              size="sm"
              value={sort}
              onChange={(e) => {
                setSort(e.target.value as Sort)
                writePref("rs.sort", e.target.value)
              }}
            >
              <NativeSelectOption value="newest">Newest</NativeSelectOption>
              <NativeSelectOption value="oldest">Oldest</NativeSelectOption>
              {view === "websites" && <NativeSelectOption value="name">Name A–Z</NativeSelectOption>}
            </NativeSelect>
          </div>
        </div>

        <div className="px-4 pb-16 sm:px-6">
          {view === "websites" && <WebsitesGrid filters={filters} />}
          {view === "pages" && <PagesGrid filters={filters} />}
          {view === "animations" && <AnimationsGrid filters={filters} />}
        </div>
      </main>
    </div>
  )
}

// ---------- Sidebar ----------

function MobileCollectionPicker({ active, onSelect }: { active?: string; onSelect: (id?: string) => void }) {
  const { collections } = useCollections()
  return (
    <NativeSelect size="sm" className="md:hidden" value={active ?? ""} onChange={(e) => onSelect(e.target.value || undefined)} aria-label="Collection">
      <NativeSelectOption value="">All references</NativeSelectOption>
      {collections.map((c) => (
        <NativeSelectOption key={c.id} value={c.id}>
          {c.name}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  )
}

function CollectionsSidebar({ login, active, onSelect }: { login: string; active?: string; onSelect: (id?: string) => void }) {
  const { collections, refresh } = useCollections()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState("")

  const create = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
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

  return (
    <aside className="sticky top-0 hidden h-svh w-60 shrink-0 flex-col border-r border-border bg-sidebar md:flex">
      <Link href="/" onClick={() => onSelect(undefined)} className="flex items-center gap-2 px-4 py-4">
        <Logo className="size-6" />
        <span className="text-sm font-semibold">Refshelf</span>
      </Link>
      <nav className="flex-1 overflow-y-auto px-2">
        <SidebarItem active={!active} onClick={() => onSelect(undefined)} icon={<LayersIcon />} label="All references" />
        <div className="mt-5 mb-1 flex items-center justify-between px-2">
          <span className="text-2xs font-medium text-muted-foreground uppercase">Collections</span>
          <Button variant="ghost" size="icon-xs" aria-label="New collection" onClick={() => setCreating(true)}>
            <PlusIcon />
          </Button>
        </div>
        {creating && (
          <form onSubmit={create} className="px-1 pb-1">
            <Input
              className="h-7"
              autoFocus
              placeholder="Collection name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => !name && setCreating(false)}
              onKeyDown={(e) => e.key === "Escape" && setCreating(false)}
            />
          </form>
        )}
        {collections.map((c) => (
          <SidebarItem
            key={c.id}
            active={active === c.id}
            onClick={() => onSelect(c.id)}
            icon={<FolderIcon />}
            label={c.name}
            count={c.referenceCount}
            menu={<CollectionMenu id={c.id} name={c.name} onDeleted={() => active === c.id && onSelect(undefined)} />}
          />
        ))}
        {!collections.length && !creating && <p className="px-2 py-1 text-2xs text-muted-foreground">No collections yet.</p>}
      </nav>
      <div className="flex items-center justify-between border-t border-border px-4 py-3">
        <span className="truncate text-xs text-muted-foreground">@{login}</span>
        <Button variant="ghost" size="icon-xs" aria-label="Sign out" render={<a href="/auth/logout" />} nativeButton={false}>
          <LogOutIcon />
        </Button>
      </div>
    </aside>
  )
}

function SidebarItem(props: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; count?: number; menu?: React.ReactNode }) {
  return (
    <div
      className={cn(
        "group/item flex h-8 items-center gap-2 rounded-lg px-2 text-sm text-foreground/80 hover:bg-fill-2 [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-muted-foreground",
        props.active && "bg-fill-2 font-medium text-foreground",
      )}
    >
      <button className="flex min-w-0 flex-1 items-center gap-2 text-left [&_svg]:size-4 [&_svg]:text-muted-foreground" onClick={props.onClick}>
        {props.icon}
        <span className="truncate">{props.label}</span>
      </button>
      {props.count !== undefined && <span className="text-2xs text-muted-foreground group-hover/item:hidden">{props.count}</span>}
      {props.menu && <span className="hidden group-hover/item:block">{props.menu}</span>}
    </div>
  )
}

function CollectionMenu({ id, name, onDeleted }: { id: string; name: string; onDeleted: () => void }) {
  const { refresh } = useCollections()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label="Collection options" />}>
        <MoreHorizontalIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onClick={async () => {
            const next = prompt("Rename collection", name)
            if (next?.trim()) {
              await api.renameCollection(id, next.trim())
              await refresh()
            }
          }}
        >
          <PencilIcon /> Rename
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onClick={async () => {
            if (!confirm(`Delete collection "${name}"? References stay in your library.`)) return
            await api.deleteCollection(id)
            await refresh()
            onDeleted()
          }}
        >
          <Trash2Icon /> Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// ---------- Grids ----------

function useReloadEvent(reload: () => void) {
  useEffect(() => {
    window.addEventListener("rs:reload", reload)
    return () => window.removeEventListener("rs:reload", reload)
  }, [reload])
}

function Masonry({ children }: { children: React.ReactNode }) {
  return <div className="columns-1 gap-5 sm:columns-2 lg:columns-3 2xl:columns-4 [&>*]:mb-5 [&>*]:break-inside-avoid">{children}</div>
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
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="space-y-2">
          <Skeleton className={cn("w-full rounded-xl", i % 3 ? "aspect-[16/10]" : "aspect-[4/5]")} />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ))}
    </Masonry>
  )
}

function WebsitesGrid({ filters }: { filters: Filters }) {
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
          <ReferenceCard key={r.id} r={r} />
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
              <EmptyTitle>{filters.q || filters.collection ? "Nothing matches" : "No references yet"}</EmptyTitle>
              <EmptyDescription>
                {filters.q || filters.collection ? "Try another search or collection." : "Click Add reference and paste a website you like."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        }
      />
    </>
  )
}

function StatusOverlay({ r }: { r: Reference }) {
  if (r.status === "ready") return null
  return (
    <div className="absolute inset-0 grid place-items-center bg-background/70 backdrop-blur-sm">
      <div className="flex max-w-[80%] flex-col items-center gap-2 text-center">
        {r.status === "failed" ? <AlertCircleIcon className="size-5 text-destructive-foreground" /> : <Spinner className="size-5 text-muted-foreground" />}
        <span className="text-xs text-muted-foreground">
          {r.status === "failed" ? (r.error ?? "Capture failed") : (r.progress ?? (r.status === "queued" ? "Queued" : "Capturing"))}
        </span>
      </div>
    </div>
  )
}

function ReferenceCard({ r }: { r: Reference }) {
  const { collections } = useCollections()
  const cols = collections.filter((c) => r.collectionIds.includes(c.id))
  return (
    <Link href={`/r/${r.id}`} className="group block">
      <div className="relative overflow-hidden rounded-xl bg-fill-1 ring-1 ring-border transition-shadow group-hover:shadow-lg">
        {r.coverKey ? (
          <img src={fileUrl(r.coverKey)} alt="" loading="lazy" className="aspect-[16/10] w-full object-cover object-top transition-transform duration-500 group-hover:scale-[1.02]" />
        ) : (
          <div className="aspect-[16/10] w-full" />
        )}
        <StatusOverlay r={r} />
      </div>
      <div className="mt-2 flex items-start gap-2 px-0.5">
        {r.favicon ? (
          <img src={r.favicon} alt="" className="mt-0.5 size-4 rounded-sm" onError={(e) => (e.currentTarget.style.display = "none")} />
        ) : (
          <GlobeIcon className="mt-0.5 size-4 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{r.title || r.domain}</div>
          <div className="flex items-center gap-1.5 text-2xs text-muted-foreground">
            <span className="truncate">{r.domain}</span>
            {r.pageCount > 0 && <span>· {r.pageCount} {r.pageCount === 1 ? "page" : "pages"}</span>}
            {r.animationCount > 0 && <span>· {r.animationCount} GIFs</span>}
          </div>
        </div>
        {cols.length > 0 && (
          <div className="flex shrink-0 gap-1">
            {cols.slice(0, 2).map((c) => (
              <Badge key={c.id} variant="secondary">
                {c.name}
              </Badge>
            ))}
          </div>
        )}
      </div>
    </Link>
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
          <Link key={p.id} href={`/r/${p.referenceId}?page=${p.id}`} className="group block">
            <div className="overflow-hidden rounded-xl bg-fill-1 ring-1 ring-border transition-shadow group-hover:shadow-lg">
              <img src={fileUrl(p.desktopThumbKey)} alt="" loading="lazy" className="aspect-[16/10] w-full object-cover object-top" />
            </div>
            <div className="mt-2 px-0.5">
              <div className="truncate text-sm font-medium">{p.title || p.path}</div>
              <div className="truncate text-2xs text-muted-foreground">
                {p.reference.domain}
                {p.path}
              </div>
            </div>
          </Link>
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
          <Link key={a.id} href={`/r/${a.referenceId}?tab=animations`} className="group block">
            <div className="transition-shadow group-hover:shadow-lg rounded-xl">
              <GifTile a={a} />
            </div>
            <div className="mt-2 flex items-center gap-2 px-0.5">
              <Badge variant="outline">{a.kind === "scroll" ? "Scroll" : "Hover"}</Badge>
              <span className="truncate text-sm">{a.label || a.reference.title || a.reference.domain}</span>
            </div>
          </Link>
        ))}
      </Masonry>
      <GridFooter {...list} count={list.items.length} empty={<EmptyNote text="No animations captured yet." />} />
    </>
  )
}

function EmptyNote({ text }: { text: string }) {
  return <p className="py-24 text-center text-sm text-muted-foreground">{text}</p>
}
