import { test } from "node:test"
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { Miniflare, convertV4MiniflareOptions } from "miniflare"
import { app } from "../worker/app"
import * as db from "../worker/db"

async function setup() {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ["DB"], r2Buckets: ["FILES"] }))
  const database = await mf.getD1Database("DB") as unknown as D1Database
  const files = await mf.getR2Bucket("FILES") as unknown as R2Bucket
  const dir = new URL("../migrations/", import.meta.url)
  for (const migration of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = await readFile(new URL(migration, dir), "utf8")
    const statements = sql.replace(/^--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean)
    await database.batch(statements.map((statement) => database.prepare(statement)))
  }
  const env = { DB: database, FILES: files, SESSION_SECRET: "test-secret", DEV_LOGIN: "max" } as unknown as Env
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext
  const call = (path: string, method = "GET", body?: unknown) =>
    app.request(`http://localhost${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } }, env, ctx)
  return { mf, database, files, call }
}

test("adding a saved URL again returns the saved reference unless duplicates are allowed", async () => {
  const { mf, call } = await setup()
  try {
    const first = await call("/api/references", "POST", { url: "linear.app", mode: "single" })
    assert.equal(first.status, 201)
    const again = await call("/api/references", "POST", { url: "https://linear.app/", mode: "crawl" })
    assert.equal(again.status, 409)
    const body = await again.json() as { existing: { id: string } }
    assert.equal(body.existing.id, (await first.json() as { id: string }).id)
    assert.equal((await call("/api/references", "POST", { url: "https://linear.app/", mode: "single", allowDuplicate: true })).status, 201)
  } finally {
    await mf.dispose()
  }
})

test("notes are saved, searchable and bounded", async () => {
  const { mf, database, call } = await setup()
  try {
    const ref = await (await call("/api/references", "POST", { url: "https://stripe.com", mode: "single", notes: "  pricing table tabs " })).json() as { id: string; notes: string }
    assert.equal(ref.notes, "pricing table tabs")
    assert.equal((await db.listReferences(database, { q: "table tabs" })).items.length, 1)
    assert.equal((await call(`/api/references/${ref.id}`, "PATCH", { notes: "hero gradient" })).status, 200)
    assert.equal((await db.getReferenceRecord(database, ref.id))!.notes, "hero gradient")
    assert.equal((await call(`/api/references/${ref.id}`, "PATCH", { notes: "" })).status, 200)
    assert.equal((await db.getReferenceRecord(database, ref.id))!.notes, null)
    assert.equal((await call(`/api/references/${ref.id}`, "PATCH", { notes: "x".repeat(db.MAX_NOTES + 1) })).status, 400)
    assert.equal((await call(`/api/references/missing`, "PATCH", { notes: "x" })).status, 404)
  } finally {
    await mf.dispose()
  }
})

test("capture options are cleaned and handed to the agent", async () => {
  const { mf, database, call } = await setup()
  try {
    assert.equal(db.cleanOptions({ colorScheme: "light", desktopWidth: 1440 }), null, "defaults are not stored")
    assert.deepEqual(db.cleanOptions({ colorScheme: "dark", desktopWidth: 999, signedIn: "yes", extra: 1 }), { colorScheme: "dark" })
    await call("/api/references", "POST", { url: "https://vercel.com", mode: "single", options: { colorScheme: "dark", desktopWidth: 1920, signedIn: true } })
    const job = await db.claimJob(database)
    assert.deepEqual(job!.options, { colorScheme: "dark", desktopWidth: 1920, signedIn: true })
  } finally {
    await mf.dispose()
  }
})

test("agent presence and storage usage for the gallery", async () => {
  const { mf, database, files, call } = await setup()
  try {
    assert.equal((await (await call("/api/agent")).json() as { freshness: string }).freshness, "never")
    await db.touchPresence(database, "idle", null)
    assert.equal((await (await call("/api/agent")).json() as { freshness: string }).freshness, "recent")
    await files.put("refs/a/b/p0/desktop.jpg", "12345")
    await files.put("refs/a/b/p0/mobile.jpg", "123")
    const usage = await (await call("/api/storage")).json() as { bytes: number; objects: number; partial: boolean }
    assert.deepEqual([usage.bytes, usage.objects, usage.partial], [8, 2, false])
  } finally {
    await mf.dispose()
  }
})
