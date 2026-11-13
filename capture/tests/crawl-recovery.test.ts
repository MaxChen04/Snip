import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import http from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium, type Browser } from "playwright"
import type { CrawlState, Job, JobComplete, PageUpload } from "../../web/shared/types"
import { JobGoneError } from "../src/api"
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

test("a capture whose job another agent took stops at the first refused call: no more pages, and nothing is completed or paused", { timeout: 300_000 }, async () => {
  await withServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" })
    res.end(req.url === "/b" ? plain("Page B") : req.url === "/c" ? plain("Page C") : plain("Page A", `<nav><a href="/b">B</a> <a href="/c">C</a></nav>`))
  }, async (base) => {
    const browser = await launch()
    try {
      // Where the Worker's "job is gone" lands: the first file upload, the first page save, or the check between pages.
      for (const refused of ["upload", "addPage", "control"] as const) {
        const seen = { uploads: 0, pages: [] as string[], controls: 0, completed: 0, paused: 0 }
        const gone = () => { throw new JobGoneError() }
        const api = {
          control: async () => { if (refused === "control" && ++seen.controls === 2) gone(); return null },
          progress: async () => {},
          upload: async (key: string) => { if (refused === "upload") gone(); seen.uploads++; return key },
          addPage: async (_id: string, page: PageUpload) => { if (refused === "addPage") gone(); seen.pages.push(page.path) },
          pause: async () => { seen.paused++; return true },
          complete: async () => { seen.completed++ },
        }
        await assert.rejects(captureJob(browser, api as never, { id: "taken", url: base, mode: "crawl", maxPages: 3, attempt, resume: null, options: null, features: [] } as unknown as Job), JobGoneError, refused)
        assert.deepEqual({ completed: seen.completed, paused: seen.paused }, { completed: 0, paused: 0 }, `${refused}: a replaced agent neither finishes nor hands back the job`)
        assert.deepEqual(seen.pages, refused === "control" ? ["/"] : [], `${refused}: no page is started after the refusal`)
        if (refused === "upload") assert.equal(seen.uploads, 0, "nothing more is uploaded")
      }
    } finally {
      await closeRenderer()
      await browser.close()
    }
  })
})

const SITE = (req: http.IncomingMessage) => req.url === "/b" ? plain("Page B") : req.url === "/c" ? plain("Page C") : plain("Page A", `<nav><a href="/b">B</a> <a href="/c">C</a></nav>`)

test("a crawl's first page is reported without a total until its links are known, and a hand-back is not called a pause", { timeout: 300_000 }, async () => {
  await withServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" })
    res.end(SITE(req))
  }, async (base) => {
    const browser = await launch()
    const lines: string[] = []
    const log = console.log
    console.log = (...a: unknown[]) => { lines.push(a.join(" ")) }
    try {
      const run = async (job: Partial<Job>, control: (n: number) => "pause" | null, signal?: AbortSignal, afterPage = () => {}) => {
        const messages: string[] = []
        let calls = 0
        const api = {
          control: async () => control(calls++),
          progress: async (_id: string, message: string) => { messages.push(message) },
          upload: async (key: string) => key,
          addPage: async () => { afterPage() },
          pause: async () => true,
          complete: async () => {},
        }
        await captureJob(browser, api as never, { id: "words", url: base, mode: "crawl", maxPages: 3, attempt, resume: null, options: null, features: [], ...job } as unknown as Job, signal)
        return messages
      }
      assert.deepEqual(await run({}, () => null), ["Capturing page 1: /", "Capturing 2/3: /b", "Capturing 3/3: /c"], "no total before the first page's links are in, the fraction after")
      assert.deepEqual(await run({ mode: "single", maxPages: 1 }, () => null), ["Capturing 1/1: /"], "a single page has its own total")
      assert.deepEqual(await run({ maxPages: 1 }, () => null), ["Capturing 1/1: /"], "a crawl of one page is one page")

      assert.deepEqual(await run({}, (n) => (n === 1 ? "pause" : null)), ["Capturing page 1: /"])
      assert.ok(lines.some((l) => l.endsWith("paused after 1 page(s)")), `a user's pause says paused, got ${lines}`)
      const abort = new AbortController()
      await run({}, () => null, abort.signal, () => abort.abort())
      assert.ok(lines.some((l) => l.endsWith("handed back after 1 page(s)")), `a stopping worker's hand-back says handed back, got ${lines}`)
    } finally {
      console.log = log
      await closeRenderer()
      await browser.close()
    }
  })
})

/** An api whose page "/b" is cut off: `cut` runs when its capture starts. Records what the agent did. */
function cutOffApi(cut: () => void, acceptsPause: boolean) {
  const seen = { pages: [] as PageUpload[], paused: [] as { state: CrawlState; release?: boolean }[], completed: 0 }
  const api = {
    control: async () => null,
    progress: async (_id: string, message: string) => { if (message.endsWith(": /b")) setTimeout(cut, 400) },
    upload: async (key: string) => key,
    addPage: async (_id: string, page: PageUpload) => { seen.pages.push(page) },
    pause: async (_id: string, state: CrawlState, release?: boolean) => { seen.paused.push({ state, release }); return acceptsPause },
    complete: async () => { seen.completed++ },
  }
  return { api, seen }
}

test("a page cut off by a stop is no failure: it heads the checkpoint, and the resume captures it under an ord of its own", { timeout: 300_000 }, async () => {
  let hold = true
  await withServer((req, res) => {
    if (hold && req.url === "/b") return // the page never answers: the stop and the closed browser land mid-page
    res.writeHead(200, { "content-type": "text/html" })
    res.end(SITE(req))
  }, async (base) => {
    const first = await launch()
    try {
      const abort = new AbortController()
      const { api, seen } = cutOffApi(() => { abort.abort(); void first.close() }, true)
      await captureJob(first, api as never, { id: "cut", url: base, mode: "crawl", maxPages: 3, attempt, resume: null, options: null, features: [] } as unknown as Job, abort.signal)
      assert.deepEqual(seen.pages.map((p) => p.path), ["/"], "the cut-off page was not stored")
      assert.equal(seen.completed, 0)
      assert.equal(seen.paused.length, 1)
      assert.equal(seen.paused[0]!.release, true)
      const state = seen.paused[0]!.state
      assert.equal(state.failures, 0, "a page the stop cut off is not a failure")
      assert.equal(state.captured, 1)
      assert.deepEqual(state.queue, [`${base}b`, `${base}c`], "the cut-off page is first in line")
      assert.deepEqual(state.visited, [base, `${base}b`], "its ord stays taken")

      // Resumed by the next claim, in a browser of its own.
      hold = false
      const second = await launch()
      try {
        const resumed = cutOffApi(() => {}, true)
        await captureJob(second, resumed.api as never, { id: "cut", url: base, mode: "crawl", maxPages: 3, attempt, resume: state, options: null, features: [] } as unknown as Job)
        assert.deepEqual(resumed.seen.pages.map((p) => p.path), ["/b", "/c"], "the cut-off page is captured, then the rest")
        assert.deepEqual([...seen.pages, ...resumed.seen.pages].map((p) => p.ord), [0, 2, 3], "ords stay unique across the pause")
        assert.equal(resumed.seen.completed, 1)
      } finally {
        await closeRenderer()
        await second.close()
      }
    } finally {
      await closeRenderer()
      await first.close()
    }
  })
})

// The browser process dies, as when it is killed or runs out of memory.
const crash = async (browser: Browser) => (await browser.newBrowserCDPSession()).send("Browser.crash").catch(() => {})

test("a browser lost mid-page is handed back like a stop, or ends the capture, and never loops", { timeout: 300_000 }, async () => {
  let hold = true
  await withServer((req, res) => {
    if (hold && req.url === "/b") return
    res.writeHead(200, { "content-type": "text/html" })
    res.end(SITE(req))
  }, async (base) => {
    const run = async (acceptsPause: boolean, resume: CrawlState | null) => {
      const browser = await launch()
      try {
        const { api, seen } = cutOffApi(() => void crash(browser), acceptsPause)
        const done = captureJob(browser, api as never, { id: "lost", url: base, mode: "crawl", maxPages: 3, attempt, resume, options: null, features: [] } as unknown as Job).then(() => null, (e: Error) => e)
        return { error: await done, seen }
      } finally {
        await closeRenderer()
        await browser.close()
      }
    }
    // The Worker takes the crawl back: nothing fails, and the cut-off page leads the queue.
    const handed = await run(true, null)
    assert.equal(handed.error, null)
    assert.equal(handed.seen.paused.length, 1)
    assert.equal(handed.seen.paused[0]!.state.failures, 0)
    assert.equal(handed.seen.paused[0]!.state.queue[0], `${base}b`)
    assert.equal(handed.seen.completed, 0)
    // An older Worker refuses: the pages it has are kept.
    const kept = await run(false, null)
    assert.equal(kept.error, null)
    assert.deepEqual(kept.seen.pages.map((p) => p.path), ["/"])
    assert.equal(kept.seen.completed, 1)
    // Nothing captured yet and nothing taking it back: the capture ends with an error, it does not retry on a dead browser.
    hold = false
    const empty = await run(false, { version: 1, queue: [`${base}b`], visited: [base], captured: 0, failures: 0, navLinksQueued: true, hoverSeen: [], meta: null, tokens: null })
    assert.match(empty.error?.message ?? "", /browser closed/)
    assert.equal(empty.seen.completed, 0)
  })
})

test("SIGTERM during a page lets the agent finish it, then hand the crawl back", { timeout: 300_000 }, async () => {
  const saved = { pages: [] as string[], paused: [] as { release: boolean; queue: string[] }[], failed: 0, completed: 0 }
  let agent: ReturnType<typeof spawn> | undefined
  let claimed = false
  // The Worker: one crawl job, then an empty queue.
  const worker = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => {
      const url = new URL(req.url!, "http://worker")
      const body = Buffer.concat(chunks).toString()
      const reply = (status: number, payload = "{}") => { res.writeHead(status, { "content-type": "application/json" }); res.end(payload) }
      if (url.pathname === "/agent/jobs/claim") {
        if (claimed) return reply(204, "")
        claimed = true
        return reply(200, JSON.stringify({ id: "term", url: siteBase, mode: "crawl", maxPages: 3, attempt, lease: "lease", resume: null, options: null, features: [], recordingFormats: ["gif"] }))
      }
      if (url.pathname === "/agent/jobs/term/control") return reply(200, '{"control":null}')
      if (url.pathname === "/agent/jobs/term/pages") saved.pages.push((JSON.parse(body) as PageUpload).path)
      if (url.pathname === "/agent/jobs/term/pause") saved.paused.push({ release: url.searchParams.has("release"), queue: (JSON.parse(body) as CrawlState).queue })
      if (url.pathname === "/agent/jobs/term/fail") saved.failed++
      if (url.pathname === "/agent/jobs/term/complete") saved.completed++
      reply(200)
    })
  })
  let siteBase = ""
  await new Promise<void>((resolve) => worker.listen(0, "127.0.0.1", resolve))
  try {
    await withServer((req, res) => {
      // The first page answers a beat after the signal, so the signal lands while the page is loading (once: a second one forces the exit).
      if (req.url === "/" && !agent!.killed) agent!.kill("SIGTERM")
      setTimeout(() => { res.writeHead(200, { "content-type": "text/html" }); res.end(SITE(req)) }, req.url === "/" ? 1500 : 0)
    }, async (base) => {
      siteBase = base
      agent = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../src/index.ts", import.meta.url))], {
        stdio: "ignore",
        env: {
          ...process.env,
          SNIP_URL: `http://127.0.0.1:${(worker.address() as { port: number }).port}`,
          CAPTURE_TOKEN: "test",
          SNIP_CAPTURE_ENV_FILE: join(tmpdir(), "snip-no-such.env"),
          ALLOW_PRIVATE_URLS: "true",
          POLL_SECONDS: "1",
        },
      })
      const exit = await new Promise<number | null>((resolve) => agent!.once("exit", (code) => resolve(code)))
      assert.equal(exit, 0, "the agent winds down on its own")
      assert.deepEqual(saved.pages, ["/"], "the page in flight was finished, not cut off")
      assert.deepEqual(saved.paused, [{ release: true, queue: [`${base}b`, `${base}c`] }], "the crawl was handed back")
      assert.deepEqual({ failed: saved.failed, completed: saved.completed }, { failed: 0, completed: 0 })
    })
  } finally {
    agent?.kill("SIGKILL")
    await new Promise<void>((resolve) => worker.close(() => resolve()))
  }
})

test("a page that came out blank and a page taller than its shot are flagged on the page; real minimal pages are not", { timeout: 300_000 }, async () => {
  const pages: Record<string, string> = {
    // Nothing rendered: the app's script is missing, or there is no app at all.
    "/blank-missing": `<!doctype html><title>Missing script</title><body style="background: #f4f4f2"><div id="root"></div><script src="/missing.js"></script>`,
    "/blank-empty": `<!doctype html><title>Empty</title><body style="background: #f4f4f2">`,
    // Small but real: text on a plain page, with or without a file that failed to load.
    "/hello": `<!doctype html><title>Hello</title><body style="background: #f4f4f2"><p>Hello</p>`,
    "/hello-missing": `<!doctype html><title>Hello missing</title><body style="background: #f4f4f2"><p>Hello</p><script src="/missing.js"></script>`,
    "/tall": `<!doctype html><title>Tall</title><body style="margin: 0"><div style="height: 16500px; background: linear-gradient(red, blue)"></div>`,
  }
  await withServer((req, res) => {
    const body = pages[req.url!]
    res.writeHead(body ? 200 : req.url === "/missing.js" ? 404 : 200, { "content-type": "text/html" })
    res.end(body ?? plain("Home", `<nav>${Object.keys(pages).map((p) => `<a href="${p}">${p}</a>`).join(" ")}</nav>`))
  }, async (base) => {
    const browser = await launch()
    try {
      const warned = new Map<string, PageUpload["warnings"]>()
      const api = {
        control: async () => null,
        progress: async () => {},
        upload: async (key: string) => key,
        addPage: async (_id: string, page: PageUpload) => { warned.set(page.path, page.warnings) },
        complete: async () => {},
      }
      await captureJob(browser, api as never, { id: "warn", url: base, mode: "crawl", maxPages: 6, attempt, resume: null, options: null, features: [] } as unknown as Job)
      assert.deepEqual(Object.fromEntries(warned), {
        "/": undefined,
        "/blank-missing": ["blank"],
        "/blank-empty": ["blank"],
        "/hello": undefined,
        "/hello-missing": undefined,
        "/tall": ["truncated"],
      })
    } finally {
      await closeRenderer()
      await browser.close()
    }
  })
})
