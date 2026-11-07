import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import type { CloudError, CloudSnapshotState, EngineChoiceEvent, EngineEvent } from "./types"

export type LiveStatus = "pending" | "running" | "waiting" | "done" | "skipped" | "failed"
export interface LiveStep {
  id: string
  status: LiveStatus
  message?: string
  detail?: string
}
export interface HumanAction {
  step: string
  action: "enable_r2" | "open_url"
  url?: string
  message?: string
}
export interface Progress {
  step: string
  message?: string
  current?: number
  total?: number
  unit?: string
}

const EMPTY: CloudSnapshotState = { mode: "local", state: null, busy: false, running: null }

function resultMessage(code: string): string {
  switch (code) {
    case "NEEDS_INPUT":
      return "Snip needs one more choice before it can continue."
    case "LOCKED":
      return "Another Snip setup is already running."
    case "UNSUPPORTED":
      return "This Mac can’t run cloud setup yet."
    case "FAILED":
      return "Setup stopped before it finished."
    default:
      return "Setup didn’t finish."
  }
}

/**
 * One source of truth for Settings: a disk snapshot plus the live engine events.
 * The renderer never inspects the engine's files; everything arrives over the bridge.
 */
export function useCloud(bridge = window.snipCloud) {
  const [snapshot, setSnapshot] = useState<CloudSnapshotState>(EMPTY)
  const [loaded, setLoaded] = useState(false)
  const [steps, setSteps] = useState<Record<string, LiveStep>>({})
  const [action, setAction] = useState<HumanAction | null>(null)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [error, setError] = useState<CloudError | null>(null)
  const [choice, setChoice] = useState<EngineChoiceEvent | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ level: "info" | "warn" | "error"; message: string; id: number } | null>(null)
  const runId = useRef(0)

  const refresh = useCallback(async () => {
    if (!bridge) return
    try {
      const next = await bridge.state()
      if (next) {
        setSnapshot(next)
        setBusy(next.busy)
        setError(next.state?.error ?? null)
        if (!next.busy) {
          setSteps(previous => {
            // A cold read wins only when no engine is running; live events are fresher otherwise.
            const seeded: Record<string, LiveStep> = {}
            for (const step of next.state?.steps ?? []) {
              seeded[step.id] = { id: step.id, status: step.status === "running" ? "running" : step.status, detail: step.detail ?? undefined }
            }
            return Object.keys(previous).length && next.busy ? previous : seeded
          })
        }
      }
    } finally {
      setLoaded(true)
    }
  }, [bridge])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Settings can open while main is still resolving Node; once the runtime is ready
  // there is no event to tell us, so check until the bridge reports it.
  useEffect(() => {
    if (snapshot.ready !== false) return
    const timer = window.setInterval(() => void refresh(), 750)
    return () => window.clearInterval(timer)
  }, [snapshot.ready, refresh])

  useEffect(() => {
    if (!bridge) return
    const offProgress = bridge.onProgress((event: EngineEvent) => {
      if (event.event === "step") {
        setBusy(true)
        setSteps(previous => ({
          ...previous,
          [event.step]: {
            id: event.step,
            status: event.status === "started" ? "running" : event.status === "ok" ? "done" : event.status === "skipped" ? "skipped" : event.status === "waiting" ? "waiting" : "failed",
            message: event.message ?? previous[event.step]?.message,
            detail: event.detail,
          },
        }))
        if (event.status === "started") setError(null)
        if (event.status !== "waiting" && event.status !== "started") setAction(current => (current?.step === event.step ? null : current))
        if (event.status === "failed") {
          setError({
            step: event.step,
            code: typeof event.data?.code === "string" ? event.data.code : null,
            message: event.message ?? "This step stopped.",
            hint: typeof event.data?.hint === "string" ? event.data.hint : null,
            at: event.at ?? null,
          })
        }
        return
      }
      if (event.event === "human") {
        setAction({ step: event.step, action: event.action, url: event.url, message: event.message })
        return
      }
      if (event.event === "choice") {
        // Terminal: the engine stopped so a consequence is never inferred from a default.
        setChoice(event)
        setAction(null)
        setBusy(false)
        return
      }
      if (event.event === "progress") {
        setProgress({ step: event.step, message: event.message, current: event.current, total: event.total, unit: event.unit })
        return
      }
      if (event.event === "needs_input") {
        const label = event.keys?.[0]?.label ?? "one more choice"
        setNote({ level: "warn", message: `Snip needs ${label} to continue.`, id: Date.now() })
        return
      }
      if (event.event === "result") {
        setBusy(false)
        setAction(null)
        setProgress(null)
        if (!event.ok && event.code !== "CANCELLED") {
          const retryable = event.retryable !== false
          setError(previous => previous
            ? { ...previous, retryable }
            : {
                step: typeof event.data?.step === "string" ? event.data.step : null,
                code: event.code,
                message: typeof event.data?.message === "string" ? event.data.message : resultMessage(event.code),
                hint: typeof event.data?.hint === "string" ? event.data.hint : null,
                at: null,
                retryable,
              })
        }
        void refresh()
        // The child may still be exiting when the result lands; read the final mode once more.
        window.setTimeout(() => void refresh(), 400)
      }
    })
    const offLog = bridge.onLog(entry => {
      setNote({ level: entry.level, message: entry.message, id: Date.now() })
      if (entry.level === "error") toast.error(entry.message)
    })
    return () => {
      offProgress()
      offLog()
    }
  }, [bridge, refresh])

  const begin = useCallback(async (call: () => Promise<{ started?: true; error?: string }>) => {
    const ticket = ++runId.current
    setSteps({})
    setAction(null)
    setProgress(null)
    setError(null)
    setChoice(null)
    setBusy(true)
    const reply = await call()
    if (reply?.error) {
      if (ticket === runId.current) setBusy(false)
      toast.error(reply.error)
      return false
    }
    return true
  }, [])

  return {
    bridge,
    snapshot,
    loaded,
    mode: snapshot.mode,
    file: snapshot.state,
    cloud: snapshot.state?.cloud ?? null,
    snapshotRecord: snapshot.state?.snapshot ?? null,
    local: snapshot.local ?? null,
    engineAvailable: snapshot.engine?.available !== false,
    busy: busy || snapshot.busy,
    running: snapshot.running,
    steps,
    action,
    choice,
    progress,
    error,
    note,
    refresh,
    begin,
    clearChoice: () => setChoice(null),
    clearNote: () => setNote(null),
  }
}
