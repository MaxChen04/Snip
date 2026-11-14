import { test } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { chromium } from "playwright"
import type { Job, JobComplete, PageUpload } from "../../web/shared/types"
import { captureJob } from "../src/capture"
import { closeRenderer } from "../src/sheet"

const attempt = "a".repeat(32)
const launch = () => chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined })
const html = (title: string, links = "") => `<!doctype html><title>${title}</title><body><h1>${title}</h1>${links}</body>`

async function withSite(run: (base: string, requested: string[]) => Promise<void>) {
  const previous = process.env.ALLOW_PRIVATE_URLS
  process.env.ALLOW_PRIVATE_URLS = "true"
  const requested: string[] = []
  let base = ""
  const server = http.createServer((req, res) => {
    const path = req.url!
    requested.push(path)
    if (path === "/sitemap.xml") {
      res.writeHead(200, { "content-type": "application/xml" })
      return res.end(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${base}healthy</loc></url></urlset>`)
    }
    const status = Number(path.match(/^\/error\/(\d+)$/)?.[1] ?? 200)
    res.writeHead(status, { "content-type": "text/html" })
    res.end(status >= 400 ? html(`HTTP ${status}`, `<a href="/healthy">Healthy page</a>`) : html(path === "/healthy" ? "Healthy" : "Home", `<nav><a href="/error/404">Missing</a><a href="/error/503">Unavailable</a><a href="/healthy">Healthy page</a></nav>`))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`
  try {
    await run(base, requested)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    if (previous === undefined) delete process.env.ALLOW_PRIVATE_URLS
    else process.env.ALLOW_PRIVATE_URLS = previous
  }
}

function recordingApi() {
  const saved = { pages: [] as PageUpload[], uploads: [] as string[], completed: null as JobComplete | null }
  const api = {
    control: async () => null,
    progress: async () => {},
    upload: async (key: string) => { saved.uploads.push(key); return key },
    addPage: async (_id: string, page: PageUpload) => { saved.pages.push(page) },
    complete: async (_id: string, complete: JobComplete) => { saved.completed = complete },
  }
  return { saved, api }
}

test("a root HTTP error fails single-page and crawl captures before saving or following sitemap links", { timeout: 120_000 }, async (t) => {
  await withSite(async (base, requested) => {
    const browser = await launch()
    try {
      for (const mode of ["single", "crawl"] as const) for (const status of [403, 500]) {
        await t.test(`${mode}: HTTP ${status}`, async () => {
          requested.length = 0
          const { api, saved } = recordingApi()
          const job = { id: "http-error", url: `${base}error/${status}`, mode, maxPages: 5, attempt, resume: null, options: null, features: [] } as unknown as Job
          await assert.rejects(captureJob(browser, api as never, job), { message: `The site returned HTTP ${status} for the requested page.` })
          assert.deepEqual(saved, { pages: [], uploads: [], completed: null }, "no error-page files, saved page, or successful completion")
          assert.ok(requested.includes(`/error/${status}`), "the requested page was actually fetched")
          assert.ok(!requested.includes("/healthy"), "a successful sitemap page cannot disguise the failed root")
        })
      }
    } finally {
      await closeRenderer()
      await browser.close()
    }
  })
})

test("a healthy crawl skips HTTP-error child links and keeps its successful pages", { timeout: 120_000 }, async () => {
  await withSite(async (base, requested) => {
    const browser = await launch()
    try {
      const { api, saved } = recordingApi()
      await captureJob(browser, api as never, { id: "http-children", url: base, mode: "crawl", maxPages: 5, attempt, resume: null, options: null, features: [] } as unknown as Job)
      assert.ok(requested.includes("/error/404") && requested.includes("/error/503"), "both kinds of child error were visited")
      assert.deepEqual(saved.pages.map((page) => page.path).sort(), ["/", "/healthy"])
      assert.equal(saved.completed?.title, "Home")
      assert.ok(saved.pages.every((page) => page.title !== "HTTP 404" && page.title !== "HTTP 503"))
    } finally {
      await closeRenderer()
      await browser.close()
    }
  })
})
