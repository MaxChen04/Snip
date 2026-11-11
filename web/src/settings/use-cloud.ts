import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import type { CloudError, CloudSnapshotState, EngineChoiceEvent, EngineEvent, OwnerLink } from "./types"

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
export interface NeededInput {
  key: string
  label: string
  secret: boolean
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
    case "CONFIRM_MISSING":
    case "CONFIRM_MISMATCH":
      // The record the person saw no longer matches what is on disk.
      return "This item changed. Refresh and try again."
    case "FAILED":
      return "Setup stopped before it finished."
    default:
      return "Setup didn’t finish."
  }
}

const CONFIRM_CODES = new Set(["CONFIRM_MISSING", "CONFIRM_MISMATCH"])

/**
 * One source of truth for Settings: main's `state()` snapshot plus the live engine events
 * of the run in flight. Main never pushes state, so this re-reads it whenever main says
 * something happened. The renderer never inspects the engine's files.
 */
export function useCloud(bridge = window.snipCloud) {
  const [snapshot, setSnapshot] = useState<CloudSnapshotState>(EMPTY)
  const [loaded, setLoaded] = useState(false)
  const [steps, setSteps] = useState<Record<string, LiveStep>>({})
  const [action, setAction] = useState<HumanAction | null>(null)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [error, setError] = useState<CloudError | null>(null)
  const [choice, setChoice] = useState<EngineChoiceEvent | null>(null)
  const [needed, setNeeded] = useState<NeededInput[] | null>(null)
  const [link, setLink] = useState<OwnerLink | null>(null)
  const [linkPending, setLinkPending] = useState(false)
  const [linkError, setLinkError] = useState<string | null>(null)
  // The log callback is installed once; this ref says whether a mint is waiting, so a
  // failure can be shown in the sheet that asked for it instead of as a loose toast.
  const minting = useRef(false)
  // The link arrives on its own channel. These let the wait end the moment it does,
  // rather than after the next `state()` round trip.
  const linkSettled = useRef(false)
  const linkLatest = useRef<OwnerLink | null>(null)
  const [note, setNote] = useState<{ level: "info" | "warn" | "error"; message: string; id: number } | null>(null)
  // `state()` replies can land out of order: one issued before the last applied is dropped.
  const reads = useRef({ issued: 0, applied: 0 })

  // A snapshot read can be older than the link event; keep a link that is still valid
  // rather than blanking it, and drop one that has run out.
  const keepLink = useCallback((current: OwnerLink | null, next: OwnerLink | null | undefined) =>
    next ?? (current && Date.parse(current.expiresAt) > Date.now() ? current : null), [])

  const refresh = useCallback(async () => {
    const ticket = ++reads.current.issued
    try {
      const next = await bridge?.state()
      if (!next || ticket < reads.current.applied) return
      reads.current.applied = ticket
      setSnapshot(next)
      setLink(current => keepLink(current, next.link))
      if (!next.busy) {
        // A cold read wins only when no engine is running; live events are fresher otherwise.
        const seeded: Record<string, LiveStep> = {}
        for (const step of next.state?.steps ?? []) {
          seeded[step.id] = { id: step.id, status: step.status, detail: step.detail ?? undefined }
        }
        setSteps(seeded)
        setAction(null)
      }
    } finally {
      setLoaded(true)
    }
  }, [bridge, keepLink])

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
        return
      }
      if (event.event === "progress") {
        setProgress({ step: event.step, message: event.message, current: event.current, total: event.total, unit: event.unit })
        return
      }
      if (event.event === "needs_input") {
        // Terminal: the engine never reads stdin. Collect the value here and re-invoke.
        const keys = (event.keys ?? [])
          .filter(entry => entry && typeof entry.key === "string")
          .map(entry => ({ key: entry.key, label: entry.label ?? entry.key, secret: entry.secret === true }))
          .slice(0, 4)
        if (keys.some(entry => entry.key === "confirm")) {
          // `confirm` is never typed by a person: the record the shell rendered is stale.
          setError({ step: null, code: "CONFIRM_MISMATCH", message: "This item changed. Refresh and try again.", hint: null, at: null, retryable: false })
          setNeeded(null)
        } else {
          setNeeded(keys.length ? keys : null)
        }
        return
      }
      if (event.event === "result") {
        setSnapshot(current => ({ ...current, busy: false }))
        setAction(null)
        setProgress(null)
        if (!event.ok && event.code !== "CANCELLED") {
          const retryable = event.retryable !== false
          const code = typeof event.data?.code === "string" ? event.data.code : event.code
          if (CONFIRM_CODES.has(code)) {
            setError({ step: null, code, message: "This item changed. Refresh and try again.", hint: null, at: null, retryable: false })
          } else {
            setError(previous => previous
              ? { ...previous, retryable }
              : {
                  step: typeof event.data?.step === "string" ? event.data.step : null,
                  code,
                  message: [event.message, event.data?.message].find((value): value is string => typeof value === "string" && value !== "") ?? resultMessage(code),
                  hint: typeof event.data?.hint === "string" ? event.data.hint : null,
                  at: null,
                  retryable,
                })
          }
        }
        void refresh()
      }
    })
    const offLog = bridge.onLog(entry => {
      if (entry.level === "error" && minting.current) {
        // One reason, in the sheet that asked for it, next to its own Try again.
        linkSettled.current = true
        setLinkError(entry.message)
        setLinkPending(false)
        return
      }
      setNote({ level: entry.level, message: entry.message, id: Date.now() })
      if (entry.level === "error") toast.error(entry.message)
      // Main logs when a run starts and when its child has exited, with or without a result.
      void refresh()
    })
    // The link is not a "step" event: it arrives on its own channel so the window never
    // flips into the progress view for it.
    const offLink = bridge.onLink(next => {
      linkLatest.current = next
      linkSettled.current = true
      setLink(next)
      setLinkPending(false)
    })
    return () => {
      offProgress()
      offLog()
      offLink()
    }
  }, [bridge, refresh])

  const requestLink = useCallback(async () => {
    if (!bridge) return null
    minting.current = true
    linkSettled.current = false
    linkLatest.current = null
    setLinkPending(true)
    setLinkError(null)
    try {
      const reply = await bridge.ownerLink()
      if (reply?.error) {
        setLinkError(reply.error)
        return null
      }
      // The mint lands on its own channel. This loop is the fallback for a link that
      // arrived before anyone was listening, and the way to notice a run that ended
      // without one. `settled` keeps it from waiting on a slow read it doesn't need.
      for (let attempt = 0; attempt < 60; attempt++) {
        if (linkSettled.current) return linkLatest.current
        await new Promise(resolve => window.setTimeout(resolve, 250))
        if (linkSettled.current) return linkLatest.current
        const next = await bridge.state()
        if (next?.link) {
          linkLatest.current = next.link
          setLink(next.link)
          return next.link
        }
        if (!next?.running) {
          // Main logs the reason; without one, say the plain thing.
          setLinkError(current => current ?? "Snip couldn’t create a sign-in link. Try again.")
          return null
        }
      }
      return null
    } finally {
      minting.current = false
      setLinkPending(false)
    }
  }, [bridge])

  const begin = useCallback(async (call: () => Promise<{ started?: true; error?: string }>) => {
    // A read from before this run must not land on top of it.
    reads.current.applied = ++reads.current.issued
    setSteps({})
    setAction(null)
    setProgress(null)
    setError(null)
    setChoice(null)
    setNeeded(null)
    setSnapshot(current => ({ ...current, busy: true }))
    const reply = await call()
    if (reply?.error) {
      setSnapshot(current => ({ ...current, busy: false }))
      toast.error(reply.error)
      return false
    }
    return true
  }, [])

  const busy = snapshot.busy

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
    busy,
    running: snapshot.running,
    steps,
    action,
    choice,
    needed,
    progress,
    // The file's error is from before the run in flight; a live one is newer than the file.
    error: busy ? null : error ?? snapshot.state?.error ?? null,
    note,
    link,
    linkPending,
    linkError,
    requestLink,
    refresh,
    begin,
    clearChoice: () => setChoice(null),
    clearNeeded: () => setNeeded(null),
    clearError: () => setError(null),
    clearNote: () => setNote(null),
  }
}
