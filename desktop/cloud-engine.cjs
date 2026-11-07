// Spawns `desktop/provision/cli.cjs` as a child and turns its NDJSON into events.
// The session token in `event: "session"` is consumed by main and never re-emitted.
const { spawn } = require("node:child_process")
const fs = require("node:fs")
const path = require("node:path")

const CANCELLATION_GRACE_MS = 5000
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
 * Run one engine command. Returns a handle with `cancel()`; the promise resolves
 * with the child's exit code once stdout has been drained.
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
  let killTimer = null

  const emit = value => {
    const event = safeEvent(value)
    if (!event) {
      // Unrecognised stdout may contain a token. Report the shape, never the text.
      onEvent({ v: 1, event: "log", level: "warn", message: "The setup engine printed output Snip did not understand." })
      return
    }
    onEvent(event)
  }
  const drain = chunk => {
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
  child.stdout.on("end", () => {
    const line = buffer.trim()
    buffer = ""
    if (!line) return
    try {
      emit(JSON.parse(line))
    } catch {
      emit(null)
    }
  })
  // stderr is human text, sometimes a wrangler warning. Keep it out of the renderer:
  // the contract makes `snip:cloud-log` the single rendering path for engine problems.
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", () => {})

  const finish = (code, signal) => {
    if (finished) return
    finished = true
    clearTimeout(killTimer)
    onExit({ code, signal, cancelled })
  }
  child.on("error", error => {
    onEvent({ v: 1, event: "log", level: "error", message: error.message })
    finish(1, null)
  })
  child.on("close", finish)

  return {
    child,
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

module.exports = { enginePath, engineAvailable, engineArgs, engineEnv, runEngine, safeEvent, CANCELLATION_GRACE_MS }
