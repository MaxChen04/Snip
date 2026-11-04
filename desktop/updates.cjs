const { EventEmitter } = require("node:events")
const fs = require("node:fs/promises")
const path = require("node:path")
const { pathToFileURL } = require("node:url")

const REPOSITORY = "MaxChen04/Snip"
const CHECK_INTERVAL = 6 * 60 * 60 * 1000
const versionParts = version => /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) ? version.split(".").map(Number) : null
function newer(candidate, current) {
  const a = versionParts(candidate), b = versionParts(current)
  if (!a || !b || [...a, ...b].some(n => !Number.isSafeInteger(n))) return false
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i] }
  return false
}

function releaseFrom(data, current) {
  if (!data || data.draft || data.prerelease || typeof data.tag_name !== "string") return null
  const version = data.tag_name.replace(/^v/, "")
  if (!newer(version, current)) return null
  const name = `Snip-${version}-darwin-arm64.zip`
  const asset = data.assets?.find(item => item.name === name && item.state === "uploaded")
  const expected = `https://github.com/${REPOSITORY}/releases/download/${encodeURIComponent(data.tag_name)}/${name}`
  if (!asset || asset.browser_download_url !== expected || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 3 * 1024 ** 3 || !/^sha256:[a-f0-9]{64}$/.test(asset.digest || "")) {
    throw new Error("This release does not have a complete, verified Apple Silicon download yet. Try again later.")
  }
  return { version, url: expected, size: asset.size, sha256: asset.digest.slice(7) }
}

async function latestRelease(fetcher = fetch) {
  const response = await fetcher(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, {
    headers: { accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    signal: AbortSignal.timeout(15000), redirect: "error",
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(response.status === 404 ? "No public Snip release is available yet." : "Could not check for updates. Please try again later.")
  }
  const chunks = []; let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > 1024 * 1024) throw new Error("The update service returned an unexpected response.")
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}

// Owns release discovery and the native updater lifecycle. The caller drains
// library services before Squirrel is allowed to close the app.
class Updates extends EventEmitter {
  constructor({ native, version, directory, enabled, fetchRelease = latestRelease, drain, installFailed = () => {}, now = Date.now, timers = globalThis }) {
    super()
    Object.assign(this, { native, version, directory, fetchRelease, drain, installFailed, now, timers, enabled, phase: enabled ? "idle" : "disabled", release: null, error: "", lastCheck: 0, timer: null, disposed: false })
    this.handlers = {
      "update-downloaded": () => { if (this.phase === "downloading") this.change("ready") },
      "update-not-available": () => { if (this.phase === "downloading") this.change("error", "The update is no longer available. Check again later.") },
      error: () => {
        if (this.phase === "installing") void this.recoverInstall()
        else if (["downloading", "ready"].includes(this.phase)) this.change("error", "The update could not be downloaded or verified. Your current version is unchanged. Try again later.")
      },
    }
    if (enabled) for (const [event, handler] of Object.entries(this.handlers)) native.on(event, handler)
  }
  change(phase, error = "") { this.phase = phase; this.error = error; this.emit("change") }
  async start() {
    if (!this.enabled) return
    try {
      const saved = JSON.parse(await fs.readFile(path.join(this.directory, "state.json"), "utf8"))
      if (Number.isFinite(saved.lastCheck) && saved.lastCheck <= this.now()) this.lastCheck = saved.lastCheck
    } catch {}
    if (!this.disposed) this.schedule(Math.max(60000, CHECK_INTERVAL - (this.now() - this.lastCheck)))
  }
  schedule(ms = CHECK_INTERVAL) {
    this.timers.clearTimeout(this.timer)
    if (this.disposed || !this.enabled) return
    this.timer = this.timers.setTimeout(() => void this.check(), ms)
    this.timer.unref?.()
  }
  resume() { if (this.now() - this.lastCheck >= CHECK_INTERVAL) void this.check() }
  async check() {
    if (!this.enabled || this.disposed || ["checking", "downloading", "ready", "installing"].includes(this.phase)) return
    this.change("checking")
    this.lastCheck = this.now()
    try {
      const release = releaseFrom(await this.fetchRelease(), this.version)
      if (this.disposed) return
      this.release = release
      this.change(release ? "available" : "current")
    } catch (error) { if (!this.disposed) this.change("error", error.message || "Could not check for updates.") }
    finally {
      try {
        await fs.mkdir(this.directory, { recursive: true, mode: 0o700 })
        await fs.writeFile(path.join(this.directory, "state.json"), JSON.stringify({ lastCheck: this.lastCheck }), { mode: 0o600 })
      } catch {} // A cache write must not prevent checking or running the app.
      this.schedule()
    }
  }
  async download() {
    if (this.disposed || !this.release || !["available", "error"].includes(this.phase)) return
    this.change("downloading")
    try {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 })
      const feed = path.join(this.directory, "feed.json")
      await fs.writeFile(feed, JSON.stringify({ ...this.release, name: this.release.version, notes: `Snip ${this.release.version}` }), { mode: 0o600 })
      if (this.disposed) return
      this.native.setFeedURL({ url: pathToFileURL(feed).href })
      this.native.checkForUpdates()
    } catch { this.change("error", "Could not start the update download. Your current version is unchanged.") }
  }
  async install() {
    if (this.phase !== "ready" || this.disposed) return
    this.change("installing")
    try {
      this.pendingDrain = Promise.resolve().then(() => this.drain())
      await this.pendingDrain
      if (!this.recovering && !this.disposed) this.native.quitAndInstall()
    }
    catch { await this.recoverInstall() }
  }
  async recoverInstall() {
    if (this.recovering || this.disposed) return
    this.recovering = true
    try {
      await this.pendingDrain?.catch(() => {})
      await this.installFailed()
    } catch {} // Keep the staged update available even if UI recovery fails.
    finally {
      this.recovering = false
      this.change("ready", "Snip could not restart to install the update. Please try again.")
    }
  }
  dispose() {
    this.disposed = true
    this.timers.clearTimeout(this.timer)
    if (this.enabled) for (const [event, handler] of Object.entries(this.handlers)) this.native.removeListener(event, handler)
  }
}

module.exports = { Updates, newer, releaseFrom, latestRelease, CHECK_INTERVAL, REPOSITORY }
