import { useState } from "react"
import { PauseIcon, PlayIcon, StopIcon } from "@/components/icons"
import { Spinner } from "@/components/ui/spinner"
import { notify } from "@/components/notify"
import { api, type Reference } from "@/lib/api"
import { cn } from "@/lib/utils"

type Action = "pause" | "resume" | "stop"

const ACTIONS: Record<Action, { label: string; title: string; done: string; icon: typeof PauseIcon }> = {
  pause: { label: "Pause", title: "Pause after the page being captured. Resume picks up where it left off.", done: "Pausing after this page", icon: PauseIcon },
  resume: { label: "Resume", title: "Continue capturing from where it paused", done: "Resuming capture", icon: PlayIcon },
  stop: { label: "Stop", title: "Stop after the page being captured and keep the pages captured so far", done: "Stopping after this page", icon: StopIcon },
}

/** Which controls a capture offers right now. Only crawls have pages to pause or stop between. */
export function captureActions(r: Reference): Action[] {
  if (r.mode !== "crawl") return []
  if (r.status === "paused") return ["resume", "stop"]
  if (r.status === "capturing") return r.control === "stop" ? [] : r.control === "pause" ? ["resume", "stop"] : ["pause", "stop"]
  if (r.status === "queued") return ["pause", "stop"]
  return []
}

/** Status line for a capture that has not finished, including a pause or stop that is winding down. */
export function captureLabel(r: Reference, short = false) {
  if (r.status === "paused") return r.pageCount ? (short ? `Paused at ${r.pageCount} of ${r.maxPages}` : `Paused after ${r.pageCount} of ${r.maxPages} pages`) : "Paused"
  if (r.control === "pause") return short ? "Pausing…" : "Pausing after this page"
  if (r.control === "stop") return short ? "Stopping…" : "Stopping after this page"
  return null
}

/**
 * Pause, Resume and Stop for a running crawl. Each takes effect between pages, so the page
 * being captured always finishes.
 */
export function CaptureControls({ r, onChange, className }: { r: Reference; onChange: () => void; className?: string }) {
  const [busy, setBusy] = useState<Action | null>(null)
  const actions = captureActions(r)
  if (!actions.length) return null
  const run = async (action: Action) => {
    setBusy(action)
    try {
      const next = await api.captureControl(r.id, action)
      notify(next?.status === "ready" ? `Stopped with ${next.pageCount} ${next.pageCount === 1 ? "page" : "pages"}` : next?.status === "failed" ? "Capture stopped" : ACTIONS[action].done)
      onChange()
    } catch (err) {
      notify(`Couldn't ${action}: ${(err as Error).message}`)
      onChange()
    } finally {
      setBusy(null)
    }
  }
  return (
    <span className={cn("inline-flex items-center", "gap-2", className)}>
      {actions.map((action) => {
        const { label, title, icon: Icon } = ACTIONS[action]
        return (
          <button
            key={action}
            type="button"
            disabled={!!busy}
            title={title}
            aria-label={label}
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              void run(action)
            }}
            className={cn(
              "tactile press inline-flex shrink-0 items-center justify-center rounded-full font-medium text-foreground disabled:opacity-60",
              // Full size matches the status pill beside it on the reference page.
              "h-7 gap-1.5 px-3 text-xs",
            )}
          >
            {busy === action ? <Spinner className="size-3.5" /> : <Icon className="size-3.5" />}
            {label}
          </button>
        )
      })}
    </span>
  )
}
