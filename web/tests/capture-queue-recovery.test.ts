import { test } from "node:test"
import assert from "node:assert/strict"
import { Miniflare, convertV4MiniflareOptions } from "miniflare"
import { app } from "../worker/app"
import * as db from "../worker/db"
import { applyMigrations } from "./helpers/d1"
import type { CrawlState, Job, PageUpload } from "../shared/types"
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
  const row = (id: string) => database.prepare("SELECT status, capture_control, capture_attempt, capture_lease, capture_run, crawl_state, page_count, error FROM refs WHERE id = ?").bind(id).first<{
    status: string; capture_control: string | null; capture_attempt: string | null; capture_lease: string | null; capture_run: number; crawl_state: string | null; page_count: number; error: string | null }>()
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
    assert.ok(await db.addPage(database, ref.id, first.lease, page(ref.id, first.attempt, 0)))
    assert.equal(await db.requestPause(database, ref.id), true)
    assert.equal(await db.pauseJob(database, ref.id, first.lease, state(1)), "paused")
    assert.equal(await db.resumeReference(database, ref.id), true)
    const resumed = (await db.claimJob(database))!
    assert.equal(resumed.attempt, first.attempt)
    assert.ok(await db.addPage(database, ref.id, resumed.lease, page(ref.id, resumed.attempt, 1)))
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

test("a stop requested on a capturing row whose agent is gone settles at once and keeps the pages", async () => {
  const { mf, database, makeStale, row, pageCount } = await setup()
  try {
    const ref = await db.createReference(database, { url: "https://example.com", mode: "crawl", maxPages: 5 })
    const job = (await db.claimJob(database))!
    assert.ok(await db.addPage(database, ref.id, job.lease, page(ref.id, job.attempt, 0)))
    assert.ok(await db.addPage(database, ref.id, job.lease, page(ref.id, job.attempt, 1)))
    await makeStale(ref.id)

    assert.equal(await db.requestStop(database, ref.id), true)
    // Nobody is left to see the stop, so the request itself ends the capture: it does not wait for another agent to poll.
    const after = (await row(ref.id))!
    assert.deepEqual({ status: after.status, control: after.capture_control }, { status: "ready", control: null }, "the stop settles the reference with what it has")
    assert.equal(await pageCount(ref.id), 2, "its pages are kept")
    assert.equal(after.page_count, 2)
    assert.equal(await db.claimJob(database), null, "a stopped capture is not handed out again")
  } finally {
    await mf.dispose()
  }
})

test("a pause requested on a capturing row whose agent is gone parks it at once and does not delete its pages", async () => {
  const { mf, database, makeStale, pageCount } = await setup()
  try {
    const ref = await db.createReference(database, { url: "https://example.com", mode: "crawl", maxPages: 5 })
    const job = (await db.claimJob(database))!
    assert.ok(await db.addPage(database, ref.id, job.lease, page(ref.id, job.attempt, 0)))
    assert.ok(await db.addPage(database, ref.id, job.lease, page(ref.id, job.attempt, 1)))
    await makeStale(ref.id)

    assert.equal(await db.requestPause(database, ref.id), true)
    assert.equal((await db.getReference(database, ref.id))!.reference.status, "paused", "the pause takes effect without another agent")
    assert.equal(await db.claimJob(database), null, "a paused capture is not handed out")
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
    assert.ok(await db.addPage(database, ref.id, job.lease, page(ref.id, job.attempt, 0)))
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
    assert.ok(await db.addPage(database, capturing.id, job.lease, page(capturing.id, job.attempt, 0)))
    const before = (await row(capturing.id))!
    assert.equal((await recapture(capturing.id)).status, 409)
    const after = (await row(capturing.id))!
    assert.equal(after.status, "capturing")
    assert.equal(after.capture_attempt, before.capture_attempt)
    assert.equal(after.capture_run, before.capture_run)
    assert.equal(await pageCount(capturing.id), 1)
    assert.equal(await db.setProgress(database, capturing.id, job.lease, "still mine"), true, "the agent's lease survives")

    // Paused: the saved pages and checkpoint must survive.
    const paused = await db.createReference(database, { url: "https://paused.example", mode: "crawl" })
    const pjob = (await db.claimJob(database))!
    assert.equal(pjob.id, paused.id)
    assert.ok(await db.addPage(database, paused.id, pjob.lease, page(paused.id, pjob.attempt, 0)))
    await db.requestPause(database, paused.id)
    assert.equal(await db.pauseJob(database, paused.id, pjob.lease, state(1)), "paused")
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

    assert.equal((await recapture("0000000000000000")).status, 404)
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
        headers: { authorization: "Bearer test-token", "x-snip-capture-protocol": "4", "x-snip-capture-lease": job.lease } }, { ...env, FILES: failingFiles }, ctx)).status
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

test("a stale reclaim never hands the agent an ord, or a file prefix, that a saved page already has", async () => {
  const { mf, database, makeStale } = await setup()
  try {
    const ref = await db.createReference(database, { url: "https://example.com", mode: "crawl", maxPages: 9 })
    const first = (await db.claimJob(database))!
    assert.ok(await db.addPage(database, ref.id, first.lease, page(ref.id, first.attempt, 0)))
    await db.requestPause(database, ref.id)
    assert.equal(await db.pauseJob(database, ref.id, first.lease, state(1)), "paused")
    await db.resumeReference(database, ref.id)
    const resumed = (await db.claimJob(database))!
    // After the pause the agent visits three more URLs: two are skipped (ords 1 and 2), the third is saved as ord 3.
    assert.ok(await db.addPage(database, ref.id, resumed.lease, page(ref.id, resumed.attempt, 3)))
    await makeStale(ref.id)
    const again = (await db.claimJob(database))!
    assert.equal(again.resume!.captured, 2)
    // The agent gives its next page the ord `visited.length`.
    assert.ok(again.resume!.visited.length > 3, `next ord ${again.resume!.visited.length} would overwrite the page saved as 3`)
    assert.ok(again.resume!.visited.includes("https://example.com/3"))
  } finally {
    await mf.dispose()
  }
})

test("an agent that is stopping hands its crawl back to the queue, and the next claim resumes it", async () => {
  const { mf, database, row, pageCount } = await setup()
  try {
    const ref = await db.createReference(database, { url: "https://example.com", mode: "crawl", maxPages: 9 })
    const first = (await db.claimJob(database))!
    assert.ok(await db.addPage(database, ref.id, first.lease, page(ref.id, first.attempt, 0)))
    // Nobody asked for a pause: the agent itself is winding down.
    assert.equal(await db.pauseJob(database, ref.id, first.lease, state(1)), "changed", "an ordinary pause still needs a request")
    assert.equal(await db.pauseJob(database, ref.id, first.lease, state(1), true), "paused")
    assert.deepEqual({ status: (await row(ref.id))!.status, control: (await row(ref.id))!.capture_control }, { status: "queued", control: null })
    assert.equal(await db.setProgress(database, ref.id, first.lease, "late"), false, "the lease is released")
    const next = (await db.claimJob(database))!
    assert.equal(next.attempt, first.attempt)
    assert.deepEqual(next.resume!.queue, ["https://example.com/next"])
    assert.equal(next.resume!.captured, 1)
    assert.equal(await pageCount(ref.id), 1)

    // A stop the user asked for still wins over the hand-back.
    await db.requestStop(database, ref.id)
    assert.equal(await db.pauseJob(database, ref.id, next.lease, state(1), true), "changed")
  } finally {
    await mf.dispose()
  }
})

test("a crawl whose agent dies without ever pausing carries on from its last saved page", async () => {
  const { mf, database, makeStale, row } = await setup()
  try {
    const ref = await db.createReference(database, { url: "https://example.com", mode: "crawl", maxPages: 9 })
    const first = (await db.claimJob(database))!
    assert.ok(await db.addPage(database, ref.id, first.lease, { ...page(ref.id, first.attempt, 0), state: state(1) }))
    await makeStale(ref.id)
    const again = (await db.claimJob(database))!
    assert.equal(again.attempt, first.attempt)
    assert.deepEqual(again.resume, state(1), "the rest of the crawl, its title and its tokens are still known")

    // An older agent sends no state with its pages: the last one saved stays.
    assert.ok(await db.addPage(database, ref.id, again.lease, page(ref.id, again.attempt, 1)))
    assert.deepEqual(JSON.parse((await row(ref.id))!.crawl_state!), state(1))
    // A stop finds the title and tokens there too.
    await db.requestStop(database, ref.id)
    await makeStale(ref.id)
    assert.equal(await db.claimJob(database), null)
    assert.equal((await db.getReference(database, ref.id))!.reference.title, "Example")
  } finally {
    await mf.dispose()
  }
})

test("two agents on one library: the agent that reclaims a stale capture fences out the first, and their pages never collide", async () => {
  const { mf, database, files, ctx, env, makeStale, row, pageCount } = await setup()
  try {
    // The local R2 wants a body of known length; a request stream has none until it is read.
    const storage = new Proxy(files, { get(target, name) {
      if (name === "put") return async (key: string, body: ReadableStream, options: R2PutOptions) => target.put(key, await new Response(body).arrayBuffer(), options)
      const value = Reflect.get(target, name, target)
      return typeof value === "function" ? value.bind(target) : value
    } })
    const call = (path: string, lease: string | null, init: RequestInit = {}) => app.request(`https://snip.test/agent${path}`, { method: "POST", ...init,
      headers: { authorization: "Bearer test-token", "content-type": "application/json", "x-snip-capture-protocol": "4", ...(lease ? { "x-snip-capture-lease": lease } : {}) } }, { ...env, FILES: storage }, ctx)
    const claim = async (): Promise<Job> => (await call("/jobs/claim", null)).json() as Promise<Job>
    const ref = await db.createReference(database, { url: "https://example.com", mode: "crawl", maxPages: 9 })
    const refused = async (lease: string | null, id = ref.id) => {
      const attempt = (await row(id))!.capture_attempt!
      const key = `refs/${id}/${attempt}/p9/late.jpg`
      const results = {
        heartbeat: await call("/heartbeat", lease, { body: JSON.stringify({ jobId: id }) }),
        progress: await call(`/jobs/${id}/progress`, lease, { body: JSON.stringify({ message: "late" }) }),
        control: await call(`/jobs/${id}/control`, lease, { method: "GET", body: undefined }),
        pause: await call(`/jobs/${id}/pause?release`, lease, { body: JSON.stringify(state(1)) }),
        upload: await call(`/files/${key}`, lease, { method: "PUT", body: "late" }),
        page: await call(`/jobs/${id}/pages`, lease, { body: JSON.stringify(page(id, attempt, 9)) }),
        complete: await call(`/jobs/${id}/complete`, lease, { body: JSON.stringify(done) }),
        fail: await call(`/jobs/${id}/fail`, lease, { body: JSON.stringify({ error: "late" }) }),
      }
      assert.deepEqual(Object.fromEntries(Object.entries(results).map(([name, response]) => [name, response.status])),
        { heartbeat: 410, progress: 410, control: 410, pause: 410, upload: 410, page: 410, complete: 410, fail: 410 })
      assert.equal(await files.get(key), null, "a refused upload stores nothing")
    }

    const first = await claim()
    assert.match(first.lease, /^[a-f0-9]{32}$/)
    assert.notEqual(first.lease, first.attempt, "the lease is its own token, not the file namespace")
    const firstKey = `refs/${ref.id}/${first.attempt}/p0/desktop.jpg`
    assert.equal((await call(`/files/${firstKey}`, first.lease, { method: "PUT", body: "first" })).status, 200)
    assert.equal((await call(`/jobs/${ref.id}/pages`, first.lease, { body: JSON.stringify(page(ref.id, first.attempt, 0)) })).status, 200)

    // The first agent is alive but silent for 30 minutes; a second one reclaims the capture in the same file namespace.
    await makeStale(ref.id)
    const second = await claim()
    assert.equal(second.id, ref.id)
    assert.equal(second.attempt, first.attempt, "pages and files continue in the same namespace")
    assert.notEqual(second.lease, first.lease, "a reclaim issues a new lease")
    assert.equal(second.resume?.captured, 1)

    // Everything the first agent still sends is refused with "job is gone", whatever it presents as the lease.
    await refused(first.lease)
    await refused(first.attempt)
    await refused(null)
    await refused("f".repeat(32))
    const held = (await row(ref.id))!
    assert.deepEqual({ status: held.status, lease: held.capture_lease, error: held.error }, { status: "capturing", lease: second.lease, error: null }, "the refused fail and pause did not touch the second agent's job")
    assert.equal(await pageCount(ref.id), 1)

    // The second agent's calls go through and its pages land after the first agent's.
    const ord = second.resume!.visited.length
    assert.equal((await call("/heartbeat", second.lease, { body: JSON.stringify({ jobId: ref.id }) })).status, 200)
    assert.equal((await call(`/jobs/${ref.id}/control`, second.lease, { method: "GET", body: undefined })).status, 200)
    const secondKey = `refs/${ref.id}/${second.attempt}/p${ord}/desktop.jpg`
    assert.equal((await call(`/files/${secondKey}`, second.lease, { method: "PUT", body: "second" })).status, 200)
    assert.equal((await call(`/jobs/${ref.id}/pages`, second.lease, { body: JSON.stringify(page(ref.id, second.attempt, ord)) })).status, 200)
    const saved = (await db.getReference(database, ref.id))!.pages
    assert.deepEqual(saved.map((p) => p.ord), [0, ord])
    assert.equal(new Set(saved.map((p) => p.desktopKey)).size, 2, "no two pages share a file")
    assert.equal(await (await files.get(firstKey))!.text(), "first", "the second agent did not overwrite the first agent's file")
    assert.equal(await (await files.get(secondKey))!.text(), "second")
    assert.equal((await call(`/jobs/${ref.id}/complete`, second.lease, { body: JSON.stringify(done) })).status, 200)
    const finished = (await row(ref.id))!
    assert.deepEqual({ status: finished.status, lease: finished.capture_lease }, { status: "ready", lease: null }, "the lease is cleared when the capture ends")
    await refused(second.lease)
  } finally {
    await mf.dispose()
  }
})

test("the lease is issued on every claim and cleared whenever the capture leaves capturing", async () => {
  const { mf, database, makeStale, row } = await setup()
  try {
    const lease = async (id: string) => (await row(id))!.capture_lease
    const crawl = (url: string) => db.createReference(database, { url, mode: "crawl", maxPages: 5 })

    // A fresh claim, a pause and resume, and a stale reclaim each hand out a lease nobody held before.
    const a = await crawl("https://a.example")
    const claimed = (await db.claimJob(database))!
    assert.equal(await lease(a.id), claimed.lease)
    assert.ok(await db.addPage(database, a.id, claimed.lease, page(a.id, claimed.attempt, 0)))
    await db.requestPause(database, a.id)
    assert.equal(await db.pauseJob(database, a.id, claimed.lease, state(1)), "paused")
    assert.equal(await lease(a.id), null, "a pause releases it")
    await db.resumeReference(database, a.id)
    const resumed = (await db.claimJob(database))!
    assert.equal(resumed.attempt, claimed.attempt)
    await makeStale(a.id)
    const reclaimed = (await db.claimJob(database))!
    assert.equal(reclaimed.attempt, claimed.attempt)
    assert.equal(new Set([claimed.lease, resumed.lease, reclaimed.lease]).size, 3)
    assert.equal(await db.renewLease(database, a.id, resumed.lease), false, "the replaced holder cannot renew")
    assert.equal(await db.renewLease(database, a.id, reclaimed.lease), true)
    assert.equal(await db.renewLease(database, a.id, reclaimed.attempt), false, "the attempt is not a lease")
    assert.equal(await db.failJob(database, a.id, reclaimed.lease, "boom"), true)
    assert.equal(await lease(a.id), null, "a failure releases it")

    // Stop and a stale pause release it too, and so does a capture whose agents keep dying.
    const b = await crawl("https://b.example")
    const stopping = (await db.claimJob(database))!
    await db.requestStop(database, b.id)
    await makeStale(b.id)
    assert.equal(await db.claimJob(database), null)
    assert.equal(await lease(b.id), null, "a stop settled for a dead agent releases it")
    assert.equal(await db.setProgress(database, b.id, stopping.lease, "late"), false)

    const c = await crawl("https://c.example")
    assert.ok(await db.claimJob(database))
    await db.requestPause(database, c.id)
    await makeStale(c.id)
    assert.equal(await db.claimJob(database), null)
    assert.equal(await lease(c.id), null, "a pause parked for a dead agent releases it")

    const d = await crawl("https://d.example")
    for (let claims = 0; claims < 4; claims++) { // the claim and three reclaims
      assert.ok(await db.claimJob(database), `claim ${claims + 1} of the budget`)
      await makeStale(d.id)
    }
    assert.equal(await db.claimJob(database), null)
    assert.equal((await row(d.id))!.status, "failed")
    assert.equal(await lease(d.id), null, "an abandoned capture releases it")
  } finally {
    await mf.dispose()
  }
})

test("a stop or pause requested on an agent that is already gone settles at once: stopped-empty without pages, ready or paused with them", async () => {
  const { mf, database, makeStale, row, pageCount } = await setup()
  try {
    const crawl = (url: string) => db.createReference(database, { url, mode: "crawl", maxPages: 5 })
    const withPage = async (url: string) => {
      const ref = await crawl(url)
      const job = (await db.claimJob(database))!
      assert.ok(await db.addPage(database, ref.id, job.lease, { ...page(ref.id, job.attempt, 0), state: state(1) }))
      return { ref, job }
    }

    const empty = await crawl("https://empty.example")
    assert.ok(await db.claimJob(database))
    await makeStale(empty.id)
    assert.equal(await db.requestStop(database, empty.id), true)
    assert.deepEqual({ status: (await row(empty.id))!.status, error: (await row(empty.id))!.error, lease: (await row(empty.id))!.capture_lease }, { status: "failed", error: STOPPED_EMPTY, lease: null })

    const stopped = await withPage("https://stopped.example")
    await makeStale(stopped.ref.id)
    assert.equal(await db.requestStop(database, stopped.ref.id), true)
    const ready = (await db.getReference(database, stopped.ref.id))!.reference
    assert.deepEqual({ status: ready.status, title: ready.title, pages: ready.pageCount, control: ready.control }, { status: "ready", title: "Example", pages: 1, control: null }, "the title and tokens its last page saved are kept")
    assert.equal((await row(stopped.ref.id))!.capture_lease, null)
    assert.equal(await db.requestStop(database, stopped.ref.id), false, "a settled capture has nothing left to stop")

    const paused = await withPage("https://paused.example")
    await makeStale(paused.ref.id)
    assert.equal(await db.requestPause(database, paused.ref.id), true)
    assert.equal((await db.getReference(database, paused.ref.id))!.reference.status, "paused")
    assert.equal((await row(paused.ref.id))!.capture_lease, null)
    assert.equal(await db.claimJob(database), null, "nobody is handed a paused capture")
    assert.equal(await db.resumeReference(database, paused.ref.id), true)
    const resumed = (await db.claimJob(database))!
    assert.equal(resumed.attempt, paused.job.attempt, "it continues in its own files")
    assert.notEqual(resumed.lease, paused.job.lease, "under a lease of its own")
    assert.equal(resumed.resume?.captured, 1)
    assert.equal(await pageCount(paused.ref.id), 1)

    // A stop beats the reclaim budget: a capture on its last legs still ends with the pages it has.
    const spent = await withPage("https://spent.example")
    await database.prepare("UPDATE refs SET stale_reclaims = 3 WHERE id = ?").bind(spent.ref.id).run()
    await makeStale(spent.ref.id)
    assert.equal(await db.requestStop(database, spent.ref.id), true)
    assert.equal((await row(spent.ref.id))!.status, "ready")
  } finally {
    await mf.dispose()
  }
})

test("nothing settles a live capture: a stop or pause waits for its agent, whoever asks", async () => {
  const { mf, database, row } = await setup()
  try {
    const crawl = (url: string) => db.createReference(database, { url, mode: "crawl", maxPages: 5 })
    const stopping = await crawl("https://stopping.example")
    const stopJob = (await db.claimJob(database))!
    assert.ok(await db.addPage(database, stopping.id, stopJob.lease, page(stopping.id, stopJob.attempt, 0)))
    const pausing = await crawl("https://pausing.example")
    const pauseJob = (await db.claimJob(database))!
    const idle = await crawl("https://idle.example")
    const idleJob = (await db.claimJob(database))!
    // Just short of the stale window: a heartbeat 29 minutes ago still holds the capture.
    await database.prepare("UPDATE refs SET claimed_at = ?").bind(new Date(Date.now() - 29 * 60_000).toISOString()).run()

    assert.equal(await db.requestStop(database, stopping.id), true)
    assert.equal(await db.requestPause(database, pausing.id), true)
    await db.sweepAbandoned(database)
    assert.equal(await db.claimJob(database), null, "a live capture is not handed to a second agent")
    const held = async (id: string) => { const r = (await row(id))!; return { status: r.status, control: r.capture_control, lease: r.capture_lease } }
    assert.deepEqual(await held(stopping.id), { status: "capturing", control: "stop", lease: stopJob.lease })
    assert.deepEqual(await held(pausing.id), { status: "capturing", control: "pause", lease: pauseJob.lease })
    assert.deepEqual(await held(idle.id), { status: "capturing", control: null, lease: idleJob.lease })
    // The agent still sees the request and acts on it itself.
    assert.deepEqual(await db.getControl(database, stopping.id, stopJob.lease), { control: "stop" })
    assert.equal(await db.pauseJob(database, pausing.id, pauseJob.lease, state(0)), "paused")
  } finally {
    await mf.dispose()
  }
})
