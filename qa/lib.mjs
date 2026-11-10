// Shared helpers for the QA harness. Only ever touches processes started from qa/ (tracked by pid files).
import { spawn, execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"

export const QA = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(QA, "..")
for (const d of ["out", "shots", "logs"]) fs.mkdirSync(path.join(QA, d), { recursive: true })
const require = createRequire(path.join(ROOT, "package.json"))
export const { chromium } = require("playwright")
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export const CHANNELS = {
  stable: {
    name: "stable", exe: path.join(QA, "build-stable/Snip-darwin-arm64/Snip.app/Contents/MacOS/Snip"),
    port: 5373, debug: 9373, profile: path.join(QA, "profile-stable"),
    library: path.join(ROOT, "web/.wrangler/state"), state: path.join(ROOT, "web/.wrangler/state"), // source-run stable: library is the worktree itself
    logs: path.join(QA, "profile-stable/logs"),
  },
  dev: {
    name: "dev", exe: path.join(QA, "build-dev/Snip Dev-darwin-arm64/Snip Dev.app/Contents/MacOS/Snip Dev"),
    port: 5383, debug: 9383, profile: path.join(QA, "profile-dev"),
    library: path.join(QA, "profile-dev/library"), state: path.join(QA, "profile-dev/library/web/.wrangler/state"),
    logs: path.join(QA, "profile-dev/logs"),
  },
}
export const origin = (ch) => `http://localhost:${CHANNELS[ch].port}`
const pidFile = (ch) => path.join(QA, `.pid-${ch}`)
export const readPid = (ch) => { try { return Number(fs.readFileSync(pidFile(ch), "utf8")) } catch { return 0 } }
export const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

export function ps() {
  const out = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,time=,command="], { encoding: "utf8", maxBuffer: 64 << 20 })
  return out.split("\n").filter(Boolean).map((l) => {
    const m = l.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d:.]+)\s+(.*)$/)
    if (!m) return null
    const t = m[4].split(":").map(Number)
    const cpuSec = t.reduce((a, x) => a * 60 + x, 0)
    return { pid: +m[1], ppid: +m[2], rssKiB: +m[3], cpuSec, command: m[5] }
  }).filter(Boolean)
}
/** The main pid, all descendants, plus orphans whose command line points at this worktree/profile. */
export function tree(mainPid, ch, rows = ps()) {
  if (!mainPid || !alive(mainPid)) return []
  const ids = new Set([mainPid])
  for (let c = true; c;) { c = false; for (const r of rows) if (ids.has(r.ppid) && !ids.has(r.pid)) { ids.add(r.pid); c = true } }
  const mine = CHANNELS[ch]
  const marker = [mine.profile, `--remote-debugging-port=${mine.debug}`]
  return rows.filter((r) => ids.has(r.pid) || (r.pid !== process.pid && marker.some((m) => r.command.includes(m))))
}
export function role(r) {
  const c = r.command
  if (/--type=renderer/.test(c)) return "electron-renderer"
  if (/--type=gpu-process/.test(c)) return "electron-gpu"
  if (/--type=utility/.test(c)) return "electron-utility"
  if (/chrome-headless-shell|ms-playwright|Chromium/.test(c)) return /--type=renderer/.test(c) ? "capture-chromium-renderer" : /--type=gpu/.test(c) ? "capture-chromium-gpu" : "capture-chromium"
  if (/workerd/.test(c)) return "workerd"
  if (/esbuild/.test(c)) return "esbuild"
  if (/src\/index\.ts/.test(c)) return "node-capture"
  if (/local-server\.cjs|dev-server\.cjs/.test(c)) return "node-web"
  if (/\/MacOS\/Snip/.test(c) && !/--type=/.test(c)) return "electron-main"
  if (/node/.test(c)) return "node-other"
  return "other"
}

export function startApp(ch, extraEnv = {}) {
  const c = CHANNELS[ch]
  if (readPid(ch) && alive(readPid(ch))) throw new Error(`${ch} already running (pid ${readPid(ch)})`)
  fs.mkdirSync(c.profile, { recursive: true })
  const env = { ...process.env, SNIP_DESKTOP_PROFILE: c.profile, SNIP_DESKTOP_PORT: String(c.port), WRANGLER_SEND_METRICS: "false", WRANGLER_WRITE_LOGS: "false", ...extraEnv }
  delete env.ELECTRON_RUN_AS_NODE
  const out = fs.openSync(path.join(QA, `logs/app-${ch}.out.log`), "a")
  const child = spawn(c.exe, [`--remote-debugging-port=${c.debug}`], { env, detached: true, stdio: ["ignore", out, out] })
  child.unref()
  fs.writeFileSync(pidFile(ch), String(child.pid))
  return child.pid
}
export async function waitHttp(url, ms = 180000) {
  const t = Date.now()
  while (Date.now() - t < ms) { try { const r = await fetch(url); if (r.status < 500) return true } catch {} await sleep(500) }
  throw new Error(`timeout waiting for ${url}`)
}
export async function stopApp(ch, graceMs = 60000) {
  const pid = readPid(ch)
  if (!pid || !alive(pid)) return { stopped: true, forced: false, leftovers: [] }
  const before = tree(pid, ch)
  process.kill(pid, "SIGTERM")
  const t = Date.now()
  while (Date.now() - t < graceMs && alive(pid)) await sleep(500)
  let forced = false
  if (alive(pid)) { forced = true; for (const r of before) { try { process.kill(r.pid, "SIGKILL") } catch {} } }
  await sleep(2500)
  const leftovers = before.filter((r) => alive(r.pid))
  for (const r of leftovers) { try { process.kill(r.pid, "SIGKILL") } catch {} }
  return { stopped: !alive(pid), forced, tookMs: Date.now() - t, leftovers: leftovers.map((r) => `${r.pid} ${r.command.slice(0, 120)}`) }
}
/** Connect to the app's renderer window over CDP. */
export async function connect(ch) {
  const browser = await chromium.connectOverCDP(`http://localhost:${CHANNELS[ch].debug}`)
  const t = Date.now()
  let page
  while (Date.now() - t < 120000) {
    page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith(origin(ch)))
    if (page) break
    await sleep(500)
  }
  if (!page) throw new Error(`no ${ch} page at ${origin(ch)}; pages: ${browser.contexts().flatMap((c) => c.pages()).map((p) => p.url())}`)
  return { browser, page }
}
export function du(dir) { try { return Number(execFileSync("du", ["-sk", dir], { encoding: "utf8" }).split("\t")[0]) / 1024 } catch { return 0 } }
export const load1 = () => os.loadavg()[0].toFixed(2)
