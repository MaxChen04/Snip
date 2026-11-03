import { useCallback, useEffect, useState } from "react"
import { Link, useLocation, useSearch } from "wouter"
import {
  CodeIcon,
  ExternalLinkIcon,
  FileJsonIcon,
  FolderIcon,
  SparklesIcon,
  MonitorIcon,
  MoreHorizontalIcon,
  RefreshCwIcon,
  SmartphoneIcon,
  Trash2Icon,
  AlertCircleIcon,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"
import { notify } from "@/components/notify"
import { CollectionPicker } from "@/components/collection-picker"
import { EMPTY_SELECTION, SelectCheck, SelectionBar, toggleIn, type Selection } from "@/components/prompt-selection"
import { Masonry } from "@/components/gallery-page"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { TokensPanel } from "@/components/tokens-panel"
import { ActionCircle, Segmented, TopBar } from "@/components/top-bar"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { cn } from "@/lib/utils"
import { api, fileUrl, type Animation, type Page, type Reference } from "@/lib/api"
import { useCollections } from "@/lib/collections"
import { referenceViewUrl, useDesktopState } from "@/hooks/use-desktop-state"
import { usePoll } from "@/hooks/use-poll"

type Detail = { reference: Reference; pages: Page[]; animations: Animation[] }

export function ReferencePage({ id, login }: { id: string; login: string }) {
  const [location, navigate] = useLocation()
  const query = useSearch()
  const search = new URLSearchParams(query)
  const [data, setData] = useState<Detail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const tab = search.get("tab") ?? "pages"
  const openPage = search.get("page")
  const setView = (key: "tab" | "page", value: string | null) => {
    navigate(referenceViewUrl(location, query, key, value), { replace: true })
  }
  const setTab = (value: string) => setView("tab", value)
  const setOpenPage = (value: string | null) => setView("page", value)
  const [selecting, setSelecting] = useDesktopState(`snip:${id}:selecting`, false)
  const [sel, setSel] = useDesktopState<Selection>(`snip:${id}:selection`, EMPTY_SELECTION)
  const { collections, refresh: refreshCollections } = useCollections()

  const load = useCallback(() => {
    return api
      .reference(id)
      .then(setData)
      .catch((e) => setError((e as Error).message))
  }, [id])

  useEffect(() => { void load() }, [load])

  const busy = data && (data.reference.status === "queued" || data.reference.status === "capturing")
  usePoll(load, !!busy)

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
      <TopBar login={login} solid />

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
            {r.animationCount > 0 && ` · ${r.animationCount} ${r.animationCount === 1 ? "GIF" : "GIFs"}`}
          </a>
        </div>

        <div className="mt-3 flex items-start gap-6">
          <ActionCircle icon={<ExternalLinkIcon />} label="Visit" href={r.url} />
          <Popover>
            <PopoverTrigger className="group flex flex-col items-center gap-1.5">
              <span className="grid size-9 place-items-center rounded-full ring-1 ring-border transition-colors group-hover:bg-fill-2 group-data-popup-open:bg-foreground group-data-popup-open:text-background [&_svg]:size-4">
                <FolderIcon />
              </span>
              <span className="text-2xs text-muted-foreground">Organize</span>
            </PopoverTrigger>
            <PopoverContent align="center" className="w-80 rounded-3xl p-3">
              <CollectionPicker className="max-h-72" selected={r.collectionIds} onToggle={(cid, on) => void toggleCollection(cid, on)} />
            </PopoverContent>
          </Popover>
          <ActionCircle
            icon={<RefreshCwIcon />}
            label="Re-capture"
            onClick={async () => {
              await api.recapture(r.id)
              notify("Re-capture queued")
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
        <div className="sticky top-16 z-20 -mx-4 mb-6 flex flex-col items-center gap-2 bg-background px-4 py-2 sm:-mx-6 sm:grid sm:grid-cols-[1fr_auto_1fr] sm:gap-3 sm:px-6">
          <span className="hidden sm:block" />
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
          <div className="flex min-w-0 justify-end">
            {selecting || sel.pages.length + sel.animations.length > 0 || sel.tokens ? (
              <SelectionBar
                reference={r}
                pages={pages}
                animations={animations}
                selection={sel}
                onChange={setSel}
                onDone={() => {
                  setSelecting(false)
                  setSel(EMPTY_SELECTION)
                }}
              />
            ) : tab === "tokens" ? (
              r.tokens && (
                <PromptPill
                  on={false}
                  onClick={() => {
                    setSelecting(true)
                    setSel((x) => ({ ...x, tokens: true }))
                  }}
                >
                  Add tokens to prompt
                </PromptPill>
              )
            ) : (
              <PromptPill on={false} onClick={() => setSelecting(true)}>
                Select
              </PromptPill>
            )}
          </div>
        </div>

        {tab === "pages" && (
          <>
            <Masonry>
              {pages.map((p) => (
                <div key={p.id} className="group relative">
                <SelectCheck on={sel.pages.includes(p.id)} active={selecting} label={`Select ${p.path}`} onToggle={() => setSel((x) => ({ ...x, pages: toggleIn(x.pages, p.id) }))} />
                <button
                  className={cn("group relative block w-full overflow-hidden rounded-sm bg-fill-1 text-left", sel.pages.includes(p.id) && "ring-2 ring-foreground ring-offset-2 ring-offset-background")}
                  onClick={() => (selecting ? setSel((x) => ({ ...x, pages: toggleIn(x.pages, p.id) })) : setOpenPage(p.id))}
                >                  <img src={fileUrl(p.desktopThumbKey)} alt={p.title ?? p.path} loading="lazy" className="aspect-[16/10] w-full object-cover object-top" />
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
                </div>
              ))}
            </Masonry>
            {!pages.length && <p className="py-16 text-center text-sm text-muted-foreground">No pages captured yet.</p>}
          </>
        )}

        {tab === "animations" && (
          <div className="space-y-10">
            {!animations.length && <p className="py-16 text-center text-sm text-muted-foreground">No animations captured yet.</p>}
            {scrollGifs.length > 0 && <AnimationSection title="Scroll" items={scrollGifs} pages={pages} selected={sel.animations} selecting={selecting} onToggle={(id) => setSel((x) => ({ ...x, animations: toggleIn(x.animations, id) }))} />}
            {hoverGifs.length > 0 && <AnimationSection title="Hover" items={hoverGifs} pages={pages} selected={sel.animations} selecting={selecting} onToggle={(id) => setSel((x) => ({ ...x, animations: toggleIn(x.animations, id) }))} />}
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

function PromptPill({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      className={cn(
        "flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-xs font-medium whitespace-nowrap ring-1 ring-border transition-colors hover:bg-fill-1",
        on && "bg-foreground text-background ring-foreground hover:bg-foreground/85",
      )}
    >
      <SparklesIcon className="size-3.5" />
      <span>{children}</span>
    </button>
  )
}

function AnimationSection({
  title,
  items,
  pages,
  selected,
  selecting,
  onToggle,
}: {
  title: string
  items: Animation[]
  pages: Page[]
  selected: string[]
  selecting: boolean
  onToggle: (id: string) => void
}) {
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
          <figure
            key={a.id}
            className={cn("group relative rounded-sm", selecting && "cursor-pointer", selected.includes(a.id) && "ring-2 ring-foreground ring-offset-2 ring-offset-background")}
            onClick={selecting ? () => onToggle(a.id) : undefined}
          >
            <SelectCheck on={selected.includes(a.id)} active={selecting} label={`Select ${a.label ?? a.kind} animation`} onToggle={() => onToggle(a.id)} />
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
