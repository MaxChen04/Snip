import { test } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { chromium } from "playwright"
import type { CrawlState, Job, JobComplete, PageUpload } from "../../web/shared/types"
import { captureJob } from "../src/capture"
import { closeRenderer } from "../src/sheet"

// Regression tests for crawl recovery bugs in capturePages (reached through captureJob, with a real browser and a local server).
// They assert the CORRECT behaviour and fail until capture.ts is fixed.

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64")
const launch = () => chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined })
const attempt = "a".repeat(32)

async function withServer<T>(handler: http.RequestListener, fn: (base: string) => Promise<T>) {
  const previous = process.env.ALLOW_PRIVATE_URLS
  process.env.ALLOW_PRIVATE_URLS = "true"
  const server = http.createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    return await fn(`http://127.0.0.1:${(server.address() as { port: number }).port}/`)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    if (previous === undefined) delete process.env.ALLOW_PRIVATE_URLS
    else process.env.ALLOW_PRIVATE_URLS = previous
  }
}

const plain = (title: string, links = "") => `<!doctype html><title>${title}</title><body><h1>${title}</h1>${links}</body>`

test("a page whose addPage failed does not lend its ord (file prefix) to the next page", { timeout: 240_000 }, async () => {
  await withServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" })
    res.end(req.url === "/b" ? plain("Page B") : req.url === "/c" ? plain("Page C") : plain("Page A", `<nav><a href="/b">B</a> <a href="/c">C</a></nav>`))
  }, async (base) => {
    const browser = await launch()
    try {
      const attempted: { ord: number; url: string; desktopKey: string }[] = []
      const uploads: string[] = []
      let calls = 0
      const api = {
        control: async () => null,
        progress: async () => {},
        upload: async (key: string) => { uploads.push(key); return key },
        // The first call is recorded, then fails: the server may or may not have committed it.
        addPage: async (_id: string, page: PageUpload) => {
          attempted.push({ ord: page.ord, url: page.url, desktopKey: page.desktopKey })
          if (++calls === 1) throw new Error("addPage failed: 500")
        },
        complete: async () => {},
      }
      await captureJob(browser, api as never, { id: "ords", url: base, mode: "crawl", maxPages: 3, attempt, resume: null, options: null, features: [] } as unknown as Job)
      assert.ok(attempted.length >= 2, `at least two pages were attempted, got ${attempted.length}`)
      const ords = attempted.map((a) => a.ord)
      assert.equal(new Set(ords).size, ords.length, `every attempted page gets a distinct ord, got ${JSON.stringify(ords)}`)
      const prefixes = attempted.map((a) => a.desktopKey.replace(/\/desktop\.jpg$/, ""))
      assert.equal(new Set(prefixes).size, prefixes.length, `every attempted page gets a distinct file prefix, got ${JSON.stringify(prefixes)}`)
    } finally {
      await closeRenderer()
      await browser.close()
    }
  })
})

test("complete() carries the stored icon key even when the icon is slower than the whole page capture", { timeout: 240_000 }, async () => {
  let releaseIcon!: () => void
  const iconGate = new Promise<void>((resolve) => { releaseIcon = resolve })
  let iconRequested = false
  await withServer((req, res) => {
    if (req.url === "/icon.png") {
      iconRequested = true
      void iconGate.then(() => { res.writeHead(200, { "content-type": "image/png" }); res.end(PNG) })
      return
    }
    res.writeHead(200, { "content-type": "text/html" })
    res.end(`<!doctype html><title>Slow icon</title><link rel="icon" href="/icon.png"><body><h1>Slow icon</h1></body>`)
  }, async (base) => {
    const browser = await launch()
    try {
      const uploads: string[] = []
      let completed: JobComplete | null = null
      const api = {
        control: async () => null,
        progress: async () => {},
        upload: async (key: string) => { uploads.push(key); return key },
        // The page has landed; the icon answers only well after that, but within its own 10 s fetch timeout.
        addPage: async () => { setTimeout(releaseIcon, 1500) },
        complete: async (_id: string, c: JobComplete) => { completed = c },
      }
      await captureJob(browser, api as never, { id: "slow-icon", url: base, mode: "single", maxPages: 1, attempt, resume: null, options: null, features: ["icon"] } as unknown as Job)
      assert.ok(iconRequested, "the icon fetch started")
      assert.ok(completed, "complete() was sent")
      assert.match(completed!.favicon ?? "", /^refs\//, `complete() carries the stored icon key, got ${completed!.favicon}`)
      assert.ok(uploads.some((k) => k.endsWith("icon.png")), "the icon was uploaded")
    } finally {
      releaseIcon()
      await closeRenderer()
      await browser.close()
    }
  })
})

// A moving hero shared by every page of the site (a logo marquee, an animated banner), then page-specific copy.
const sharedHero = `<style>
  body { margin: 0 } section { height: 600px; box-sizing: border-box; padding: 20px }
  #spin { width: 80px; height: 80px; background: tomato; animation: move 1s linear infinite } @keyframes move { to { transform: translateX(600px) } }
</style><section><h1>Ship faster with Acme</h1><p>The shared animated hero.</p><div id="spin"></div></section>`
const livePage = (title: string, links = "") => `<!doctype html><title>${title}</title><body>${sharedHero}<section><h2>${title} details</h2>${links}</section></body>`

test("a live clip uploaded for a page whose addPage failed is not reused by a later page", { timeout: 240_000 }, async () => {
  await withServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" })
    res.end(req.url === "/b" ? livePage("Page B") : livePage("Page A", `<nav><a href="/b">B</a></nav>`))
  }, async (base) => {
    const browser = await launch()
    try {
      // Uploads are grouped into the window of the page attempt that made them; a window is stored only if its addPage succeeded.
      type Attempt = { uploads: string[]; page?: PageUpload; stored: boolean }
      const attempts: Attempt[] = [{ uploads: [], stored: false }]
      let calls = 0
      const api = {
        control: async () => null,
        progress: async () => {},
        upload: async (key: string) => { attempts.at(-1)!.uploads.push(key); return key },
        addPage: async (_id: string, page: PageUpload) => {
          const attempt = attempts.at(-1)!
          attempt.page = page
          attempts.push({ uploads: [], stored: false })
          if (++calls === 1) throw new Error("addPage failed: 500")
          attempt.stored = true
        },
        complete: async () => {},
      }
      await captureJob(browser, api as never, {
        id: "live", url: base, mode: "crawl", maxPages: 2, attempt, resume: null, options: null,
        recordingFormats: ["gif", "webm"], features: ["sections", "live"],
      } as unknown as Job)
      const pages = attempts.filter((a) => a.page)
      assert.equal(pages.length, 2, "both pages were attempted")
      assert.ok(pages[0]!.uploads.some((k) => /live\.webm$/.test(k)), "the first page uploaded a live clip (the test page produces one)")
      const stored = pages.filter((a) => a.stored)
      assert.equal(stored.length, 1)
      const keysOfStoredPages = new Set(stored.flatMap((a) => a.uploads))
      const referenced = stored[0]!.page!.sections?.flatMap((s) => s.live?.key ?? []) ?? []
      assert.ok(referenced.length > 0, "the stored page has a live clip")
      for (const key of referenced) assert.ok(keysOfStoredPages.has(key), `live clip ${key} was uploaded for the stored page, not only for a failed one`)
    } finally {
      await closeRenderer()
      await browser.close()
    }
  })
})

test("an aborted crawl pauses at the next page boundary when the server accepts it, and otherwise stops with the pages it has", { timeout: 240_000 }, async () => {
  await withServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" })
    res.end(req.url === "/b" ? plain("Page B") : req.url === "/c" ? plain("Page C") : plain("Page A", `<nav><a href="/b">B</a> <a href="/c">C</a></nav>`))
  }, async (base) => {
    const browser = await launch()
    try {
      const run = async (acceptsPause: boolean, abortAt: "start" | "first page") => {
        const abort = new AbortController()
        if (abortAt === "start") abort.abort()
        const seen = { pages: [] as string[], states: [] as CrawlState[], paused: [] as CrawlState[], completed: 0, controls: 0 }
        const api = {
          control: async () => { seen.controls++; return null },
          progress: async () => {},
          upload: async (key: string) => key,
          addPage: async (_id: string, page: PageUpload) => { seen.pages.push(page.path); seen.states.push(page.state!); abort.abort() },
          pause: async (_id: string, state: CrawlState, release?: boolean) => { assert.equal(release, true, "the hand-back is marked as the worker's own"); seen.paused.push(state); return acceptsPause },
          complete: async () => { seen.completed++ },
        }
        await captureJob(browser, api as never, { id: "abort", url: base, mode: "crawl", maxPages: 3, attempt, resume: null, options: null, features: [] } as unknown as Job, abort.signal)
        return seen
      }

      const paused = await run(true, "first page")
      assert.deepEqual(paused.pages, ["/"], "no page is started after the abort")
      assert.equal(paused.paused.length, 1)
      assert.equal(paused.paused[0]!.captured, 1)
      assert.deepEqual(paused.paused[0]!.queue, [`${base}b`, `${base}c`], "the checkpoint holds the rest of the crawl")
      assert.equal(paused.completed, 0, "a paused crawl is not completed")
      // Each page carries where the crawl stands once it is saved, so a crawl whose agent dies resumes from there.
      assert.deepEqual({ ...paused.states[0]!, meta: null }, { ...paused.paused[0]!, meta: null })
      assert.equal(paused.states[0]!.meta!.title, paused.paused[0]!.meta!.title)

      const stopped = await run(false, "first page")
      assert.deepEqual(stopped.pages, ["/"])
      assert.equal(stopped.completed, 1, "the pages it has are kept")

      // Aborted before its first page and the server will not pause it: one page is captured, so the job is not failed as empty.
      const early = await run(false, "start")
      assert.deepEqual(early.pages, ["/"])
      assert.equal(early.completed, 1)
    } finally {
      await closeRenderer()
      await browser.close()
    }
  })
})

test("a resumed crawl does not reuse an ord stored before the pause, when a failed page had taken one", { timeout: 240_000 }, async () => {
  await withServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" })
    res.end(plain("Page D"))
  }, async (base) => {
    const browser = await launch()
    try {
      const ords: number[] = []
      const api = {
        control: async () => null,
        progress: async () => {},
        upload: async (key: string) => key,
        addPage: async (_id: string, page: PageUpload) => { ords.push(page.ord) },
        complete: async () => {},
      }
      // Before the pause: / stored as 0, /b failed as 1, /c stored as 2.
      const resume: CrawlState = { version: 1, queue: [`${base}d`], visited: [base, `${base}b`, `${base}c`], captured: 2, failures: 1, navLinksQueued: true, hoverSeen: [], meta: null, tokens: null }
      await captureJob(browser, api as never, { id: "resumed", url: base, mode: "crawl", maxPages: 3, attempt, resume, options: null, features: [] } as unknown as Job)
      assert.deepEqual(ords, [3])
    } finally {
      await closeRenderer()
      await browser.close()
    }
  })
})
