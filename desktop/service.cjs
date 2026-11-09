const { EventEmitter } = require("node:events")
const { spawn } = require("node:child_process")
const { StringDecoder } = require("node:string_decoder")

// A launch owns its child, completion promise and log. Late events from an
// earlier launch cannot clear a replacement process.
class Service extends EventEmitter {
  constructor(key, { spawnProcess = spawn, kill = process.kill.bind(process) } = {}) {
    super()
    Object.assign(this, { key, spawnProcess, kill, proc: null, status: "stopped", detail: "", url: null, tail: "", stopping: false, closed: Promise.resolve() })
  }

  changed() { this.emit("change") }

  start({ executable, args, cwd, env, log }) {
    if (this.proc) return
    Object.assign(this, { status: "starting", detail: "", url: null, tail: "", stopping: false })
    let finish
    this.closed = new Promise(resolve => { finish = resolve })
    let child
    try {
      child = this.spawnProcess(executable, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe", "ipc"] })
    } catch (error) {
      log.end(`${error.message}\n`)
      this.status = "crashed"
      this.detail = error.message
      finish()
      this.changed()
      return
    }
    this.proc = child
    let ended = false
    let spawnError = null
    let startupFailure = null
    let swept = false
    const decoder = new StringDecoder("utf8")
    const sweep = () => {
      if (swept) return
      swept = true
      this.killGroup(child)
    }
    const finalize = (code, signal) => {
      if (ended) return
      ended = true
      sweep()
      this.tail = (this.tail + decoder.end()).slice(-4000)
      log.end(`--- exited (${spawnError?.message ?? signal ?? code}) ---\n`)
      if (this.proc === child) {
        this.proc = null
        this.url = null
        this.status = this.stopping ? "stopped" : "crashed"
        this.detail = this.stopping ? "" : spawnError?.message ?? startupFailure ?? (this.tail.trim().split("\n").at(-1) || `Exited (${signal ?? code})`)
        this.stopping = false
        this.changed()
      }
      finish()
    }
    const data = chunk => {
      if (ended) return
      log.write(chunk)
      this.tail = (this.tail + decoder.write(chunk)).slice(-4000)
    }
    child.stdout.on("data", data)
    child.stderr.on("data", data)
    child.on("message", message => {
      if (ended || this.proc !== child || !message || typeof message !== "object") return
      if (message.type === "snip:web-ready" && typeof message.url === "string" && !this.stopping) this.ready(message.url)
      if (message.type === "snip:web-error" && typeof message.message === "string") {
        startupFailure = message.message.slice(0, 2000)
        log.write(`${startupFailure}\n`)
      }
      if (message.type === "snip:capture-status" && ["connecting", "idle", "busy", "disconnected", "stopping"].includes(message.state)) {
        if (!this.stopping) this.status = message.state
        this.detail = typeof message.error === "string" ? message.error.slice(0, 500) : message.state === "busy" ? "Capturing" : ""
        this.changed()
      }
    })
    child.on("error", error => {
      spawnError = error
      if (child.pid === undefined) finalize(null, null)
    })
    // Kill the process group as soon as its leader exits so descendants cannot
    // keep inherited pipes open. Wait for close before ending the log: Node can
    // deliver the final stdout/stderr bytes after exit.
    child.on("exit", sweep)
    child.on("close", finalize)
    this.changed()
  }

  ready(url) {
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) return
      this.url = parsed.origin
      this.status = "running"
      this.changed()
    } catch {}
  }

  send(message) {
    if (!this.proc?.connected) return false
    try { this.proc.send(message, () => {}); return true } catch { return false }
  }

  stop() {
    if (!this.proc || this.stopping) return this.closed
    this.stopping = true
    this.status = "stopping"
    if (!this.send({ type: "snip:stop" })) this.proc.kill("SIGTERM")
    this.changed()
    return this.closed
  }

  killGroup(child = this.proc) {
    if (!Number.isInteger(child?.pid) || child.pid <= 0) return
    try { this.kill(-child.pid, "SIGKILL") } catch {}
  }

  forceStop() {
    if (this.proc) {
      this.stopping = true
      this.killGroup()
    }
    return this.closed
  }
}

// Capture drains while its API remains reachable. Only web cleanup has an
// automatic deadline; abandoning a capture is an explicit user action.
async function stopServices(capture, web, { webTimeoutMs = 5000 } = {}) {
  await capture.stop()
  const timer = setTimeout(() => web.forceStop(), webTimeoutMs)
  timer.unref?.()
  try { await web.stop() } finally { clearTimeout(timer) }
}

module.exports = { Service, stopServices }
