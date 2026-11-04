import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile, readdir } from "node:fs/promises"
import { Miniflare, convertV4MiniflareOptions } from "miniflare"
import { app } from "../worker/app"
import * as db from "../worker/db"
import { mcpApiHandler } from "../worker/mcp"

const page = (referenceId: string, attempt: string, path: string, ord: number) => {
  const key = `refs/${referenceId}/${attempt}/p${ord}/desktop.webp`
  return {
    url: `https://example.com${path}`, path, title: path, ord,
    desktopKey: key, desktopThumbKey: key, desktopWidth: 100, desktopHeight: 100,
    mobileKey: null, mobileThumbKey: null, mobileWidth: null, mobileHeight: null,
    snapshotKey: null, stylesKey: null, tokens: null,
    animations: [{ kind: "scroll" as const, label: "Scroll", selector: null, viewport: "desktop" as const, gifKey: key, width: 100, height: 100, sheetKey: null, meta: null }],
  }
}

// Real local D1 and R2 bindings; no deployed resources are used.
test("pages can be saved to many collections without copying files, and survive a recapture", async (t) => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ["DB"], r2Buckets: ["FILES"] }))
  try {
    const database = (await mf.getD1Database("DB")) as unknown as D1Database
    const files = (await mf.getR2Bucket("FILES")) as unknown as R2Bucket
    const dir = new URL("../migrations/", import.meta.url)
    for (const migration of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) {
      const sql = await readFile(new URL(migration, dir), "utf8")
      const statements = sql.replace(/^--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean)
      await database.batch(statements.map((statement) => database.prepare(statement)))
    }

    // Two websites, one pricing page each, plus a home page on the first.
    const capture = async (url: string, paths: string[]) => {
      const ref = await db.createReference(database, { url, mode: "crawl" })
      const job = (await db.claimJob(database))!
      for (const [i, path] of paths.entries()) await db.addPage(database, ref.id, job.attempt, page(ref.id, job.attempt, path, i))
      await db.completeJob(database, ref.id, job.attempt, { title: null, description: null, favicon: null, coverKey: null, tokens: null })
      return (await db.getReference(database, ref.id))!
    }
    const mistral = await capture("https://mistral.ai", ["/", "/pricing"])
    const stripe = await capture("https://stripe.com", ["/pricing"])
    const pricingPages = [mistral.pages[1]!, stripe.pages[0]!]

    const pricing = await db.createCollection(database, "Pricing pages")
    const llm = await db.createCollection(database, "LLM sites")
    await db.setReferenceCollection(database, mistral.reference.id, llm, true)

    const pending: Promise<unknown>[] = []
    const ctx = { waitUntil(p: Promise<unknown>) { pending.push(p) }, passThroughOnException() {} } as ExecutionContext
    const env = { DB: database, FILES: files, SESSION_SECRET: "test-secret", DEV_LOGIN: "max" } as unknown as Env
    const objectCount = async () => (await files.list()).objects.length
    await files.put(pricingPages[0]!.desktopKey!, "stored-screenshot-canary")
    const before = await objectCount()

    assert.deepEqual(await db.setPageCollection(database, pricing, pricingPages.map((p) => p.id), true), { ok: true, changed: 2 })
    assert.deepEqual(await db.setPageCollection(database, pricing, pricingPages.map((p) => p.id), true), { ok: true, changed: 0 }, "saving twice is a no-op")
    assert.deepEqual(await db.setPageCollection(database, "missing", [pricingPages[0]!.id], true), { ok: false, reason: "collection-not-found" })
    // The Mistral pricing page can also sit in a second collection.
    assert.deepEqual(await db.setPageCollection(database, llm, [mistral.pages[1]!.id], true), { ok: true, changed: 1 })
    assert.equal(await objectCount(), before, "collections reference the same stored files")
    assert.equal(await (await files.get(pricingPages[0]!.desktopKey!))!.text(), "stored-screenshot-canary")

    const inPricing = await db.listPages(database, { collectionId: pricing })
    assert.deepEqual(inPricing.items.map((p) => p.desktopKey).sort(), pricingPages.map((p) => p.desktopKey).sort())
    // LLM sites holds Mistral as a whole website, so it lists both Mistral pages once each.
    const inLlm = await db.listPages(database, { collectionId: llm })
    assert.deepEqual(inLlm.items.map((p) => p.path).sort(), ["/", "/pricing"])
    assert.equal((await db.listAnimations(database, { collectionId: pricing })).items.length, 2)
    // The page is still in its website.
    assert.equal((await db.getReference(database, mistral.reference.id))!.pages.length, 2)
    assert.deepEqual((await db.getPage(database, mistral.pages[1]!.id))!.collectionIds.sort(), [llm, pricing].sort())

    const counts = Object.fromEntries((await db.listCollections(database)).map((c) => [c.name, [c.referenceCount, c.pageCount, c.coverKeys.length]]))
    assert.deepEqual(counts["Pricing pages"], [0, 2, 2])
    assert.deepEqual(counts["LLM sites"], [1, 1, 2])

    // A recapture replaces page rows; membership follows the page path.
    await db.requeueReference(database, stripe.reference.id)
    const again = (await db.claimJob(database))!
    await db.addPage(database, stripe.reference.id, again.attempt, page(stripe.reference.id, again.attempt, "/pricing", 0))
    const recaptured = await db.listPages(database, { collectionId: pricing })
    assert.equal(recaptured.items.length, 2)
    assert.ok(recaptured.items.some((p) => p.desktopKey?.includes(again.attempt)))

    // MCP: list collections, then fetch the collection's pages.
    const rpc = async (name: string, args: unknown) => {
      const request = new Request("http://localhost/mcp", {
        method: "POST",
        headers: { host: "localhost", "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      })
      const body = await (await mcpApiHandler.fetch(request, env, ctx)).text()
      return JSON.parse(body.split("\n").find((line) => line.startsWith("data: "))!.slice(6)).result
    }
    const listed = (await rpc("list_collections", {})).structuredContent.collections as { name: string; pageCount: number }[]
    assert.equal(listed.find((c) => c.name === "Pricing pages")?.pageCount, 2)
    const found = (await rpc("search_pages", { collection_id: pricing })).structuredContent
    assert.equal(found.items.length, 2)
    assert.ok(found.items.every((p: { savedTo: string; thumbUrl: string }) => p.savedTo === "page" && p.thumbUrl.includes("sig=")))
    const viaWebsite = (await rpc("search_pages", { collection_id: llm })).structuredContent.items as { path: string; savedTo: string }[]
    assert.deepEqual(viaWebsite.map((p) => p.savedTo).sort(), ["page", "website"])
    const removed = (await rpc("set_page_collection_membership", { page_ids: [mistral.pages[1]!.id], collection_id: pricing, member: false })).structuredContent
    assert.equal(removed.changed, 1)
    assert.ok((await rpc("set_page_collection_membership", { page_ids: ["x"], collection_id: "missing", member: true })).isError)

    // Exercise the authenticated HTTP route, not an early unauthorized response.
    const request = (body: unknown, cid = pricing) => app.request("http://localhost/api/collections/" + cid + "/pages", {
      method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" },
    }, env, ctx)
    assert.equal((await request({})).status, 400)
    assert.equal((await request({ pageIds: Array(201).fill("x") })).status, 400)
    assert.equal((await request({ pageIds: [mistral.pages[1]!.id] }, "missing")).status, 404)
    assert.equal((await request({ pageIds: [mistral.pages[1]!.id], member: true })).status, 200)
    assert.ok((await db.getPage(database, mistral.pages[1]!.id))!.collectionIds.includes(pricing))
    assert.equal((await request({ pageIds: [mistral.pages[1]!.id], member: false })).status, 200)

    await t.test("stale page IDs reject entire add and remove batches through the database, HTTP and MCP", async () => {
      const staleId = stripe.pages[0]!.id
      const replacement = recaptured.items.find((p) => p.referenceId === stripe.reference.id)!
      assert.notEqual(replacement.id, staleId)
      assert.equal(await db.getPage(database, staleId), null)
      await db.setPageCollection(database, pricing, [mistral.pages[1]!.id], true)

      const unchanged = async () => {
        assert.ok(!(await db.getPage(database, mistral.pages[0]!.id))!.collectionIds.includes(pricing), "a valid unsaved page must not be partly added")
        assert.ok((await db.getPage(database, mistral.pages[1]!.id))!.collectionIds.includes(pricing), "a valid saved page must not be partly removed")
        assert.ok((await db.getPage(database, replacement.id))!.collectionIds.includes(pricing), "stale removals must preserve path-based membership")
      }
      for (const member of [true, false]) {
        const validId = mistral.pages[member ? 0 : 1]!.id
        for (const pageIds of [[staleId], [validId, staleId]]) {
          assert.deepEqual(await db.setPageCollection(database, pricing, pageIds, member), { ok: false, reason: "pages-changed" })
          await unchanged()
          const response = await request({ pageIds, member })
          assert.equal(response.status, 409)
          assert.match((await response.json() as { error: string }).error, /Reload this page/)
          await unchanged()
          const result = await rpc("set_page_collection_membership", { page_ids: pageIds, collection_id: pricing, member })
          assert.equal(result.isError, true)
          assert.match(result.content[0].text, /Refresh page IDs with search_pages/)
          await unchanged()
        }
      }
      // Retrying with fresh IDs succeeds, including duplicates and idempotent saves/removals.
      assert.deepEqual(await db.setPageCollection(database, pricing, [replacement.id, replacement.id], true), { ok: true, changed: 0 })
      const freshRemoval = await request({ pageIds: [replacement.id], member: false })
      assert.equal(freshRemoval.status, 200)
      assert.deepEqual(await freshRemoval.json(), { ok: true, changed: 1 })
      assert.deepEqual(await db.setPageCollection(database, pricing, [replacement.id], false), { ok: true, changed: 0 })
      const freshSave = await rpc("set_page_collection_membership", { page_ids: [replacement.id], collection_id: pricing, member: true })
      assert.deepEqual(freshSave.structuredContent, { ok: true, changed: 1 })
      await unchanged()
    })

    // Deleting a collection or a website removes memberships, never the other side's pages.
    await db.deleteCollection(database, llm)
    assert.equal((await db.getReference(database, mistral.reference.id))!.pages.length, 2)
    await db.deleteReference(database, mistral.reference.id)
    assert.equal((await database.prepare("SELECT count(*) AS n FROM page_collections").first<{ n: number }>())!.n, 1)
    await Promise.allSettled(pending)
  } finally {
    await mf.dispose()
  }
})
