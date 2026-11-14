import { useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from "react"
import { navigate } from "wouter/use-browser-location"
import { toast } from "sonner"
import { AlertCircleIcon, ArrowRight, CheckIcon, Clock, FileIcon, GlobeIcon, ImageIcon, Link2, Loader2Icon, MoreHorizontalIcon, PauseIcon, StopIcon, XIcon } from "@/components/icons"
import { Logo } from "@/components/brand"
import { useAddFlow } from "@/components/add-flow"
import { CaptureControls, captureLabel, isStopped } from "@/components/capture-controls"
import { diagnoseCaptureError, RetryCaptureButton } from "@/components/capture-retry"
import { notify } from "@/components/notify"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { reloadCanvas } from "@/components/canvas/types"
import { LIVE_POLL, usePoll } from "@/hooks/use-poll"
import { api, DuplicateError, fileUrl, type CaptureMode, type Page, type Reference } from "@/lib/api"
import { IMAGE_TYPES, uploadImages } from "@/lib/images"
import { parseProgress } from "@/lib/capture-progress"
import { CRAWL_LIMITS, extractUrls, typedUrls } from "@/lib/site-url"
import { useCollections } from "@/lib/collections"
import { cn } from "@/lib/utils"
import { warningText } from "@/lib/page-warnings"
import { WAITING } from "../../../shared/capture-errors"

// ---------- Captures the card follows (one shows at a time; a dropped link joins them) ----------

let session: string[] = []
const listeners = new Set<() => void>()
const setSession = (next: string[]) => {
  session = next
  listeners.forEach((l) => l())
}
const track = (id: string) => setSession([...session.filter((x) => x !== id), id])
/** Show a capture started elsewhere (such as the New reference dialog) on the capture card. */
export const trackCapture = track
const untrack = (id: string) => session.includes(id) && setSession(session.filter((x) => x !== id))
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => void listeners.delete(l)
}

// Captures already running when the app loads (started in another tab, the desktop app or an agent) join once
// per page load, behind the ones started here.
let adopted = false
const adoptRunning = async () => {
  if (adopted) return
  adopted = true
  // Not paused ones: a crawl paused days ago shouldn't take over the card on every load.
  const lists = await Promise.all((["capturing", "queued"] as const).map((status) => api.references({ status }, null, 10).catch(() => null)))
  const running = lists.flatMap((l) => l?.items ?? []).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const fresh = running.map((r) => r.id).filter((id) => !session.includes(id))
  if (fresh.length) setSession([...fresh, ...session])
}

type Detail = { reference: Reference; pages: Page[] }

/** The capture the card shows: one that is capturing (the one started last), else the newest. */
const shown = (ids: string[], found: Record<string, Detail | undefined>) =>
  ids
    .filter((id) => found[id]?.reference.status === "capturing")
    .sort((a, b) => (found[a]!.reference.claimedAt ?? "").localeCompare(found[b]!.reference.claimedAt ?? ""))
    .at(-1) ?? ids.at(-1)

type CaptureOpts = { mode: CaptureMode; maxPages?: number; boardId?: string; allowDuplicate?: boolean }

/**
 * Start capturing one link and show its progress on the capture card. A link that is already saved gets an
 * "Already saved" toast (Open / Capture again) and resolves null; any other failure throws.
 */
export async function captureLink(url: URL, opts: CaptureOpts): Promise<Reference | null> {
  try {
    const ref = await api.addReference({
      url: url.href,
      mode: opts.mode,
      maxPages: opts.mode === "crawl" ? (opts.maxPages ?? 25) : 1,
      collectionIds: opts.boardId ? [opts.boardId] : undefined,
      allowDuplicate: opts.allowDuplicate,
    })
    track(ref.id)
    reloadCanvas()
    return ref
  } catch (err) {
    if (!(err instanceof DuplicateError)) throw err
    const existing = err.existing
    // One id per saved site, so asking again replaces the toast rather than stacking another.
    toast("Already saved", {
      id: `saved-${existing.id}`,
      description: existing.title ?? existing.domain,
      action: { label: "Open", onClick: () => navigate(`/r/${existing.id}`) },
      cancel: {
        label: "Capture again",
        onClick: () => void captureLink(url, { ...opts, allowDuplicate: true }).catch((e) => toast.error((e as Error).message)),
      },
    })
    return null
  }
}

/** One line for images that didn't upload. */
export const uploadFailureText = (failed: { name: string; error: string }[]) =>
  failed.length === 1 ? `Couldn't add ${failed[0].name}: ${failed[0].error}` : `Couldn't add ${failed.length} images. ${failed[0].error}`

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`

// ---------- The card ----------

const MODES = [
  { value: "single", label: "One page", icon: FileIcon },
  { value: "crawl", label: "Crawl site", icon: GlobeIcon },
] as const
const EXAMPLES = ["stripe.com", "linear.app", "vercel.com", "rauno.me"]
const RUNNING: Reference["status"][] = ["queued", "capturing", "paused"]

function Tip({ label, children }: { label: string; children: ReactElement }) {
  return (
    // These labels repeat the buttons' accessible names. When keyboard focus opens one over the URL field,
    // keep the field clickable instead of letting the label catch the click.
    <Tooltip disableHoverablePopup>
      <TooltipTrigger render={children} />
      <TooltipContent className="h-8 rounded-full px-2.5 text-xs">{label}</TooltipContent>
    </Tooltip>
  )
}

const iconButton = "press grid size-8 shrink-0 place-items-center rounded-full text-ink-10 hover:bg-ink-3 hover:text-foreground active:scale-[0.92]"

/**
 * The mascot and capture card at the canvas origin: paste a link (or several), choose one page or crawl,
 * upload images, and watch the running capture's progress with pause/stop. Self-contained: it calls the API,
 * polls, and fires reloadCanvas() as pages land.
 */
export function CaptureCard({
  boardId,
  firstRun,
  className,
  caption,
}: {
  /** Captures and uploads also go on this board. */
  boardId?: string
  /** Empty library: show the "Start your library" heading and example sites. */
  firstRun?: boolean
  className?: string
  /** Muted line under the card, such as "218 saved". */
  caption?: string
}) {
  const { addReference } = useAddFlow()
  const { collections } = useCollections()
  const input = useRef<HTMLInputElement>(null)
  const filePicker = useRef<HTMLInputElement>(null)
  const [text, setText] = useState("")
  const [mode, setMode] = useState<CaptureMode>("single")
  const [maxPages, setMaxPages] = useState(25)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [uploading, setUploading] = useState<{ done: number; total: number } | null>(null)

  // Every capture the card follows is polled while any runs; it shows the one capturing, whichever was started last here.
  const ids = useSyncExternalStore(subscribe, () => session)
  const [details, setDetails] = useState<Record<string, Detail>>({})
  const cur = shown(ids, details)
  const more = ids.length - 1
  const seen = useRef(new Map<string, Reference>())
  const view = cur ? details[cur] : undefined
  const r = view?.reference
  const running = !!cur && (!r || RUNNING.includes(r.status))
  // The pill beside the field names what the capture is doing, as the reference's status says.
  const pill = !r ? { label: "Starting…", Glyph: Loader2Icon } : r.quietSince ? { label: captureLabel(r, true)!, Glyph: Clock } : r.status === "paused" ? { label: "Paused", Glyph: PauseIcon } : r.status === "queued" ? { label: "Queued", Glyph: Clock } : { label: "Capturing", Glyph: Loader2Icon }

  /** Reload the canvas when a capture lands a page or finishes; drop finished captures the card is not showing. */
  const note = (ref: Reference, front: string | undefined) => {
    const before = seen.current.get(ref.id) ?? { pageCount: 0, status: "queued" }
    seen.current.set(ref.id, ref)
    if (ref.pageCount > before.pageCount || (ref.status === "ready" && before.status !== "ready")) reloadCanvas()
    if (ref.id === front || RUNNING.includes(ref.status)) return
    untrack(ref.id)
    if (ref.status === "failed" && !isStopped(ref))
      toast.error(`Couldn't capture ${ref.domain}`, {
        description: diagnoseCaptureError(ref.error)?.summary ?? ref.error ?? undefined,
        action: { label: "Open", onClick: () => navigate(`/r/${ref.id}`) },
      })
  }

  const poll = async () => {
    if (!ids.length) return
    const gone = (id: string) => (e: Error) => {
      if (/not found/i.test(e.message)) untrack(id)
      throw e
    }
    // Each capture by id, so one past the newest 50 references still finishes and leaves the card.
    // ponytail: one request per tracked capture; fine for a handful, batch it if people queue dozens.
    const got = await Promise.all(ids.map((id) => api.reference(id).catch(gone(id)).catch(() => null)))
    const fresh: Record<string, Detail> = {}
    got.forEach((d, i) => {
      if (d) fresh[ids[i]] = d
    })
    const front = shown(ids, fresh)
    for (const d of Object.values(fresh)) note(d.reference, front)
    setDetails((prev) => ({ ...prev, ...fresh }))
  }

  useEffect(() => void adoptRunning(), [])
  useEffect(() => {
    // Load when a capture joins; usePoll keeps them fresh after that.
    void poll().catch(() => {})
  }, [ids])
  usePoll(poll, running || more > 0, r?.status === "paused" ? undefined : LIVE_POLL)

  // A finished capture stays for a moment with its result, then the card goes back to idle.
  useEffect(() => {
    if (r?.status !== "ready") return
    const t = setTimeout(() => untrack(r.id), 6000)
    return () => clearTimeout(t)
  }, [r?.status, r?.id])

  // Focus the field on desktop; a phone would open its keyboard over the canvas.
  useEffect(() => {
    if (matchMedia("(pointer: fine)").matches) input.current?.focus({ preventScroll: true })
  }, [])

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault()
    if (submitting) return
    const { urls, error: refused } = typedUrls(text)
    if (!urls.length) {
      setError(refused)
      input.current?.focus()
      return
    }
    setSubmitting(true)
    setError(null)
    const failed: { url: URL; message: string }[] = []
    for (const url of urls) {
      try {
        await captureLink(url, { mode, maxPages, boardId })
      } catch (err) {
        failed.push({ url, message: (err as Error).message })
      }
    }
    setSubmitting(false)
    // Keep the links that failed in the field so they can be sent again as they were.
    setText(failed.map((f) => f.url.href).join(" "))
    if (failed.length) setError(urls.length === 1 ? failed[0].message : `${failed.length} of ${urls.length} couldn't be added. ${failed[0].message}`)
  }

  const upload = async (files: File[]) => {
    if (!files.length) return
    setUploading({ done: 0, total: files.length })
    const { uploaded, failed } = await uploadImages(files, { collectionId: boardId, onProgress: (done, total) => setUploading({ done, total }) })
    setUploading(null)
    if (uploaded.length) {
      reloadCanvas()
      notify(`Added ${plural(uploaded.length, "image")}`)
    }
    if (failed.length) toast.error(uploadFailureText(failed))
  }

  const fill = (site: string) => {
    setText(site)
    setError(null)
    input.current?.focus()
  }

  // While a capture runs the field shows its link until you type another.
  const showRunning = running && !text
  const board = boardId ? collections.find((c) => c.id === boardId)?.name : undefined

  return (
    <div data-no-pan className={cn("flex flex-col items-center gap-3", className)}>
      <Logo className="size-[72px]" />

      {firstRun && (
        <div className="flex flex-col items-center gap-1.5 text-center">
          <h1 className="text-2xl text-ink-12">Start your library</h1>
          <p className="text-sm text-ink-11">Paste any site. Snip saves its pages, sections, colors and type here.</p>
        </div>
      )}

      <form onSubmit={submit} className="surface-raised flex w-[520px] max-w-[calc(100vw-2rem)] flex-col gap-2 rounded-3xl bg-card p-2 shadow-modal">
        <label className={cn("well flex h-12 items-center gap-2.5 rounded-xl pr-1.5 pl-3.5", error && "shadow-[0_0_0_1px_var(--red-11)]")}>
          <Link2 className="size-4 shrink-0 text-ink-10" />
          <input
            ref={input}
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              setError(null)
            }}
            onPaste={(e) => {
              // Pasted text gives up its links, however it is worded: a sentence, or lines a text field would glue together.
              const found = extractUrls(e.clipboardData.getData("text"))
              if (!found.length) return
              e.preventDefault()
              setText(found.map((u) => u.href).join(" "))
              setError(null)
            }}
            onKeyDown={(e) => {
              if (e.key !== "Escape") return
              if (text || error) {
                setText("")
                setError(null)
              } else e.currentTarget.blur()
            }}
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            aria-label="Link to capture"
            aria-invalid={!!error}
            aria-describedby={error ? "capture-error" : undefined}
            placeholder={showRunning && r ? r.url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "") : "Paste a link, or drop an image"}
            className={cn(
              "h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-ink-10 pointer-coarse:text-base",
              showRunning && r && "placeholder:text-ink-12",
            )}
          />
          {showRunning ? (
            <span className="flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-ink-4 px-3.5 text-xs tracking-[-0.01em] text-ink-11" aria-hidden>
              <pill.Glyph className={cn("size-3.5", pill.Glyph === Loader2Icon && "animate-spin motion-reduce:animate-none")} />
              {pill.label}
            </span>
          ) : (
            <button
              type="submit"
              disabled={submitting}
              className="press flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-primary px-3.5 text-xs tracking-[-0.01em] text-primary-foreground shadow-primary hover:bg-(--primary-hover) disabled:opacity-60"
            >
              Snip
              {submitting ? <Loader2Icon className="size-3.5 animate-spin motion-reduce:animate-none" /> : <ArrowRight className="size-3.5" />}
            </button>
          )}
        </label>

        {error && (
          <p id="capture-error" role="alert" className="px-1.5 text-2xs text-(--red-11)">
            {error}
          </p>
        )}

        <div className="flex items-center gap-1 px-1 pb-0.5">
          <div role="group" aria-label="Capture" className="tactile-track flex h-8 items-center">
            {MODES.map((m) => (
              <Tip key={m.value} label={m.label}>
                <button
                  type="button"
                  aria-label={m.label}
                  aria-pressed={mode === m.value}
                  onClick={() => setMode(m.value)}
                  className={cn("press grid size-7 place-items-center rounded-full text-ink-10 hover:text-foreground", mode === m.value && "tactile-chosen")}
                >
                  <m.icon className="size-3.5" />
                </button>
              </Tip>
            ))}
          </div>
          {mode === "crawl" && (
            <div role="group" aria-label="Pages to crawl" className="tactile-track ml-1 flex h-8 items-center">
              {CRAWL_LIMITS.map((n) => (
                <button
                  key={n}
                  type="button"
                  aria-label={`Up to ${n} pages`}
                  aria-pressed={maxPages === n}
                  onClick={() => setMaxPages(n)}
                  className={cn("press h-7 min-w-9 rounded-full px-2 text-2xs text-ink-11 tabular-nums hover:text-foreground", maxPages === n && "tactile-chosen")}
                >
                  {n}
                </button>
              ))}
            </div>
          )}
          <Tip label="Upload images">
            <button type="button" aria-label="Upload images" disabled={!!uploading} onClick={() => filePicker.current?.click()} className={cn(iconButton, "ml-1 disabled:opacity-40")}>
              <ImageIcon className="size-4" />
            </button>
          </Tip>
          <Tip label="More options">
            <button type="button" aria-label="More options" onClick={() => addReference(boardId, text.trim() || undefined)} className={iconButton}>
              <MoreHorizontalIcon className="size-4" />
            </button>
          </Tip>
          <span aria-live="polite" className="ml-auto flex min-w-0 items-center gap-1.5 pr-1 text-2xs text-ink-10">
            {uploading ? (
              <>
                <Loader2Icon className="size-3 shrink-0 animate-spin motion-reduce:animate-none" />
                Uploading {Math.min(uploading.done + 1, uploading.total)} of {uploading.total}…
              </>
            ) : board ? (
              <span className="truncate">Saves to {board}</span>
            ) : null}
          </span>
          <input
            ref={filePicker}
            type="file"
            multiple
            hidden
            accept={IMAGE_TYPES.join(",")}
            onChange={(e) => {
              void upload([...(e.target.files ?? [])])
              e.target.value = ""
            }}
          />
        </div>

        {cur && <Status r={r} pages={view?.pages ?? []} more={more} onChange={() => void poll().catch(() => {})} onOpen={(id) => navigate(`/r/${id}`)} />}
      </form>

      {r && view && <Landing r={r} pages={view.pages} />}

      {firstRun && !cur && (
        <div className="flex flex-wrap items-center justify-center gap-1.5">
          <span className="pr-1 text-2xs text-ink-10">Try one</span>
          {EXAMPLES.map((site) => (
            <button key={site} type="button" onClick={() => fill(site)} className="tactile press h-7 rounded-full px-3 text-2xs">
              {site}
            </button>
          ))}
        </div>
      )}

      {caption && !firstRun && <p className="text-2xs text-ink-10">{caption}</p>}
    </div>
  )
}

function Status({
  r,
  pages,
  more,
  onChange,
  onOpen,
}: {
  r: Reference | undefined
  pages: Page[]
  more: number
  onChange: () => void
  onOpen: (id: string) => void
}) {
  const moreNote = more > 0 ? <span className="shrink-0 text-ink-10">+{more} more</span> : null
  if (!r) {
    return (
      <div className="flex h-9 items-center gap-2 px-1.5 text-xs text-ink-10">
        <Loader2Icon className="size-3.5 animate-spin motion-reduce:animate-none" />
        Starting…
      </div>
    )
  }

  if (r.status === "ready") {
    const n = r.pageCount || pages.length
    // What the capture agent noticed about the pages it saved: one page says it in full, several point at the website.
    const flagged = pages.filter((pg) => pg.warnings.length)
    const warning = flagged.length > 1 ? `${flagged.length} of ${n} pages have a warning. Open the website to see which.` : flagged[0] ? warningText(flagged[0]) : null
    return (
      <div role="status" className="flex items-center gap-2 px-1.5 py-1 text-xs">
        <span className="grid size-5 shrink-0 place-items-center rounded-full bg-(--green-3) text-(--green-11)">
          <CheckIcon className="size-3" />
        </span>
        <span className={cn("min-w-0 text-ink-12", !warning && "truncate")}>
          Saved {plural(n, "page")}
          {warning ? `. ${warning}` : ` from ${r.domain}`}
        </span>
        {moreNote}
        <button type="button" onClick={() => onOpen(r.id)} className="tactile press ml-auto h-7 shrink-0 rounded-full px-3 text-xs">
          View
        </button>
      </div>
    )
  }

  if (r.status === "failed") {
    const diagnosis = diagnoseCaptureError(r.error)
    const stopped = isStopped(r)
    return (
      <div role={stopped ? "status" : "alert"} className="flex items-center gap-2 px-1.5 py-1 text-xs">
        {stopped ? (
          <span className="grid size-5 shrink-0 place-items-center rounded-full bg-ink-3 text-ink-11">
            <StopIcon className="size-3" />
          </span>
        ) : (
          <AlertCircleIcon className="size-3.5 shrink-0 text-(--red-11)" />
        )}
        <span className={cn("min-w-0 text-ink-12", !stopped && "truncate")} title={stopped ? undefined : (r.error ?? undefined)}>
          {diagnosis?.summary ?? r.error ?? `Couldn't capture ${r.domain}`}
        </span>
        {moreNote}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <RetryCaptureButton id={r.id} error={r.error} onRetried={onChange} className="h-7 px-3 text-xs" />
          <button type="button" aria-label="Dismiss" onClick={() => untrack(r.id)} className="press grid size-7 place-items-center rounded-full text-ink-10 hover:bg-ink-3 hover:text-foreground active:scale-[0.92]">
            <XIcon className="size-3.5" />
          </button>
        </span>
      </div>
    )
  }

  // The agent has gone quiet: no spinner and no bar, which would say it is working.
  if (r.quietSince) {
    return (
      <div className="flex items-start gap-2 px-1.5 py-1">
        <p role="status" className="min-w-0 flex-1 py-1 text-xs text-ink-11">
          {captureLabel(r)} {moreNote}
        </p>
        <CaptureControls r={r} onChange={onChange} className="gap-1" />
      </div>
    )
  }

  const p = parseProgress(r)
  const paused = r.status === "paused"
  // A queued capture says what the Worker says, as the reference page does.
  const title = r.status === "queued" ? (r.progress ?? WAITING) : `${r.mode === "crawl" ? "Crawling" : "Capturing"} ${r.domain}`
  const meta = captureLabel(r, true) ?? (p ? (r.mode !== "crawl" ? p.path : p.total ? `${p.n} of ${p.total} pages` : `Page ${p.n}`) : null)
  // Share of pages finished, so the last page reads 92%, not 100%, while it is still being captured. A single page
  // has no fraction to report, nor does a crawl that has not found its total, nor a capture that has not started: the bar then
  // only shows it is working.
  const fraction = paused ? r.pageCount / Math.max(1, r.maxPages) : p?.total && r.mode === "crawl" ? (p.n - 1) / p.total : null
  return (
    <div className="flex flex-col gap-2 px-1.5 py-1">
      <div className="flex min-h-7 items-center gap-2 text-xs">
        <p aria-live="polite" className="flex min-w-0 items-center gap-2">
          <span className="truncate text-ink-12">{title}</span>
          {meta && <span className="shrink-0 text-ink-10 tabular-nums">{meta}</span>}
          {moreNote}
        </p>
        <CaptureControls r={r} onChange={onChange} className="ml-auto gap-1" />
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-ink-4">
        {fraction !== null ? (
          <div
            className={cn("h-full rounded-full transition-[width] duration-300 ease-out motion-reduce:transition-none", paused ? "bg-ink-9" : "bg-ink-12")}
            style={{ width: `${Math.max(4, Math.min(100, fraction * 100))}%` }}
          />
        ) : r.status === "capturing" ? (
          // Reduced motion gets the whole track, still; otherwise a segment sweeps along it.
          <div role="progressbar" aria-label="Capturing" className="h-full w-full rounded-full bg-ink-7 motion-safe:w-2/5 motion-safe:animate-[indeterminate_1.4s_ease-in-out_infinite] motion-safe:bg-ink-12" />
        ) : null}
      </div>
    </div>
  )
}

/** The latest pages that landed, the page being captured, and how many are still queued. */
function Landing({ r, pages }: { r: Reference; pages: Page[] }) {
  const landed = pages.filter((pg) => pg.desktopThumbKey ?? pg.mobileThumbKey).slice(-2)
  const p = parseProgress(r)
  // Nothing is capturing or waiting behind a page while the agent is quiet.
  const quiet = !!r.quietSince
  const queued = r.mode === "crawl" && p?.total && !quiet ? p.total - p.n : 0
  const capturing = r.status === "capturing" && r.control !== "stop" && !quiet
  if (!landed.length && !capturing && !queued) return null
  // Three of these and their gaps come to the card's 520 px, so the row stays between the canvas columns.
  const tile = "h-[105px] w-[168px] shrink-0 rounded-md"
  return (
    <div className="flex gap-2" aria-hidden>
      {landed.map((pg) => (
        <div key={pg.id} className={cn(tile, "relative overflow-hidden bg-card shadow-card motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-300")}>
          <img src={fileUrl(pg.desktopThumbKey ?? pg.mobileThumbKey)} alt="" draggable={false} className="size-full object-cover object-top" />
          <span className="tactile absolute bottom-1.5 left-1.5 flex h-6 max-w-[calc(100%-12px)] items-center gap-1 rounded-full pr-2 pl-1.5 text-2xs">
            <CheckIcon className="size-3 shrink-0" />
            <span className="truncate">{pg.path}</span>
          </span>
        </div>
      ))}
      {capturing && (
        <div className={cn(tile, "flex flex-col items-center justify-center gap-2 bg-ink-3 px-3 shadow-[0_0_0_1px_rgb(var(--shadow-ink)/0.08)] dark:shadow-[0_0_0_0.5px_var(--ink-6)]")}>
          <Loader2Icon className="size-4 animate-spin text-ink-10 motion-reduce:animate-none" />
          <span className="max-w-full truncate text-2xs text-ink-11">{p?.path ?? "Starting…"}</span>
        </div>
      )}
      {queued > 0 && (
        <div className={cn(tile, "flex flex-col items-center justify-center gap-2 border border-dashed border-ink-7")}>
          <Clock className="size-4 text-ink-9" />
          <span className="text-2xs text-ink-10">{queued} more queued</span>
        </div>
      )}
    </div>
  )
}
