import { test } from "node:test"
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { Miniflare, convertV4MiniflareOptions } from "miniflare"
import { mcpApiHandler } from "../worker/mcp"
import * as db from "../worker/db"
import type { PageUpload } from "../shared/types"

// What an agent that has never seen Snip relies on: tool hints it can trust, links it can hand the user,
// a reason whenever something is missing, and one section's markup without reading the whole document.

const FILLER = "<!-- " + "x".repeat(60_000) + " -->"
const HTML = "<html><head><title>Orbitly</title></head><body><nav><a>Loved by teams</a></nav>" + FILLER +
  '<section class="quotes"><h2>Loved by teams</h2><div class="grid"><figure><blockquote>Hours saved.</blockquote></figure><div>Nested</div></div></section>' +
  FILLER + "<footer>Orbitly</footer></body></html>"

async function setup() {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ["DB"], r2Buckets: ["FILES"] }))
  const DB = (await mf.getD1Database("DB")) as unknown as D1Database
  const FILES = (await mf.getR2Bucket("FILES")) as unknown as R2Bucket
  const dir = new URL("../migrations/", import.meta.url)
  for (const migration of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = await readFile(new URL(migration, dir), "utf8")
    const statements = sql.replace(/^--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean)
    await DB.batch(statements.map((statement) => DB.prepare(statement)))
  }
  const env = { DB, FILES, SESSION_SECRET: "test" } as unknown as Env
  async function rpc(method: string, params: Record<string, unknown>) {
    const request = new Request("http://localhost/mcp", {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    })
    const response = await mcpApiHandler.fetch(request, env, { waitUntil() {}, props: { ownerId: "max" } } as unknown as ExecutionContext)
    const body = await response.text()
    const line = body.split("\n").find((l) => l.startsWith("data: "))
    return JSON.parse(line ? line.slice(6) : body).result as Record<string, any>
  }
  const call = async (name: string, args: Record<string, unknown>) => (await rpc("tools/call", { name, arguments: args })).structuredContent as Record<string, any>

  const ref = await db.createReference(DB, { url: "https://orbitly.test", mode: "single" })
  const job = (await db.claimJob(DB))!
  const snapshotKey = "refs/" + ref.id + "/" + job.attempt + "/p0/snapshot.html"
  await FILES.put(snapshotKey, HTML, { httpMetadata: { contentType: "text/html" } })
  const page: PageUpload = {
    url: "https://orbitly.test/", path: "/", title: "Orbitly", ord: 0,
    desktopKey: null, desktopThumbKey: null, desktopWidth: null, desktopHeight: null,
    mobileKey: null, mobileThumbKey: null, mobileWidth: null, mobileHeight: null,
    snapshotKey, stylesKey: null, tokens: null, animations: [],
  }
  const pageId = (await db.addPage(DB, ref.id, job.lease, page))!
  await db.completeJob(DB, ref.id, job.lease, { title: "Orbitly", description: null, favicon: null, coverKey: null, tokens: null })
  return { mf, rpc, call, pageId, refId: ref.id }
}

test("every tool states whether it writes, and writes say whether they can undo the user's work", async () => {
  const { mf, rpc } = await setup()
  try {
    const { tools } = await rpc("tools/list", {})
    const writes = new Set(["add_reference", "set_reference_notes", "create_collection", "set_collection_membership", "set_page_collection_membership"])
    for (const t of tools as { name: string; title?: string; annotations?: Record<string, boolean> }[]) {
      assert.ok(t.title, t.name + " has a title")
      if (writes.has(t.name)) {
        assert.equal(t.annotations?.readOnlyHint, false, t.name)
        assert.equal(typeof t.annotations?.destructiveHint, "boolean", t.name + " says whether it can remove or overwrite")
      } else {
        assert.equal(t.annotations?.readOnlyHint, true, t.name)
        assert.equal(t.annotations?.openWorldHint, false, t.name + " reads only the library")
      }
    }
    // Removing from a board and replacing a note are not additive.
    const hint = (name: string) => (tools as { name: string; annotations: Record<string, boolean> }[]).find((t) => t.name === name)!.annotations
    assert.equal(hint("set_page_collection_membership").destructiveHint, true)
    assert.equal(hint("set_reference_notes").destructiveHint, true)
    assert.equal(hint("create_collection").destructiveHint, false)
    assert.equal(hint("add_reference").openWorldHint, true, "capturing visits an outside site")
  } finally {
    await mf.dispose()
  }
})

test("the first 512 characters of the instructions name the core tools and the app's word for collections", async () => {
  const { mf, rpc } = await setup()
  try {
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } })
    const opening = (init.instructions as string).slice(0, 512)
    for (const name of ["search_pages", "search_references", "get_page", "add_reference", "wait_for_capture"]) assert.ok(opening.includes(name), name)
    assert.match(opening, /Boards in the Snip app are called collections/)
    assert.ok((init.instructions as string).length <= 4096, "within Claude Code's instruction budget")
  } finally {
    await mf.dispose()
  }
})

test("a board comes back with a link the user can open", async () => {
  const { mf, call, pageId } = await setup()
  try {
    const created = await call("create_collection", { name: " Pricing inspiration " })
    assert.equal(created.name, "Pricing inspiration")
    assert.equal(created.appUrl, "http://localhost/b/" + created.id)
    const added = await call("set_page_collection_membership", { page_ids: [pageId], collection_id: created.id, member: true })
    assert.deepEqual(added, { ok: true, changed: 1, collectionId: created.id, appUrl: created.appUrl })
    const { collections } = await call("list_collections", {})
    assert.equal(collections[0].appUrl, created.appUrl)
  } finally {
    await mf.dispose()
  }
})

test("get_page says what was not captured instead of returning bare nulls", async () => {
  const { mf, call, pageId } = await setup()
  try {
    const page = await call("get_page", { page_id: pageId, image: "none" })
    assert.equal(page.htmlSnapshotUrl !== null, true)
    assert.deepEqual(Object.keys(page.unavailable).sort(), ["styles", "tokens"])
  } finally {
    await mf.dispose()
  }
})

test("html_find returns the element around the text, not the whole document", async () => {
  const { mf, call, pageId } = await setup()
  try {
    const first = (await call("get_page", { page_id: pageId, image: "none", include_html: true, html_find: "loved by TEAMS" })).html
    assert.equal(first.found.element, "nav", "the first match is the nav link")
    assert.equal(first.content, "<nav><a>Loved by teams</a></nav>")
    const second = (await call("get_page", { page_id: pageId, image: "none", include_html: true, html_find: "Loved by teams", html_offset: first.found.nextSearchFrom })).html
    assert.equal(second.found.element, "section")
    assert.match(second.content, /^<section class="quotes"><h2>Loved by teams<\/h2>.*<\/section>$/)
    assert.equal(second.nextOffset, null)
    assert.equal(second.totalChars, HTML.length)

    const missing = (await call("get_page", { page_id: pageId, image: "none", include_html: true, html_find: "pricing table" })).html
    assert.equal(missing.included, false)
    assert.match(missing.reason, /does not appear/)

    // Without html_find nothing changes: the document from the top, in 40,000-character chunks.
    const whole = (await call("get_page", { page_id: pageId, image: "none", include_html: true })).html
    assert.equal(whole.offset, 0)
    assert.equal(whole.content.length, 40_000)
    assert.equal(whole.hint, undefined)
  } finally {
    await mf.dispose()
  }
})
