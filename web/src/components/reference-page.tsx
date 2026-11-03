import { useCallback, useEffect, useState } from "react"
import { Link, useLocation, useSearch } from "wouter"
import {
  ArrowLeftIcon,
  CodeIcon,
  ExternalLinkIcon,
  FileJsonIcon,
  FolderIcon,
  MonitorIcon,
  MoreHorizontalIcon,
  RefreshCwIcon,
  SmartphoneIcon,
  Trash2Icon,
  AlertCircleIcon,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"
import { TokensPanel } from "@/components/tokens-panel"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { api, fileUrl, type Animation, type Page, type Reference } from "@/lib/api"
import { useCollections } from "@/lib/collections"

type Detail = { reference: Reference; pages: Page[]; animations: Animation[] }

export function ReferencePage({ id }: { id: string }) {
  const [, navigate] = useLocation()
  const search = new URLSearchParams(useSearch())
  const [data, setData] = useState<Detail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState(search.get("tab") ?? "pages")
  const [openPage, setOpenPage] = useState<string | null>(search.get("page"))
  const { collections, refresh: refreshCollections } = useCollections()

  const load = useCallback(() => {
    api
      .reference(id)
      .then(setData)
      .catch((e) => setError((e as Error).message))
  }, [id])

  useEffect(load, [load])

  const busy = data && (data.reference.status === "queued" || data.reference.status === "capturing")
  useEffect(() => {
    if (!busy) return
    const t = setInterval(load, 4000)
    return () => clearInterval(t)
  }, [busy, load])

  if (error) return <div className="grid min-h-svh place-items-center text-sm text-muted-foreground">{error}</div>
  if (!data) {
    return (
      <div className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6">
        <Skeleton className="h-8 w-64" />
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="aspect-[16/10] rounded-xl" />
          ))}
        </div>
      </div>
    )
  }

  const { reference: r, pages, animations } = data
  const toggleCollection = async (cid: string, member: boolean) => {
    await api.setMembership(r.id, cid, member)
    setData({ ...data, reference: { ...r, collectionIds: member ? [...r.collectionIds, cid] : r.collectionIds.filter((x) => x !== cid) } })
    void refreshCollections()
  }
  const current = pages.find((p) => p.id === openPage) ?? null
  const scrollGifs = animations.filter((a) => a.kind === "scroll")
  const hoverGifs = animations.filter((a) => a.kind === "hover")

  return (
    <div className="min-h-svh">
      <header className="sticky top-0 z-20 border-b border-border bg-background/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3 sm:px-6">
          <Button variant="ghost" size="icon-sm" aria-label="Back" render={<Link href="/" />} nativeButton={false}>
            <ArrowLeftIcon />
          </Button>
          {r.favicon && <img src={r.favicon} alt="" className="size-5 rounded-sm" onError={(e) => (e.currentTarget.style.display = "none")} />}
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold">{r.title || r.domain}</h1>
            <a href={r.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 truncate text-2xs text-muted-foreground hover:text-foreground">
              {r.url} <ExternalLinkIcon className="size-3" />
            </a>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {r.collectionIds.length > 0 && (
              <div className="hidden gap-1 sm:flex">
                {collections
                  .filter((c) => r.collectionIds.includes(c.id))
                  .map((c) => (
                    <Badge key={c.id} variant="secondary">
                      {c.name}
                    </Badge>
                  ))}
              </div>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
                <FolderIcon data-icon="inline-start" /> Collections
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-48">
                <DropdownMenuLabel>Add to collection</DropdownMenuLabel>
                {collections.map((c) => (
                  <DropdownMenuCheckboxItem key={c.id} checked={r.collectionIds.includes(c.id)} onCheckedChange={(v) => void toggleCollection(c.id, !!v)}>
                    {c.name}
                  </DropdownMenuCheckboxItem>
                ))}
                {!collections.length && <div className="px-2 py-1.5 text-xs text-muted-foreground">Create one from the sidebar.</div>}
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="More" />}>
                <MoreHorizontalIcon />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={async () => {
                    await api.recapture(r.id)
                    toast.success("Re-capture queued")
                    load()
                  }}
                >
                  <RefreshCwIcon /> Re-capture
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onClick={async () => {
                    if (!confirm("Delete this reference and all its captures?")) return
                    await api.deleteReference(r.id)
                    void refreshCollections()
                    navigate("/")
                  }}
                >
                  <Trash2Icon /> Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        {r.status !== "ready" && (
          <div className="mb-6 flex items-center gap-3 rounded-xl bg-fill-1 px-4 py-3 text-sm">
            {r.status === "failed" ? <AlertCircleIcon className="size-4 text-destructive-foreground" /> : <Spinner className="text-muted-foreground" />}
            <span>{r.status === "failed" ? `Capture failed: ${r.error ?? "unknown error"}` : (r.progress ?? "Waiting for the capture agent")}</span>
          </div>
        )}

        <Tabs value={tab} onValueChange={(v) => setTab(v as string)} className="flex-col">
          <TabsList>
            <TabsTrigger value="pages">Pages {pages.length > 0 && <span className="text-muted-foreground">{pages.length}</span>}</TabsTrigger>
            <TabsTrigger value="animations">
              Animations {animations.length > 0 && <span className="text-muted-foreground">{animations.length}</span>}
            </TabsTrigger>
            <TabsTrigger value="tokens">Design tokens</TabsTrigger>
          </TabsList>

          <TabsContent value="pages" className="pt-4">
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {pages.map((p) => (
                <button key={p.id} className="group text-left" onClick={() => setOpenPage(p.id)}>
                  <div className="relative overflow-hidden rounded-xl bg-fill-1 ring-1 ring-border transition-shadow group-hover:shadow-lg">
                    <img src={fileUrl(p.desktopThumbKey)} alt="" loading="lazy" className="aspect-[16/10] w-full object-cover object-top" />
                    {p.mobileThumbKey && (
                      <img
                        src={fileUrl(p.mobileThumbKey)}
                        alt=""
                        loading="lazy"
                        className="absolute right-3 bottom-3 h-[55%] rounded-md object-cover object-top shadow-lg ring-1 ring-border"
                      />
                    )}
                  </div>
                  <div className="mt-2 px-0.5">
                    <div className="truncate text-sm font-medium">{p.title || p.path}</div>
                    <div className="truncate text-2xs text-muted-foreground">{p.path}</div>
                  </div>
                </button>
              ))}
            </div>
            {!pages.length && <p className="py-16 text-center text-sm text-muted-foreground">No pages captured yet.</p>}
          </TabsContent>

          <TabsContent value="animations" className="space-y-8 pt-4">
            {!animations.length && <p className="py-16 text-center text-sm text-muted-foreground">No animations captured yet.</p>}
            {scrollGifs.length > 0 && (
              <AnimationSection title="Scroll" items={scrollGifs} pages={pages} />
            )}
            {hoverGifs.length > 0 && (
              <AnimationSection title="Hover" items={hoverGifs} pages={pages} />
            )}
          </TabsContent>

          <TabsContent value="tokens" className="pt-4">
            {r.tokens ? <TokensPanel tokens={r.tokens} /> : <p className="py-16 text-center text-sm text-muted-foreground">Tokens appear after capture.</p>}
          </TabsContent>
        </Tabs>
      </div>

      {current && <PageViewer page={current} onClose={() => setOpenPage(null)} />}
    </div>
  )
}

function AnimationSection({ title, items, pages }: { title: string; items: Animation[]; pages: Page[] }) {
  const pageName = (id: string | null) => {
    const p = pages.find((x) => x.id === id)
    return p ? p.title || p.path : ""
  }
  return (
    <section>
      <h2 className="mb-3 text-sm font-medium">{title}</h2>
      <div className="columns-1 gap-5 sm:columns-2 lg:columns-3 [&>*]:mb-5 [&>*]:break-inside-avoid">
        {items.map((a) => (
          <figure key={a.id}>
            <GifTile a={a} />
            <figcaption className="mt-1.5 truncate px-0.5 text-2xs text-muted-foreground">
              {a.label ? `${a.label} · ` : ""}
              {pageName(a.pageId)}
            </figcaption>
          </figure>
        ))}
      </div>
    </section>
  )
}

export function GifTile({ a }: { a: Animation }) {
  // Hover GIFs are small element crops: show them at natural size, centered, instead of upscaling.
  const small = a.kind === "hover" && a.width < 480
  return (
    <div className={small ? "grid place-items-center overflow-hidden rounded-xl bg-fill-1 p-6 ring-1 ring-border" : "overflow-hidden rounded-xl bg-fill-1 ring-1 ring-border"}>
      <img
        src={fileUrl(a.gifKey)}
        alt={a.label ?? ""}
        loading="lazy"
        className={small ? "max-w-full rounded-md" : "w-full"}
        style={small ? { width: a.width } : { aspectRatio: `${a.width}/${a.height}` }}
      />
    </div>
  )
}

function PageViewer({ page, onClose }: { page: Page; onClose: () => void }) {
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop")
  const key = device === "desktop" ? page.desktopKey : page.mobileKey

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    window.addEventListener("keydown", onKey)
    document.body.style.overflow = "hidden"
    return () => {
      window.removeEventListener("keydown", onKey)
      document.body.style.overflow = ""
    }
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background" role="dialog" aria-modal="true">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}>
          <XIcon />
        </Button>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{page.title || page.path}</div>
          <a href={page.url} target="_blank" rel="noreferrer" className="truncate text-2xs text-muted-foreground hover:text-foreground">
            {page.url}
          </a>
        </div>
        <ToggleGroup
          className="mx-auto"
          variant="outline"
          size="sm"
          value={[device]}
          onValueChange={(v) => v[0] && setDevice(v[0] as "desktop" | "mobile")}
        >
          <ToggleGroupItem value="desktop" aria-label="Desktop">
            <MonitorIcon /> Desktop
          </ToggleGroupItem>
          <ToggleGroupItem value="mobile" aria-label="Mobile">
            <SmartphoneIcon /> Mobile
          </ToggleGroupItem>
        </ToggleGroup>
        <div className="flex items-center gap-2">
          {page.snapshotKey && (
            <Button variant="outline" size="sm" render={<a href={fileUrl(page.snapshotKey)} target="_blank" rel="noreferrer" />} nativeButton={false}>
              <CodeIcon data-icon="inline-start" /> HTML snapshot
            </Button>
          )}
          {page.stylesKey && (
            <Button variant="outline" size="sm" render={<a href={`${fileUrl(page.stylesKey)}?download=1`} />} nativeButton={false}>
              <FileJsonIcon data-icon="inline-start" /> Computed styles
            </Button>
          )}
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-y-auto bg-fill-1 p-6">
          {key ? (
            <img
              src={fileUrl(key)}
              alt=""
              className={device === "desktop" ? "mx-auto w-full max-w-6xl rounded-lg shadow-lg ring-1 ring-border" : "mx-auto w-[390px] max-w-full rounded-2xl shadow-lg ring-1 ring-border"}
            />
          ) : (
            <p className="py-24 text-center text-sm text-muted-foreground">No {device} screenshot.</p>
          )}
        </div>
        {page.tokens && (
          <aside className="hidden w-80 shrink-0 overflow-y-auto border-l border-border p-4 lg:block">
            <TokensPanel tokens={page.tokens} compact />
          </aside>
        )}
      </div>
    </div>
  )
}
