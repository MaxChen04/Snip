// Shared harness for the Settings window browser tests.
//
// Bridge injection: web/src/settings/settings-main.tsx installs its dev fixture only when
// `window.snipCloud` is unset (`import.meta.env.DEV && !window.snipCloud`). So the tests
// define `window.snipCloud` with page.addInitScript before the app loads, and the
// fixture is never used. No product file is touched. The injected bridge is
// fake-main.js, a small model of desktop/main.cjs; tests drive the "engine" through
// window.__sim (see `sim()` below).
import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"

const here = path.dirname(fileURLToPath(import.meta.url))
const webRoot = path.resolve(here, "../..")
const fakeMain = fs.readFileSync(path.join(here, "fake-main.js"), "utf8")

export interface Server {
  url: string
  stop(): Promise<void>
}

async function freePort(start: number): Promise<number> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const port = start + Math.floor(Math.random() * 500) + attempt
    const ok = await new Promise<boolean>(resolve => {
      const server = net.createServer()
      server.once("error", () => resolve(false))
      server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)))
    })
    if (ok) return port
  }
  throw new Error("no free port")
}

export async function startVite(): Promise<Server> {
  const port = await freePort(5400 + Math.floor(Math.random() * 3000))
  const child: ChildProcess = spawn("npx", ["vite", "--config", "vite.settings.config.ts", "--port", String(port), "--strictPort", "--host", "127.0.0.1"], {
    cwd: webRoot,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  })
  let output = ""
  child.stdout?.on("data", chunk => (output += chunk))
  child.stderr?.on("data", chunk => (output += chunk))
  const url = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 60_000
  for (;;) {
    if (child.exitCode !== null) throw new Error(`vite exited early:\n${output}`)
    try {
      const response = await fetch(`${url}/settings.html`)
      if (response.ok) break
    } catch {}
    if (Date.now() > deadline) throw new Error(`vite did not start:\n${output}`)
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  return {
    url,
    async stop() {
      try {
        process.kill(-child.pid!, "SIGTERM")
      } catch {}
      await new Promise<void>(resolve => {
        if (child.exitCode !== null) return resolve()
        child.once("exit", () => resolve())
        setTimeout(resolve, 3000)
      })
    },
  }
}

export async function launch(): Promise<Browser> {
  return chromium.launch()
}

export interface Opened {
  page: Page
  pageErrors: string[]
  close(): Promise<void>
}

/**
 * Opens /settings.html with the fake main process installed before any app script runs.
 * `mode` is what cloud.json says at start.
 * `search` is the page's query string; `awaitFirstPaint: false` returns before the first
 * state() reply has rendered anything.
 */
export async function openSettings(browser: Browser, server: Server, config: { mode?: "local" | "enabling" | "cloud"; stateDelayMs?: number; cancelKillMs?: number; search?: string; awaitFirstPaint?: boolean } = {}): Promise<Opened> {
  const context = await browser.newContext({ viewport: { width: 900, height: 900 } })
  const page = await context.newPage()
  const pageErrors: string[] = []
  page.on("pageerror", error => pageErrors.push(String(error)))
  await page.addInitScript({ content: `window.__SIM_CONFIG__ = ${JSON.stringify(config)};\n${fakeMain}` })
  await page.goto(`${server.url}/settings.html${config.search ?? ""}`)
  // The dev entry must have kept our bridge (not the fixture) and rendered the app.
  const installed = await page.evaluate(() => typeof (window as any).__sim === "object")
  if (!installed) throw new Error("fake bridge was not installed")
  if (config.awaitFirstPaint !== false) await page.getByRole("heading", { level: 1 }).first().waitFor()
  return { page, pageErrors, close: () => context.close() }
}

/** Call a method of the fake main process: `await sim(page, "step", "preflight", "started")`. */
export async function sim(page: Page, method: string, ...args: unknown[]): Promise<void> {
  await page.evaluate(([name, rest]) => (window as any).__sim[name as string](...(rest as unknown[])), [method, args] as const)
}

export async function calls(page: Page, method?: string): Promise<{ method: string; args: unknown[] }[]> {
  const all = (await page.evaluate("window.__sim.calls")) as { method: string; args: unknown[] }[]
  return method ? all.filter(entry => entry.method === method) : all
}

/** Text currently visible OUTSIDE sonner toasts (toasts are transient, a toast is not UI state). */
export async function pageTextOutsideToasts(page: Page): Promise<string> {
  return page.evaluate(() => {
    const clone = document.body.cloneNode(true) as HTMLElement
    clone.querySelectorAll("[data-sonner-toaster], [data-sonner-toast]").forEach(node => node.remove())
    return clone.innerText ?? clone.textContent ?? ""
  })
}

export async function toastTexts(page: Page): Promise<string[]> {
  return page.locator("[data-sonner-toast]").allInnerTexts()
}

/**
 * Records, from inside the page, every moment `predicate` (a JS expression string) was
 * true, so a transient element cannot slip between two Playwright polls.
 */
export async function watch(page: Page, name: string, predicateSource: string): Promise<void> {
  // A plain string, evaluated in the page: tsx would inject helpers into a function body.
  await page.evaluate(`(function () {
    var w = window; w.__watch = w.__watch || {}
    var key = ${JSON.stringify(name)}
    w.__watch[key] = { seen: false, firstAt: 0 }
    function tick() {
      try {
        if (${predicateSource}) { if (!w.__watch[key].seen) w.__watch[key].firstAt = Date.now(); w.__watch[key].seen = true }
      } catch (e) {}
    }
    new MutationObserver(tick).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true })
    window.setInterval(tick, 20)
  })()`)
}

export async function watched(page: Page, name: string): Promise<boolean> {
  return page.evaluate((key) => !!(window as any).__watch?.[key]?.seen, name)
}

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
