import { useCallback, useEffect, useState } from "react"
import { Link, useLocation, useSearch } from "wouter"
import {
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
import { Masonry } from "@/components/gallery-page"
import { TokensPanel } from "@/components/tokens-panel"
import { ActionCircle, Segmented, TopBar } from "@/components/top-bar"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { api, fileUrl, type Animation, type Page, type Reference } from "@/lib/api"
import { useCollections } from "@/lib/collections"

type Detail = { reference: Reference; pages: Page[]; animations: Animation[] }

export function ReferencePage({ id, login }: { id: string; login: string }) {
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

  const inCollections = collections.filter((c) => r.collectionIds.includes(c.id))

  return (
    <div className="min-h-svh">
      <TopBar login={login} onAdd={() => navigate("/")} />

      <div className="flex flex-col items-center gap-3 px-4 pt-8 pb-2 text-center">
        {r.favicon && <img src={r.favicon} alt="" className="size-8 rounded-lg ring-1 ring-border" onError={(e) => (e.currentTarget.style.display = "none")} />}
        <div className="max-w-2xl">
          <p className="text-xs text-muted-foreground">
            <Link href="/" className="hover:text-foreground">
              Everything
            </Link>
            {inCollections.length > 0 && (
              <>
                {" / "}
                {inCollections.map((c, i) => (
                  <span key={c.id}>
                    {i > 0 && ", "}
                    <Link href={`/?collection=${c.id}`} className="hover:text-foreground">
                      {c.name}
                    </Link>
                  </span>
                ))}
              </>
            )}
          </p>
          <h1 className="mt-1 text-2xl font-medium text-balance">{r.title || r.domain}</h1>
          <a href={r.url} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs text-muted-foreground hover:text-foreground">
            {r.domain} · {r.pageCount} {r.pageCount === 1 ? "page" : "pages"}
            {r.animationCount > 0 && ` · ${r.animationCount} GIFs`}
          </a>
        </div>

        <div className="mt-3 flex items-start gap-6">
          <ActionCircle icon={<ExternalLinkIcon />} label="Visit" href={r.url} />
          <DropdownMenu>
            <DropdownMenuTrigger render={<button className="group flex flex-col items-center gap-1.5" />}>
              <span className="grid size-9 place-items-center rounded-full ring-1 ring-border transition-colors group-hover:bg-fill-2 [&_svg]:size-4">
                <FolderIcon />
              </span>
              <span className="text-2xs text-muted-foreground">Organize</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="center" className="min-w-48">
              <DropdownMenuGroup>
              <DropdownMenuLabel>Collections</DropdownMenuLabel>
              {collections.map((c) => (
                <DropdownMenuCheckboxItem key={c.id} checked={r.collectionIds.includes(c.id)} onCheckedChange={(v) => void toggleCollection(c.id, !!v)}>
                  {c.name}
                </DropdownMenuCheckboxItem>
              ))}
              {!collections.length && <div className="px-2 py-1.5 text-xs text-muted-foreground">Create a collection from the home page.</div>}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <ActionCircle
            icon={<RefreshCwIcon />}
            label="Re-capture"
            onClick={async () => {
              await api.recapture(r.id)
              toast.success("Re-capture queued")
              load()
            }}
          />
          <DropdownMenu>
            <DropdownMenuTrigger render={<button className="group flex flex-col items-center gap-1.5" />}>
              <span className="grid size-9 place-items-center rounded-full ring-1 ring-border transition-colors group-hover:bg-fill-2 [&_svg]:size-4">
                <MoreHorizontalIcon />
              </span>
              <span className="text-2xs text-muted-foreground">More</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="center">
              <DropdownMenuItem
                variant="destructive"
                onClick={async () => {
                  if (!confirm("Delete this reference and all its captures?")) return
                  await api.deleteReference(r.id)
                  void refreshCollections()
                  navigate("/")
                }}
              >
                <Trash2Icon /> Delete reference
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {r.status !== "ready" && (
          <div className="mt-3 flex items-center gap-2 rounded-full bg-fill-1 px-4 py-2 text-xs">
            {r.status === "failed" ? <AlertCircleIcon className="size-4 text-destructive-foreground" /> : <Spinner className="text-muted-foreground" />}
            <span>{r.status === "failed" ? `Capture failed: ${r.error ?? "unknown error"}` : (r.progress ?? "Waiting for the capture agent")}</span>
          </div>
        )}
      </div>

      <div className="px-4 pt-6 pb-24 sm:px-6">
        <div className="mb-6 flex justify-center">
          <Segmented
            value={tab}
            onChange={setTab}
            options={[
              { value: "pages", label: `Pages${pages.length ? ` ${pages.length}` : ""}` },
              { value: "animations", label: `Animations${animations.length ? ` ${animations.length}` : ""}` },
              { value: "tokens", label: "Design tokens" },
            ]}
            className="[&_button]:h-8 [&_button]:px-3.5"
          />
        </div>

        {tab === "pages" && (
          <>
            <Masonry>
              {pages.map((p) => (
                <button key={p.id} className="group relative block w-full overflow-hidden rounded-sm bg-fill-1 text-left" onClick={() => setOpenPage(p.id)}>
                  <img src={fileUrl(p.desktopThumbKey)} alt={p.title ?? p.path} loading="lazy" className="aspect-[16/10] w-full object-cover object-top" />
                  {p.mobileThumbKey && (
                    <img
                      src={fileUrl(p.mobileThumbKey)}
                      alt=""
                      loading="lazy"
                      className="absolute right-3 bottom-3 h-[55%] rounded-md object-cover object-top shadow-lg ring-1 ring-black/10 transition-transform duration-300 group-hover:-translate-y-1"
                    />
                  )}
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent px-3 pt-10 pb-2.5 opacity-0 transition-opacity group-hover:opacity-100">
                    <div className="truncate text-xs font-medium text-white">{p.title || p.path}</div>
                    <div className="truncate text-2xs text-white/75">{p.path}</div>
                  </div>
                </button>
              ))}
            </Masonry>
            {!pages.length && <p className="py-16 text-center text-sm text-muted-foreground">No pages captured yet.</p>}
          </>
        )}

        {tab === "animations" && (
          <div className="space-y-10">
            {!animations.length && <p className="py-16 text-center text-sm text-muted-foreground">No animations captured yet.</p>}
            {scrollGifs.length > 0 && <AnimationSection title="Scroll" items={scrollGifs} pages={pages} />}
            {hoverGifs.length > 0 && <AnimationSection title="Hover" items={hoverGifs} pages={pages} />}
          </div>
        )}

        {tab === "tokens" && (
          <div className="mx-auto max-w-6xl">
            {r.tokens ? <TokensPanel tokens={r.tokens} /> : <p className="py-16 text-center text-sm text-muted-foreground">Tokens appear after capture.</p>}
          </div>
        )}
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
      <h2 className="mb-3 text-sm font-medium">
        {title} <span className="text-muted-foreground">{items.length}</span>
      </h2>
      <Masonry>
        {items.map((a) => (
          <figure key={a.id} className="group relative overflow-hidden rounded-sm">
            <GifTile a={a} bare />
            <figcaption className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/60 to-transparent px-3 pt-8 pb-2 text-2xs text-white opacity-0 transition-opacity group-hover:opacity-100">
              {a.label ? `${a.label} · ` : ""}
              {pageName(a.pageId)}
            </figcaption>
          </figure>
        ))}
      </Masonry>
    </section>
  )
}

export function GifTile({ a, bare }: { a: Animation; bare?: boolean }) {
  // Hover GIFs are small element crops: show them at natural size, centered, instead of upscaling.
  const small = a.kind === "hover" && a.width < 480
  const frame = bare ? "rounded-sm bg-fill-1" : "rounded-xl bg-fill-1 ring-1 ring-border"
  return (
    <div className={small ? `grid place-items-center overflow-hidden p-8 ${frame}` : `overflow-hidden ${frame}`}>
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
