import { useCallback, useEffect, useRef, useState } from "react"
import { Link, useLocation, useSearch } from "wouter"
import {
  ExternalLinkIcon,
  FolderIcon,
  SparklesIcon,
  MoreHorizontalIcon,
  RefreshCwIcon,
  Trash2Icon,
  AlertCircleIcon,
  DownloadIcon,
  PauseIcon,
  StopIcon,
} from "@/components/icons"
import { exportReference } from "@/lib/export-reference"
import { toast } from "sonner"
import { notify } from "@/components/notify"
import { CollectionPicker } from "@/components/collection-picker"
import { diagnoseCaptureError, RetryCaptureButton } from "@/components/capture-retry"
import { CaptureControls, captureLabel, isStopped } from "@/components/capture-controls"
import { EMPTY_SELECTION, SelectCheck, SelectionBar, toggleIn, type Selection } from "@/components/prompt-selection"
import { SavePagesButton } from "@/components/save-pages"
import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { TokensPanel } from "@/components/tokens-panel"
import { ImageGeneration } from "@/components/image-generation"
import { PageViewer } from "@/components/page-viewer"
import { ActionCircle, Segmented, TopBar } from "@/components/top-bar"
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
import { cn } from "@/lib/utils"
import { api, fileUrl, NotFoundError, type Animation, type Page, type Reference } from "@/lib/api"
import { WAITING } from "../../shared/capture-errors"
import { isVideoKey } from "../../shared/types"
import { useCollections } from "@/lib/collections"
import { referenceViewUrl, useDesktopState } from "@/hooks/use-desktop-state"
import { LIVE_POLL, usePoll } from "@/hooks/use-poll"
import { masonryCols, useGridSize } from "@/lib/prefs"

function Masonry({ children }: { children: React.ReactNode }) {
  const [grid] = useGridSize()
  return <div className={cn(masonryCols[grid], "gap-4 lg:gap-5 [&>*]:mb-4 lg:[&>*]:mb-5 [&>*]:break-inside-avoid")}>{children}</div>
}

/** A failed capture: what went wrong in plain terms, the raw error, and Retry. */
function CaptureFailure({ id, error, onRetried }: { id: string; error: string | null; onRetried: () => void }) {
  const diagnosis = diagnoseCaptureError(error)
  return (
    <div className="mt-3 flex max-w-xl items-start gap-2.5 rounded-2xl bg-(--red-3) px-3.5 py-2.5 text-left text-xs text-(--red-11) shadow-badge">
      <AlertCircleIcon className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="font-medium">{diagnosis?.summary ?? "Capture failed."}</p>
        {diagnosis && <p className="text-(--red-11)/80">{diagnosis.fix}</p>}
        {error && <p className="font-mono text-2xs break-words text-(--red-11)/70">{error}</p>}
      </div>
      <RetryCaptureButton id={id} error={error} onRetried={onRetried} />
    </div>
  )
}

/** A capture the user stopped before it saved a page: not a failure, so no red and no raw error. Start again, or let it go. */
function CaptureStopped({ id, error, onRetried, onDelete }: { id: string; error: string | null; onRetried: () => void; onDelete: () => void }) {
  return (
    <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
      <div role="status" className="flex h-7 items-center gap-2 rounded-full bg-control px-3 text-xs shadow-button">
        <StopIcon className="size-3.5 text-ink-10" />
        <span>{diagnoseCaptureError(error)?.summary}</span>
      </div>
      <RetryCaptureButton id={id} error={error} onRetried={onRetried} className="h-7 gap-1.5 px-3 text-xs" />
      <button type="button" onClick={onDelete} className="tactile press inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-medium text-(--red-11)">
        <Trash2Icon className="size-3.5" />
        Delete
      </button>
    </div>
  )
}

type Detail = { reference: Reference; pages: Page[]; animations: Animation[] }

/** The owner's note on a website. Saved when the field loses focus. */
function NotesField({ r, onSaved }: { r: Reference; onSaved: (notes: string | null) => void }) {
  const [value, setValue] = useState(r.notes ?? "")
  // Escape blurs the field; the blur must not save the edit being discarded.
  const cancelling = useRef(false)
  useEffect(() => setValue(r.notes ?? ""), [r.notes])
  const save = async () => {
    if (cancelling.current) {
      cancelling.current = false
      return
    }
    const next = value.trim()
    if (next === (r.notes ?? "")) return
    try {
      await api.setNotes(r.id, next)
      onSaved(next || null)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  return (
    <textarea
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.blur()
        if (e.key === "Escape") {
          cancelling.current = true
          setValue(r.notes ?? "")
          e.currentTarget.blur()
        }
      }}
      maxLength={2000}
      rows={1}
      aria-label="Note"
      placeholder="Add a note: what to borrow from it"
      className="field-sizing-content mt-2 max-h-40 w-full max-w-md resize-none rounded-lg bg-transparent px-3 py-1.5 text-center text-sm text-ink-11 outline-none placeholder:text-ink-9 hover:bg-ink-2 focus:bg-ink-2 focus:text-foreground dark:hover:bg-ink-3 dark:focus:bg-ink-3"
    />
  )
}

const optionLabel = (r: Reference) =>
  [r.options?.colorScheme === "dark" && "Dark mode", r.options?.desktopWidth && `${r.options.desktopWidth}px`, r.options?.signedIn && "Signed in"].filter(Boolean).join(" · ")

export function ReferencePage({ id, login }: { id: string; login: string }) {
  const [location, navigate] = useLocation()
  const query = useSearch()
  const search = new URLSearchParams(query)
  const [data, setData] = useState<Detail | null>(null)
  // Shown only while there is no data: a failed refresh keeps the last good page on screen.
  const [error, setError] = useState<Error | null>(null)
  const [deleting, setDeleting] = useState(false)
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
  const [working, setWorking] = useState(false)
  /** Re-capture and Delete: one at a time, and a failure is said. */
  const act = async (fn: () => Promise<unknown>) => {
    if (working) return
    setWorking(true)
    try {
      await fn()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setWorking(false)
    }
  }

  const load = useCallback(() => {
    return api
      .reference(id)
      .then((d) => {
        setData(d)
        setError(null)
      })
      .catch((e) => {
        // A reference that is gone has no page to keep, and nothing left to poll.
        if (e instanceof NotFoundError) setData(null)
        setError(e as Error)
      })
  }, [id])

  useEffect(() => { void load() }, [load])

  const busy = data && (data.reference.status === "queued" || data.reference.status === "capturing")
  // Each captured page appears as soon as it is saved: poll at a steady pace while capturing, back off while queued.
  usePoll(load, !!busy, data?.reference.status === "capturing" ? LIVE_POLL : undefined)

  if (!data) {
    if (error)
      return (
        <div className="grid min-h-svh place-items-center px-4 text-center">
          <div className="grid justify-items-center gap-3" role="alert">
            <p className="text-sm text-ink-12">{error instanceof NotFoundError ? "This website doesn't exist" : "Couldn't load this website"}</p>
            <p className="text-xs text-ink-11">{error instanceof NotFoundError ? "It may have been deleted." : error.message}</p>
            <Link href="/" className="tactile press flex h-8 items-center rounded-full px-3.5 text-xs">
              Go to All saves
            </Link>
          </div>
        </div>
      )
    return (
      <div className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6">
        <Skeleton className="h-8 w-64" />
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="aspect-[16/10] rounded-lg" />
          ))}
        </div>
      </div>
    )
  }

  const { reference: r, pages, animations } = data
  const toggleCollection = async (cid: string, member: boolean) => {
    try {
      await api.setMembership(r.id, cid, member)
    } catch (e) {
      return void toast.error((e as Error).message)
    }
    setData((d) => {
      if (!d) return d
      const others = d.reference.collectionIds.filter((x) => x !== cid)
      return { ...d, reference: { ...d.reference, collectionIds: member ? [...others, cid] : others } }
    })
    void refreshCollections().catch(() => {})
  }
  const setPageCollections = (pageIds: string[], cid: string, member: boolean) =>
    setData((d) =>
      d && {
        ...d,
        pages: d.pages.map((p) =>
          pageIds.includes(p.id)
            ? { ...p, collectionIds: member ? [...new Set([...p.collectionIds, cid])] : p.collectionIds.filter((x) => x !== cid) }
            : p,
        ),
      },
    )
  const selectedPages = pages.filter((p) => sel.pages.includes(p.id))
  const current = pages.find((p) => p.id === openPage) ?? null
  const scrollRecordings = animations.filter((a) => a.kind === "scroll")
  const hoverRecordings = animations.filter((a) => a.kind === "hover")

  const inCollections = collections.filter((c) => r.collectionIds.includes(c.id))
  // The capture agent reports "Capturing 7/25: /enterprise" while it works on a page.
  const capturing = r.progress?.match(/^Capturing (\d+)\/(\d+): (.+)$/)
  const capturingPath = capturing?.[3]
  const progressText = capturingPath ? `Capturing ${capturingPath}` : (r.progress ?? WAITING)
  // Share of pages already finished, so the last page reads 83%, not 100%, while it is still capturing. Only a crawl has one.
  const capturedPercent = capturing && r.mode === "crawl" ? Math.round(((Number(capturing[1]) - 1) / Number(capturing[2])) * 100) : null

  return (
    <div className="min-h-svh">
      <TopBar login={login} solid />

      <div className="flex flex-col items-center gap-3 px-4 pt-8 pb-2 text-center">
        {r.favicon && <img src={fileUrl(r.favicon)} alt="" className="size-8 rounded-md shadow-button" onError={(e) => (e.currentTarget.style.display = "none")} />}
        <div className="max-w-2xl">
          <p className="text-xs text-ink-10">
            <Link href="/" className="hover:text-foreground">
              All saves
            </Link>
            {inCollections.length > 0 && (
              <>
                {" / "}
                {inCollections.map((c, i) => (
                  <span key={c.id}>
                    {i > 0 && ", "}
                    <Link href={`/b/${c.id}`} className="hover:text-foreground">
                      {c.name}
                    </Link>
                  </span>
                ))}
              </>
            )}
          </p>
          <h1 className="mt-1 text-xl font-medium tracking-tight text-balance">{r.title || r.domain}</h1>
          <a href={r.url} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs text-ink-11 hover:text-foreground">
            {r.domain} · {r.pageCount} {r.pageCount === 1 ? "page" : "pages"}
            {r.animationCount > 0 && ` · ${r.animationCount} ${r.animationCount === 1 ? "recording" : "recordings"}`}
            {optionLabel(r) && ` · ${optionLabel(r)}`}
          </a>
          <div className="flex justify-center">
            <NotesField r={r} onSaved={(notes) => setData((d) => d && { ...d, reference: { ...d.reference, notes } })} />
          </div>
        </div>

        <div className="mt-3 flex items-start gap-6">
          <ActionCircle icon={<ExternalLinkIcon />} label="Visit" href={r.url} />
          <Popover>
            <PopoverTrigger className="group flex flex-col items-center gap-1.5">
              <span className="tactile press grid size-9 place-items-center rounded-full group-active:scale-[0.94] group-data-popup-open:bg-control-hover [&_svg]:size-4 [&_svg]:text-ink-11">
                <FolderIcon />
              </span>
              <span className="text-2xs text-ink-11">Organize</span>
            </PopoverTrigger>
            <PopoverContent align="center" className="w-80 p-2">
              <CollectionPicker className="max-h-72" selected={r.collectionIds} onToggle={(cid, on) => void toggleCollection(cid, on)} />
            </PopoverContent>
          </Popover>
          {/* The server refuses to re-capture one that is still queued, capturing or paused. */}
          {(r.status === "ready" || r.status === "failed") && (
            <ActionCircle
              icon={<RefreshCwIcon />}
              label="Re-capture"
              onClick={() => {
                if (pages.length && !confirm(`Re-capture ${r.domain}? Its ${pages.length} captured ${pages.length === 1 ? "page" : "pages"} will be replaced.`)) return
                void act(async () => {
                  await api.recapture(r.id)
                  notify("Re-capture queued")
                  await load()
                })
              }}
            />
          )}
          <DropdownMenu>
            <DropdownMenuTrigger render={<button className="group flex flex-col items-center gap-1.5" />}>
              <span className="tactile press grid size-9 place-items-center rounded-full group-active:scale-[0.94] group-data-popup-open:bg-control-hover [&_svg]:size-4 [&_svg]:text-ink-11">
                <MoreHorizontalIcon />
              </span>
              <span className="text-2xs text-ink-11">More</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="center">
              <DropdownMenuItem
                disabled={!pages.length}
                onClick={async () => {
                  const id = toast.loading("Preparing export…")
                  try {
                    const n = await exportReference(r, pages, animations, (done, total) => toast.loading(`Preparing export… ${done}/${total}`, { id }))
                    toast.success(`Exported ${n} files`, { id })
                  } catch (e) {
                    toast.error(`Export failed: ${(e as Error).message}`, { id })
                  }
                }}
              >
                <DownloadIcon /> Export as .zip
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onClick={() => setDeleting(true)}>
                <Trash2Icon /> Delete reference
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {isStopped(r) ? (
          <CaptureStopped id={r.id} error={r.error} onRetried={load} onDelete={() => setDeleting(true)} />
        ) : r.status === "failed" ? (
          <CaptureFailure id={r.id} error={r.error} onRetried={load} />
        ) : r.status !== "ready" && (
          <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
            <div className="flex h-7 items-center gap-2 rounded-full bg-control px-3 text-xs shadow-button">
              {r.status === "paused" ? <PauseIcon className="size-3.5 text-ink-10" /> : <Spinner className="size-3.5 text-ink-10" />}
              <span>{captureLabel(r) ?? r.progress ?? WAITING}</span>
            </div>
            <CaptureControls r={r} onChange={load} />
          </div>
        )}
      </div>

      <div className="px-4 pt-6 pb-24 sm:px-6">
        <div className="sticky top-16 z-20 -mx-4 mb-6 flex flex-col items-center gap-2 bg-background px-4 py-2 sm:-mx-6 sm:grid sm:grid-cols-[1fr_auto_1fr] sm:gap-3 sm:px-6">
          <div className="flex min-w-0 justify-start empty:hidden sm:empty:block">
            {selectedPages.length > 0 && <SavePagesButton pages={selectedPages} onChange={setPageCollections} />}
          </div>
          <Segmented
            value={tab}
            onChange={setTab}
            options={[
              { value: "pages", label: `Pages${pages.length ? ` ${pages.length}` : ""}` },
              { value: "animations", label: `Animations${animations.length ? ` ${animations.length}` : ""}` },
              { value: "tokens", label: "Design tokens" },
            ]}
            className="[&_button]:h-7 [&_button]:px-3"
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
                  className={cn("group relative block w-full overflow-hidden rounded-lg bg-surface-top text-left shadow-card transition-[scale,box-shadow] duration-150 ease-out active:scale-[0.99]", sel.pages.includes(p.id) && "ring-2 ring-ink-12 ring-offset-2 ring-offset-background")}
                  onClick={() => (selecting ? setSel((x) => ({ ...x, pages: toggleIn(x.pages, p.id) })) : setOpenPage(p.id))}
                >                  <img src={fileUrl(p.desktopThumbKey)} alt={p.title ?? p.path} loading="lazy" className="aspect-[16/10] w-full object-cover object-top" />
                  {p.mobileThumbKey && (
                    <img
                      src={fileUrl(p.mobileThumbKey)}
                      alt=""
                      loading="lazy"
                      className="absolute right-3 bottom-3 h-[55%] rounded-md object-cover object-top shadow-menu transition-transform duration-300 ease-out group-hover:-translate-y-1"
                    />
                  )}
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent px-3 pt-10 pb-2.5 opacity-0 transition-opacity group-hover:opacity-100">
                    <div className="truncate text-xs font-medium text-white">{p.title || p.path}</div>
                    <div className="truncate text-2xs text-white/75">{p.path}</div>
                  </div>
                </button>
                </div>
              ))}
              {busy && (
                <ImageGeneration
                  status={r.status === "queued" ? "queued" : "generating"}
                  label={progressText}
                  resolution={capturingPath ?? ""}
                  aspectRatio="16 / 10"
                  size="fluid"
                  statusText={capturedPercent === null ? progressText : `${capturedPercent}%`}
                  statusClassName="tabular-nums"
                  className="[&_[role=img]]:rounded-lg [&_[role=img]]:shadow-card"
                />
              )}
            </Masonry>
            {!pages.length && !busy && <p className="py-16 text-center text-sm text-muted-foreground">No pages captured yet.</p>}
          </>
        )}

        {tab === "animations" && (
          <div className="space-y-10">
            {!animations.length && <p className="py-16 text-center text-sm text-muted-foreground">No animations captured yet.</p>}
            {scrollRecordings.length > 0 && <AnimationSection title="Scroll" items={scrollRecordings} pages={pages} selected={sel.animations} selecting={selecting} onToggle={(id) => setSel((x) => ({ ...x, animations: toggleIn(x.animations, id) }))} />}
            {hoverRecordings.length > 0 && <AnimationSection title="Hover" items={hoverRecordings} pages={pages} selected={sel.animations} selecting={selecting} onToggle={(id) => setSel((x) => ({ ...x, animations: toggleIn(x.animations, id) }))} />}
          </div>
        )}

        {tab === "tokens" && (
          <div className="mx-auto max-w-6xl">
            {r.tokens ? <TokensPanel tokens={r.tokens} /> : <p className="py-16 text-center text-sm text-muted-foreground">Tokens appear after capture.</p>}
          </div>
        )}
      </div>

      {current && <PageViewer page={current} onClose={() => setOpenPage(null)} onCollectionsChange={setPageCollections} />}

      <Dialog open={deleting} onOpenChange={setDeleting}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete {r.domain}?</DialogTitle>
            <DialogDescription>Its pages, recordings and design tokens are deleted for good, and it leaves every board. This can't be undone.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button
              variant="destructive-confirm"
              onClick={() => {
                setDeleting(false)
                void act(async () => {
                  await api.deleteReference(r.id)
                  void refreshCollections().catch(() => {})
                  notify(`Deleted ${r.domain}`)
                  navigate("/")
                })
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function PromptPill({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      className={cn(
        "tactile press flex h-7 shrink-0 items-center gap-1.5 rounded-full pr-3 pl-2.5 text-xs font-medium whitespace-nowrap",
        on && "bg-primary text-primary-foreground shadow-primary hover:bg-(--primary-hover)",
      )}
    >
      <SparklesIcon className="size-3.5 text-ink-9" />
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
        {title} <span className="text-ink-10 tabular-nums">{items.length}</span>
      </h2>
      <Masonry>
        {items.map((a) => (
          <figure
            key={a.id}
            className={cn("group relative rounded-lg", selecting && "cursor-pointer", selected.includes(a.id) && "ring-2 ring-ink-12 ring-offset-2 ring-offset-background")}
            onClick={selecting ? () => onToggle(a.id) : undefined}
          >
            <SelectCheck on={selected.includes(a.id)} active={selecting} label={`Select ${a.label ?? a.kind} animation`} onToggle={() => onToggle(a.id)} />
            <RecordingTile a={a} bare />
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

export function RecordingTile({ a, bare }: { a: Animation; bare?: boolean }) {
  // Hover recordings are small element crops: show them at natural size, centered, instead of upscaling.
  const small = a.kind === "hover" && a.width < 480
  const frame = bare ? "rounded-lg bg-surface-top shadow-card" : "rounded-xl bg-surface-top shadow-card"
  const className = small ? "max-w-full rounded-md" : "w-full"
  const style = small ? { width: a.width } : { aspectRatio: `${a.width}/${a.height}` }
  return (
    <div className={small ? `grid place-items-center overflow-hidden p-8 ${frame}` : `overflow-hidden ${frame}`}>
      {isVideoKey(a.gifKey) ? (
        <RecordingVideo src={fileUrl(a.gifKey)} label={a.label ?? ""} className={className} style={style} />
      ) : (
        <img src={fileUrl(a.gifKey)} alt={a.label ?? ""} loading="lazy" className={className} style={style} />
      )}
    </div>
  )
}

/** A looping, muted recording that only loads and plays while near the viewport, like a lazy GIF. */
function RecordingVideo({ src, label, className, style }: { src: string | undefined; label: string; className: string; style: React.CSSProperties }) {
  const ref = useRef<HTMLVideoElement>(null)
  const [near, setNear] = useState(false)
  const [loaded, setLoaded] = useState(false) // keep the source once loaded, so scrolling back doesn't refetch
  useEffect(() => {
    const video = ref.current
    if (!video) return
    const io = new IntersectionObserver(([entry]) => setNear(!!entry?.isIntersecting), { rootMargin: "200px" })
    io.observe(video)
    return () => io.disconnect()
  }, [])
  useEffect(() => {
    const video = ref.current
    if (!video) return
    if (near) {
      setLoaded(true)
      video.play().catch(() => {})
    } else video.pause()
  }, [near])
  return (
    <video
      ref={ref}
      src={near || loaded ? src : undefined}
      aria-label={label}
      muted
      loop
      playsInline
      preload="none"
      disablePictureInPicture
      className={className}
      style={style}
    />
  )
}
