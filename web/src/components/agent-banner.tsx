import { useEffect, useState } from "react"
import { TriangleAlertIcon } from "@/components/icons"
import { api, type AgentPresence } from "@/lib/api"

const CHECK_MS = 30_000

/** Says so when captures are waiting and the capture agent isn't checking in. */
export function AgentBanner() {
  const [state, setState] = useState<{ presence: AgentPresence; waiting: boolean } | null>(null)

  useEffect(() => {
    let alive = true
    const check = async () => {
      try {
        const [presence, queued, capturing] = await Promise.all([
          api.agent(),
          api.references({ status: "queued" }, null),
          api.references({ status: "capturing" }, null),
        ])
        if (alive) setState({ presence, waiting: queued.items.length + capturing.items.length > 0 })
      } catch {
        /* the gallery shows its own errors */
      }
    }
    void check()
    const timer = setInterval(() => document.visibilityState === "visible" && void check(), CHECK_MS)
    const reload = () => void check()
    window.addEventListener("rs:reload", reload)
    return () => {
      alive = false
      clearInterval(timer)
      window.removeEventListener("rs:reload", reload)
    }
  }, [])

  if (!state?.waiting || state.presence.freshness === "recent") return null
  const seen = state.presence.lastSeenAt ? new Date(state.presence.lastSeenAt) : null
  const when = seen
    ? seen.toDateString() === new Date().toDateString()
      ? seen.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
      : seen.toLocaleDateString([], { month: "short", day: "numeric" })
    : null
  const desktop = typeof window !== "undefined" && !!window.snipDesktop
  return (
    <div role="status" className="mx-4 mt-3 flex items-start gap-2.5 rounded-xl bg-ink-2 px-3.5 py-2.5 text-xs text-ink-12 shadow-[0_0_0_0.5px_var(--ink-6)] sm:mx-6 dark:bg-ink-3">
      <TriangleAlertIcon className="mt-px size-3.5 shrink-0 text-(--red-11)" />
      <p>
        <span className="font-medium">{when ? `Capture agent offline since ${when}.` : "No capture agent has connected yet."}</span>{" "}
        Queued captures wait until it runs.{" "}
        {desktop ? "Use Retry in Snip's menu bar, or restart Snip." : <>Start it with <code className="rounded bg-ink-4 px-1 py-px font-mono">npm run capture</code>, or open Snip.app.</>}
      </p>
    </div>
  )
}
