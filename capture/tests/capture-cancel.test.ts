import assert from "node:assert/strict"
import { test } from "node:test"
import { readdir, readFile } from "node:fs/promises"
import http from "node:http"
import { setTimeout as delay } from "node:timers/promises"
import { chromium, type BrowserContextOptions } from "playwright"
import { Miniflare, convertV4MiniflareOptions } from "miniflare"
import { app } from "../../web/worker/app"
import * as db from "../../web/worker/db"
import { STOPPED_EMPTY } from "../../web/shared/capture-errors"
import { SnipApi, JobGoneError } from "../src/api"
import { captureJob } from "../src/capture"
import { renderer } from "../src/sheet"

// Real HTTP -> Worker/D1 -> lease polling -> Chromium. The fixture site never
// finishes its response, the separate video helper never finishes opening, or its encoder deliberately never resolves.
for (const [mode, stall] of [["single", "navigation"], ["crawl", "navigation"], ["single", "helper startup"], ["single", "encoding"]] as const) test(`Cancel interrupts ${mode} capture during stuck ${stall} and releases only its browser contexts`, { timeout: 30_000 }, async () => {
  const previous = process.env.ALLOW_PRIVATE_URLS
  process.env.ALLOW_PRIVATE_URLS = "true"
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ["DB"], r2Buckets: ["FILES"] }))
  const database = await mf.getD1Database("DB") as unknown as D1Database
  const files = await mf.getR2Bucket("FILES") as unknown as R2Bucket
  const migrations = new URL("../../web/migrations/", import.meta.url)
  for (const name of (await readdir(migrations)).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = await readFile(new URL(name, migrations), "utf8")
    await database.batch(sql.replace(/^--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean).map((s) => database.prepare(s)))
  }
  const env = { DB: database, FILES: files, DEV_LOGIN: "tester", SESSION_SECRET: "test-secret", CAPTURE_TOKEN: "test-token" } as Env
  const pending: Promise<unknown>[] = []
  const ctx = { waitUntil(p: Promise<unknown>) { pending.push(p) }, passThroughOnException() {} } as ExecutionContext
  const entered = Promise.withResolvers<void>()
  const outage = Promise.withResolvers<void>()
  let failNextControl = false
  let controls = 0
  let connections = 0
  const server = http.createServer(async (req, res) => {
    if (req.url === "/site") {
      connections++
      res.on("close", () => connections--)
      res.writeHead(200, { "content-type": "text/html" })
      if (stall !== "navigation") { res.end('<!doctype html><title>Encoder fixture</title><body style="height:3000px">Scroll this page</body>'); return }
      res.write("<!doctype html><title>Unfinished page</title><body>Loading")
      entered.resolve()
      return
    }
    if (!req.url?.startsWith("/agent/") && !req.url?.startsWith("/api/")) { res.writeHead(404).end(); return }
    if (req.url.endsWith("/control")) {
      controls++
      if (failNextControl) { failNextControl = false; res.writeHead(503).end(); outage.resolve(); return }
    }
    try {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = Buffer.concat(chunks)
      const response = await app.request(`http://localhost${req.url}`, {
        method: req.method, headers: req.headers as Record<string, string>, ...(body.length ? { body } : {}),
      }, env, ctx)
      res.writeHead(response.status, Object.fromEntries(response.headers))
      res.end(Buffer.from(await response.arrayBuffer()))
    } catch (error) { res.writeHead(500).end(String(error)) }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined })
  let running: Promise<unknown> | undefined
  try {
    const unrelated = await browser.newContext()
    if (stall === "encoding") {
      const helper = await renderer(browser)
      await helper.exposeFunction("captureEncoding", () => entered.resolve())
      await helper.evaluate(`window.snipVideo = {
          supported: async () => true,
          start: async () => {},
          add: async () => { await window.captureEncoding(); return new Promise(() => {}) },
          finish: async () => { throw new Error("The stuck encoder cannot finish") },
        }`)
    }
    if (stall === "helper startup") {
      // The helper is the only 800x600 context; its document is never answered, so it is still opening when Cancel lands.
      const newContext = browser.newContext.bind(browser)
      browser.newContext = async (options?: BrowserContextOptions) => {
        const ctx = await newContext(options)
        if (options?.viewport?.width !== 800 || options.viewport.height !== 600) return ctx
        const newPage = ctx.newPage.bind(ctx)
        ctx.newPage = async () => {
          const page = await newPage()
          const route = page.route.bind(page)
          page.route = (async (url: string) => route(url, () => entered.resolve())) as typeof page.route
          return page
        }
        return ctx
      }
    }
    const ref = await db.createReference(database, { url: `${base}/site`, mode, maxPages: 5 })
    const api = new SnipApi(base, "test-token")
    const job = (await api.claim())!
    running = captureJob(browser, api, job).then(() => "completed", (error: unknown) => error)
    await entered.promise
    failNextControl = true
    await outage.promise
    assert.ok(browser.contexts().length > 1, "a transient control failure does not cancel the scrape")
    const start = performance.now()
    const response = await fetch(`${base}/api/references/${ref.id}/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ run: ref.captureRun }) })
    assert.equal(response.status, 200)
    assert.equal((await response.json() as { error: string }).error, STOPPED_EMPTY)
    let timeout: ReturnType<typeof setTimeout> | undefined
    const result = await Promise.race([running, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error("Cancel did not stop the capture within five seconds")), 5000)
    })]).finally(() => clearTimeout(timeout))
    assert.ok(result instanceof JobGoneError, String(result))
    assert.ok(performance.now() - start < 5000, "cancellation does not wait for navigation or the page deadline")
    assert.deepEqual(browser.contexts(), [unrelated], "only this job's contexts were closed")
    assert.equal(connections, 0, "the hanging page's connections were closed")
    assert.equal(await db.claimJob(database), null)
    await assert.rejects(api.progress(ref.id, "late progress"), JobGoneError)
    await assert.rejects(api.upload(`refs/${ref.id}/${job.attempt}/p0/late.jpg`, "late", "image/jpeg"), JobGoneError)
    await Promise.all(pending)
    assert.equal((await files.list()).objects.length, 0)
    const checked = controls
    await delay(1200)
    assert.equal(controls, checked, "the lease polling timer ends with the capture")
    assert.equal((await db.getReference(database, ref.id))!.reference.error, STOPPED_EMPTY)
  } finally {
    await browser.close()
    await running
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await Promise.allSettled(pending)
    await mf.dispose()
    if (previous === undefined) delete process.env.ALLOW_PRIVATE_URLS
    else process.env.ALLOW_PRIVATE_URLS = previous
  }
})

test("an in-flight capture upload can be aborted without waiting for the server", async () => {
  const entered = Promise.withResolvers<void>()
  const server = http.createServer((_req, _res) => entered.resolve())
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const api = new SnipApi(`http://127.0.0.1:${(server.address() as { port: number }).port}`, "test")
    const abort = new AbortController()
    const upload = api.upload("refs/test/attempt/p0/image.jpg", "fixture", "image/jpeg", abort.signal)
    const rejected = assert.rejects(upload, JobGoneError)
    await entered.promise
    abort.abort(new JobGoneError())
    await rejected
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
