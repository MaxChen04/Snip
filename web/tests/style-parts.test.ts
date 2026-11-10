import { test } from "node:test"
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { Miniflare, convertV4MiniflareOptions } from "miniflare"
import { mcpApiHandler } from "../worker/mcp"
import * as db from "../worker/db"
import { readStylePart } from "../worker/files"
import { encodeCursor } from "../worker/mcp-bounds"
import { STYLE_CHUNK_ELEMENTS, packStyles, stylePartsKey, validStylesSummary, type CapturedStyles, type StyleIndexEntry } from "../shared/style-parts"
import type { PageUpload } from "../shared/types"

test("the capture agent carries an identical copy of style-parts", async () => {
  const shared = await readFile(new URL("../shared/style-parts.ts", import.meta.url), "utf8")
  const capture = await readFile(new URL("../../capture/src/style-parts.ts", import.meta.url), "utf8")
  assert.equal(capture, shared)
})

test("the parts file sits next to the styles file", () => {
  assert.equal(stylePartsKey("refs/a/b/p0/styles.json"), "refs/a/b/p0/styles-parts.gzm")
  assert.equal(stylePartsKey("refs/a/b/p0/styles.gz.json"), "refs/a/b/p0/styles-parts.gzm")
  assert.equal(stylePartsKey("refs/a/b/p0/other.json"), null)
})

function styles(n = 700): CapturedStyles {
  return {
    viewport: { width: 1440, height: 900 },
    document: { width: 1440, height: 5000 },
    elementCount: n,
    truncated: false,
    elements: Array.from({ length: n }, (_, i) => ({
      sel: i % 4 ? `main > div.Card-${i}` : `header > nav > a:nth-of-type(${i})`,
      ...(i % 3 ? { text: i % 5 ? `Item ${i}` : `See PRICING ${i}` } : {}),
      rect: { x: 0, y: i * 10, w: 100, h: 10 },
      // One element too large for a response, so results carry an omission marker with its position.
      styles: i === 262 ? { color: "#111", "background-image": "x".repeat(30_000) } : { color: "#111" },
    })),
    keyframes: [{ name: "fade", css: "@keyframes fade {}" }, { name: "fade", css: "@keyframes fade {}" }, { name: "spin", css: "@keyframes spin {}" }],
    hoverRules: Array.from({ length: 30 }, (_, i) => `.a${i}:hover { color: red }`),
    fontFaces: [`@font-face { src: url("data:${"x".repeat(300)}") }`],
    cssVariables: { "--a": "1px", "--b": "2px" },
  }
}

test("each part decodes on its own from a range read", async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', r2Buckets: ["FILES"] }))
  try {
    const FILES = (await mf.getR2Bucket("FILES")) as unknown as R2Bucket
    const s = styles()
    const key = "refs/r/a/p0/styles-parts.gzm"
    const { bytes, summary } = await packStyles(s, key)
    await FILES.put(key, bytes)
    assert.equal(summary.elements, 700)
    assert.equal(summary.parts.elements.length, Math.ceil(700 / STYLE_CHUNK_ELEMENTS))
    assert.deepEqual(summary.keyframes, ["fade", "spin"])
    const index = await readStylePart<StyleIndexEntry[]>(FILES, key, summary.parts.index)
    assert.equal(index!.length, 700)
    assert.deepEqual(index![5], ["main > div.card-5", "see pricing 5"])
    assert.deepEqual(index![0], ["header > nav > a:nth-of-type(0)", null])
    const last = await readStylePart<unknown[]>(FILES, key, summary.parts.elements.at(-1)!)
    assert.deepEqual(last, s.elements!.slice(2 * STYLE_CHUNK_ELEMENTS))
    // A range that doesn't land on a member reads as missing, so the caller falls back to the full file.
    assert.equal(await readStylePart(FILES, key, [3, 40]), null)

    assert.ok(validStylesSummary(summary, "refs/r/a/"))
    assert.ok(!validStylesSummary(summary, "refs/r/other/"), "parts outside the capture's prefix")
    assert.ok(!validStylesSummary({ ...summary, parts: { ...summary.parts, elements: summary.parts.elements.slice(1) } }, "refs/r/a/"))
    assert.ok(!validStylesSummary({ ...summary, v: 2 }, "refs/r/a/"))
  } finally {
    await mf.dispose()
  }
})

async function setup() {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ["DB"], r2Buckets: ["FILES"] }))
  const DB = (await mf.getD1Database("DB")) as unknown as D1Database
  const FILES = (await mf.getR2Bucket("FILES")) as unknown as R2Bucket
  const dir = new URL("../migrations/", import.meta.url)
  for (const migration of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = await readFile(new URL(migration, dir), "utf8")
    await DB.batch(sql.replace(/^--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean).map((s) => DB.prepare(s)))
  }
  // put can be held open, to stand a background write still in flight while something else happens.
  let hold: Promise<void> | null = null
  const files = new Proxy(FILES, {
    get(t, k) {
      if (k === "put") return async (...a: Parameters<R2Bucket["put"]>) => { if (hold) await hold; return t.put(...a) }
      const v = Reflect.get(t, k)
      return typeof v === "function" ? v.bind(t) : v
    },
  })
  const env = { DB, FILES: files, SESSION_SECRET: "test" } as unknown as Env
  const pending: Promise<unknown>[] = []
  async function call(name: string, args: Record<string, unknown>) {
    const request = new Request("http://localhost/mcp", {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    })
    const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p), props: { ownerId: "max" } } as unknown as ExecutionContext
    const body = await (await mcpApiHandler.fetch(request, env, ctx)).text()
    const line = body.split("\n").find((l) => l.startsWith("data: "))
    const msg = JSON.parse(line ? line.slice(6) : body)
    return msg.result as { structuredContent?: any; isError?: boolean; content: { text: string }[] }
  }
  const settle = async () => {
    await Promise.all(pending.splice(0))
  }

  /** A crawl with `pages` pages, one hover recording each; `split` decides which pages get a summary at capture. */
  async function crawl(pages: number, split: (i: number) => boolean, name = "styles.json") {
    const ref = await db.createReference(DB, { url: "https://example.com", mode: "crawl", maxPages: 200 })
    const job = (await db.claimJob(DB))!
    const ids: string[] = []
    for (let i = 0; i < pages; i++) {
      const p = `refs/${ref.id}/${job.attempt}/p${i}`
      const stylesKey = `${p}/${split(i) ? "styles.json" : name}`
      const s = styles()
      await FILES.put(stylesKey, JSON.stringify(s))
      let stylesSummary
      if (split(i)) {
        const packed = await packStyles(s, stylePartsKey(stylesKey)!)
        await FILES.put(packed.summary.parts.key, packed.bytes)
        stylesSummary = packed.summary
      }
      const upload: PageUpload = {
        url: `https://example.com/p${i}`, path: `/p${i}`, title: `Page ${i}`, ord: i,
        desktopKey: `${p}/d.jpg`, desktopThumbKey: `${p}/t.jpg`, desktopWidth: 1440, desktopHeight: 900,
        mobileKey: null, mobileThumbKey: null, mobileWidth: null, mobileHeight: null,
        snapshotKey: null, stylesKey, stylesSummary, tokens: null,
        animations: [{ kind: "hover", label: `A${i}`, selector: `.a${i}`, viewport: "desktop", gifKey: `${p}/a.webm`, width: 10, height: 10, sheetKey: null, meta: null }],
      }
      ids.push((await db.addPage(DB, ref.id, job.attempt, upload))!)
    }
    await db.completeJob(DB, ref.id, job.attempt, { title: "Example", description: null, favicon: null, coverKey: null, tokens: null })
    return { refId: ref.id, pageIds: ids }
  }
  const holdPuts = () => {
    let release!: () => void
    hold = new Promise((r) => (release = r))
    return () => { hold = null; release() }
  }
  return { mf, DB, FILES, call, settle, crawl, holdPuts }
}

const STYLE_CALLS: Record<string, unknown>[] = [
  {},
  { section: "elements" },
  { section: "elements", offset: 240, limit: 30 },
  { section: "elements", selector_contains: "card", offset: 190, limit: 20 },
  { section: "elements", offset: 690, limit: 40 },
  { section: "elements", selector_contains: "NAV" },
  { section: "elements", selector_contains: "nav", offset: 100, limit: 50 },
  { section: "elements", text_contains: "pricing", limit: 200 },
  { section: "elements", selector_contains: "card", text_contains: "item 7" },
  { section: "elements", selector_contains: "no such thing" },
  { section: "keyframes" },
  { section: "hover_rules", offset: 10, limit: 5 },
  { section: "font_faces" },
  { section: "css_variables" },
]

test("get_page_styles answers the same from parts as from the full styles file", async () => {
  const { mf, call, crawl } = await setup()
  try {
    // The other page's file is named so it is never split on read: every call below reads it whole.
    const { pageIds } = await crawl(2, (i) => i === 0, "unsplittable-styles.json")
    const [split, whole] = pageIds as [string, string]
    for (const args of STYLE_CALLS) {
      const a = (await call("get_page_styles", { page_id: split, ...args })).structuredContent
      const b = (await call("get_page_styles", { page_id: whole, ...args })).structuredContent
      assert.deepEqual({ ...a, pageId: null }, { ...b, pageId: null }, JSON.stringify(args))
    }
  } finally {
    await mf.dispose()
  }
})

test("a page captured before parts is split on its first read, and later reads skip the full file", async () => {
  const { mf, DB, FILES, call, settle, crawl } = await setup()
  try {
    const { pageIds } = await crawl(1, () => false)
    const id = pageIds[0]!
    const first = (await call("get_page_styles", { page_id: id, section: "elements", text_contains: "pricing" })).structuredContent
    await settle()
    const page = await db.getPage(DB, id)
    assert.ok(page!.stylesSummary, "the summary was saved")
    assert.ok(await FILES.head(page!.stylesSummary!.parts.key), "the parts file was written")
    // With the full file gone, only the parts can answer.
    await FILES.delete(page!.stylesKey!)
    const second = (await call("get_page_styles", { page_id: id, section: "elements", text_contains: "pricing" })).structuredContent
    assert.deepEqual(second, first)
    assert.equal((await call("get_page_styles", { page_id: id })).structuredContent.elements.total, 700)
  } finally {
    await mf.dispose()
  }
})

test("a missing parts file falls back to the full styles file", async () => {
  const { mf, DB, FILES, call, crawl } = await setup()
  try {
    const { pageIds } = await crawl(1, () => true)
    const page = await db.getPage(DB, pageIds[0]!)
    await FILES.delete(page!.stylesSummary!.parts.key)
    const res = (await call("get_page_styles", { page_id: page!.id, section: "elements", selector_contains: "nav", limit: 3 })).structuredContent
    assert.equal(res.total, 175)
    assert.equal(res.items[0].sel, "header > nav > a:nth-of-type(0)")
  } finally {
    await mf.dispose()
  }
})

test("get_reference pages and animations page through every row once, in order", async () => {
  const { mf, DB, call, crawl } = await setup()
  try {
    const { refId, pageIds } = await crawl(60, () => false)
    for (const part of ["pages", "animations"]) {
      const seen: string[] = []
      let cursor: string | undefined
      let calls = 0
      do {
        const res = (await call("get_reference", { id: refId, part, limit: 25, ...(cursor ? { cursor } : {}) })).structuredContent
        assert.equal(res.total, 60)
        assert.equal(res.offset, seen.length)
        seen.push(...res.items.map((x: { id: string; pageId?: string }) => (part === "pages" ? x.id : x.pageId)))
        cursor = res.nextCursor ?? undefined
        calls++
      } while (cursor)
      assert.equal(calls, 3)
      assert.deepEqual(seen, pageIds, part)
    }
    const overview = (await call("get_reference", { id: refId, part: "overview" })).structuredContent
    assert.equal(overview.pages.length, 20)
    assert.deepEqual(overview.omitted.pages, 40)
    assert.deepEqual(overview.omitted.animations, 40)
    // A cursor from before keyed paging (offset only) is refused rather than restarting silently.
    const rev = (await db.getReferenceRecord(DB, refId))!.updatedAt
    const old = encodeCursor({ referenceId: refId, part: "pages", offset: 25, rev })
    const refused = await call("get_reference", { id: refId, part: "pages", cursor: old })
    assert.equal(refused.isError, true)
    assert.match(refused.content[0]!.text, /older version/)
  } finally {
    await mf.dispose()
  }
})

test("deleting a capture while its styles are being split leaves no file behind", async () => {
  const { mf, DB, FILES, call, settle, crawl, holdPuts } = await setup()
  try {
    const { refId, pageIds } = await crawl(1, () => false)
    const page = (await db.getPage(DB, pageIds[0]!))!
    const partsKey = stylePartsKey(page.stylesKey!)!
    const release = holdPuts()
    await call("get_page_styles", { page_id: page.id })
    while (!(await DB.prepare("SELECT 1 FROM capture_uploads").first())) await new Promise((r) => setTimeout(r, 5))
    // The split is waiting to write. Delete the capture and sweep its storage meanwhile.
    await db.deleteReference(DB, refId)
    await db.cleanupRetiredFiles(DB, FILES)
    assert.ok(await DB.prepare("SELECT 1 FROM capture_cleanup").first(), "the tombstone outlives the sweep while the write is pending")
    release()
    await settle()
    assert.equal(await FILES.head(partsKey), null, "the late write removed itself")
    // The next retry of the sweep, without waiting out its backoff.
    await DB.prepare("UPDATE capture_cleanup SET next_attempt = NULL").run()
    await db.cleanupRetiredFiles(DB, FILES)
    assert.equal(await DB.prepare("SELECT 1 FROM capture_cleanup").first(), null)
    assert.equal(await DB.prepare("SELECT 1 FROM capture_uploads").first(), null)
    // After deletion, a split never starts.
    const again = await db.beginStylePartsUpload(DB, page.id, page.stylesKey!, partsKey)
    assert.equal(again, null)
  } finally {
    await mf.dispose()
  }
})
