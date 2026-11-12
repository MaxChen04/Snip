// Shared harness for the browser tests: starts the Vite dev server on a free port, opens a page in Chromium and
// mocks every /api and /auth request with Playwright, so a test can hold, delay or fail one response to make a race.
//
//   const app = await startApp()           // once, in before()
//   const t = await app.session({ state })  // a signed-in browser page with the default API mocks
//   t.on("GET", /^\/api\/references\/ref1$/, (req) => ...)  // override one endpoint (return undefined to fall through)
//   await t.goto("/r/ref1")
//   await app.stop()                       // in after()
import { spawn, type ChildProcess } from "node:child_process"
import net from "node:net"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import type { BoardCanvas, BoardGroup, BoardItem, Collection, Reference, SavedImage } from "../../shared/types.ts"

const here = path.dirname(fileURLToPath(import.meta.url))
const webDir = path.resolve(here, "../..")
const viteBin = path.resolve(webDir, "../node_modules/.bin/vite")

// ---------------------------------------------------------------- fixtures

const NOW = "2026-01-01T00:00:00.000Z"
export const collection = (o: Partial<Collection> = {}): Collection => ({
  id: "board1",
  name: "Moodboard",
  description: null,
  referenceCount: 0,
  pageCount: 0,
  imageCount: 0,
  coverKeys: [],
  createdAt: NOW,
  ...o,
})

export const reference = (o: Partial<Reference> = {}): Reference => ({
  id: "ref1",
  url: "https://example.com/",
  domain: "example.com",
  title: "Example Domain",
  description: null,
  favicon: null,
  mode: "single",
  maxPages: 1,
  status: "ready",
  control: null,
  progress: null,
  error: null,
  coverKey: "covers/example.png",
  previewKeys: [],
  pageCount: 0,
  animationCount: 0,
  tokens: null,
  collectionIds: [],
  notes: null,
  options: null,
  createdAt: NOW,
  updatedAt: NOW,
  claimedAt: null,
  quietSince: null,
  captureRun: 1,
  ...o,
})

export const image = (o: Partial<SavedImage> = {}): SavedImage => ({
  id: "img1",
  title: "Picture",
  key: "uploads/img1/original.png",
  thumbKey: "uploads/img1/thumb.png",
  width: 200,
  height: 150,
  mime: "image/png",
  palette: [],
  collectionIds: ["board1"],
  createdAt: NOW,
  ...o,
})

/** A website on a board. */
export const websiteItem = (r: Reference, x: number | null, y: number | null, o: Partial<BoardItem> = {}): BoardItem => ({ kind: "reference", id: r.id, x, y, z: x === null ? null : 0, w: null, groupId: null, reference: r, ...o })
export const imageItem = (i: SavedImage, x: number | null, y: number | null, o: Partial<BoardItem> = {}): BoardItem => ({ kind: "image", id: i.id, x, y, z: x === null ? null : 0, w: null, groupId: null, image: i, ...o })
export const noteItem = (id: string, text: string, x: number, y: number, o: Partial<BoardItem> = {}): BoardItem => ({ kind: "note", id, x, y, z: 0, w: null, groupId: null, text, ...o })
export const frame = (id: string, x: number, y: number, w: number, h: number, name = "Frame"): BoardGroup => ({ id, name, x, y, w, h })

export const boardOf = (items: BoardItem[] = [], groups: BoardGroup[] = [], c: Collection = collection()): BoardCanvas => ({ collection: c, items, groups })

export type State = {
  collections: Collection[]
  /** GET /api/references/:id returns { reference, pages: [], animations: [] } for these. */
  references: Record<string, Reference>
  boards: Record<string, BoardCanvas>
}

// ---------------------------------------------------------------- tools for tests

/** A promise a test settles by hand: hold a response with `await gate.opened` inside a handler, release it later. */
export function gate<T = void>() {
  let open!: (v: T) => void
  const opened = new Promise<T>((r) => (open = r))
  return { opened, open }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Poll until fn returns truthy (or throw with the label). */
export async function until<T>(label: string, fn: () => T | Promise<T>, timeout = 8000): Promise<NonNullable<T>> {
  const end = Date.now() + timeout
  for (;;) {
    const v = await fn()
    if (v) return v as NonNullable<T>
    if (Date.now() > end) throw new Error(`timed out waiting for: ${label}`)
    await sleep(25)
  }
}

export type Req = { method: string; path: string; query: URLSearchParams; body: any; url: URL }
export type Reply = { status?: number; json?: unknown; abort?: boolean }
type Handler = (req: Req) => Reply | undefined | Promise<Reply | undefined>
type Matcher = string | RegExp

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64")

export type App = Awaited<ReturnType<typeof startApp>>

// ---------------------------------------------------------------- server and browser

async function freePort(): Promise<number> {
  // Other agents start Vite servers above 5300 too: ask the OS for any free port instead of guessing.
  for (;;) {
    const port = await new Promise<number>((res, rej) => {
      const s = net.createServer()
      s.once("error", rej)
      s.listen(0, "127.0.0.1", () => {
        const p = (s.address() as net.AddressInfo).port
        s.close(() => res(p))
      })
    })
    if (port > 5300) return port
  }
}

async function startVite(): Promise<{ proc: ChildProcess; url: string }> {
  const port = await freePort()
  const proc = spawn(viteBin, ["--config", path.join(here, "vite.config.mjs"), "--port", String(port), "--strictPort", "--host", "127.0.0.1"], {
    cwd: webDir,
    env: { ...process.env, SNIP_BROWSER_PORT: String(port), FORCE_COLOR: "0" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  })
  let log = ""
  proc.stdout!.on("data", (d) => (log += d))
  proc.stderr!.on("data", (d) => (log += d))
  const url = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 60_000
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`vite exited early:\n${log}`)
    try {
      const r = await fetch(url + "/")
      if (r.ok) break
    } catch {}
    if (Date.now() > deadline) throw new Error(`vite did not start:\n${log}`)
    await sleep(150)
  }
  return { proc, url }
}

const killTree = (proc: ChildProcess) => {
  try {
    process.kill(-proc.pid!, "SIGTERM")
  } catch {}
}

export async function startApp() {
  const { proc, url } = await startVite()
  const browser: Browser = await chromium.launch()
  const contexts: Page[] = []
  // Make sure a crash of the test process does not leave the server behind.
  const bye = () => killTree(proc)
  process.once("exit", bye)

  async function session(
    opts: {
      state?: Partial<State>
      /** Install Playwright's fake clock before the page loads (time still flows; use page.clock.fastForward to jump). */
      clock?: boolean
      viewport?: { width: number; height: number }
    } = {},
  ) {
    const context = await browser.newContext({ viewport: opts.viewport ?? { width: 1280, height: 800 }, serviceWorkers: "block" })
    const page = await context.newPage()
    contexts.push(page)
    const state: State = {
      collections: [collection()],
      references: {},
      boards: {},
      ...opts.state,
    }
    const requests: { method: string; path: string; body: any; at: number }[] = []
    const overrides: Handler[] = []
    const consoleErrors: string[] = []
    page.on("pageerror", (e) => consoleErrors.push(String(e)))
    const unmocked: string[] = []

    const defaults: Handler[] = [
      ({ method, path }) => (method === "GET" && path === "/api/me" ? { json: { login: "tester", ownerId: "owner1", method: "owner" } } : undefined),
      ({ method, path }) => (method === "GET" && path === "/api/collections" ? { json: state.collections } : undefined),
      ({ method, path }) =>
        method === "GET" && path === "/api/agent" ? { json: { lastSeenAt: NOW, freshness: "recent", activity: "idle" } } : undefined,
      ({ method, path }) => (method === "GET" && path === "/api/references" ? { json: { items: [], nextCursor: null } } : undefined),
      ({ method, path }) => {
        const m = method === "GET" && path.match(/^\/api\/references\/([^/]+)$/)
        const r = m && state.references[m[1]!]
        return r ? { json: { reference: r, pages: [], animations: [] } } : undefined
      },
      ({ method, path }) => {
        const m = method === "GET" && path.match(/^\/api\/boards\/([^/]+)$/)
        const b = m && state.boards[m[1]!]
        return b ? { json: b } : undefined
      },
      ({ method, path }) =>
        method === "GET" && path === "/api/counts" ? { json: { websites: 0, pages: 0, sections: 0, animations: 0, images: 0 } } : undefined,
      ({ method, path }) => (method === "GET" && path === "/api/storage" ? { json: { bytes: 0, objects: 0, partial: false, freeBytes: 1e10 } } : undefined),
      ({ method, path }) => (method === "GET" && /^\/api\/(pages|animations|sections|images)$/.test(path) ? { json: { items: [], nextCursor: null } } : undefined),
      // Writes succeed by default; tests override the ones they care about.
      ({ method, path }) => (method === "POST" && path === "/api/collections" ? { json: { id: "newboard" } } : undefined),
      ({ method, path, body }) => (method === "POST" && path === "/api/references" ? { json: reference({ id: `new-${Date.now()}`, url: body.url, domain: new URL(body.url).hostname, status: "queued" }) } : undefined),
      ({ method }) => (method !== "GET" ? { json: { ok: true, changed: 1 } } : undefined),
    ]

    // By path, so a source file under src/components/auth/ is still served.
    await page.route((url) => /^\/(api|auth)\//.test(url.pathname), async (route, request) => {
      const u = new URL(request.url())
      let body: any = null
      try {
        body = request.postData() ? JSON.parse(request.postData()!) : null
      } catch {}
      const req: Req = { method: request.method(), path: u.pathname, query: u.searchParams, body, url: u }
      requests.push({ method: req.method, path: req.path, body, at: Date.now() })
      for (const h of [...overrides, ...defaults]) {
        const r = await h(req)
        if (!r) continue
        if (r.abort) return route.abort("failed").catch(() => {})
        return route.fulfill({ status: r.status ?? 200, contentType: "application/json", body: JSON.stringify(r.json ?? {}) }).catch(() => {})
      }
      unmocked.push(`${req.method} ${req.path}`)
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not mocked" }) }).catch(() => {})
    })
    await page.route(/\/files\//, (route) => route.fulfill({ status: 200, contentType: "image/png", body: PNG }))
    await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.fulfill({ status: 200, contentType: "text/css", body: "" }))

    if (opts.clock) await page.clock.install()

    return {
      page,
      /** Navigate. Install overrides with on() first so the boot requests see them. */
      goto: (start: string) => page.goto(url + start),
      state,
      requests,
      consoleErrors,
      unmocked,
      /** Override one endpoint. Return a Reply to answer, or undefined to fall through to older overrides and the defaults. Newest wins. */
      on(method: string, path: Matcher, handler: Handler) {
        overrides.unshift((req) => {
          if (req.method !== method) return
          if (typeof path === "string" ? req.path !== path : !path.test(req.path)) return
          return handler(req)
        })
      },
      /** Requests seen so far, for one method and path. */
      count(method: string, path: Matcher) {
        return requests.filter((r) => r.method === method && (typeof path === "string" ? r.path === path : path.test(r.path))).length
      },
      list(method: string, path: Matcher) {
        return requests.filter((r) => r.method === method && (typeof path === "string" ? r.path === path : path.test(r.path)))
      },
    }
  }

  return {
    url,
    session,
    async stop() {
      process.off("exit", bye)
      await browser.close().catch(() => {})
      killTree(proc)
    },
  }
}

/** The board header's "Add website" button opens the Add dialog on a board page. */
export async function openAddDialog(page: Page) {
  await page.getByRole("button", { name: "Add website" }).first().click()
  const dialog = page.getByRole("dialog", { name: "New reference" })
  await dialog.waitFor()
  return dialog
}

/** Close the Add dialog with its Close button and wait until it is gone from the page. */
export async function closeDialog(page: Page) {
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click()
  await page.getByRole("dialog").waitFor({ state: "detached" })
}

/** Paste text onto the page body as if from the clipboard (the app opens its Add dialog for pasted URLs). */
export async function pasteOnPage(page: Page, text: string) {
  await page.evaluate((text) => {
    const data = new DataTransfer()
    data.setData("text/plain", text)
    document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }))
  }, text)
}
