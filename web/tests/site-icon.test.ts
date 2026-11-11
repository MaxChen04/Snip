import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile, readdir } from "node:fs/promises"
import { Miniflare, convertV4MiniflareOptions } from "miniflare"
import { app } from "../worker/app"
import * as db from "../worker/db"
import type { Job } from "../shared/types"

// Real local D1 and R2 bindings; no deployed resources are used.
test("a website's icon is saved with its capture and served from Snip's files; an older capture's icon URL is never handed to the app", async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ["DB"], r2Buckets: ["FILES"] }))
  const pending: Promise<unknown>[] = []
  try {
    const database = (await mf.getD1Database("DB")) as unknown as D1Database
    const files = (await mf.getR2Bucket("FILES")) as unknown as R2Bucket
    const dir = new URL("../migrations/", import.meta.url)
    for (const migration of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) {
      const sql = await readFile(new URL(migration, dir), "utf8")
      const statements = sql.replace(/^--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean)
      await database.batch(statements.map((statement) => database.prepare(statement)))
    }
    const ctx = { waitUntil(p: Promise<unknown>) { pending.push(p) }, passThroughOnException() {}, props: { ownerId: "max" } } as unknown as ExecutionContext
    const env = { DB: database, FILES: files, SESSION_SECRET: "test-secret", DEV_LOGIN: "max", CAPTURE_TOKEN: "test-token" } as unknown as Env
    const agent = (path: string, lease: string | null, init: RequestInit = {}) =>
      app.request(`http://localhost/agent${path}`, { ...init, headers: { authorization: "Bearer test-token", "x-snip-capture-protocol": "4", ...(lease ? { "x-snip-capture-lease": lease } : {}), ...(init.headers ?? {}) } }, env, ctx)
    const capture = async (favicon: (prefix: string) => string, svg = false) => {
      const ref = await db.createReference(database, { url: "https://example.com", mode: "single" })
      const job = (await (await agent("/jobs/claim", null, { method: "POST" })).json()) as Job
      assert.ok(job.features?.includes("icon"), "the Worker says it saves icons")
      const prefix = `refs/${ref.id}/${job.attempt}`
      if (svg) await files.put(`${prefix}/icon.svg`, "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>", { httpMetadata: { contentType: "image/svg+xml" } })
      const done = await agent(`/jobs/${ref.id}/complete`, job.lease, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: null, description: null, favicon: favicon(prefix), coverKey: null, tokens: null }) })
      assert.equal(done.status, 200)
      return { ref, prefix }
    }

    const saved = await capture((prefix) => `${prefix}/icon.svg`, true)
    assert.equal((await db.getReference(database, saved.ref.id))!.reference.favicon, `${saved.prefix}/icon.svg`)
    const file = await app.request(`http://localhost/files/${saved.prefix}/icon.svg`, {}, env, ctx)
    assert.equal(file.status, 200)
    assert.equal(file.headers.get("content-type"), "image/svg+xml")
    assert.match(file.headers.get("content-security-policy") ?? "", /sandbox/, "an SVG opened on its own cannot run its script")

    // An agent that predates saved icons sends the site's own icon URL; it is not stored.
    const legacy = await capture(() => "https://example.com/favicon.ico")
    assert.equal(await database.prepare("SELECT favicon FROM refs WHERE id = ?").bind(legacy.ref.id).first("favicon"), null)

    // Rows saved before this change hold the URL. It stays in the database but is never handed to the app.
    await database.prepare("UPDATE refs SET favicon = 'https://example.com/favicon.ico' WHERE id = ?").bind(legacy.ref.id).run()
    assert.equal((await db.getReference(database, legacy.ref.id))!.reference.favicon, null)
    assert.equal((await db.listReferences(database, {})).items.find((r) => r.id === legacy.ref.id)!.favicon, null)

    // A recapture starts without the old icon, whose file is cleaned up with the old attempt.
    await db.requeueReference(database, saved.ref.id)
    assert.equal(await database.prepare("SELECT favicon FROM refs WHERE id = ?").bind(saved.ref.id).first("favicon"), null)
  } finally {
    await Promise.allSettled(pending)
    await mf.dispose()
  }
})
