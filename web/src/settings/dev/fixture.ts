// Dev-only stand-in for preload-settings.cjs. `npm run dev:settings` renders every
// Settings state in a plain browser with no Electron and no engine:
//   ?fake=local | local-empty | enabling&step=4 | enabling-error | cloud | cloud-empty
//         | detached | pulling
// Actions advance the same NDJSON-shaped events the real engine emits.
import type { CloudBridge, CloudFile, CloudSnapshotState, EngineEvent } from "../types"
import { stepsFor } from "../steps"

const params = new URLSearchParams(location.search)
const scenario = params.get("fake") ?? "local"
const requestedStep = Number(params.get("step"))
const listeners = new Set<(event: EngineEvent) => void>()
const logListeners = new Set<(entry: { level: "info" | "warn" | "error"; message: string }) => void>()
const timers = new Set<number>()

const emit = (event: EngineEvent) => listeners.forEach(listener => listener(event))
const log = (level: "info" | "warn" | "error", message: string) => logListeners.forEach(listener => listener({ level, message }))
const later = (fn: () => void, ms: number) => {
  const id = window.setTimeout(() => {
    timers.delete(id)
    fn()
  }, ms)
  timers.add(id)
  return id
}
const stopTimers = () => {
  for (const id of timers) clearTimeout(id)
  timers.clear()
}

const library = { id: "8f3c2a1b4d5e6f70" }
const cloud = {
  url: "https://snip.max.workers.dev",
  accountId: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
  workerName: "snip",
  bucket: "snip-files",
  ownerId: "max",
  detachedAt: null as string | null,
  adoptedAt: null as string | null,
  adoptedFrom: null as string | null,
  adoptedLibrary: null as { refs: number | null; pages: number | null; collections: number | null } | null,
  lastDeployedAt: "2026-11-06T10:12:00Z",
  lastVerifiedAt: "2026-11-06T10:12:00Z",
}
const snapshot = { path: "backups/cloud-move-2026-11-06T10-12-00", takenAt: "2026-11-06T10:12:00Z", refs: 42, files: 311, bytes: 812000000 }

function file(mode: CloudFile["mode"], extra: Partial<CloudFile> = {}): CloudFile {
  return { version: 1, mode, library, cloud: mode === "local" ? null : cloud, snapshot: null, transfer: null, steps: [], error: null, ...extra }
}

const STATES: Record<string, CloudSnapshotState> = {
  local: {
    mode: "local",
    state: file("local"),
    busy: false,
    running: null,
    engine: { available: true },
    local: { reachable: true, empty: false, refs: 42 },
    app: { version: "0.2.0", dataRoot: "/Users/max/Snip", captureEnv: ".env" },
  },
  "local-empty": {
    mode: "local",
    state: file("local"),
    busy: false,
    running: null,
    engine: { available: true },
    local: { reachable: true, empty: true, refs: 0 },
    app: { version: "0.2.0", dataRoot: "/Users/max/Snip", captureEnv: ".env" },
  },
  cloud: {
    mode: "cloud",
    state: file("cloud", { snapshot, transfer: { keys: 311, bytes: 812000000 }, move: { status: "completed", reason: null, at: "2026-11-06T10:12:00Z" } }),
    busy: false,
    running: null,
    engine: { available: true },
    local: { reachable: false, empty: null, refs: null },
    app: { version: "0.2.0", dataRoot: "/Users/max/Snip", captureEnv: ".env.cloud" },
  },
  "cloud-empty": {
    mode: "cloud",
    state: file("cloud"),
    busy: false,
    running: null,
    engine: { available: true },
    local: { reachable: false, empty: null, refs: null },
    app: { version: "0.2.0", dataRoot: "/Users/max/Snip", captureEnv: ".env.cloud" },
  },
  detached: {
    mode: "local",
    state: file("local", { cloud: { ...cloud, detachedAt: "2026-11-06T12:40:00Z" }, snapshot }),
    busy: false,
    running: null,
    engine: { available: true },
    local: { reachable: true, empty: false, refs: 42 },
    app: { version: "0.2.0", dataRoot: "/Users/max/Snip", captureEnv: ".env.local" },
  },
  "cloud-adopted": {
    mode: "cloud",
    state: file("cloud", {
      cloud: { ...cloud, adoptedAt: "2026-11-06T12:40:00Z", adoptedFrom: "legacy", adoptedLibrary: { refs: 1284, pages: 9120, collections: 7 } },
      snapshot: { path: null, takenAt: "2026-11-06T12:40:00Z", refs: 312, files: 1900, bytes: 240000000, keptLocal: true },
      move: { status: "skipped", reason: "adopted-existing", at: "2026-11-06T12:40:00Z" },
    }),
    busy: false,
    running: null,
    engine: { available: true },
    local: { reachable: false, empty: null, refs: null },
    app: { version: "0.2.0", dataRoot: "/Users/max/Snip", captureEnv: ".env.cloud" },
  },
  "enabling-error": {
    mode: "enabling",
    state: file("enabling", {
      cloud,
      steps: [
        { id: "preflight", status: "done", at: "2026-11-06T10:10:00Z", detail: null },
        { id: "import", status: "failed", at: "2026-11-06T10:11:00Z", detail: "Cloudflare rejected part of the library copy." },
      ],
      error: {
        step: "import",
        code: "IMPORT_FAILED",
        message: "Cloudflare rejected part of the library copy.",
        hint: "Retry the step. Only the copy restarts; Cloudflare keeps nothing from the failed attempt.",
        at: "2026-11-06T10:11:00Z",
      },
    }),
    busy: false,
    running: { command: "setup", step: "import" },
    engine: { available: true },
    local: { reachable: true, empty: false, refs: 42 },
    app: { version: "0.2.0", dataRoot: "/Users/max/Snip", captureEnv: ".env" },
  },
}

function seeded(command: string, index: number, error = false): { state: CloudSnapshotState; steps: Record<string, { id: string; status: "done" | "running" | "pending" | "waiting" | "failed"; message: string }> } {
  const order = stepsFor(command)
  const steps: Record<string, { id: string; status: "done" | "running" | "pending" | "waiting" | "failed"; message: string }> = {}
  order.forEach((id, i) => {
    steps[id] = { id, status: i < index ? "done" : i === index ? (error ? "failed" : "running") : "pending", message: "" }
  })
  return {
    steps,
    state: {
      mode: command === "setup" ? "enabling" : "disabling",
      state: file(command === "setup" ? "enabling" : "disabling", { cloud }),
      busy: !error,
      running: { command, step: order[index] ?? null },
      engine: { available: true },
      local: { reachable: true, empty: false, refs: 42 },
      app: { version: "0.2.0", dataRoot: "/Users/max/Snip", captureEnv: ".env" },
    },
  }
}

const stepId = (command: string, index: number) => stepsFor(command)[index] ?? null

function initial(): { state: CloudSnapshotState; steps: Record<string, { id: string; status: "done" | "running" | "pending" | "waiting" | "failed"; message: string }> } {
  if (scenario === "enabling") {
    const index = Number.isFinite(requestedStep) ? requestedStep : 4
    return seeded("setup", index)
  }
  if (scenario === "pulling") return seeded("pull", 4)
  // A terminal decision from guard, shown before anything is copied.
  if (scenario === "choice") return seeded("setup", 6)
  return { state: STATES[scenario] ?? STATES.local, steps: {} }
}

const current = initial()
let state = current.state
const seededSteps = current.steps

function set(next: CloudSnapshotState) {
  state = next
}

function runCommand(command: string, onDone: () => void) {
  const order = stepsFor(command)
  let index = 0
  const advance = () => {
    const id = order[index]
    if (!id) {
      onDone()
      return
    }
    const human = command === "setup" && (id === "cloudflare-auth" || id === "r2" || id === "owner")
    emit({ v: 1, event: "step", command, step: id, status: "started", message: "" })
    if (human) {
      emit({ v: 1, event: "step", step: id, status: "waiting", message: "" })
      emit({
        v: 1,
        event: "human",
        step: id,
        action: id === "r2" ? "enable_r2" : "open_url",
        url: id === "r2" ? "https://dash.cloudflare.com/?to=/:account/r2/overview" : "https://dash.cloudflare.com/oauth2/auth",
        message: id === "r2" ? "Turn on R2 in the Cloudflare dashboard, then come back." : "Approve Snip in your browser.",
      })
      later(() => {
        emit({ v: 1, event: "step", step: id, status: "ok", message: "" })
        index++
        advance()
      }, 1400)
      return
    }
    later(() => {
      emit({ v: 1, event: "step", step: id, status: "ok", message: "" })
      index++
      advance()
    }, 260)
  }
  advance()
}

export function createFixtureBridge(): CloudBridge {
  return {
    async state() {
      return state
    },
    async enable(options) {
      const next = seeded("setup", 0)
      set({ ...next.state, busy: true })
      emit({ v: 1, event: "step", command: "setup", step: "preflight", status: "started", message: "" })
      runCommand("setup", () => {
        if (options?.adoptExisting) {
          set({
            mode: "cloud",
            state: file("cloud", {
              cloud: { ...cloud, adoptedAt: "2026-11-06T12:40:00Z", adoptedFrom: "legacy", adoptedLibrary: { refs: 1284, pages: 9120, collections: 7 } },
              snapshot: { path: null, takenAt: "2026-11-06T12:40:00Z", refs: 312, files: 1900, bytes: 240000000, keptLocal: true },
              move: { status: "skipped", reason: "adopted-existing", at: "2026-11-06T12:40:00Z" },
            }),
            busy: false,
            running: null,
            engine: { available: true },
            local: { reachable: false, empty: null, refs: null },
          })
        } else {
          set({ mode: "cloud", state: file("cloud", { snapshot }), busy: false, running: null, engine: { available: true }, local: { reachable: false, empty: null, refs: null } })
        }
        emit({ v: 1, event: "result", ok: true, code: "OK", mode: "cloud" })
      })
      return { started: true }
    },
    async disable(action) {
      const command = action === "pull" ? "pull" : "detach"
      const next = seeded(command, 0)
      set({ ...next.state, busy: true })
      runCommand(command, () => {
        set({
          mode: "local",
          state: file("local", { cloud: { ...cloud, detachedAt: "2026-11-06T12:40:00Z" }, snapshot }),
          busy: false,
          running: null,
          engine: { available: true },
          local: { reachable: true, empty: false, refs: 42 },
        })
        emit({ v: 1, event: "result", ok: true, code: "OK", mode: "local" })
      })
      return { started: true }
    },
    async retryStep() {
      const next = seeded("setup", 4)
      set({ ...next.state, busy: true })
      runCommand("setup", () => {
        set({ mode: "cloud", state: file("cloud", { snapshot }), busy: false, running: null, engine: { available: true } })
        emit({ v: 1, event: "result", ok: true, code: "OK", mode: "cloud" })
      })
      return { started: true }
    },
    async cancel() {
      stopTimers()
      set({ ...state, busy: false })
      emit({ v: 1, event: "result", ok: false, code: "CANCELLED", mode: state.mode })
      return { cancelled: true }
    },
    async abort() {
      stopTimers()
      set({ mode: "local", state: file("local"), busy: false, running: null, engine: { available: true }, local: { reachable: true, empty: false, refs: 42 } })
      emit({ v: 1, event: "result", ok: true, code: "OK", mode: "local" })
      return { started: true }
    },
    async answer() {
      return { accepted: true }
    },
    async openSettings() {
      return { opened: true }
    },
    async openUrl() {
      return { opened: true }
    },
    async signOutAll() {
      return { ok: true, epoch: 2 }
    },
    async deleteResources() {
      return { started: true }
    },
    async snapshot() {
      return { started: true }
    },
    onProgress(callback) {
      listeners.add(callback)
      // Seed the visible steps for a scenario that opens mid-run.
      for (const step of Object.values(seededSteps)) {
        // Pending steps emit nothing: the UI already renders unseen steps as dim.
        if (step.status === "pending") continue
        const status = step.status === "done" ? "ok" : step.status === "failed" ? "failed" : "started"
        emit({ v: 1, event: "step", step: step.id, status, message: step.message })
      }
      const index = Number.isFinite(requestedStep) ? requestedStep : 4
      if (scenario === "enabling") {
        const id = stepId("setup", index)
        if (id === "r2" || id === "cloudflare-auth" || id === "owner") {
          emit({
            v: 1,
            event: "human",
            step: id,
            action: id === "r2" ? "enable_r2" : "open_url",
            url: id === "r2" ? "https://dash.cloudflare.com/?to=/:account/r2/overview" : "https://dash.cloudflare.com/oauth2/auth",
            message: id === "r2" ? "Turn on R2 in the Cloudflare dashboard, then come back." : "Approve Snip in your browser, then come back.",
          })
          emit({ v: 1, event: "step", step: id, status: "waiting", message: "" })
        } else if (id) {
          emit({ v: 1, event: "progress", step: id, message: "Copying your library", current: 420, total: 812, unit: "MB" })
        }
      }
      if (scenario === "pulling") emit({ v: 1, event: "progress", step: "pull-files", message: "Downloading screenshots", current: 180, total: 311, unit: "files" })
      if (scenario === "choice") {
        emit({
          v: 1,
          event: "choice",
          step: "guard",
          id: "existing-library",
          message: "This Cloudflare account already has a Snip library.",
          data: { url: "https://snip.maxschen29.workers.dev", counts: { refs: 1284, pages: 9120, collections: 7 } },
          options: [
            { id: "adopt-existing", label: "Use that library", detail: "Switches this Mac to it. Your local library is kept and is not copied." },
            { id: "stop", label: "Stop", detail: "Changes nothing." },
          ],
        })
      }
      return () => listeners.delete(callback)
    },
    onLog(callback) {
      logListeners.add(callback)
      log("info", state.mode === "cloud" ? "Snip is now using your cloud library." : "Local library")
      return () => logListeners.delete(callback)
    },
  }
}
