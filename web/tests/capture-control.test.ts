import { test } from "node:test"
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { Miniflare, convertV4MiniflareOptions } from "miniflare"
import { app } from "../worker/app"
import * as db from "../worker/db"
import type { CrawlState, PageUpload } from "../shared/types"

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

async function setup() {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ["DB"], r2Buckets: ["FILES"] }))
  const database = await mf.getD1Database("DB") as unknown as D1Database
  const dir = new URL("../migrations/", import.meta.url)
  for (const migration of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = await readFile(new URL(migration, dir), "utf8")
    const statements = sql.replace(/^--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean)
    await database.batch(statements.map((statement) => database.prepare(statement)))
  }
  return { mf, database }
}

test("a paused crawl keeps its pages and resumes where it left off", async () => {
  const { mf, database } = await setup()
  try {
    const ref = await db.createReference(database, { url: "https://example.com", mode: "crawl", maxPages: 5 })
    const job = (await db.claimJob(database))!
    assert.equal(job.resume, null)
    assert.ok(await db.addPage(database, ref.id, job.lease, page(ref.id, job.attempt, 0)))

    // The request waits for the agent; the page in progress is not interrupted.
    assert.deepEqual(await db.getControl(database, ref.id, job.lease), { control: null })
    assert.equal(await db.requestPause(database, ref.id), true)
    assert.equal((await db.getReference(database, ref.id))!.reference.control, "pause")
    assert.deepEqual(await db.getControl(database, ref.id, job.lease), { control: "pause" })

    assert.equal(await db.pauseJob(database, ref.id, job.lease, state(1)), "paused")
    const paused = (await db.getReference(database, ref.id))!
    assert.equal(paused.reference.status, "paused")
    assert.equal(paused.reference.control, null)
    assert.equal(paused.pages.length, 1)
    assert.equal(await db.claimJob(database), null, "paused captures stay out of the queue")
    assert.equal(await db.setProgress(database, ref.id, job.lease, "late"), false, "the old lease is released")
    assert.equal((await db.listReferences(database, { status: "paused" })).items.length, 1)
    assert.equal((await db.listReferences(database, { status: "queued" })).items.length, 0)

    const cleanups = async () => (await database.prepare("SELECT group_concat(prefix) AS p FROM capture_cleanup").first<{ p: string | null }>())!.p
    const retiredBefore = await cleanups()
    assert.equal(await db.resumeReference(database, ref.id), true)
    assert.equal((await db.getReference(database, ref.id))!.reference.status, "queued")
    const resumed = (await db.claimJob(database))!
    assert.equal(resumed.attempt, job.attempt, "same file namespace, so the saved pages stay valid")
    assert.deepEqual(resumed.resume, state(1))
    const during = (await db.getReference(database, ref.id))!
    assert.equal(during.reference.status, "capturing")
    assert.equal(during.reference.pageCount, 1)
    assert.equal(during.pages.length, 1)
    assert.equal(await cleanups(), retiredBefore, "resuming retires no files")

    assert.ok(await db.addPage(database, ref.id, resumed.lease, page(ref.id, resumed.attempt, 1)))
    assert.ok(await db.completeJob(database, ref.id, resumed.lease, { title: "Example", description: null, favicon: null, coverKey: null, tokens: null }))
    const done = (await db.getReference(database, ref.id))!
    assert.equal(done.reference.status, "ready")
    assert.equal(done.pages.length, 2)
  } finally {
    await mf.dispose()
  }
})

test("stop winds down a running crawl, a paused one and a queued one", async () => {
  const { mf, database } = await setup()
  try {
    // Running: the agent sees the stop before its next page and completes with what it has.
    const running = await db.createReference(database, { url: "https://running.example", mode: "crawl" })
    const job = (await db.claimJob(database))!
    assert.ok(await db.addPage(database, running.id, job.lease, page(running.id, job.attempt, 0)))
    assert.equal(await db.requestPause(database, running.id), true)
    assert.equal(await db.requestStop(database, running.id), true, "stop replaces a pending pause")
    assert.deepEqual(await db.getControl(database, running.id, job.lease), { control: "stop" })
    assert.equal(await db.pauseJob(database, running.id, job.lease, state(1)), "changed", "a stale pause loses to the stop")
    assert.ok(await db.completeJob(database, running.id, job.lease, { title: null, description: null, favicon: null, coverKey: null, tokens: null }))
    const stopped = (await db.getReference(database, running.id))!.reference
    assert.equal(stopped.status, "ready")
    assert.equal(stopped.control, null)

    // Paused: finishes on the server from the saved metadata and tokens.
    const paused = await db.createReference(database, { url: "https://paused.example", mode: "crawl" })
    const pjob = (await db.claimJob(database))!
    assert.ok(await db.addPage(database, paused.id, pjob.lease, { ...page(paused.id, pjob.attempt, 0), tokens: state(1).tokens }))
    await db.requestPause(database, paused.id)
    assert.equal(await db.pauseJob(database, paused.id, pjob.lease, state(1)), "paused")
    assert.equal(await db.requestStop(database, paused.id), true)
    const finished = (await db.getReference(database, paused.id))!
    assert.equal(finished.reference.status, "ready")
    assert.equal(finished.reference.title, "Example")
    assert.equal(finished.reference.tokens?.colors[0]?.value, "#000")
    assert.equal(finished.reference.coverKey, `refs/${paused.id}/${pjob.attempt}/p0/desktop.jpg`)
    assert.equal(finished.pages.length, 1)
    // A page carries its tokens with its website, not in the pages feed.
    assert.equal(finished.pages[0]!.tokens?.colors[0]?.value, "#000")
    const listed = (await db.listPages(database, {})).items.find((p) => p.id === finished.pages[0]!.id)!
    assert.equal(listed.tokens, null)

    // Resumed but not picked up yet: still finishes with its pages.
    const waiting = await db.createReference(database, { url: "https://waiting.example", mode: "crawl" })
    const wjob = (await db.claimJob(database))!
    assert.ok(await db.addPage(database, waiting.id, wjob.lease, page(waiting.id, wjob.attempt, 0)))
    await db.requestPause(database, waiting.id)
    assert.equal(await db.pauseJob(database, waiting.id, wjob.lease, state(1)), "paused")
    await db.resumeReference(database, waiting.id)
    assert.equal(await db.requestStop(database, waiting.id), true)
    const kept = (await db.getReference(database, waiting.id))!
    assert.equal(kept.reference.status, "ready")
    assert.equal(kept.reference.title, "Example")
    assert.equal(kept.pages.length, 1)

    // Queued: nothing was captured, so it ends as a failure Retry can restart.
    const queued = await db.createReference(database, { url: "https://queued.example", mode: "crawl" })
    assert.equal(await db.requestStop(database, queued.id), true)
    const cancelled = (await db.getReference(database, queued.id))!.reference
    assert.equal(cancelled.status, "failed")
    assert.equal(cancelled.error, "Stopped before any pages were captured")
    assert.equal(await db.requestStop(database, queued.id), false, "nothing left to stop")

    // Paused while still queued, then resumed: a normal fresh claim.
    const later = await db.createReference(database, { url: "https://later.example", mode: "crawl" })
    assert.equal(await db.requestPause(database, later.id), true)
    assert.equal(await db.claimJob(database), null)
    await db.resumeReference(database, later.id)
    const fresh = (await db.claimJob(database))!
    assert.equal(fresh.id, later.id)
    assert.equal(fresh.resume, null)

    // Cancelling a pause before it takes effect.
    assert.equal(await db.requestPause(database, later.id), true)
    assert.equal(await db.resumeReference(database, later.id), true)
    assert.deepEqual(await db.getControl(database, later.id, fresh.lease), { control: null })
  } finally {
    await mf.dispose()
  }
})

test("agent control and pause routes are fenced by the capture lease", async () => {
  const { mf, database } = await setup()
  try {
    const ref = await db.createReference(database, { url: "https://example.com", mode: "crawl" })
    const job = (await db.claimJob(database))!
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext
    const env = { DB: database, CAPTURE_TOKEN: "test-token" } as Env
    const headers = (lease: string) => ({ authorization: "Bearer test-token", "content-type": "application/json", "x-snip-capture-protocol": "4", "x-snip-capture-lease": lease })
    const req = (path: string, lease: string, init: RequestInit = {}) => app.request(`https://snip.test${path}`, { ...init, headers: headers(lease) }, env, ctx)

    assert.equal((await req(`/agent/jobs/${ref.id}/control`, "f".repeat(32))).status, 410)
    assert.deepEqual(await (await req(`/agent/jobs/${ref.id}/control`, job.lease)).json(), { control: null })
    const pause = () => req(`/agent/jobs/${ref.id}/pause`, job.lease, { method: "POST", body: JSON.stringify(state(0)) })
    assert.equal((await pause()).status, 409, "no pause was requested")
    await db.requestPause(database, ref.id)
    assert.deepEqual(await (await req(`/agent/jobs/${ref.id}/control`, job.lease)).json(), { control: "pause" })
    assert.equal((await pause()).status, 200)
    assert.equal((await pause()).status, 410, "the lease ends at the pause")
  } finally {
    await mf.dispose()
  }
})

test("a website's saved icon survives pause, resume and stop, and only an icon from the capture's own files is kept", async () => {
  const { mf, database } = await setup()
  try {
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext
    const env = { DB: database, CAPTURE_TOKEN: "test-token" } as Env
    const finish = (id: string, lease: string, favicon: string | null) => app.request(`https://snip.test/agent/jobs/${id}/complete`, {
      method: "POST", body: JSON.stringify({ title: null, description: null, favicon, coverKey: null, tokens: null }),
      headers: { authorization: "Bearer test-token", "content-type": "application/json", "x-snip-capture-protocol": "4", "x-snip-capture-lease": lease },
    }, env, ctx)
    const icon = async (id: string) => (await db.getReference(database, id))!.reference.favicon
    const withIcon = (favicon: string | null): CrawlState => ({ ...state(1), meta: { title: "Example", description: null, favicon } })
    const crawl = async (url: string) => {
      const ref = await db.createReference(database, { url, mode: "crawl", maxPages: 5 })
      const job = (await db.claimJob(database))!
      assert.ok(await db.addPage(database, ref.id, job.lease, page(ref.id, job.attempt, 0)))
      return { ref, job, key: `refs/${ref.id}/${job.attempt}/icon.png` }
    }
    const pause = async (id: string, lease: string, favicon: string | null) => {
      await db.requestPause(database, id)
      assert.equal(await db.pauseJob(database, id, lease, withIcon(favicon)), "paused")
    }

    // Pause, resume, finish: the checkpoint hands the saved key back, and it is still under the capture's own prefix
    // because a resumed crawl keeps its attempt.
    const a = await crawl("https://resume.example")
    await pause(a.ref.id, a.job.lease, a.key)
    assert.equal(await icon(a.ref.id), null, "nothing is shown until the capture ends")
    assert.ok(await db.resumeReference(database, a.ref.id))
    const resumed = (await db.claimJob(database))!
    assert.equal(resumed.attempt, a.job.attempt)
    assert.equal(resumed.resume!.meta!.favicon, a.key, "the resumed agent reuses the saved icon instead of fetching again")
    assert.equal((await finish(a.ref.id, resumed.lease, resumed.resume!.meta!.favicon)).status, 200)
    assert.equal(await icon(a.ref.id), a.key)

    // Pause, stop: the server finishes the crawl from the checkpoint, icon included.
    const b = await crawl("https://stop.example")
    await pause(b.ref.id, b.job.lease, b.key)
    assert.equal(await db.requestStop(database, b.ref.id), true)
    assert.equal((await db.getReference(database, b.ref.id))!.reference.status, "ready")
    assert.equal(await icon(b.ref.id), b.key)
    // ...and the same when the pause was resumed but not picked up yet.
    const c = await crawl("https://waiting.example")
    await pause(c.ref.id, c.job.lease, c.key)
    await db.resumeReference(database, c.ref.id)
    assert.equal(await db.requestStop(database, c.ref.id), true)
    assert.equal(await icon(c.ref.id), c.key)

    // A checkpoint whose icon was not saved yet still holds the site's URL: nothing is kept, and the stop still finishes.
    const d = await crawl("https://unsaved.example")
    await pause(d.ref.id, d.job.lease, "https://unsaved.example/favicon.ico")
    assert.equal(await db.requestStop(database, d.ref.id), true)
    assert.equal(await icon(d.ref.id), null)
    assert.equal((await db.getReference(database, d.ref.id))!.reference.status, "ready")

    // Only a key under the capture's own prefix is kept, however the capture ends: not another website's, not an
    // earlier attempt's, not a URL (what an older agent sends).
    const e = await crawl("https://other.example")
    let live = e.job
    for (const wrong of [b.key, `refs/${e.ref.id}/${"0".repeat(32)}/icon.png`, "https://other.example/favicon.ico"]) {
      assert.equal((await finish(e.ref.id, live.lease, wrong)).status, 200)
      assert.equal(await icon(e.ref.id), null)
      await db.requeueReference(database, e.ref.id)
      live = (await db.claimJob(database))!
    }
    const f = await crawl("https://wrong.example")
    await pause(f.ref.id, f.job.lease, b.key)
    await db.requestStop(database, f.ref.id)
    assert.equal(await icon(f.ref.id), null, "a checkpoint cannot point the website at another capture's file")

    // A recapture clears the icon with the retired attempt, and the old key cannot come back under the new one.
    await db.requeueReference(database, b.ref.id)
    assert.equal(await icon(b.ref.id), null)
    const retired = (await database.prepare("SELECT group_concat(prefix) AS p FROM capture_cleanup").first<{ p: string }>())!.p
    assert.ok(retired.includes(`refs/${b.ref.id}/${b.job.attempt}/`), "the old attempt's files, icon included, are retired")
    const next = (await db.claimJob(database))!
    assert.notEqual(next.attempt, b.job.attempt)
    assert.equal(next.resume, null, "a recapture starts over, with no checkpoint to restore an icon from")
    assert.equal((await finish(b.ref.id, next.lease, b.key)).status, 200)
    assert.equal(await icon(b.ref.id), null)
  } finally {
    await mf.dispose()
  }
})
