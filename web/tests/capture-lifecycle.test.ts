import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { Miniflare, convertV4MiniflareOptions } from "miniflare"
import { app } from "../worker/app"
import * as db from "../worker/db"

// Real local D1 and R2 bindings; no deployed resources are used.
test("capture leases fence stale workers and isolate cleanup", async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ["DB"], r2Buckets: ["FILES"] }))
  try {
    const database = await mf.getD1Database("DB") as unknown as D1Database
    const files = await mf.getR2Bucket("FILES") as unknown as R2Bucket
    for (const migration of ["0001_init.sql", "0002_mcp_media_status.sql", "0003_capture_attempts.sql", "0004_page_collections.sql", "0005_capture_control.sql"]) {
      const sql = await readFile(new URL(`../migrations/${migration}`, import.meta.url), "utf8")
      // D1 exec accepts one statement per line; migration comments and multiline SQL need prepare/batch.
      const statements = sql.replace(/^--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean)
      await database.batch(statements.map((statement) => database.prepare(statement)))
    }
    const ref = await db.createReference(database, { url: "https://example.com", mode: "single" })
    const legacyKey = `refs/${ref.id}/p0/desktop.jpg`
    await files.put(legacyKey, "legacy")
    const old = (await db.claimJob(database))!
    const oldKey = `refs/${ref.id}/${old.attempt}/p0/desktop.jpg`
    await files.put(oldKey, "old")
    await db.requeueReference(database, ref.id)
    const current = (await db.claimJob(database))!
    assert.notEqual(current.attempt, old.attempt)
    const currentKey = `refs/${ref.id}/${current.attempt}/p0/desktop.jpg`
    await files.put(currentKey, "current")
    assert.equal(await db.setProgress(database, ref.id, old.attempt, "old"), false)
    const page = { url: "https://example.com", path: "/", title: "Page", ord: 0,
      desktopKey: currentKey, desktopThumbKey: currentKey, desktopWidth: 100, desktopHeight: 100,
      mobileKey: null, mobileThumbKey: null, mobileWidth: null, mobileHeight: null,
      snapshotKey: null, stylesKey: null, tokens: null,
      animations: [{ kind: "scroll" as const, label: "Scroll", selector: null, viewport: "desktop" as const, gifKey: currentKey, width: 100, height: 100, sheetKey: null, meta: null }] }
    assert.equal(await db.addPage(database, ref.id, old.attempt, page), null)
    assert.ok(await db.addPage(database, ref.id, current.attempt, page))
    assert.equal((await db.getReference(database, ref.id))?.pages.length, 1)
    assert.equal(await db.failJob(database, ref.id, old.attempt, "old"), false)
    assert.equal(await db.completeJob(database, ref.id, old.attempt, { title: null, description: null, favicon: null, coverKey: null, tokens: null }), false)
    const failingFiles = new Proxy(files, { get(target, name) {
      if (name === "list") return async () => { throw new Error("temporary storage failure") }
      const value = Reflect.get(target, name, target)
      return typeof value === "function" ? value.bind(target) : value
    } })
    await db.cleanupRetiredFiles(database, failingFiles)
    assert.ok((await database.prepare("SELECT count(*) AS n FROM capture_cleanup").first<{ n: number }>())!.n > 0)
    await database.prepare("UPDATE capture_cleanup SET next_attempt = NULL").run()
    await db.cleanupRetiredFiles(database, files)
    assert.equal(await files.get(legacyKey), null)
    assert.equal(await files.get(oldKey), null)
    assert.ok(await files.get(currentKey))
    await database.prepare("UPDATE refs SET claimed_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").bind(ref.id).run()
    assert.equal(await db.renewLease(database, ref.id, old.attempt), false)
    assert.equal(await db.renewLease(database, ref.id, current.attempt), true)
    assert.equal(await db.claimJob(database), null)

    const pending: Promise<unknown>[] = []
    const ctx = { waitUntil(p: Promise<unknown>) { pending.push(p) }, passThroughOnException() {} } as ExecutionContext
    const env = { DB: database, FILES: files, CAPTURE_TOKEN: "test-token" } as Env
    const req = (path: string, init: RequestInit = {}) => app.request(`https://snip.test${path}`, init, env, ctx)
    const auth = { authorization: "Bearer test-token" }
    const rejected = await req("/agent/jobs/claim", { method: "POST", headers: auth })
    assert.equal(rejected.status, 426)
    const beat = (attempt: string) => req("/agent/heartbeat", { method: "POST", headers: { ...auth, "content-type": "application/json", "x-snip-capture-protocol": "2", "x-snip-capture-attempt": attempt }, body: JSON.stringify({ jobId: ref.id }) })
    assert.equal((await beat(old.attempt)).status, 410)
    assert.equal((await beat(current.attempt)).status, 200)

    let release!: () => void
    let started!: () => void
    const entered = new Promise<void>((resolve) => { started = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    const delayedFiles = new Proxy(files, { get(target, name) {
      if (name === "put") return async (key: string, body: ReadableStream, options: R2PutOptions) => { const bytes = await new Response(body).arrayBuffer(); started(); await gate; return target.put(key, bytes, options) }
      const value = Reflect.get(target, name, target)
      return typeof value === "function" ? value.bind(target) : value
    } })
    const uploadKey = `refs/${ref.id}/${current.attempt}/p0/late.jpg`
    const upload = app.request(`https://snip.test/agent/files/${uploadKey}`, { method: "PUT", body: "late", headers: { ...auth, "x-snip-capture-protocol": "2", "x-snip-capture-attempt": current.attempt } }, { ...env, FILES: delayedFiles }, ctx)
    await entered
    await db.deleteReference(database, ref.id)
    await db.cleanupRetiredFiles(database, files)
    release()
    assert.equal((await upload).status, 410)
    assert.equal(await files.get(uploadKey), null)
    await Promise.all(pending)
    assert.equal((await database.prepare("SELECT count(*) AS n FROM capture_uploads").first<{ n: number }>())!.n, 0)
    await database.prepare("UPDATE capture_cleanup SET next_attempt = NULL").run()
    await db.cleanupRetiredFiles(database, files)

    // A storage write can finish after deletion and then lose its postcheck.
    // Its unresolved intent retains the tombstone, so later sweeps remove the late object.
    const uncertainRef = await db.createReference(database, { url: "https://uncertain.example", mode: "single" })
    const uncertainJob = (await db.claimJob(database))!
    let releaseUncertain!: () => void
    let startedUncertain!: () => void
    const enteredUncertain = new Promise<void>((resolve) => { startedUncertain = resolve })
    const gateUncertain = new Promise<void>((resolve) => { releaseUncertain = resolve })
    const slowFiles = new Proxy(files, { get(target, name) {
      if (name === "put") return async (key: string, body: ReadableStream, options: R2PutOptions) => { const bytes = await new Response(body).arrayBuffer(); startedUncertain(); await gateUncertain; return target.put(key, bytes, options) }
      const value = Reflect.get(target, name, target)
      return typeof value === "function" ? value.bind(target) : value
    } })
    const failingDb = new Proxy(database, { get(target, name) {
      if (name === "prepare") return (sql: string) => {
        if (sql.startsWith("SELECT 1 FROM refs")) throw new Error("postcheck unavailable")
        return target.prepare(sql)
      }
      const value = Reflect.get(target, name, target)
      return typeof value === "function" ? value.bind(target) : value
    } })
    const lateKey = `refs/${uncertainRef.id}/${uncertainJob.attempt}/p0/late.jpg`
    const lateUpload = app.request(`https://snip.test/agent/files/${lateKey}`, { method: "PUT", body: "late", headers: { ...auth, "x-snip-capture-protocol": "2", "x-snip-capture-attempt": uncertainJob.attempt } }, { ...env, DB: failingDb, FILES: slowFiles }, ctx)
    await enteredUncertain
    await db.deleteReference(database, uncertainRef.id)
    await db.cleanupRetiredFiles(database, files)
    assert.ok(await database.prepare("SELECT prefix FROM capture_cleanup WHERE prefix = ?").bind(`refs/${uncertainRef.id}/`).first())
    releaseUncertain()
    assert.equal((await lateUpload).status, 500)
    assert.ok(await files.get(lateKey))
    await database.prepare("UPDATE capture_cleanup SET next_attempt = NULL").run()
    await db.cleanupRetiredFiles(database, files)
    assert.equal(await files.get(lateKey), null)
    assert.ok(await database.prepare("SELECT prefix FROM capture_cleanup WHERE prefix = ?").bind(`refs/${uncertainRef.id}/`).first())
    assert.ok(await database.prepare("SELECT id FROM capture_uploads WHERE object_key = ?").bind(lateKey).first())

    const staleRef = await db.createReference(database, { url: "https://example.org", mode: "single" })
    const expired = (await db.claimJob(database))!
    await database.prepare("UPDATE refs SET claimed_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").bind(staleRef.id).run()
    const reclaimed = (await db.claimJob(database))!
    assert.equal(reclaimed.id, staleRef.id)
    assert.notEqual(reclaimed.attempt, expired.attempt)
    assert.equal(await db.addPage(database, staleRef.id, expired.attempt, page), null)
    assert.equal(await db.failJob(database, staleRef.id, expired.attempt, "expired"), false)
  } finally {
    await mf.dispose()
  }
})
