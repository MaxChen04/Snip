import { useEffect, useState } from "react"
import { TriangleAlertIcon } from "@/components/icons"
import { api, type AgentPresence } from "@/lib/api"
import { agentAdvice, agentState } from "../../shared/agent-state"

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

  const agent = state?.waiting ? agentState(state.presence) : null
  if (!agent || agent.kind === "online") return null
  const { headline, action } = agentAdvice(agent, typeof window !== "undefined" && window.snipDesktop ? "desktop" : "browser")
  return (
    <div role="status" className="mx-4 mt-3 flex items-start gap-2.5 rounded-xl bg-ink-2 px-3.5 py-2.5 text-xs text-ink-12 shadow-[0_0_0_0.5px_var(--ink-6)] sm:mx-6 dark:bg-ink-3">
      <TriangleAlertIcon className="mt-px size-3.5 shrink-0 text-(--red-11)" />
      <p>
        <span className="font-medium">{headline}</span>{" "}
        {action.split("`").map((part, i) => (i % 2 ? <code key={i} className="rounded bg-ink-4 px-1 py-px font-mono">{part}</code> : part))}
      </p>
    </div>
  )
}
