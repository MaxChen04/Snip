import { useCallback, useEffect, useRef, useState } from "react"
import { Link } from "wouter"
import { toast } from "sonner"
import {
  AlertCircleIcon,
  ArrowUpRightIcon,
  ChevronDownIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FolderIcon,
  MoreHorizontalIcon,
  PauseIcon,
  RefreshCwIcon,
  StopIcon,
  Trash2Icon,
} from "@/components/icons"
import { captureActions, CaptureControls, captureLabel, isStopped } from "@/components/capture-controls"
import { diagnoseCaptureError, RetryCaptureButton } from "@/components/capture-retry"
import { CollectionPicker } from "@/components/collection-picker"
import { notify } from "@/components/notify"
import { SiteIcon } from "@/components/site-icon"
import { RELOAD_EVENT, reloadCanvas } from "@/components/canvas/types"
import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Progress } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"
import { LIVE_POLL, usePoll } from "@/hooks/use-poll"
import { api, NotFoundError, type Animation, type Page, type Reference } from "@/lib/api"
import { parseProgress } from "@/lib/capture-progress"
import { useCollections } from "@/lib/collections"
import { exportReference } from "@/lib/export-reference"
import { leaveSite } from "@/lib/scope"
import { cn } from "@/lib/utils"
import { WAITING } from "../../../shared/capture-errors"

export type SiteDetail = { reference: Reference; pages: Page[]; animations: Animation[] }

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`
export const isBusy = (r: Reference) => r.status === "queued" || r.status === "capturing" || r.status === "paused"

/**
 * The website a scope shows: its record, pages and recordings, polled while it captures so each saved page appears.
 * A failed refresh keeps the last good copy; `missing` is a site that no longer exists.
 */
export function useSite(id: string | null) {
  const [state, setState] = useState<{ id: string; detail: SiteDetail | null; error: Error | null }>()
  // Only the newest request counts: a late answer for the site the user just left must not replace this one's.
  const latest = useRef(0)
  // The site on screen. A reload or update made for another one (a Re-capture, note or Organize that finished after
  // the user moved on) is dropped before it can touch this site's state.
  const active = useRef(id)
  active.current = id
  const shown = useRef<Reference | null>(null)
  const load = useCallback(() => {
    if (!id || active.current !== id) return Promise.resolve()
    const request = ++latest.current
    return api.reference(id).then(
      (detail) => {
        if (request !== latest.current) return
        // New pages or recordings: everything else holding a copy of this site (the inspector's) refreshes.
        const before = shown.current
        shown.current = detail.reference
        const r = detail.reference
        if (before?.id === id && (r.pageCount > before.pageCount || r.animationCount > before.animationCount || (r.status === "ready" && before.status !== "ready"))) reloadCanvas()
        setState({ id, detail, error: null })
      },
      (error: Error) => request === latest.current && setState((s) => ({ id, detail: s?.id === id && !(error instanceof NotFoundError) ? s.detail : null, error })),
    )
  }, [id])
  useEffect(() => void load(), [load])
  // A change made elsewhere (the inspector's note, an upload, a capture) reloads the site too.
  useEffect(() => {
    const onReload = () => void load()
    window.addEventListener(RELOAD_EVENT, onReload)
    return () => window.removeEventListener(RELOAD_EVENT, onReload)
  }, [load])
  const current = state?.id === id ? state : undefined
  const r = current?.detail?.reference
  usePoll(load, !!r && (r.status === "queued" || r.status === "capturing"), r?.status === "capturing" ? LIVE_POLL : undefined)
  const update = (fn: (d: SiteDetail) => SiteDetail) => setState((s) => (s?.id === id && s.detail ? { ...s, detail: fn(s.detail) } : s))
  return { detail: current?.detail ?? null, error: current?.error ?? null, missing: current?.error instanceof NotFoundError, reload: load, update }
}

/** The owner's note on a website. Saved when the field loses focus; Escape discards the edit. */
function NoteField({ r, onSaved }: { r: Reference; onSaved: (notes: string | null) => void }) {
  const [value, setValue] = useState(r.notes ?? "")
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
          // Discard the edit and keep the popover open: the next Escape closes it.
          e.stopPropagation()
          cancelling.current = true
          setValue(r.notes ?? "")
          e.currentTarget.blur()
        }
      }}
      maxLength={2000}
      rows={2}
      aria-label="Note"
      placeholder="Add a note: what to borrow from it"
      className="field-sizing-content max-h-40 min-h-16 w-full resize-none rounded-lg bg-ink-2 px-3 py-2 text-xs text-foreground outline-none placeholder:text-ink-9 focus-visible:outline-2 focus-visible:outline-offset-2 dark:bg-ink-3"
    />
  )
}

const optionLabel = (r: Reference) =>
  [r.options?.colorScheme === "dark" && "Dark mode", r.options?.desktopWidth && `${r.options.desktopWidth}px`, r.options?.signedIn && "Signed in"].filter(Boolean).join(" · ")
const savedOn = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: new Date(iso).getFullYear() === new Date().getFullYear() ? undefined : "numeric" })

const action = "tactile press flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium [&_svg]:size-3.5 [&_svg]:text-ink-10"

/**
 * Bottom left inside a site: its name and page count, opening the site's details (note, Visit, Organize, More). Takes the
 * place of the library's "N saved" caption.
 */
export function SitePill({ site, onChange }: { site: ReturnType<typeof useSite>; onChange: () => void }) {
  const { collections, refresh } = useCollections()
  const [recapturing, setRecapturing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [working, setWorking] = useState(false)
  if (!site.detail) return null
  const { reference: r, pages, animations } = site.detail
  const sections = pages.reduce((n, p) => n + p.sections.length, 0)
  const boards = collections.filter((c) => r.collectionIds.includes(c.id))
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
  const recapture = () =>
    void act(async () => {
      await api.recapture(r.id)
      notify("Re-capture queued")
      await site.reload()
      onChange()
    })
  const toggleBoard = async (cid: string, member: boolean) => {
    try {
      await api.setMembership(r.id, cid, member)
    } catch (e) {
      return void toast.error((e as Error).message)
    }
    site.update((d) => {
      const others = d.reference.collectionIds.filter((x) => x !== cid)
      return { ...d, reference: { ...d.reference, collectionIds: member ? [...others, cid] : others } }
    })
    void refresh().catch(() => {})
  }
  const exportZip = async () => {
    const id = toast.loading("Preparing export…")
    try {
      const n = await exportReference(r, pages, animations, (done, total) => toast.loading(`Preparing export… ${done}/${total}`, { id }))
      toast.success(`Exported ${n} files`, { id })
    } catch (e) {
      toast.error(`Export failed: ${(e as Error).message}`, { id })
    }
  }
  const name = r.title || r.domain
  return (
    <>
      <Popover>
        <PopoverTrigger
          aria-label={`Site details: ${name}`}
          className="press flex h-10 max-w-[calc(50vw-200px)] min-w-0 items-center gap-2 rounded-full bg-control pr-3 pl-2.5 text-xs font-medium shadow-button hover:bg-control-hover data-popup-open:bg-control-hover max-md:max-w-none max-md:pr-2.5"
        >
          <SiteIcon domain={r.domain} icon={r.favicon} className="size-5 rounded-md" />
          <span className="truncate max-md:hidden">{name}</span>
          <span className="shrink-0 text-ink-10 tabular-nums max-lg:hidden">· {plural(r.pageCount, "page")}</span>
          <ChevronDownIcon className="size-3.5 shrink-0 text-ink-10" />
        </PopoverTrigger>
        <PopoverContent side="top" align="start" sideOffset={10} className="flex w-[22rem] max-w-[calc(100vw-32px)] flex-col gap-3 rounded-2xl p-4">
          <div className="flex min-w-0 items-center gap-3">
            <SiteIcon domain={r.domain} icon={r.favicon} className="size-9 rounded-lg shadow-button" />
            <div className="min-w-0">
              <p className="truncate text-base leading-6 font-medium tracking-tight">{name}</p>
              <a href={r.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-ink-11 hover:text-foreground">
                <span className="truncate">{r.domain}</span>
                <ArrowUpRightIcon className="size-3 shrink-0" />
              </a>
            </div>
          </div>
          <p className="text-2xs text-ink-10 tabular-nums">
            {[plural(r.pageCount, "page"), plural(sections, "section"), plural(animations.length, "recording"), optionLabel(r), `saved ${savedOn(r.createdAt)}`].filter(Boolean).join(" · ")}
            {boards.length > 0 && (
              <>
                {" · on "}
                {boards.map((c, i) => (
                  <span key={c.id}>
                    {i > 0 && ", "}
                    <Link href={`/b/${c.id}`} className="underline decoration-ink-7 underline-offset-2 hover:text-foreground">
                      {c.name}
                    </Link>
                  </span>
                ))}
              </>
            )}
          </p>
          <NoteField
            r={r}
            onSaved={(notes) => {
              site.update((d) => ({ ...d, reference: { ...d.reference, notes } }))
              reloadCanvas()
            }}
          />
          <div className="flex flex-wrap items-center gap-2">
            <a href={r.url} target="_blank" rel="noreferrer" title="Opens in a new tab" className={action}>
              <ExternalLinkIcon />
              Visit
            </a>
            <Popover>
              <PopoverTrigger className={cn(action, "data-popup-open:bg-control-hover")}>
                <FolderIcon />
                Organize
              </PopoverTrigger>
              <PopoverContent side="top" align="start" className="w-80 p-2">
                <CollectionPicker className="max-h-72" selected={r.collectionIds} onToggle={(cid, on) => void toggleBoard(cid, on)} />
              </PopoverContent>
            </Popover>
            <DropdownMenu>
              <DropdownMenuTrigger className={cn(action, "data-popup-open:bg-control-hover")}>
                <MoreHorizontalIcon />
                More
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" className="w-52">
                {/* The server refuses to re-capture one that is still queued, capturing or paused. */}
                {(r.status === "ready" || r.status === "failed") && (
                  <DropdownMenuItem disabled={working} onClick={() => (pages.length ? setRecapturing(true) : recapture())}>
                    <RefreshCwIcon /> Re-capture
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem disabled={!pages.length} onClick={() => void exportZip()}>
                  <DownloadIcon /> Export as .zip
                </DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onClick={() => setDeleting(true)}>
                  <Trash2Icon /> Delete reference
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </PopoverContent>
      </Popover>

      <Dialog open={recapturing} onOpenChange={setRecapturing}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Re-capture {r.domain}?</DialogTitle>
            <DialogDescription>
              Its {plural(pages.length, "captured page")} will be replaced.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button
              onClick={() => {
                setRecapturing(false)
                recapture()
              }}
            >
              Re-capture
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <DeleteSiteDialog r={r} open={deleting} onOpenChange={setDeleting} />
    </>
  )
}

/** Confirm, delete, and leave the scope: the site is gone. */
function DeleteSiteDialog({ r, open, onOpenChange }: { r: Reference; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { refresh } = useCollections()
  const [busy, setBusy] = useState(false)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Delete {r.domain}?</DialogTitle>
          <DialogDescription>Its pages, recordings and design tokens are deleted for good, and it leaves every board. This can't be undone.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button
            variant="destructive-confirm"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                await api.deleteReference(r.id)
                onOpenChange(false)
                void refresh().catch(() => {})
                notify(`Deleted ${r.domain}`)
                reloadCanvas()
                leaveSite()
              } catch (e) {
                toast.error((e as Error).message)
              } finally {
                setBusy(false)
              }
            }}
          >
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** How far a capture has got: the share of pages finished, so the last page reads 83%, not 100%, while it captures. */
function captureShare(r: Reference) {
  const p = parseProgress(r)
  if (r.status === "paused" && r.maxPages) return r.pageCount / r.maxPages
  return p?.total ? (p.n - 1) / p.total : null
}

/**
 * A capture that hasn't finished, under the search pill: what it is doing, how far it got, and Pause, Resume and Stop.
 * A failed capture says what went wrong with Retry; one stopped before it saved a page offers Retry and Delete.
 */
export function CapturePill({ r, onChange }: { r: Reference; onChange: () => void }) {
  const [deleting, setDeleting] = useState(false)
  if (r.status === "ready") return null
  if (isStopped(r))
    return (
      <div className="flex flex-wrap items-center justify-center gap-2 rounded-full bg-control/90 p-1 pl-3 text-xs shadow-button backdrop-blur-md">
        <StopIcon className="size-3.5 text-ink-10" />
        <span role="status">{diagnoseCaptureError(r.error)?.summary}</span>
        <RetryCaptureButton id={r.id} error={r.error} onRetried={onChange} className="h-7 gap-1.5 px-3 text-xs" />
        <button type="button" onClick={() => setDeleting(true)} className="tactile press inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-medium text-(--red-11)">
          <Trash2Icon className="size-3.5" />
          Delete
        </button>
        <DeleteSiteDialog r={r} open={deleting} onOpenChange={setDeleting} />
      </div>
    )
  if (r.status === "failed") {
    const diagnosis = diagnoseCaptureError(r.error)
    return (
      <div role="alert" className="flex max-w-xl items-start gap-2.5 rounded-2xl bg-(--red-3) px-3.5 py-2.5 text-left text-xs text-(--red-11) shadow-badge">
        <AlertCircleIcon className="mt-0.5 size-3.5 shrink-0" />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="font-medium">{diagnosis?.summary ?? "Capture failed."}</p>
          {diagnosis && <p className="text-(--red-11)/80">{diagnosis.fix}</p>}
          {r.error && <p className="font-mono text-2xs break-words text-(--red-11)/70">{r.error}</p>}
        </div>
        <RetryCaptureButton id={r.id} error={r.error} onRetried={onChange} />
      </div>
    )
  }
  const share = captureShare(r)
  const label = captureLabel(r) ?? r.progress ?? WAITING
  return (
    <div className="flex max-w-full items-center gap-2 rounded-full bg-control/90 p-1 pl-3 text-xs shadow-button backdrop-blur-md">
      {r.status === "paused" ? <PauseIcon className="size-3.5 shrink-0 text-ink-10" /> : !r.quietSince && <Spinner className="size-3.5 shrink-0 text-ink-10" />}
      <span role="status" className={cn("min-w-0 truncate tabular-nums", r.quietSince && "whitespace-normal text-ink-11")}>
        {label}
      </span>
      {/* A quiet capture isn't moving: no bar, as on the capture card. */}
      {!r.quietSince && <Progress value={share} paused={r.status === "paused"} label="Pages captured" className="w-14 shrink-0 max-sm:hidden" />}
      <CaptureControls r={r} onChange={onChange} className="gap-1" />
      {/* Room at the right end when there are no buttons to end the pill. */}
      {!captureActions(r).length && <span className="w-2" />}
    </div>
  )
}
