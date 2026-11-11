import { test } from "node:test"
import assert from "node:assert/strict"
import { Miniflare, convertV4MiniflareOptions } from "miniflare"
import { app } from "../worker/app"
import * as db from "../worker/db"
import { applyMigrations } from "./helpers/d1"
import type { CrawlState, PageUpload } from "../shared/types"
import { STOPPED_EMPTY, diagnoseCaptureError } from "../shared/capture-errors"

// Regression tests for capture-queue recovery bugs found by a code audit. Each asserts the CORRECT behaviour,
// so each fails until the matching bug is fixed.

const page = (id: string, attempt: string, ord: number): PageUpload => {
  const key = `refs/${id}/${attempt}/p${ord}/desktop.jpg`
  return { url: `https://example.com/${ord}`, path: `/${ord}`, title: `Page ${ord}`, ord,
    desktopKey: key, desktopThumbKey: key, desktopWidth: 100, desktopHeight: 100,
    mobileKey: null, mobileThumbKey: null, mobileWidth: null, mobileHeight: null,
    snapshotKey: null, stylesKey: null, tokens: null, animations: [] }
}

const state = (captured: number): CrawlState => ({
  version: 1, queue: ["https://example.com/next"], visited: ["https://example.com/"], captured, failures: 0, navLinksQueued: true,
  hoverSeen: ["nav a|Home"], meta: { title: "Example", description: "An example", favicon: null },
  tokens: { colors: [{ value: "#000", count: 3 }], fonts: [], fontSizes: [], spacing: [], radii: [], shadows: [], transitions: [], keyframes: [], cssVariables: {} },
})

const done = { title: null, description: null, favicon: null, coverKey: null, tokens: null }

async function setup() {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ["DB"], r2Buckets: ["FILES"] }))
  const database = await mf.getD1Database("DB") as unknown as D1Database
  const files = await mf.getR2Bucket("FILES") as unknown as R2Bucket
  await applyMigrations(database)
  const pending: Promise<unknown>[] = []
  const ctx = { waitUntil(p: Promise<unknown>) { pending.push(p) }, passThroughOnException() {} } as unknown as ExecutionContext
  const env = { DB: database, FILES: files, SESSION_SECRET: "test-secret", DEV_LOGIN: "max", CAPTURE_TOKEN: "test-token" } as unknown as Env
  /** Simulates an agent that died 40 minutes ago: its lease is older than STALE_MINUTES. */
  const makeStale = (id: string) => database.prepare("UPDATE refs SET claimed_at = ? WHERE id = ?").bind(new Date(Date.now() - 40 * 60_000).toISOString(), id).run()
  const row = (id: string) => database.prepare("SELECT status, capture_control, capture_attempt, capture_run, crawl_state, page_count, error FROM refs WHERE id = ?").bind(id).first<{
    status: string; capture_control: string | null; capture_attempt: string | null; capture_run: number; crawl_state: string | null; page_count: number; error: string | null }>()
  const pageCount = async (id: string) => (await database.prepare("SELECT count(*) AS n FROM pages WHERE reference_id = ?").bind(id).first<{ n: number }>())!.n
  /** Waits for background work (file cleanup) so it never outlives the test's storage. */
  const settle = async () => { await Promise.allSettled(pending) }
  const dispose = async () => { await settle(); await mf.dispose() }
  return { mf: { dispose }, database, files, ctx, env, makeStale, row, pageCount }
}

test("a resumed crawl whose agent dies keeps its pages when the stale lease is reclaimed", async () => {
  const { mf, database, makeStale, row, pageCount } = await setup()
  try {
    const ref = await db.createReference(database, { url: "https://example.com", mode: "crawl", maxPages: 5 })
    const first = (await db.claimJob(database))!
    assert.ok(await db.addPage(database, ref.id, first.attempt, page(ref.id, first.attempt, 0)))
    assert.equal(await db.requestPause(database, ref.id), true)
    assert.equal(await db.pauseJob(database, ref.id, first.attempt, state(1)), "paused")
    assert.equal(await db.resumeReference(database, ref.id), true)
    const resumed = (await db.claimJob(database))!
    assert.equal(resumed.attempt, first.attempt)
    assert.ok(await db.addPage(database, ref.id, resumed.attempt, page(ref.id, resumed.attempt, 1)))
    assert.equal(await pageCount(ref.id), 2)

    // The agent dies without finishing; its lease goes stale and the job is claimed again.
    await makeStale(ref.id)
    const again = await db.claimJob(database)
    assert.ok(again, "the abandoned capture is picked up again")
    assert.equal(again.attempt, first.attempt, "it resumes in the same file namespace, not from zero")
    assert.equal(await pageCount(ref.id), 2, "pages captured so far are kept")
    assert.equal((await db.getReference(database, ref.id))!.reference.pageCount, 2)
    assert.equal((await row(ref.id))!.page_count, 2)
  } finally {
    await mf.dispose()
  }
})

test("a stop requested on a capturing row whose agent is gone is honoured, and keeps the pages", async () => {
  const { mf, database, makeStale, row, pageCount } = await setup()
  try {
    const ref = await db.createReference(database, { url: "https://example.com", mode: "crawl", maxPages: 5 })
    const job = (await db.claimJob(database))!
    assert.ok(await db.addPage(database, ref.id, job.attempt, page(ref.id, job.attempt, 0)))
    assert.ok(await db.addPage(database, ref.id, job.attempt, page(ref.id, job.attempt, 1)))
    await makeStale(ref.id)

    assert.equal(await db.requestStop(database, ref.id), true)
    // Nobody is left to see the stop, so a later claim must apply it instead of restarting the crawl.
    const handedOut = await db.claimJob(database)
    assert.equal(handedOut, null, "a stopped capture is not handed out again")
    const after = (await row(ref.id))!
    assert.equal(after.status, "ready", "the stop settles the reference with what it has")
    assert.equal(await pageCount(ref.id), 2, "its pages are kept")
    assert.equal(after.page_count, 2)
  } finally {
    await mf.dispose()
  }
})

test("a pause requested on a capturing row whose agent is gone does not delete its pages", async () => {
  const { mf, database, makeStale, pageCount } = await setup()
  try {
    const ref = await db.createReference(database, { url: "https://example.com", mode: "crawl", maxPages: 5 })
    const job = (await db.claimJob(database))!
    assert.ok(await db.addPage(database, ref.id, job.attempt, page(ref.id, job.attempt, 0)))
    assert.ok(await db.addPage(database, ref.id, job.attempt, page(ref.id, job.attempt, 1)))
    await makeStale(ref.id)

    assert.equal(await db.requestPause(database, ref.id), true)
    await db.claimJob(database)
    assert.equal(await pageCount(ref.id), 2, "the pages survive the next claim")
    assert.equal((await db.getReference(database, ref.id))!.reference.pageCount, 2)
  } finally {
    await mf.dispose()
  }
})

test("a stop or pause left pending by a dead agent is applied by the next claim: stopped-empty without pages, paused with them", async () => {
  const { mf, database, makeStale, row, pageCount } = await setup()
  try {
    const empty = await db.createReference(database, { url: "https://empty.example", mode: "crawl", maxPages: 5 })
    assert.ok(await db.claimJob(database))
    assert.equal(await db.requestStop(database, empty.id), true)
    await makeStale(empty.id)
    assert.equal(await db.claimJob(database), null)
    const stopped = (await row(empty.id))!
    assert.equal(stopped.status, "failed")
    assert.equal(stopped.error, STOPPED_EMPTY)

    const ref = await db.createReference(database, { url: "https://example.com", mode: "crawl", maxPages: 5 })
    const job = (await db.claimJob(database))!
    assert.ok(await db.addPage(database, ref.id, job.attempt, page(ref.id, job.attempt, 0)))
    assert.equal(await db.requestPause(database, ref.id), true)
    await makeStale(ref.id)
    assert.equal(await db.claimJob(database), null, "a paused capture waits for the user")
    assert.equal((await db.getReference(database, ref.id))!.reference.status, "paused")

    // Resumed, it continues in the same files after the page it has.
    assert.equal(await db.resumeReference(database, ref.id), true)
    const resumed = (await db.claimJob(database))!
    assert.equal(resumed.attempt, job.attempt)
    assert.equal(resumed.resume?.captured, 1)
    assert.deepEqual(resumed.resume?.visited, ["https://example.com/0"])
    assert.equal(await pageCount(ref.id), 1)
  } finally {
    await mf.dispose()
  }
})

test("recapture is refused for capturing, queued and paused references, and allowed for ready and failed ones", async () => {
  const { mf, database, ctx, env, row, pageCount } = await setup()
  try {
    const recapture = (id: string) => app.request(`http://localhost/api/references/${id}/recapture`, { method: "POST", headers: { "content-type": "application/json" } }, env, ctx)

    // Capturing: the running agent's pages and lease must not be wiped.
    const capturing = await db.createReference(database, { url: "https://capturing.example", mode: "crawl" })
    const job = (await db.claimJob(database))!
    assert.ok(await db.addPage(database, capturing.id, job.attempt, page(capturing.id, job.attempt, 0)))
    const before = (await row(capturing.id))!
    assert.equal((await recapture(capturing.id)).status, 409)
    const after = (await row(capturing.id))!
    assert.equal(after.status, "capturing")
    assert.equal(after.capture_attempt, before.capture_attempt)
    assert.equal(after.capture_run, before.capture_run)
    assert.equal(await pageCount(capturing.id), 1)
    assert.equal(await db.setProgress(database, capturing.id, job.attempt, "still mine"), true, "the agent's lease survives")

    // Paused: the saved pages and checkpoint must survive.
    const paused = await db.createReference(database, { url: "https://paused.example", mode: "crawl" })
    const pjob = (await db.claimJob(database))!
    assert.equal(pjob.id, paused.id)
    assert.ok(await db.addPage(database, paused.id, pjob.attempt, page(paused.id, pjob.attempt, 0)))
    await db.requestPause(database, paused.id)
    assert.equal(await db.pauseJob(database, paused.id, pjob.attempt, state(1)), "paused")
    const pausedBefore = (await row(paused.id))!
    assert.ok(pausedBefore.crawl_state)
    assert.equal((await recapture(paused.id)).status, 409)
    const pausedAfter = (await row(paused.id))!
    assert.equal(pausedAfter.crawl_state, pausedBefore.crawl_state, "the checkpoint is untouched")
    assert.equal(pausedAfter.capture_run, pausedBefore.capture_run)
    assert.equal(pausedAfter.status, "queued")
    assert.equal(pausedAfter.capture_control, "paused")
    assert.equal(await pageCount(paused.id), 1)

    // Queued: a second recapture of an already waiting job is refused too.
    const queued = await db.createReference(database, { url: "https://queued.example", mode: "single" })
    const queuedBefore = (await row(queued.id))!
    assert.equal((await recapture(queued.id)).status, 409)
    assert.equal((await row(queued.id))!.capture_run, queuedBefore.capture_run)

    // Ready and failed can be recaptured.
    const ready = await db.createReference(database, { url: "https://ready.example", mode: "single" })
    await database.prepare("UPDATE refs SET status = 'ready' WHERE id = ?").bind(ready.id).run()
    assert.equal((await recapture(ready.id)).status, 200)
    assert.equal((await row(ready.id))!.status, "queued")
    const failed = await db.createReference(database, { url: "https://failed.example", mode: "single" })
    await database.prepare("UPDATE refs SET status = 'failed', error = 'boom' WHERE id = ?").bind(failed.id).run()
    assert.equal((await recapture(failed.id)).status, 200)
    assert.equal((await row(failed.id))!.status, "queued")
  } finally {
    await mf.dispose()
  }
})

test("listing by name pages through titles that are not Latin-1 without throwing, skipping or repeating", async () => {
  const { mf, database } = await setup()
  try {
    const titles = ["Alpha", "Café — guide", "Delta", "日本語", "Zed", "Ωmega 日本"]
    const ids: string[] = []
    for (const [i, title] of titles.entries()) {
      const ref = await db.createReference(database, { url: `https://site${i}.example`, mode: "single" })
      await database.prepare("UPDATE refs SET title = ? WHERE id = ?").bind(title, ref.id).run()
      ids.push(ref.id)
    }
    const everything = (await db.listReferences(database, { sort: "name", limit: 100 })).items.map((r) => r.id)
    assert.equal(everything.length, titles.length)

    for (const limit of [1, 2, 4]) {
      const seen: string[] = []
      let cursor: string | null = null
      let pages = 0
      do {
        const result: Awaited<ReturnType<typeof db.listReferences>> = await db.listReferences(database, { sort: "name", limit, cursor })
        seen.push(...result.items.map((r) => r.id))
        cursor = result.nextCursor
        assert.ok(++pages <= titles.length + 1, "paging terminates")
      } while (cursor)
      assert.deepEqual(seen, everything, `limit ${limit}: every row exactly once, in order`)
    }
  } finally {
    await mf.dispose()
  }
})

test("an agent upload whose R2 write fails leaves no capture_uploads pin behind", async () => {
  const { mf, database, files, ctx, env } = await setup()
  try {
    const ref = await db.createReference(database, { url: "https://example.com", mode: "single" })
    const job = (await db.claimJob(database))!
    const failingFiles = new Proxy(files, { get(target, name) {
      if (name === "put") return async () => { throw new Error("R2 put failed") }
      const value = Reflect.get(target, name, target)
      return typeof value === "function" ? value.bind(target) : value
    } })
    const key = `refs/${ref.id}/${job.attempt}/p0/desktop.jpg`
    let status: number | null = null
    try {
      status = (await app.request(`https://snip.test/agent/files/${key}`, { method: "PUT", body: "bytes",
        headers: { authorization: "Bearer test-token", "x-snip-capture-protocol": "3", "x-snip-capture-attempt": job.attempt } }, { ...env, FILES: failingFiles }, ctx)).status
    } catch { /* the failure may surface as a thrown error rather than a 5xx */ }
    assert.ok(status === null || status >= 500, `the failed write is not reported as success (got ${status})`)
    const pins = (await database.prepare("SELECT count(*) AS n FROM capture_uploads").first<{ n: number }>())!.n
    assert.equal(pins, 0, "no capture_uploads row remains for the failed upload")
  } finally {
    await mf.dispose()
  }
})

test("a capture whose agent keeps dying is failed after a few stale reclaims instead of retrying forever", async () => {
  const { mf, database, makeStale, row } = await setup()
  try {
    const ref = await db.createReference(database, { url: "https://example.com", mode: "single" })
    assert.ok(await db.claimJob(database))
    for (let reclaim = 1; reclaim <= 3; reclaim++) {
      await makeStale(ref.id)
      if (!(await db.claimJob(database))) break // a budget of fewer than 3 reclaims is also fine
    }
    await makeStale(ref.id)
    assert.equal(await db.claimJob(database), null, "the budget is spent: no more claims")
    const after = (await row(ref.id))!
    assert.equal(after.status, "failed")
    assert.ok(after.error, "the failure carries an error message")
    const again = await db.claimJob(database)
    assert.equal(again, null)
    assert.ok(diagnoseCaptureError(after.error), "the error is one the app explains")

    // A Recapture starts the budget over.
    await db.requeueReference(database, ref.id)
    assert.ok(await db.claimJob(database))
    await makeStale(ref.id)
    assert.ok(await db.claimJob(database))
  } finally {
    await mf.dispose()
  }
})
