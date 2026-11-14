import { useState } from "react"
import { RefreshCwIcon } from "@/components/icons"
import { Spinner } from "@/components/ui/spinner"
import { notify } from "@/components/notify"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"
import { diagnoseCaptureError, STOPPED_EMPTY } from "../../shared/capture-errors"

export { diagnoseCaptureError }

/**
 * Requeue a failed capture. The capture agent repairs known problems (such as a
 * missing browser) when it picks the job back up, so Retry is all the user needs.
 * For a capture the user stopped it reads Re-capture: there was nothing to retry.
 */
export function RetryCaptureButton({ id, error, onRetried, className }: { id: string; error: string | null; onRetried: () => void; className?: string }) {
  const [busy, setBusy] = useState(false)
  const diagnosis = diagnoseCaptureError(error)
  const stopped = error === STOPPED_EMPTY
  return (
    <button
      type="button"
      disabled={busy}
      title={stopped ? undefined : (diagnosis?.fix ?? "Queue this capture again")}
      onClick={async (e) => {
        e.preventDefault()
        e.stopPropagation()
        setBusy(true)
        try {
          await api.recapture(id)
          notify(stopped ? "Re-capture queued" : diagnosis ? "Retrying with a fix" : "Retry queued")
          onRetried()
        } catch (err) {
          notify(`Couldn't retry: ${(err as Error).message}`)
        } finally {
          setBusy(false)
        }
      }}
      className={cn("tactile press inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2.5 text-2xs font-medium text-foreground disabled:opacity-60", className)}
    >
      {busy ? <Spinner className="size-3" /> : <RefreshCwIcon className="size-3" />}
      {stopped ? "Re-capture" : "Retry"}
    </button>
  )
}
