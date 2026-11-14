import { test } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { chromium } from "playwright"
import type { CrawlState, Job, JobComplete } from "../../web/shared/types"
import { captureJob } from "../src/capture"

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64")

test("the icon is saved beside the first page, kept in the pause checkpoint, reused on resume, and holds up completion only until its fetch gives up", { timeout: 240_000 }, async () => {
  const previous = process.env.ALLOW_PRIVATE_URLS
  process.env.ALLOW_PRIVATE_URLS = "true"
  const hits = { icon: 0, hang: 0 }
  const page = (title: string, icon: string, links = "") => `<!doctype html><title>${title}</title><link rel="icon" href="${icon}"><body><h1>${title}</h1>${links}</body>`
  const server = http.createServer((req, res) => {
    if (req.url === "/icon.png") { hits.icon++; res.writeHead(200, { "content-type": "image/png" }); return res.end(PNG) }
    if (req.url === "/hang.ico") { hits.hang++; return } // accepted, never answered
    res.writeHead(200, { "content-type": "text/html" })
    res.end(req.url === "/hang" ? page("Hanging icon", "/hang.ico") : req.url === "/b" ? page("Page B", "/icon.png") : page("Page A", "/icon.png", `<nav><a href="/b">B</a></nav>`))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined })
  const attempt = "a".repeat(32)
  const prefix = `refs/icons/${attempt}`
  const key = `${prefix}/icon.png`

  // Only the "icon" feature: no sections, clips or other scheme, so each capture is quick.
  const run = async (job: Partial<Job>, controls: ("pause" | null)[] = []) => {
    const seen = { uploads: [] as string[], pageAt: 0, complete: null as { favicon: string | null; at: number } | null, paused: null as CrawlState | null }
    const api = {
      control: async () => controls.shift() ?? null,
      progress: async () => {},
      upload: async (k: string) => { seen.uploads.push(k); return k },
      addPage: async () => { seen.pageAt = Date.now() },
      complete: async (_id: string, c: JobComplete) => { seen.complete = { favicon: c.favicon, at: Date.now() } },
      pause: async (_id: string, state: CrawlState) => { seen.paused = state; return true },
    }
    await captureJob(browser, api as never, { id: "icons", url: base, mode: "single", maxPages: 1, attempt, resume: null, options: null, features: ["icon"], ...job })
    return seen
  }
  const checkpoint = (favicon: string): CrawlState => ({ version: 1, queue: [`${base}b`], visited: [base], captured: 1, failures: 0, navLinksQueued: true, hoverSeen: [], meta: { title: "Page A", description: null, favicon }, tokens: null })

  try {
    // Saved with the first page; a pause after it hands the key to the checkpoint, not the URL.
    const first = await run({ mode: "crawl", maxPages: 2 }, [null, "pause"])
    assert.deepEqual(first.uploads.filter((k) => k.endsWith("icon.png")), [key])
    assert.equal(first.paused!.meta!.favicon, key)
    assert.equal(hits.icon, 1)

    // Resumed from that checkpoint: the saved key is reused and the icon is not fetched again.
    const resumed = await run({ mode: "crawl", maxPages: 2, resume: checkpoint(key) })
    assert.equal(resumed.complete!.favicon, key)
    assert.deepEqual(resumed.uploads.filter((k) => k.endsWith("icon.png")), [])
    assert.equal(hits.icon, 1, "no second fetch")

    // Resumed from a checkpoint that only has the URL (the icon had not landed when it paused): fetched once, then kept.
    const retried = await run({ mode: "crawl", maxPages: 2, resume: checkpoint(`${base}icon.png`) })
    assert.equal(retried.complete!.favicon, key)
    assert.equal(hits.icon, 2)

    // An icon that never answers: its fetch starts with the first page, so completion waits out only what is left of
    // the fetch's ten-second timeout, not a whole one started at the end.
    const hung = await run({ url: `${base}hang` })
    assert.equal(hits.hang, 1, "the fetch did start")
    assert.ok(hung.complete!.at - hung.pageAt < 10_000, `completion waited ${hung.complete!.at - hung.pageAt}ms after the last page`)
    assert.equal(hung.complete!.favicon, `${base}hang.ico`, "unsaved, so the checkpoint and completion still carry the URL")
  } finally {
    await browser.close()
    await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) })
    if (previous === undefined) delete process.env.ALLOW_PRIVATE_URLS
    else process.env.ALLOW_PRIVATE_URLS = previous
  }
})
