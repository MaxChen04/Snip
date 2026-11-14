import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { test } from "node:test"
import { Miniflare, convertV4MiniflareOptions } from "miniflare"
import { loadLibrary, migratedDatabase } from "../../qa/discovery/load"
import { scoreRetrieval } from "../../qa/discovery/retrieval"
import * as db from "../worker/db"
import { mcpApiHandler } from "../worker/mcp"
import { searchPages, searchReferences, searchTerms, variants } from "../worker/search"

test("queries split into stemmed terms without stop words", () => {
  assert.deepEqual(searchTerms("Find the rounded pricing cards!"), ["round", "pric", "card"])
  assert.deepEqual(searchTerms("a an the"), [])
  assert.deepEqual(searchTerms("FAQ faq Faqs"), ["faq"])
  assert.deepEqual(variants("équipe"), ["équipe", "ÉQUIPE", "Équipe"])
  assert.deepEqual(variants("card"), ["card"])
  assert.equal(searchTerms("one two three four five six seven eight nine ten").length, 8)
})

// The fixture library and tasks are the ones the agent evals use (qa/discovery). The numbers are an
// upper bound: the same person wrote the pages and the queries. They guard against regressions.
test("search finds the right page for discovery tasks, where the substring filter did not", async () => {
  const { mf, database, files } = await migratedDatabase()
  try {
    await loadLibrary(database, files)
    const { summary, scores } = await scoreRetrieval(database)
    const missed = scores.filter((s) => s.kind !== "visual" && (s.rank == null || s.rank > 5)).map((s) => s.id)
    assert.deepEqual(missed, [], "every task with a word to find has its page in the top five")
    assert.ok(summary.hit1 >= 0.85, `hit@1 ${summary.hit1}`)
    assert.ok(summary.sectionAccuracy! >= 0.75, `section accuracy ${summary.sectionAccuracy}`)
    assert.ok(summary.baselineHit5 < 0.3, "the old substring filter misses multi-word queries")
  } finally {
    await mf.dispose()
  }
})

test("hits say what matched, carry the note, and follow recaptures and note edits", async () => {
  const { mf, database, files } = await migratedDatabase()
  try {
    const lib = await loadLibrary(database, files)
    const plainleaf = lib.refs.get("https://plainleaf.test")!

    const pages = await searchPages(database, { q: "pricing cards annual toggle" })
    const top = pages.items[0]!
    assert.equal(top.page.path, "/pricing")
    assert.equal(top.reference.domain, "plainleaf.test")
    assert.match(top.notes!, /copy for our pricing page/)
    assert.deepEqual(top.match.unmatched, [])
    assert.deepEqual(top.match.in, ["notes", "section_labels", "page_title", "page_text"])
    assert.equal(top.section?.label, "Simple pricing for growing teams")
    assert.match(top.excerpt!, /Annual/)

    const refs = await searchReferences(database, { q: "pricing cards annual toggle" })
    assert.equal(refs.items[0]!.reference.id, plainleaf)
    assert.equal(refs.items[0]!.bestPage?.path, "/pricing")

    // Limits and cursors page through the ranking without repeats.
    const first = await searchPages(database, { q: "pricing", limit: 2 })
    const second = await searchPages(database, { q: "pricing", limit: 2, cursor: first.nextCursor })
    assert.ok(first.nextCursor)
    assert.equal(new Set([...first.items, ...second.items].map((h) => h.page.id)).size, 4)

    // Scoped to one website.
    const scoped = await searchPages(database, { q: "pricing", referenceId: lib.refs.get("https://tallyho.test")! })
    assert.deepEqual(scoped.items.map((h) => h.reference.domain), ["tallyho.test", "tallyho.test"])

    // A note edit is searchable at once: notes are read from the website, not copied.
    await db.setNotes(database, lib.refs.get("https://pebble.test")!, "Purple gradient hero")
    assert.equal((await searchPages(database, { q: "purple gradient" })).items[0]?.reference.domain, "pebble.test")

    // Non-ASCII letters: LIKE folds ASCII case only, so a lowercase query still finds an uppercase title.
    await db.setNotes(database, lib.refs.get("https://kiln.test")!, "ÉQUIPE éditoriale")
    assert.equal((await searchReferences(database, { q: "équipe" })).items[0]?.reference.domain, "kiln.test")
    assert.equal((await searchReferences(database, { q: "ÉQUIPE" })).items[0]?.reference.domain, "kiln.test")

    // A recapture removes the old pages' text with them.
    await db.requeueReference(database, plainleaf)
    const orphans = await database.prepare(`SELECT count(*) AS n FROM page_text WHERE page_id NOT IN (SELECT id FROM pages)`).first<{ n: number }>()
    assert.equal(orphans?.n, 0)
    assert.equal((await searchPages(database, { q: "ledger" })).items.length, 0)
    await db.deleteReference(database, lib.refs.get("https://harbor.test")!)
    assert.equal((await searchPages(database, { q: "newsletter" })).items.length, 0)
  } finally {
    await mf.dispose()
  }
})

test("pages captured before page text keep their section labels searchable", async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ["DB"] }))
  try {
    const database = (await mf.getD1Database("DB")) as unknown as D1Database
    const dir = new URL("../migrations/", import.meta.url)
    const apply = async (name: string) => {
      const sql = await readFile(new URL(name, dir), "utf8")
      const statements = sql.replace(/^--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean)
      await database.batch(statements.map((s) => database.prepare(s)))
    }
    const all = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()
    const at = all.indexOf("0016_page_text.sql")
    for (const m of all.slice(0, at)) await apply(m)
    // Seed the old schema directly: today's lease-aware capture code requires later migrations.
    await database.prepare(`INSERT INTO refs (id, url, domain, mode, status, created_at, updated_at) VALUES ('old-ref', 'https://old.test', 'old.test', 'single', 'ready', '2026-01-01', '2026-01-01')`).run()
    const sections = [{ kind: "section", label: "Customer stories", y: 0, height: 100, key: "refs/old-ref/old-attempt/s0.jpg" }]
    await database.prepare(`INSERT INTO pages (id, reference_id, url, path, title, ord, sections_json, created_at) VALUES ('p1', 'old-ref', 'https://old.test/', '/', 'Old', 0, ?, '2026-01-01')`).bind(JSON.stringify(sections)).run()
    for (const m of all.slice(at)) await apply(m)
    const hit = (await searchPages(database, { q: "customer stories" })).items[0]
    assert.equal(hit?.page.id, "p1")
    assert.deepEqual(hit?.match.in, ["section_labels"])
    assert.equal(hit?.section?.label, "Customer stories")
  } finally {
    await mf.dispose()
  }
})

test("search_pages over MCP returns ranked hits with match details", async () => {
  const { mf, database, files } = await migratedDatabase()
  try {
    await loadLibrary(database, files)
    const env = { DB: database, FILES: files, SESSION_SECRET: "test-secret" } as unknown as Env
    const ctx = { waitUntil() {}, passThroughOnException() {}, props: { ownerId: "max" } } as unknown as ExecutionContext
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await mcpApiHandler.fetch(new Request("http://localhost:5173/mcp", {
        method: "POST",
        headers: { host: "localhost:5173", "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      }), env, ctx)
      const line = (await res.text()).split("\n").find((l) => l.startsWith("data: "))!
      return JSON.parse(line.slice(6)).result.structuredContent as Record<string, any>
    }
    const pages = await call("search_pages", { query: "testimonials wall" })
    assert.equal(pages.items[0].reference.domain, "orbitly.test")
    assert.match(pages.items[0].notes, /Testimonials wall/)
    assert.deepEqual(pages.items[0].match.matched, ["testimonial", "wall"])
    assert.deepEqual(pages.terms, ["testimonial", "wall"])
    await database.prepare(`UPDATE pages SET warnings_json = '["truncated"]' WHERE id = ?`).bind(pages.items[0].id).run()
    const warned = await call("search_pages", { query: "testimonials wall" })
    assert.deepEqual(warned.items[0].warnings, ["truncated"], "ranked MCP hits keep captured-page warnings")

    const refs = await call("search_references", { query: "team grid" })
    assert.equal(refs.items[0].domain, "northstar.test")
    assert.equal(refs.items[0].bestPage.path, "/about")

    // An explicit sort keeps the old listing.
    const newest = await call("search_references", { query: "Kiln", sort: "newest" })
    assert.deepEqual(newest.items.map((r: { domain: string }) => r.domain), ["kiln.test"])
    assert.equal(newest.items[0].match, undefined)
  } finally {
    await mf.dispose()
  }
})

/** A D1 that records every column name and the bytes of every row it returns. */
function recording(database: D1Database) {
  const seen = { columns: new Set<string>(), bytes: 0 }
  const note = (rows: unknown[]) => {
    for (const row of rows) {
      if (!row || typeof row !== "object") continue
      for (const k of Object.keys(row)) seen.columns.add(k)
      seen.bytes += JSON.stringify(row).length
    }
  }
  const wrap = (stmt: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(stmt, {
      get(target, prop) {
        if (prop === "bind") return (...a: unknown[]) => wrap(target.bind(...a))
        if (prop === "all") return async () => { const r = await target.all(); note(r.results); return r }
        if (prop === "first") return async (col?: string) => { const r = await (col ? target.first(col) : target.first()); if (!col) note([r]); return r }
        return Reflect.get(target, prop)
      },
    })
  const db = new Proxy(database, {
    get(target, prop) {
      if (prop === "prepare") return (sql: string) => wrap(target.prepare(sql))
      return Reflect.get(target, prop)
    },
  })
  return { db, seen }
}

test("search reads no tokens, capture options or crawl state, which it never returns", async () => {
  const { mf, database, files } = await migratedDatabase()
  try {
    await loadLibrary(database, files)
    const read = async () => {
      const { db: watched, seen } = recording(database)
      await searchPages(watched, { q: "pricing plans" })
      await searchReferences(watched, { q: "pricing plans" })
      await db.listPages(watched, { limit: 20 })
      await db.listReferences(watched, { limit: 20, summary: true })
      return seen
    }
    const before = await read()
    // Real captures carry tens of KB of tokens per page and per website: adding them must not change what is read.
    const tokens = JSON.stringify({ colors: Array.from({ length: 400 }, (_, i) => ({ value: `#${String(i).padStart(6, "0")}`, count: i })) })
    await database.batch([database.prepare(`UPDATE pages SET tokens_json = ?`).bind(tokens), database.prepare(`UPDATE refs SET tokens_json = ?, crawl_state = ?`).bind(tokens, tokens)])
    const after = await read()
    for (const column of ["tokens_json", "capture_options", "crawl_state", "preview_keys"]) assert.ok(!after.columns.has(column), `${column} was read`)
    assert.equal(after.bytes, before.bytes)
  } finally {
    await mf.dispose()
  }
})
