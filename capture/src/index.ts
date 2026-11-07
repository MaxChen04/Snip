import { existsSync } from "node:fs"
import { SnipApi } from "./api"
import { CHROMIUM_ARGS, installBrowser, launchWithRepair } from "./browser"
import { CaptureRuntime } from "./runtime"

// Load capture settings before importing modules that read them at initialization.
const envFile = process.env.SNIP_CAPTURE_ENV_FILE || new URL("../.env", import.meta.url)
if (existsSync(envFile)) process.loadEnvFile(envFile)

const base = process.env.SNIP_URL
const token = process.env.CAPTURE_TOKEN
if (!base || !token) {
  console.error("Set SNIP_URL and CAPTURE_TOKEN in capture/.env (see .env.example).")
  process.exit(1)
}
const seconds = (value: string | undefined, fallback: number) => {
  const n = Number(value ?? fallback)
  return Number.isFinite(n) && n > 0 ? n * 1000 : fallback * 1000
}
const pollMs = seconds(process.env.POLL_SECONDS, 5)
const api = new SnipApi(base, token)
const runtime = new CaptureRuntime({
  api,
  // A Playwright update can expect a browser build that was never downloaded.
  // Install it once and relaunch instead of failing every capture.
  launch: async (job) => {
    const { chromium } = await import("playwright")
    const headless = process.env.HEADLESS !== "false"
    return launchWithRepair({
      launch: () => chromium.launch({ headless, args: CHROMIUM_ARGS, executablePath: process.env.CHROMIUM_PATH || undefined }),
      install: () => installBrowser(headless, (line) => console.log(`[browser install] ${line}`)),
      canInstall: !process.env.CHROMIUM_PATH && process.env.SNIP_BROWSER_AUTO_INSTALL !== "0",
      onInstall: () => api.progress(job.id, "Installing the capture browser (one-time, about a minute)"),
    })
  },
  capture: async (browser, job) => (await import("./capture")).captureJob(browser, api, job),
  status: (status) => {
    if (process.connected && process.send) {
      try { process.send(status, () => {}) } catch { /* parent disconnected */ }
    }
  },
  pollMs,
  idleMs: seconds(process.env.BROWSER_IDLE_SECONDS, 120),
  once: process.argv.includes("--once"),
  logError: (message) => console.error(message),
})

let interrupted = false
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (interrupted) process.exit(1)
    interrupted = true
    console.log("\nStopping after the current job (Ctrl+C again to force)…")
    runtime.stop()
  })
}
process.on("disconnect", () => runtime.stop())
process.on("message", (message: unknown) => {
  if (!message || typeof message !== "object" || !("type" in message)) return
  if (message.type === "snip:stop") runtime.stop()
  if (message.type === "snip:retry") runtime.retry()
})

console.log(`Snip capture agent → ${base} (polling every ${pollMs / 1000}s)`)
await runtime.run()
if (process.connected) process.disconnect?.()
