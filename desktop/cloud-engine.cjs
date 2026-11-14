// Spawns `desktop/provision/cli.cjs` as a child and turns its NDJSON into events.
// The session token in `event: "session"` is consumed by main and never re-emitted.
const { spawn } = require("node:child_process")
const fs = require("node:fs")
const path = require("node:path")

const CANCELLATION_GRACE_MS = 5000
// A grandchild can hold the pipes open after the engine exits; wait this long for 'close'.
const EXIT_DRAIN_MS = 1000
const MAX_LINE = 256 * 1024

/** Production entry point; `SNIP_CLOUD_ENGINE` overrides it for tests and dev. */
function enginePath(appDir, env = process.env) {
  return env.SNIP_CLOUD_ENGINE ? path.resolve(env.SNIP_CLOUD_ENGINE) : path.join(appDir, "provision", "cli.cjs")
}

function engineAvailable(appDir, exists = fs.existsSync, env = process.env) {
  return exists(enginePath(appDir, env))
}

function engineArgs({ appDir, root, dataRoot, command, subcommand, flags = [], env = process.env }) {
  const args = [enginePath(appDir, env), command]
  // `snapshot restore` and `snapshot delete` are positional subcommands, not flags.
  if (subcommand) args.push(subcommand)
  args.push("--json", "--root", root, "--data-root", dataRoot, "--yes", "--no-open", "--managed")
  for (const [key, value] of Object.entries(flags)) {
    if (value == null || value === false || value === "") continue
    args.push(`--${key}`)
    if (value !== true) args.push(String(value))
  }
  return args
}

/**
 * `setup` flags from what Settings sent and answered. The names are the engine's own
 * (`needs_input` keys), so an answer reaches the flag it was asked for.
 */
function setupFlags(options = {}) {
  const text = (value, limit) => (typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : undefined)
  return {
    account: text(options.account, 64),
    domain: text(options.domain, 253),
    login: text(options.login, 64),
    // Set only when the person picked "Use that library" in the choice screen.
    "adopt-existing": options.adoptExisting === true ? true : undefined,
    // The app always keeps the local capture settings as .env.local and points the
    // agent at the cloud queue; that is the "replace" behaviour from the contracts.
    "capture-env": "replace",
  }
}

/**
 * What Retry runs, as `[command, flags, subcommand]`. A setup resumes with whatever
 * was answered since; anything else that failed (an Undo included) is run again as
 * it was. With no failed run, only an unfinished setup has something to retry: a
 * healthy library is never set up again.
 */
function retryArgs({ mode, failed, answers }) {
  if (failed ? failed[0] === "setup" : mode === "enabling") return ["setup", setupFlags(answers)]
  return failed ?? null
}

function engineEnv(base, { dataRoot }) {
  // The engine runs wrangler; keep every cache inside the library, never the bundle.
  // BROWSER=none is removed because wrangler login must be able to report its URL,
  // and Snip opens that URL itself from the `human` event.
  const env = { ...base, MINIFLARE_CACHE_DIR: path.join(dataRoot, ".cache/miniflare"), WRANGLER_CACHE_DIR: path.join(dataRoot, ".cache/wrangler"), SNIP_CLOUD_LAUNCHED_BY: "electron" }
  delete env.BROWSER
  return env
}

function safeEvent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  if (value.v !== 1 || typeof value.event !== "string") return null
  if (!["step", "log", "human", "choice", "needs_input", "session", "result"].includes(value.event)) return null
  return value
}

/**
 * Run one engine command. Returns a handle with `cancel()`. `onEvent` always receives
 * exactly one `result` before `onExit`: the engine's own, or one made here when the
 * child ends without printing it.
 */
function runEngine({ executable = process.execPath, appDir, root, dataRoot, command, subcommand, flags, baseEnv, spawnProcess = spawn, onEvent = () => {}, onExit = () => {}, env = process.env }) {
  // Snip's own Node, not Electron's binary: the engine is a plain script that may
  // spawn wrangler, and Electron would try to open an app instead.
  const child = spawnProcess(executable, engineArgs({ appDir, root, dataRoot, command, subcommand, flags, env }), {
    cwd: root,
    env: engineEnv(baseEnv, { dataRoot }),
    stdio: ["ignore", "pipe", "pipe"],
  })
  let buffer = ""
  let finished = false
  let cancelled = false
  let resultSeen = false
  let killTimer = null
  let drainTimer = null
  let exited
  const exit = new Promise(resolve => (exited = resolve))

  const emit = value => {
    const event = safeEvent(value)
    if (!event) {
      // Unrecognised stdout may contain a token. Report the shape, never the text.
      onEvent({ v: 1, event: "log", level: "warn", message: "The setup engine printed output Snip did not understand." })
      return
    }
    if (event.event === "result") {
      if (resultSeen) return
      resultSeen = true
    }
    onEvent(event)
  }
  const drain = chunk => {
    if (finished) return
    buffer += chunk
    let index
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      try {
        emit(JSON.parse(line))
      } catch {
        emit(null)
      }
    }
    if (buffer.length > MAX_LINE) buffer = ""
  }
  child.stdout.setEncoding("utf8")
  child.stdout.on("data", drain)
  // A last line without a newline is still a line.
  child.stdout.on("end", () => drain("\n"))
  // stderr is human text, sometimes a wrangler warning. Keep it out of the renderer:
  // the contract makes `snip:cloud-log` the single rendering path for engine problems.
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", () => {})

  const finish = (code, signal) => {
    if (finished) return
    drain("\n")
    finished = true
    clearTimeout(killTimer)
    clearTimeout(drainTimer)
    if (!resultSeen) onEvent({ v: 1, event: "result", ok: false, code: cancelled ? "CANCELLED" : "FAILED" })
    onExit({ code, signal, cancelled })
    exited()
  }
  child.on("error", error => {
    onEvent({ v: 1, event: "log", level: "error", message: error.message })
    finish(1, null)
  })
  child.on("close", finish)
  child.on("exit", (code, signal) => {
    drainTimer = setTimeout(() => finish(code, signal), EXIT_DRAIN_MS)
  })

  return {
    child,
    /** Settles once the run has finished, after `onExit`. */
    exited: exit,
    get cancelled() {
      return cancelled
    },
    cancel() {
      if (finished) return false
      cancelled = true
      try {
        child.kill("SIGINT")
      } catch {
        return false
      }
      killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL")
        } catch {}
      }, CANCELLATION_GRACE_MS)
      killTimer.unref?.()
      return true
    },
  }
}

module.exports = { enginePath, engineAvailable, engineArgs, setupFlags, retryArgs, engineEnv, runEngine, safeEvent, CANCELLATION_GRACE_MS, EXIT_DRAIN_MS }
