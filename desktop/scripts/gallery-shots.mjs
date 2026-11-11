// Captures the gallery's "Waiting for your Mac" card from the real built app, with a
// real local Worker and a queued reference. Dev tool only: it never touches Max's
// library, Cloudflare or the running Snip.app.
// Usage: node desktop/scripts/gallery-shots.mjs [outDir]
import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import http from "node:http"
import { fork, execFile } from "node:child_process"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, "../..")
const out = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), "snip-screenshots/desktop"))
const run = promisify(execFile)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function freePort() {
  const server = http.createServer()
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

const temp = await fsp.mkdtemp(path.join(os.tmpdir(), "snip-gallery-shots-"))
const root = path.join(temp, "repo")
const appDir = path.join(root, "desktop")
const port = await freePort()
const origin = `http://localhost:${port}`
let backend
const stop = async () => {
  if (backend && backend.exitCode === null) {
    backend.send({ type: "snip:stop" })
    await new Promise(resolve => backend.once("exit", resolve))
  }
  await fsp.rm(temp, { recursive: true, force: true })
}

try {
  await fsp.mkdir(root, { recursive: true })
  await fsp.mkdir(appDir)
  for (const name of ["web/dist", "web/migrations", "web/public"]) await fsp.cp(path.join(ROOT, name), path.join(root, name), { recursive: true })
  for (const name of ["package.json", "web/wrangler.jsonc"]) await fsp.copyFile(path.join(ROOT, name), path.join(root, name))
  await fsp.symlink(path.join(ROOT, "node_modules"), path.join(root, "node_modules"), "dir")
  await fsp.copyFile(path.join(ROOT, "desktop/local-server.cjs"), path.join(appDir, "local-server.cjs"))

  const env = { ...process.env, WRANGLER_SEND_METRICS: "false" }
  for (const key of ["ELECTRON_RUN_AS_NODE", "SNIP_URL", "CAPTURE_TOKEN", "DEV_LOGIN"]) delete env[key]
  const wrangler = path.join(ROOT, "node_modules/wrangler/bin/wrangler.js")
  const state = path.join(root, "web/.wrangler/state")
  const config = path.join(root, "web/wrangler.jsonc")
  const d1 = (...args) => run(process.execPath, [wrangler, "d1", ...args, "--local", "--config", config, "--persist-to", state], { cwd: root, env })

  await fsp.writeFile(path.join(root, "web/.dev.vars"), `DEV_LOGIN=reviewer\nSESSION_SECRET=synthetic-local-session\nCAPTURE_TOKEN=synthetic-capture-token\nPUBLIC_URL=${origin}\n`)
  await d1("migrations", "apply", "snip")
  const now = "2026-11-06T10:00:00.000Z"
  await d1(
    "execute",
    "snip",
    "--command",
    `INSERT INTO refs (id, url, domain, title, mode, max_pages, status, progress, created_at, updated_at) VALUES ` +
      `('galwaiting0000001','https://linear.app/','linear.app','Linear',  'crawl', 40, 'queued', 'Waiting for your Mac', '${now}', '${now}'),` +
      `('galwaiting0000002','https://arc.net/','arc.net','Arc Browser','crawl', 12, 'queued', 'Waiting for your Mac', '${now}', '${now}'),` +
      `('galwaiting0000003','https://www.stripe.com/','stripe.com','Stripe','crawl', 18, 'failed', 'Capture failed', '${now}', '${now}')`,
  )

  backend = fork(path.join(appDir, "local-server.cjs"), [root, String(port), root], { env, stdio: ["ignore", "ignore", "ignore", "ipc"] })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("local server did not start")), 60000)
    backend.on("message", message => {
      clearTimeout(timer)
      if (message?.type === "snip:web-ready") resolve()
      else reject(new Error("local server failed"))
    })
    backend.on("exit", () => reject(new Error("local server exited")))
  })

  fs.mkdirSync(out, { recursive: true })
  const browser = await chromium.launch()
  try {
    for (const theme of ["light", "dark"]) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: theme })
      const page = await context.newPage()
      await page.goto(origin, { waitUntil: "networkidle" })
      const waiting = page.getByText("Waiting for your Mac").first()
      await waiting.waitFor({ timeout: 30000 }).catch(async error => {
        console.error("URL:", page.url())
        console.error("BODY:", (await page.locator("body").innerText().catch(() => "unavailable")).slice(0, 1500))
        throw error
      })
      await sleep(600) // let the folder tiles finish their entrance
      await page.screenshot({ path: path.join(out, `gallery-waiting-${theme}.png`) })
      const tile = waiting.locator("xpath=ancestor::div[contains(@class,'group')]").first()
      await tile.screenshot({ path: path.join(out, `gallery-waiting-card-${theme}.png`) })
      console.log(path.join(out, `gallery-waiting-${theme}.png`))
      await context.close()
    }
  } finally {
    await browser.close()
  }
} finally {
  await stop()
}
