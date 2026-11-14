import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { Miniflare, convertV4MiniflareOptions } from "miniflare"
import * as db from "../worker/db"
import { applyMigrations } from "./helpers/d1"
import { STOPPED_EMPTY, diagnoseCaptureError } from "../shared/capture-errors"
import type { CrawlState, PageUpload } from "../shared/types"

/** The real entrypoint, bundled the way gzip-files.test.ts does it, with its D1 and R2 bindings. */
async function withWorker(run: (worker: { database: D1Database; files: R2Bucket; scheduled: () => Promise<void> }) => Promise<void>) {
  const { build } = createRequire(import.meta.resolve("wrangler"))("esbuild")
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("../worker/index.ts", import.meta.url))],
    bundle: true, write: false, format: "esm", platform: "browser",
    conditions: ["workerd", "worker", "browser"], external: ["cloudflare:*", "node:*"],
  })
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-10-01", compatibilityFlags: ["nodejs_compat"],
    kvNamespaces: ["OAUTH_KV"], d1Databases: ["DB"], r2Buckets: ["FILES"],
    bindings: { PUBLIC_URL: "http://localhost", SESSION_SECRET: "test-secret" },
  }))
  try {
    const database = await mf.getD1Database("DB") as unknown as D1Database
    const files = await mf.getR2Bucket("FILES") as unknown as R2Bucket
    await applyMigrations(database)
    const scheduled = async () => { assert.equal((await (await mf.getWorker()).scheduled({ cron: "0 * * * *" })).outcome, "ok") }
    await run({ database, files, scheduled })
  } finally {
    await mf.dispose()
  }
}

test("the scheduled handler sweeps retired capture files, and the config gives it a cron trigger", { timeout: 120_000 }, async () => {
  await withWorker(async ({ database, files, scheduled }) => {
    const ref = await db.createReference(database, { url: "https://example.com", mode: "single" })
    const key = `refs/${ref.id}/p0/desktop.jpg`
    await files.put(key, "retired")
    await db.deleteReference(database, ref.id)
    assert.ok(await files.get(key), "nothing has swept it yet")

    await scheduled()
    assert.equal(await files.get(key), null)
    assert.equal((await database.prepare("SELECT count(*) AS n FROM capture_cleanup").first<{ n: number }>())!.n, 0)

    assert.match(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"), /^\s*"triggers":\s*\{\s*"crons":\s*\["[^"]+"\]/m)
  })
})

const page = (id: string, attempt: string): PageUpload => {
  const key = `refs/${id}/${attempt}/p0/desktop.jpg`
  return { url: "https://example.com/", path: "/", title: "Home", ord: 0, desktopKey: key, desktopThumbKey: key, desktopWidth: 100, desktopHeight: 100,
    mobileKey: null, mobileThumbKey: null, mobileWidth: null, mobileHeight: null, snapshotKey: null, stylesKey: null, tokens: null, animations: [],
    state: { version: 1, queue: [], visited: ["https://example.com/"], captured: 1, failures: 0, navLinksQueued: true, hoverSeen: [],
      meta: { title: "Example", description: null, favicon: null }, tokens: null } satisfies CrawlState }
}

test("the scheduled handler settles a stop or pause left on an agent that went quiet, and nothing that is live", { timeout: 120_000 }, async () => {
  await withWorker(async ({ database, scheduled }) => {
    const row = (id: string) => database.prepare("SELECT status, capture_control, capture_lease, error FROM refs WHERE id = ?").bind(id)
      .first<{ status: string; capture_control: string | null; capture_lease: string | null; error: string | null }>()
    const goQuiet = (...ids: string[]) => Promise.all(ids.map((id) =>
      database.prepare("UPDATE refs SET claimed_at = ? WHERE id = ?").bind(new Date(Date.now() - 40 * 60_000).toISOString(), id).run()))
    /** A capture claimed by an agent that is, for now, alive. */
    const capturing = async (url: string, withPage: boolean) => {
      const ref = await db.createReference(database, { url, mode: "crawl", maxPages: 5 })
      const job = (await db.claimJob(database))!
      if (withPage) assert.ok(await db.addPage(database, ref.id, job.lease, page(ref.id, job.attempt)))
      return { ref, job }
    }

    const stopWithPages = await capturing("https://stop-pages.example", true)
    const stopEmpty = await capturing("https://stop-empty.example", false)
    const pause = await capturing("https://pause.example", true)
    const untouched = await capturing("https://untouched.example", true)
    const spent = await capturing("https://spent.example", false)
    await database.prepare("UPDATE refs SET stale_reclaims = 3 WHERE id = ?").bind(spent.ref.id).run()
    // The requests come while every agent is alive: nothing can settle them yet.
    assert.equal(await db.requestStop(database, stopWithPages.ref.id), true)
    assert.equal(await db.requestStop(database, stopEmpty.ref.id), true)
    assert.equal(await db.requestPause(database, pause.ref.id), true)

    await scheduled()
    for (const { ref, job } of [stopWithPages, stopEmpty, pause, untouched, spent]) {
      const r = (await row(ref.id))!
      assert.deepEqual({ status: r.status, lease: r.capture_lease }, { status: "capturing", lease: job.lease }, "a live capture is left alone")
    }
    assert.equal((await row(stopWithPages.ref.id))!.capture_control, "stop")
    assert.equal((await row(pause.ref.id))!.capture_control, "pause")

    // Then the agents go quiet. No agent polls, but the next sweep settles what was asked for.
    await goQuiet(stopWithPages.ref.id, stopEmpty.ref.id, pause.ref.id, untouched.ref.id, spent.ref.id)
    await scheduled()
    const ready = (await db.getReference(database, stopWithPages.ref.id))!.reference
    assert.deepEqual({ status: ready.status, title: ready.title, pages: ready.pageCount, control: ready.control }, { status: "ready", title: "Example", pages: 1, control: null }, "a stop keeps the pages")
    assert.deepEqual(await row(stopEmpty.ref.id), { status: "failed", capture_control: null, capture_lease: null, error: STOPPED_EMPTY }, "a stop with no pages ends as stopped")
    assert.equal((await db.getReference(database, pause.ref.id))!.reference.status, "paused", "a pause parks the capture")
    assert.equal((await row(pause.ref.id))!.capture_lease, null)

    // A quiet capture nobody asked anything of stays for the next claim, unless it has already used up its reclaims.
    assert.deepEqual(await row(untouched.ref.id), { status: "capturing", capture_control: null, capture_lease: untouched.job.lease, error: null })
    const abandoned = (await row(spent.ref.id))!
    assert.deepEqual({ status: abandoned.status, lease: abandoned.capture_lease }, { status: "failed", lease: null })
    assert.ok(diagnoseCaptureError(abandoned.error), "the failure is one the app explains")
    const reclaimed = (await db.claimJob(database))!
    assert.equal(reclaimed.id, untouched.ref.id, "the claim still takes over what the sweep left")
    assert.notEqual(reclaimed.lease, untouched.job.lease)
  })
})
