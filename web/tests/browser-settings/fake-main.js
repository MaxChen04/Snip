// Injected into the page BEFORE the app loads (page.addInitScript). Plain JS on purpose:
// it is serialised into the browser, so it must not go through a TS transpiler.
//
// It installs `window.snipCloud` (the dev entry only installs its fixture when that is
// unset) and a tiny model of desktop/main.cjs behind it. The model mirrors the
// behaviour that matters here:
//
//  - state() is a snapshot: busy = a run exists, has not produced a result and is not an
//    owner-link run; running = { command, step } while a run exists; link = the last
//    owner link.
//  - main never pushes state. It pushes only progress (engine events), log and link.
//  - cloudInput: answers are stored by key and enable/retry merge them into flags
//    (`account`, `domain`, `login`, `adoptExisting`).
//  - Retry re-runs the last library run that did not succeed, or resumes an unfinished
//    setup; Delete cloud resources is refused while the cloud library is in use.
//
// Two things are deliberately harsher than main, so the window is proven not to lean on
// them: a killed run ends with a log line only (main also sends a CANCELLED result), and
// the old owner link stays in state() while a new one is minted (main clears it).
//
// Tests drive "the engine" from outside through window.__sim.* (page.evaluate).
;(function () {
  const config = window.__SIM_CONFIG__ || {}
  const listeners = { progress: new Set(), log: new Set(), link: new Set() }
  const calls = []
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

  const LINK_TTL_MS = 10 * 60 * 1000
  const cloudRecord = {
    url: "https://snip.example.workers.dev",
    accountId: "00000000000000000000000000000a01",
    workerName: "snip",
    bucket: "snip-files",
    ownerId: "max",
    detachedAt: null,
    adoptedAt: null,
    adoptedFrom: null,
    adoptedLibrary: null,
    lastDeployedAt: "2026-11-06T10:12:00Z",
    lastVerifiedAt: "2026-11-06T10:12:00Z",
  }
  const snapshotRecord = {
    kind: "live",
    path: null,
    takenAt: "2026-11-06T10:12:00Z",
    refs: 42,
    files: 311,
    bytes: 812000000,
    keptLocal: true,
    export: null,
  }

  const sim = {
    mode: config.mode || "local", // what cloud.json says
    run: null, // main's `cloudRun`
    ownerLink: null, // main's `ownerLink` { url, at }
    cloudInput: new Map(),
    stateDelayMs: config.stateDelayMs ?? 120, // main awaits a network probe and a local count
    cancelKillMs: config.cancelKillMs ?? 800, // real main kills the engine 5s after a cancel
    calls,
    stateReads: 0,
  }

  const emitTo = (set, payload) => set.forEach(callback => callback(payload))
  const sendProgress = event => emitTo(listeners.progress, event)
  const sendLog = (level, message) => emitTo(listeners.log, { level, message })
  const sendLink = link => emitTo(listeners.link, link)

  function fileState() {
    return {
      version: 1,
      mode: sim.mode,
      library: { id: "00000000000000a001" },
      cloud: sim.mode !== "local" ? cloudRecord : config.detached ? { ...cloudRecord, detachedAt: "2026-11-07T09:00:00Z" } : null,
      snapshot: sim.mode === "cloud" ? snapshotRecord : null,
      transfer: null,
      steps: [],
      error: null,
    }
  }

  async function snapshotState() {
    sim.stateReads++
    // Capture the answer first, then wait: the real handler also awaits before replying.
    if (sim.ownerLink && Date.now() - sim.ownerLink.at >= LINK_TTL_MS) sim.ownerLink = null
    const run = sim.run
    const answer = {
      cloudStatus: null,
      mode: sim.mode,
      state: sim.mode === "unreadable" ? null : fileState(),
      busy: !!run && !run.resultSeen && run.purpose !== "owner-link",
      running: run ? { command: run.command, step: run.step } : null,
      link: sim.ownerLink
        ? { url: sim.ownerLink.url, note: "One use. Expires in 10 minutes.", expiresAt: new Date(sim.ownerLink.at + LINK_TTL_MS).toISOString() }
        : null,
      engine: { available: true },
      ready: true,
      local: { reachable: true, empty: false, refs: 42 },
      app: { version: "0.2.0", dataRoot: "/Users/test/Snip", captureEnv: ".env" },
    }
    await delay(sim.stateDelayMs)
    return JSON.parse(JSON.stringify(answer))
  }

  // main.cjs startCloudRun
  function startRun(command, flags, purpose) {
    if (sim.run) return { error: "busy" }
    const run = { command, args: [command, flags, purpose], step: null, cancelRequested: false, resultSeen: false, purpose, link: null, flags: flags || {} }
    sim.run = run
    sim.lastResult = null
    if (purpose !== "owner-link") {
      const opening = { pull: "Reading your cloud library.", detach: "Turning off cloud on this Mac.", "owner link": "Creating a sign-in link." }[command] || "Setting up your cloud library."
      sendLog("info", opening)
    }
    return { started: true }
  }

  // main.cjs onCloudEvent: the only place events leave main.
  sim.emit = event => {
    const run = sim.run
    if (!run) throw new Error("no run in flight")
    if (event.event === "step" && typeof event.step === "string") run.step = event.step
    if (event.event === "result") {
      sim.lastResult = event
      run.resultSeen = true
      if (event.mode) sim.mode = event.mode
    }
    if (event.event === "log") sendLog(event.level, event.message)
    if (run.purpose === "owner-link") return
    sendProgress(event)
  }

  // Engine-side helpers (what the child process would print).
  sim.step = (step, status, extra) => sim.emit({ v: 1, event: "step", step, status, ...(extra || {}) })
  sim.result = (fields) => sim.emit({ v: 1, event: "result", ...fields })

  // main.cjs owner-link branch of onCloudEvent.
  sim.mintLink = url => {
    const run = sim.run
    run.link = url
    sim.ownerLink = { url, at: Date.now() }
    sendLink({ url, note: "One use. Expires in 10 minutes.", expiresAt: new Date(sim.ownerLink.at + LINK_TTL_MS).toISOString() })
  }

  // main.cjs finishCloudRun (the child exited). `cancelled` = we killed it.
  sim.exit = ({ cancelled = false, code = 0 } = {}) => {
    const run = sim.run
    const result = sim.lastResult
    sim.lastResult = null
    sim.run = null
    if (run.purpose === "owner-link") {
      if (!run.link) {
        const message = cancelled ? "The sign-in link wasn’t created." : "Snip couldn’t create a sign-in link. Try again."
        sendLog("error", message)
      }
      return
    }
    // Answers belong to the run they were given for.
    sim.cloudInput.clear()
    sim.failed = result && result.ok ? null : run.args
    if (result && result.ok) {
      sendLog("info", result.mode === "cloud" ? "Snip is now using your cloud library." : "Snip is back on this Mac.")
    } else if (cancelled || (result && result.code === "CANCELLED")) {
      sendLog("info", "Stopped.")
    } else {
      const fallback = code === 2 ? "Snip needs one more choice before it can continue." : "Setup stopped before it finished. Retry the step that failed."
      const byCode = { NEEDS_INPUT: fallback }
      sendLog("error", (result && byCode[result.code]) || fallback)
    }
  }

  // The kill 5s after cancel (shortened). No `result` event is ever sent.
  function cancelRun() {
    const run = sim.run
    if (!run) return false
    if (run.cancelRequested) return true
    run.cancelRequested = true
    if (!sim.manualCancel) setTimeout(() => { if (sim.run === run) sim.exit({ cancelled: true, code: null }) }, sim.cancelKillMs)
    return true
  }

  const record = (method, args) => calls.push({ method, args, at: Date.now() })
  const bridge = {
    state: () => { record("state", []); return snapshotState() },
    enable: async options => {
      record("enable", [options])
      if (sim.mode === "cloud") return { error: "This Mac is already using a cloud library." }
      const reply = startRun("setup", { ...Object.fromEntries(sim.cloudInput), ...(options || {}) })
      if (reply.started) sim.mode = "enabling"
      return reply
    },
    disable: async action => {
      record("disable", [action])
      if (action === "pull") return startRun("pull")
      if (action === "detach") return startRun("detach")
      return { error: "Unknown action." }
    },
    retryStep: async step => {
      record("retryStep", [step])
      // main.cjs retryArgs
      const failed = sim.failed
      if (failed ? failed[0] === "setup" : sim.mode === "enabling") return startRun("setup", Object.fromEntries(sim.cloudInput))
      return failed ? startRun(...failed) : { error: "Nothing to retry." }
    },
    cancel: async () => { record("cancel", []); return { cancelled: cancelRun() } },
    abort: async () => {
      record("abort", [])
      if (sim.mode !== "enabling") return { error: "There is no unfinished setup to undo." }
      return startRun("abort")
    },
    answer: async (key, value) => {
      record("answer", [key, value])
      if (typeof key !== "string" || !key) return { accepted: false }
      sim.cloudInput.set(key, typeof value === "string" ? value : "")
      return { accepted: true }
    },
    openSettings: async () => ({ opened: true }),
    openUrl: async url => { record("openUrl", [url]); return { opened: true } },
    signOutAll: async () => ({ ok: true, epoch: 1 }),
    deleteResources: async confirm => {
      record("deleteResources", [confirm])
      if (sim.mode === "cloud") return { error: "This Mac is using its cloud library. Turn off cloud first, then delete the cloud copy." }
      return startRun("delete-resources")
    },
    snapshot: async (action, confirm) => { record("snapshot", [action, confirm]); return startRun("snapshot " + action) },
    ownerLink: async () => {
      record("ownerLink", [])
      // Harsher than main, which clears the old link here (see the header).
      return startRun("owner link", {}, "owner-link")
    },
    onProgress: callback => { listeners.progress.add(callback); return () => listeners.progress.delete(callback) },
    onLog: callback => { listeners.log.add(callback); return () => listeners.log.delete(callback) },
    onLink: callback => { listeners.link.add(callback); return () => listeners.link.delete(callback) },
  }

  window.snipCloud = bridge
  window.__sim = sim
})()
