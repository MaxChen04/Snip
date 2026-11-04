// Update checks for local builds that run a git checkout in place. Compares the
// checkout's HEAD with main on GitHub, and hands the actual update to
// scripts/update.mjs in Terminal so its progress and any errors stay visible.
const { EventEmitter } = require("node:events")
const { execFile } = require("node:child_process")
const fs = require("node:fs/promises")
const path = require("node:path")

const BRANCH = "main"
const CHECK_INTERVAL = 60 * 60 * 1000
const DEFAULT_REPOSITORY = "MaxChen04/Snip"

// "owner/name" from an https or ssh GitHub remote, so forks check their own main.
function repositoryFrom(remote) {
  const match = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(String(remote || "").trim())
  return match ? `${match[1]}/${match[2]}` : null
}

// Interprets GitHub's compare (HEAD...main) response.
function comparison(data) {
  if (!data || typeof data.status !== "string") throw new Error("GitHub returned an unexpected response.")
  if (data.status === "identical" || data.status === "behind") return { behind: 0, commits: [] }
  if (data.status === "diverged") return { behind: data.ahead_by, commits: [], diverged: true }
  const commits = (Array.isArray(data.commits) ? data.commits : []).slice(-5).reverse()
    .map(item => String(item?.commit?.message || "").split("\n")[0].slice(0, 90)).filter(Boolean)
  return { behind: Number(data.ahead_by) || 0, commits, head: data.commits?.at(-1)?.sha }
}

const gitIn = root => (...args) => new Promise((resolve, reject) => {
  // Apps opened from Finder get a minimal PATH; /usr/bin/git is the Command Line Tools shim.
  execFile("git", args, { cwd: root, timeout: 10000, env: { ...process.env, PATH: `${process.env.PATH || ""}:/usr/bin:/opt/homebrew/bin` } },
    (error, stdout) => error ? reject(error) : resolve(stdout.trim()))
})

async function compare(repository, sha, fetcher = fetch) {
  const response = await fetcher(`https://api.github.com/repos/${repository}/compare/${sha}...${BRANCH}`, {
    headers: { accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    signal: AbortSignal.timeout(15000),
  })
  if (response.status === 404) { await response.body?.cancel(); return { unknown: true } }
  if (!response.ok) { await response.body?.cancel(); throw new Error("Could not reach GitHub. Try again later.") }
  const text = await response.text()
  if (text.length > 2 * 1024 * 1024) throw new Error("GitHub returned an unexpected response.")
  return comparison(JSON.parse(text))
}

class SourceUpdates extends EventEmitter {
  constructor({ root, git = gitIn(root), fetcher = fetch, now = Date.now, timers = globalThis }) {
    super()
    Object.assign(this, { root, git, fetcher, now, timers, phase: "idle", error: "", behind: 0, commits: [], head: "", local: "", lastCheck: 0, timer: null, disposed: false })
  }
  change(phase, error = "") { this.phase = phase; this.error = error; this.emit("change") }
  start(delay = 60000) { this.schedule(delay) }
  schedule(ms = CHECK_INTERVAL) {
    this.timers.clearTimeout(this.timer)
    if (this.disposed) return
    this.timer = this.timers.setTimeout(() => void this.check(), ms)
    this.timer.unref?.()
  }
  resume() { if (this.now() - this.lastCheck >= CHECK_INTERVAL) void this.check() }
  async check() {
    if (this.disposed || this.phase === "checking") return
    this.change("checking")
    this.lastCheck = this.now()
    try {
      const branch = await this.git("rev-parse", "--abbrev-ref", "HEAD")
      if (branch !== BRANCH) { this.change("unsupported", `This checkout is on “${branch}”. In-app updates follow ${BRANCH}.`); return }
      this.local = await this.git("rev-parse", "HEAD")
      const repository = repositoryFrom(await this.git("remote", "get-url", "origin").catch(() => "")) || DEFAULT_REPOSITORY
      const result = await compare(repository, this.local, this.fetcher)
      if (this.disposed) return
      if (result.unknown) { this.change("unsupported", "This checkout has commits GitHub doesn’t know about. Push them, then check again."); return }
      if (result.diverged) { this.change("unsupported", `This checkout has local commits and ${BRANCH} has moved on. Rebase or push, then update.`); return }
      Object.assign(this, { behind: result.behind, commits: result.commits, head: result.head || "" })
      this.change(result.behind > 0 ? "available" : "current")
    } catch (error) {
      if (!this.disposed) this.change("error", error.message || "Could not check for updates.")
    } finally { this.schedule() }
  }
  // Writes a Terminal launcher for the update script. Terminal shows progress;
  // the script asks Snip to quit gracefully, updates, and reopens it.
  async launch({ directory, node, open }) {
    if (this.disposed) return
    const file = path.join(directory, "Update Snip.command")
    const quote = value => `'${String(value).replace(/'/g, `'\\''`)}'`
    const script = [
      "#!/bin/zsh -l",
      `cd ${quote(this.root)} || exit 1`,
      ...(node ? [`export PATH=${quote(path.dirname(node))}:"$PATH"`] : []),
      `${node ? quote(node) : "node"} scripts/update.mjs --relaunch`,
      "echo; read -k1 '?Press any key to close this window.'",
      "",
    ].join("\n")
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    await fs.writeFile(file, script, { mode: 0o700 })
    await fs.chmod(file, 0o700)
    const failure = await open(file)
    if (failure) this.change("error", `Could not open Terminal: ${failure}`)
  }
  dispose() { this.disposed = true; this.timers.clearTimeout(this.timer) }
}

module.exports = { SourceUpdates, repositoryFrom, comparison, compare, CHECK_INTERVAL }
