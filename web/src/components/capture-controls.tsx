import { useRef, useState } from "react"
import { PauseIcon, PlayIcon, XIcon } from "@/components/icons"
import { Spinner } from "@/components/ui/spinner"
import { notify } from "@/components/notify"
import { api, type Reference } from "@/lib/api"
import { cn } from "@/lib/utils"
import { STOPPED_EMPTY } from "../../shared/capture-errors"

type Action = "pause" | "resume" | "cancel"

const ACTIONS: Record<Action, { label: string; title: string; done: string; icon: typeof PauseIcon }> = {
  pause: { label: "Pause", title: "Pause after the page being captured. Resume picks up where it left off.", done: "Pausing after this page", icon: PauseIcon },
  resume: { label: "Resume", title: "Continue capturing from where it paused", done: "Resuming capture", icon: PlayIcon },
  cancel: { label: "Cancel", title: "Cancel this capture now and keep completed pages", done: "Capture cancelled", icon: XIcon },
}

/**
 * Every active capture can be cancelled, including single pages started from suggestions.
 * Only crawls offer Pause/Resume, which still take effect at page boundaries.
 */
export function captureActions(r: Reference): Action[] {
  if (!["queued", "capturing", "paused"].includes(r.status)) return []
  if (r.quietSince || r.mode !== "crawl" || r.control === "stop") return ["cancel"]
  if (r.status === "paused" || r.control === "pause") return ["resume", "cancel"]
  return ["pause", "cancel"]
}

/** A capture the user stopped before any page was saved. The Worker records that as a failure; to the user it is not one. */
export const isStopped = (r: Reference) => r.status === "failed" && r.error === STOPPED_EMPTY

/** Status line for a capture that has not finished, including a pause or stop that is winding down, one whose agent has gone quiet, and one stopped before it saved a page. */
export function captureLabel(r: Reference, short = false) {
  if (isStopped(r)) return "Stopped"
  if (r.quietSince) return short ? "Not responding" : "The capture agent stopped responding. Snip picks this up again automatically, or you can cancel it."
  if (r.status === "paused") return r.pageCount ? (short ? `Paused at ${r.pageCount} of ${r.maxPages}` : `Paused after ${r.pageCount} of ${r.maxPages} pages`) : "Paused"
  if (r.control === "pause") return short ? "Pausing…" : "Pausing after this page"
  if (r.control === "stop") return short ? "Stopping…" : "Stopping after this page"
  return null
}

/** Pause/Resume for crawls, and immediate cancellation for any capture. */
export function CaptureControls({ r, onChange, className }: { r: Reference; onChange: () => void | Promise<void>; className?: string }) {
  const [busy, setBusy] = useState<Action | null>(null)
  const pending = useRef(false)
  const actions = captureActions(r)
  if (!actions.length) return null
  const run = async (action: Action) => {
    if (pending.current) return
    pending.current = true
    setBusy(action)
    try {
      const next = await api.captureControl(r.id, action)
      // What the response says happened: a capture with no page in flight pauses at once.
      notify(
        next?.status === "ready"
          ? `Stopped with ${next.pageCount} ${next.pageCount === 1 ? "page" : "pages"}`
          : next?.status === "failed"
            ? "Capture stopped"
            : next?.status === "paused"
              ? "Paused"
              : ACTIONS[action].done,
      )
    } catch (err) {
      notify(`Couldn't ${action}: ${(err as Error).message}`)
    } finally {
      await Promise.resolve().then(onChange).catch(() => {})
      pending.current = false
      setBusy(null)
    }
  }
  return (
    <span className={cn("inline-flex items-center", "gap-2", className)}>
      {actions.map((action) => {
        const { label, icon: Icon } = ACTIONS[action]
        const title = ACTIONS[action].title
        return (
          <button
            key={action}
            type="button"
            disabled={!!busy}
            aria-busy={busy === action}
            title={title}
            aria-label={label}
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              void run(action)
            }}
            className={cn(
              "tactile press inline-flex shrink-0 items-center justify-center rounded-full font-medium text-foreground disabled:opacity-60",
              // Full size matches the capture pill beside it in the site scope.
              "h-7 gap-1.5 px-3 text-xs [@media(pointer:coarse)]:min-h-11",
            )}
          >
            {busy === action ? <Spinner aria-hidden className="size-3.5" /> : <Icon className="size-3.5" />}
            {label}
          </button>
        )
      })}
    </span>
  )
}
