import { test } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { chromium, type Browser } from "playwright"
import type { CrawlState, Job, PageUpload } from "../../web/shared/types"
import { diagnoseCaptureError } from "../../web/shared/capture-errors"
import { captureJob } from "../src/capture"
import { CaptureRuntime } from "../src/runtime"
import { closeRenderer } from "../src/sheet"

// A page that hangs, drags on or never answers is given up on at the page deadline, closed, counted as failed, and the crawl
// goes on with the next page. Each case below is a way a real page gets stuck; the deadline is made short so a case takes seconds.

const launch = () => chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined })
const attempt = "a".repeat(32)
const DEADLINE_MS = 15_000 // longer than a healthy minimal page takes (about 7 s, most of it fixed waits), far shorter than the stuck ones

const plain = (title: string) => `<!doctype html><title>${title}</title><body><h1>${title}</h1><p>One screen of copy.</p></body>`
const body = (head: string, sections = 5) => `<!doctype html><title>Stuck</title><style>body{margin:0}section{height:700px}</style>${head}<body>${Array.from({ length: sections }, (_, i) => `<section><h2>Section ${i}</h2></section>`).join("")}</body>`

/** The ways a page gets stuck, as served at /stuck. `silent` never answers the document request at all. */
const STUCK = {
  // Its script spins as soon as the page has loaded: every call into the page (page.evaluate has no timeout) waits for a thread that never frees up.
  blocked: body(`<script>addEventListener("load",()=>setTimeout(()=>{for(;;);},200))</script>`),
  silent: null,
  // Twenty stylesheets added after load whose requests are never answered: each is fetched in turn from outside the page, 15 s apiece (5 minutes in all).
  sheets: body(`<script>addEventListener("load",()=>setTimeout(()=>{for(let i=0;i<20;i++){const l=document.createElement("link");l.rel="stylesheet";l.href="/hang-"+i+".css";document.head.appendChild(l)}},100))</script>`),
  // Infinite scroll whose handler keeps the thread busy: the scroll recording always has more page to go through, and every step is slow.
  endless: body(`<script>addEventListener("scroll",()=>{const end=Date.now()+80;while(Date.now()<end);if(scrollY+innerHeight>document.documentElement.scrollHeight-1500){for(let i=0;i<10;i++){const s=document.createElement("section");s.innerHTML="<h2>More</h2>";document.body.appendChild(s)}}})</script>`),
} as const

async function withServer<T>(handler: http.RequestListener, fn: (base: string) => Promise<T>) {
  const server = http.createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    return await fn(`http://127.0.0.1:${(server.address() as { port: number }).port}/`)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

const site = (kind: keyof typeof STUCK): http.RequestListener => (req, res) => {
  if (req.url === "/ok") {
    res.writeHead(200, { "content-type": "text/html" })
    return void res.end(plain("Healthy"))
  }
  if (req.url === "/stuck" && STUCK[kind] !== null) {
    res.writeHead(200, { "content-type": "text/html" })
    return void res.end(STUCK[kind])
  }
  // /stuck of `silent`, and every /hang-N.css: accepted and never answered.
  if (req.url === "/stuck" || req.url?.startsWith("/hang-")) return
  res.writeHead(404)
  res.end()
}

/** A crawl in progress that has /stuck and then /ok left to capture. */
const resumeAt = (base: string): CrawlState => ({ version: 1, queue: [`${base}stuck`, `${base}ok`], visited: [], captured: 0, failures: 0, navLinksQueued: true, hoverSeen: [], meta: null, tokens: null })
const crawl = (base: string, extra: Partial<Job> = {}) => ({ id: "deadline", url: base, mode: "crawl", maxPages: 5, attempt, resume: resumeAt(base), options: null, features: [], ...extra }) as unknown as Job

test("a stuck page is given up on at the deadline and closed, and the crawl captures the page after it", { timeout: 180_000 }, async () => {
  const previous = process.env.ALLOW_PRIVATE_URLS
  process.env.ALLOW_PRIVATE_URLS = "true"
  const lines: string[] = []
  const log = console.log
  console.log = (...a: unknown[]) => { lines.push(a.join(" ")) }
  try {
    const cases = await Promise.all((Object.keys(STUCK) as (keyof typeof STUCK)[]).map((kind) => withServer(site(kind), async (base) => {
      const browser = await launch()
      try {
        const started: Record<string, number> = {}
        const saved: PageUpload[] = []
        const uploads: string[] = []
        let pagesOpenAtNextPage = -1
        const api = {
          control: async () => null,
          progress: async (_id: string, message: string) => {
            const path = message.split(": ")[1]!
            started[path] = Date.now()
            // The next page starts only once the stuck one is gone: nothing of it may still be open in the browser.
            if (path === "/ok") pagesOpenAtNextPage = browser.contexts().flatMap((context) => context.pages()).length
          },
          upload: async (key: string) => { uploads.push(key); return key },
          addPage: async (_id: string, page: PageUpload) => { saved.push(page) },
          pause: async () => false,
          complete: async () => {},
        }
        await captureJob(browser, api as never, crawl(base), undefined, undefined, { pageDeadlineMs: DEADLINE_MS })
        return { kind, base, started, saved, uploads, pagesOpenAtNextPage }
      } finally {
        await closeRenderer()
        await browser.close()
      }
    })))

    for (const { kind, base, started, saved, uploads, pagesOpenAtNextPage } of cases) {
      const spent = started["/ok"]! - started["/stuck"]!
      assert.ok(spent >= DEADLINE_MS - 200, `${kind}: the page was given the whole deadline, took ${spent} ms`)
      assert.ok(spent < DEADLINE_MS + 6_000, `${kind}: the page was given up on at the deadline, took ${spent} ms`)
      assert.equal(pagesOpenAtNextPage, 0, `${kind}: the stuck page and its mobile page were closed before the next page began`)
      assert.deepEqual(saved.map((p) => p.path), ["/ok"], `${kind}: the page after it was captured, and the stuck one was not saved`)
      assert.equal(uploads.some((key) => key.includes("/p0/")), false, `${kind}: nothing of the stuck page (ord 0) was uploaded`)
      assert.deepEqual({ captured: saved[0]!.state!.captured, failures: saved[0]!.state!.failures, queue: saved[0]!.state!.queue }, { captured: 1, failures: 1, queue: [] }, `${kind}: the stuck page is counted as failed`)
      assert.deepEqual(saved[0]!.state!.visited, [`${base}stuck`, `${base}ok`], `${kind}: and stays visited, so it is not queued again`)
      const reported = lines.filter((l) => l.includes(`✗ ${base}stuck:`))
      assert.equal(reported.length, 1, `${kind}: the failure is reported once, got ${JSON.stringify(reported)}`)
      assert.ok(reported[0]!.endsWith(`Page took too long to capture: Timeout ${DEADLINE_MS}ms exceeded.`), `${kind}: with a reason a person can read, got ${reported[0]}`)
    }
  } finally {
    console.log = log
    if (previous === undefined) delete process.env.ALLOW_PRIVATE_URLS
    else process.env.ALLOW_PRIVATE_URLS = previous
  }
})

test("a single page that hangs fails the capture with a reason the app already explains", { timeout: 120_000 }, async () => {
  const previous = process.env.ALLOW_PRIVATE_URLS
  process.env.ALLOW_PRIVATE_URLS = "true"
  const log = console.log
  console.log = () => {}
  try {
    await withServer(site("blocked"), async (base) => {
      const browser = await launch()
      try {
        const saved: string[] = []
        const api = { control: async () => null, progress: async () => {}, upload: async (key: string) => key, addPage: async (_id: string, page: PageUpload) => { saved.push(page.path) }, complete: async () => {} }
        const started = Date.now()
        const error = await captureJob(browser, api as never, { id: "single", url: `${base}stuck`, mode: "single", maxPages: 1, attempt, resume: null, options: null, features: [] } as unknown as Job, undefined, undefined, { pageDeadlineMs: 5_000 }).then(() => null, (e: Error) => e)
        assert.ok(error, "the capture failed")
        assert.ok(Date.now() - started < 5_000 + 6_000, "within the deadline, not the 45 s a load may take or the 5 minutes of the watchdog")
        assert.equal(error.message, "Page took too long to capture: Timeout 5000ms exceeded.")
        assert.match(diagnoseCaptureError(error.message)!.summary, /didn't respond in time/, "the card explains it in its own words")
        assert.deepEqual(saved, [])
      } finally {
        await closeRenderer()
        await browser.close()
      }
    })
  } finally {
    console.log = log
    if (previous === undefined) delete process.env.ALLOW_PRIVATE_URLS
    else process.env.ALLOW_PRIVATE_URLS = previous
  }
})

test("a stuck page neither stops the lease heartbeat nor lets it lapse, and the job is not failed", { timeout: 180_000 }, async () => {
  const previous = process.env.ALLOW_PRIVATE_URLS
  process.env.ALLOW_PRIVATE_URLS = "true"
  const log = console.log
  console.log = () => {}
  try {
    await withServer(site("blocked"), async (base) => {
      const beats: number[] = []
      const events: string[] = []
      const saved: string[] = []
      let browser: Browser | undefined
      const job = crawl(base)
      const queue: (Job | null)[] = [job, null]
      const api = {
        claim: async () => queue.shift() ?? null,
        heartbeat: async () => { beats.push(Date.now()) },
        fail: async (_id: string, error: string) => { events.push(`fail: ${error}`) },
        control: async () => null,
        progress: async (_id: string, message: string) => { events.push(`${Date.now()} ${message}`) },
        upload: async (key: string) => key,
        addPage: async (_id: string, page: PageUpload) => { saved.push(page.path) },
        pause: async () => false,
        complete: async () => { events.push("complete") },
      }
      const HEARTBEAT_MS = 250
      const runtime = new CaptureRuntime({
        api,
        launch: async () => (browser = await launch()),
        capture: (b, j, signal, progress) => captureJob(b as never, api as never, j, signal, progress, { pageDeadlineMs: DEADLINE_MS }),
        status: () => {}, pollMs: 50, idleMs: 50, once: true, heartbeatMs: HEARTBEAT_MS,
      })
      try {
        await runtime.run()
      } finally {
        await closeRenderer()
        await browser?.close()
      }
      assert.deepEqual(saved, ["/ok"], "the page after the stuck one was captured")
      assert.deepEqual(events.filter((e) => !/^\d+ Capturing/.test(e)), ["complete"], "the job completed: it was not failed")

      // The Worker takes an agent for gone after three missed beats. Through the stuck page and past it, beats kept coming.
      const [stuck, ok] = events.filter((e) => /^\d+ Capturing/.test(e)).map((e) => Number(e.split(" ")[0]))
      assert.ok(ok! - stuck! >= DEADLINE_MS - 200, "the stuck page was given its whole deadline")
      const during = beats.filter((t) => t >= stuck! && t <= ok!).length
      assert.ok(during >= (DEADLINE_MS / HEARTBEAT_MS) * 0.6, `heartbeats kept beating while the page hung, got ${during}`)
      const longestGap = Math.max(...beats.slice(1).map((t, i) => t - beats[i]!))
      assert.ok(longestGap < HEARTBEAT_MS * 8, `no lapse in the beat from the first to the last, longest gap ${longestGap} ms`)

      // And once the capture is over they stop: nothing keeps the lease alive after it.
      const last = beats.length
      await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_MS * 4))
      assert.equal(beats.length, last, "no beats after the job ended")
    })
  } finally {
    console.log = log
    if (previous === undefined) delete process.env.ALLOW_PRIVATE_URLS
    else process.env.ALLOW_PRIVATE_URLS = previous
  }
})
