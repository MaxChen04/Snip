import { existsSync } from "node:fs"
import { chromium, type Browser } from "playwright"
import { SnipApi } from "./api"

// Local capture agent: polls the hosted Snip queue, captures sites with a
// real browser on this machine and uploads results. Run: npm run capture

const envFile = new URL("../.env", import.meta.url)
if (existsSync(envFile)) process.loadEnvFile(envFile)

// Capture modules read their settings at initialization, after capture/.env is loaded.
const { captureJob } = await import("./capture")

const base = process.env.SNIP_URL
const token = process.env.CAPTURE_TOKEN
if (!base || !token) {
  console.error("Set SNIP_URL and CAPTURE_TOKEN in capture/.env (see .env.example).")
  process.exit(1)
}
const once = process.argv.includes("--once")
const pollMs = Number(process.env.POLL_SECONDS ?? 5) * 1000
const api = new SnipApi(base, token)

let browser = null as Browser | null
async function getBrowser() {
  if (browser?.isConnected()) return browser
  browser = await chromium.launch({
    headless: process.env.HEADLESS !== "false",
    executablePath: process.env.CHROMIUM_PATH || undefined,
  })
  return browser
}

let stopping = false
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    if (stopping) process.exit(1)
    stopping = true
    console.log("\nStopping after the current job (Ctrl+C again to force)…")
    if (!busy) {
      await browser?.close().catch(() => {})
      process.exit(0)
    }
  })
}

let busy = false
console.log(`Snip capture agent → ${base} (polling every ${pollMs / 1000}s)`)
while (!stopping) {
  let job = null
  try {
    job = await api.claim()
  } catch (e) {
    console.error("Queue poll failed:", (e as Error).message)
  }
  if (job) {
    busy = true
    // Presence while busy: a single long page can take minutes between progress reports.
    const beat = setInterval(() => api.heartbeat(job.id), 30_000)
    try {
      await captureJob(await getBrowser(), api, job)
    } catch (e) {
      console.error(`[${job.id}] failed:`, (e as Error).message)
      await api.fail(job.id, (e as Error).message.split("\n")[0] ?? "Capture failed")
    }
    clearInterval(beat)
    busy = false
    continue
  }
  if (once) break
  await new Promise((r) => setTimeout(r, pollMs))
}
await (browser as Browser | null)?.close().catch(() => {})
