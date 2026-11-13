import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { chromium, type Browser } from "playwright"
import type { CrawlState, Job, PageUpload } from "../../web/shared/types"
import { diagnoseCaptureError } from "../../web/shared/capture-errors"
import { captureJob, loadForTest } from "../src/capture"
import { CaptureRuntime } from "../src/runtime"
import { closeRenderer } from "../src/sheet"

// A page that finishes no step for the stall window is given up on, closed and counted as failed, and the crawl goes on with the
// next page; a page that keeps finishing steps is left alone however long it takes. Each stuck case below is a way a real page
// gets stuck. The stall window is made short so a case takes seconds.

const launch = () => chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined })
const attempt = "a".repeat(32)
// Longer than the page waits on a network that never goes idle (8 s), far shorter than the stuck ones would hang. A healthy minimal page
// finishes a step every second or two.
const STALL_MS = 12_000

const plain = (title: string) => `<!doctype html><title>${title}</title><body><h1>${title}</h1><p>One screen of copy.</p></body>`
const body = (head: string, sections = 1) => `<!doctype html><title>Stuck</title><style>body{margin:0}section{height:700px}</style>${head}<body>${Array.from({ length: sections }, (_, i) => `<section><h2>Section ${i}</h2></section>`).join("")}</body>`
const lateFont = (origin: string) => `<script>addEventListener("load",()=>setTimeout(()=>{const s=document.createElement("style");s.textContent='@font-face{font-family:Late;src:url(${origin}hang.woff2) format("woff2")}';document.head.appendChild(s);const p=document.createElement("p");p.style.fontFamily="Late,sans-serif";p.textContent="late text";document.body.appendChild(p)},100))</script>`

/** The ways a page gets stuck, as served at /stuck. `silent` never answers the document request at all. */
const STUCK = {
  // Its script spins as soon as the page has loaded: every call into the page (page.evaluate has no timeout) waits for a thread that never frees up.
  blocked: () => body(`<script>addEventListener("load",()=>setTimeout(()=>{for(;;);},200))</script>`),
  silent: () => null,
  // Twenty stylesheets added after load whose requests are never answered: each is fetched in turn from outside the page, 15 s apiece (5 minutes in all).
  sheets: () => body(`<script>addEventListener("load",()=>setTimeout(()=>{for(let i=0;i<20;i++){const l=document.createElement("link");l.rel="stylesheet";l.href="/hang-"+i+".css";document.head.appendChild(l)}},100))</script>`),
  // A web font that starts loading after the page has loaded and is never answered: Playwright's screenshot waits for it.
  fontLate: (origin: string) => body(lateFont(origin)),
} as const

/** A page that is slow but never stuck: every scroll step costs 400 ms of script, and there are scroll steps for tens of seconds. */
const slowBody = () => body(`<script>addEventListener("scroll",()=>{const end=Date.now()+400;while(Date.now()<end);})</script>`, 6)

async function withServer<T>(handler: (origin: string) => http.RequestListener, fn: (base: string) => Promise<T>) {
  let origin = ""
  const server = http.createServer((req, res) => handler(origin)(req, res))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}/`
  try {
    return await fn(origin)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

const site = (kind: keyof typeof STUCK | "slow") => (origin: string): http.RequestListener => (req, res) => {
  const html = (page: string) => { res.writeHead(200, { "content-type": "text/html" }); res.end(page) }
  if (req.url === "/ok") return html(plain("Healthy"))
  if (req.url === "/slow" && kind === "slow") return html(slowBody())
  if (req.url === "/stuck" && kind !== "slow") {
    const page = STUCK[kind](origin)
    if (page !== null) return html(page)
  }
  // /stuck of `silent`, the late font and every /hang-N.css: accepted and never answered.
  if (req.url === "/stuck" || req.url?.startsWith("/hang")) return
  res.writeHead(404)
  res.end()
}

/** A crawl in progress that has /stuck and then /ok left to capture. */
const resumeAt = (base: string): CrawlState => ({ version: 1, queue: [`${base}stuck`, `${base}ok`], visited: [], captured: 0, failures: 0, navLinksQueued: true, hoverSeen: [], meta: null, tokens: null })
const crawl = (base: string, extra: Partial<Job> = {}) => ({ id: "deadline", url: base, mode: "crawl", maxPages: 5, attempt, resume: resumeAt(base), options: null, features: [], ...extra }) as unknown as Job

// The tests below run side by side. Private addresses are allowed and the agent's log lines are collected for all of them (each
// page has a base URL of its own, so a line says whose it is).
const lines: string[] = []
const log = console.log
const previousAllow = process.env.ALLOW_PRIVATE_URLS
before(() => {
  process.env.ALLOW_PRIVATE_URLS = "true"
  console.log = (...a: unknown[]) => { lines.push(a.join(" ")) }
})
after(() => {
  console.log = log
  if (previousAllow === undefined) delete process.env.ALLOW_PRIVATE_URLS
  else process.env.ALLOW_PRIVATE_URLS = previousAllow
})
const quietly = <T>(fn: () => Promise<T>) => fn()

describe("the page deadline", { concurrency: true }, () => {

  test("a stuck page is given up on once no step finishes for the stall window, and closed, and the crawl captures the page after it", { timeout: 240_000 }, async () => {
    await quietly(async () => {
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
          await captureJob(browser, api as never, crawl(base), undefined, undefined, { pageStallMs: STALL_MS })
          return { kind, base, started, saved, uploads, pagesOpenAtNextPage }
        } finally {
          await closeRenderer()
          await browser.close()
        }
      })))

      for (const { kind, base, started, saved, uploads, pagesOpenAtNextPage } of cases) {
        // The page hangs somewhere on its way (the late font only once the page has loaded and its first steps are done): from there, a full window.
        const spent = started["/ok"]! - started["/stuck"]!
        assert.ok(spent >= STALL_MS - 200, `${kind}: the page was given a whole stall window, took ${spent} ms`)
        // A page that hangs at its screenshot has waited out the network-idle wait (8 s) and the fonts cap (5 s) on the way.
        assert.ok(spent < STALL_MS + 45_000, `${kind}: and given up on soon after it, took ${spent} ms`)
        assert.equal(pagesOpenAtNextPage, 0, `${kind}: the stuck page and its mobile page were closed before the next page began`)
        assert.deepEqual(saved.map((p) => p.path), ["/ok"], `${kind}: the page after it was captured, and the stuck one was not saved`)
        assert.equal(uploads.some((key) => key.includes("/p0/")), false, `${kind}: nothing of the stuck page (ord 0) was uploaded`)
        assert.deepEqual({ captured: saved[0]!.state!.captured, failures: saved[0]!.state!.failures, queue: saved[0]!.state!.queue }, { captured: 1, failures: 1, queue: [] }, `${kind}: the stuck page is counted as failed`)
        assert.deepEqual(saved[0]!.state!.visited, [`${base}stuck`, `${base}ok`], `${kind}: and stays visited, so it is not queued again`)
        const reported = lines.filter((l) => l.includes(`✗ ${base}stuck:`))
        assert.equal(reported.length, 1, `${kind}: the failure is reported once, got ${JSON.stringify(reported)}`)
        assert.ok(reported[0]!.endsWith(`Page stopped making progress: Timeout ${STALL_MS}ms exceeded.`), `${kind}: with a reason a person can read, got ${reported[0]}`)
      }
    })
  })

  test("a slow page that keeps finishing steps is not given up on, however many stall windows it takes", { timeout: 240_000 }, async () => {
    const stall = 10_000
    await quietly(async () => {
      await withServer(site("slow"), async (base) => {
        const browser = await launch()
        try {
          const saved: PageUpload[] = []
          let reported = 0
          const api = { control: async () => null, progress: async () => {}, upload: async (key: string) => key, addPage: async (_id: string, page: PageUpload) => { saved.push(page) }, complete: async () => {} }
          const started = Date.now()
          await captureJob(browser, api as never, { id: "slow", url: `${base}slow`, mode: "single", maxPages: 1, attempt, resume: null, options: null, features: [] } as unknown as Job, undefined, () => { reported++ }, { pageStallMs: stall })
          const took = Date.now() - started
          assert.ok(took >= 3 * stall, `the page took several stall windows, ${took} ms`)
          assert.deepEqual(saved.map((p) => p.path), ["/slow"], "and was captured")
          assert.equal(saved[0]!.state?.failures ?? 0, 0)
          assert.equal(lines.some((l) => l.includes(`✗ ${base}`)), false, "with no failure reported")
          // Each finished step also tells the runtime the capture is moving, so its own watchdog does not take a long page for a hung one.
          assert.ok(reported > 100, `the steps were reported as progress, ${reported} times`)
        } finally {
          await closeRenderer()
          await browser.close()
        }
      })
    })
  })

  test("a single page that hangs fails the capture with a reason the app already explains", { timeout: 120_000 }, async () => {
    await quietly(async () => {
      await withServer(site("blocked"), async (base) => {
        const browser = await launch()
        try {
          const saved: string[] = []
          const api = { control: async () => null, progress: async () => {}, upload: async (key: string) => key, addPage: async (_id: string, page: PageUpload) => { saved.push(page.path) }, complete: async () => {} }
          const started = Date.now()
          const error = await captureJob(browser, api as never, { id: "single", url: `${base}stuck`, mode: "single", maxPages: 1, attempt, resume: null, options: null, features: [] } as unknown as Job, undefined, undefined, { pageStallMs: 5_000 }).then(() => null, (e: Error) => e)
          assert.ok(error, "the capture failed")
          assert.ok(Date.now() - started < 5_000 + 12_000, "within a stall window of the page hanging, not the 45 s a load may take or the minutes of the watchdog")
          assert.equal(error.message, "Page stopped making progress: Timeout 5000ms exceeded.")
          assert.match(diagnoseCaptureError(error.message)!.summary, /didn't respond in time/, "the card explains it in its own words")
          assert.deepEqual(saved, [])
        } finally {
          await closeRenderer()
          await browser.close()
        }
      })
    })
  })

  test("a font that is never answered after load costs the page seconds in its load, not for ever", { timeout: 120_000 }, async () => {
    await quietly(async () => {
      await withServer(site("fontLate"), async (base) => {
        const browser = await launch()
        try {
          const page = await (await browser.newContext()).newPage()
          let ticks = 0
          const started = Date.now()
          // document.fonts.ready never settles while the font loads; the load gives up on it after a few seconds.
          await Promise.race([
            loadForTest(page, `${base}stuck`, null, () => { ticks++ }),
            new Promise((_, reject) => setTimeout(() => reject(new Error("the load never returned")), 60_000)),
          ])
          const took = Date.now() - started
          assert.ok(took >= 5_000, `it did wait for the font first, ${took} ms`)
          assert.ok(took < 30_000, `and gave up on it, ${took} ms`)
          assert.ok(ticks > 0, "the steps that did finish were reported")
          assert.equal(await page.evaluate(() => 1), 1, "the page answers afterwards")
        } finally {
          await browser.close()
        }
      })
    })
  })

  test("a stuck page neither stops the lease heartbeat nor lets it lapse, and the job is not failed", { timeout: 180_000 }, async () => {
    await quietly(async () => {
      await withServer(site("blocked"), async (base) => {
        const beats: number[] = []
        const events: string[] = []
        const saved: string[] = []
        let browser: Browser | undefined
        const job = crawl(base)
        const queue: (Job | null)[] = [job, null]
        const stall = 8_000
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
          capture: (b, j, signal, progress) => captureJob(b as never, api as never, j, signal, progress, { pageStallMs: stall }),
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
        assert.ok(ok! - stuck! >= stall - 200, "the stuck page was given a whole stall window")
        const during = beats.filter((t) => t >= stuck! && t <= ok!).length
        assert.ok(during >= ((ok! - stuck!) / HEARTBEAT_MS) * 0.6, `heartbeats kept beating while the page hung, got ${during}`)
        const longestGap = Math.max(...beats.slice(1).map((t, i) => t - beats[i]!))
        assert.ok(longestGap < HEARTBEAT_MS * 8, `no lapse in the beat from the first to the last, longest gap ${longestGap} ms`)

        // And once the capture is over they stop: nothing keeps the lease alive after it.
        const last = beats.length
        await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_MS * 4))
        assert.equal(beats.length, last, "no beats after the job ended")
      })
    })
  })

})
