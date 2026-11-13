import { readdir, readFile } from "node:fs/promises"
import { Miniflare, convertV4MiniflareOptions } from "miniflare"
import { mcpApiHandler } from "../../worker/mcp"
import * as db from "../../worker/db"
import type { PageUpload } from "../../shared/types"

// How much a small MCP request reads, as a reference grows. Builds a synthetic reference of N pages
// (each with page tokens the size real captures carry and a 3,000-element styles file) and reports,
// per tool call: D1 rows read and returned, D1 bytes returned, R2 objects and bytes read, and the
// response size and wall time (Miniflare in Node, so only relative). Run: node --import tsx web/tests/bench/mcp-reads.ts [pages...] (default 20 200)

const sizes = process.argv.slice(2).map(Number).filter((n) => n > 0)
const PAGE_COUNTS = sizes.length ? sizes : [20, 200]

const words = "pricing plans team enterprise start free trial contact sales features integrations security docs blog careers about".split(" ")
const pick = (i: number, n = 3) => Array.from({ length: n }, (_, k) => words[(i * 7 + k * 3) % words.length]).join(" ")

function pageTokens(i: number) {
  const list = (n: number, f: (k: number) => string) => Array.from({ length: n }, (_, k) => ({ value: f(k), count: 100 - k }))
  return {
    colors: list(48, (k) => `#${((i * 9973 + k * 7919) % 0xffffff).toString(16).padStart(6, "0")}`),
    fonts: [{ family: "Inter, system-ui, sans-serif", count: 400 }, { family: "\"JetBrains Mono\", monospace", count: 30 }],
    fontSizes: list(24, (k) => `${10 + k}px`),
    spacing: list(24, (k) => `${k * 4}px`),
    radii: list(16, (k) => `${k}px`),
    shadows: list(12, (k) => `rgba(0, 0, 0, 0.${k}) 0px ${k}px ${k * 2}px 0px`),
    transitions: list(24, (k) => `opacity 0.${k}s cubic-bezier(0.4, 0, 0.2, 1)`),
    keyframes: ["fade-in", "slide-up", "spin"],
    cssVariables: Object.fromEntries(Array.from({ length: 300 }, (_, k) => [`--token-${k}-color-surface`, `rgb(${k % 255} ${(k * 3) % 255} ${(k * 7) % 255})`])),
  }
}

function stylesFile(i: number) {
  const elements = Array.from({ length: 3000 }, (_, k) => ({
    sel: `body > main > section:nth-of-type(${(k % 12) + 1}) > div.${k % 5 ? "card" : "nav"}-${k % 40} > ${["h3", "p", "a", "button", "span"][k % 5]}`,
    tag: ["h3", "p", "a", "button", "span"][k % 5],
    ...(k % 3 ? { text: pick(k + i, 4) } : {}),
    rect: { x: k % 1440, y: k * 13, w: 320, h: 40 },
    styles: { color: "#111827", "font-size": "16px", "line-height": "24px", "padding-top": "8px", "padding-bottom": "8px", "border-radius": "12px", display: "flex", "align-items": "center", gap: "8px" },
  }))
  return {
    url: `https://example.com/p${i}`,
    viewport: { width: 1440, height: 900 },
    document: { width: 1440, height: 9000 },
    elementCount: elements.length,
    truncated: true,
    elements,
    keyframes: [{ name: "fade-in", css: "@keyframes fade-in { from { opacity: 0 } to { opacity: 1 } }" }],
    fontFaces: ["@font-face { font-family: Inter; src: url(\"/inter.woff2\") }"],
    hoverRules: Array.from({ length: 80 }, (_, k) => `.card-${k}:hover { transform: translateY(-2px) }`),
    cssVariables: pageTokens(i).cssVariables,
    tokens: pageTokens(i),
  }
}

// Present after the style-parts change; absent on older code, where the bench still runs.
const parts = await import("../../shared/style-parts").catch(() => null)

async function build(pageCount: number) {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ["DB"], r2Buckets: ["FILES"] }))
  const DB = (await mf.getD1Database("DB")) as unknown as D1Database
  const FILES = (await mf.getR2Bucket("FILES")) as unknown as R2Bucket
  const dir = new URL("../../migrations/", import.meta.url)
  for (const m of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = await readFile(new URL(m, dir), "utf8")
    await DB.batch(sql.replace(/^--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean).map((s) => DB.prepare(s)))
  }
  const ref = await db.createReference(DB, { url: "https://example.com", mode: "crawl", maxPages: 200 })
  const job = (await db.claimJob(DB))!
  const pageIds: string[] = []
  let animationId = ""
  for (let i = 0; i < pageCount; i++) {
    const p = `refs/${ref.id}/${job.attempt}/p${i}`
    const styles = stylesFile(i)
    const stylesKey = `${p}/styles.json`
    await FILES.put(stylesKey, JSON.stringify(styles))
    let stylesSummary: unknown
    if (parts) {
      const key = parts.stylePartsKey(stylesKey)!
      const packed = await parts.packStyles(styles, key)
      await FILES.put(key, packed.bytes)
      stylesSummary = packed.summary
    }
    const upload: PageUpload & { stylesSummary?: unknown } = {
      url: `https://example.com/p${i}`, path: `/p${i}`, title: `Page ${i}`, ord: i,
      desktopKey: `${p}/desktop.jpg`, desktopThumbKey: `${p}/desktop-thumb.jpg`, desktopWidth: 1440, desktopHeight: 9000,
      mobileKey: null, mobileThumbKey: null, mobileWidth: null, mobileHeight: null,
      snapshotKey: null, stylesKey, tokens: pageTokens(i) as never, stylesSummary,
      animations: [{ kind: "hover", label: `Card ${i}`, selector: `.card-${i}`, viewport: "desktop", gifKey: `${p}/a.webm`, width: 320, height: 200, sheetKey: null, meta: null } as never],
    }
    const id = await db.addPage(DB, ref.id, job.lease, upload)
    if (!id) throw new Error(`Benchmark capture lost its lease while saving page ${i}`)
    pageIds.push(id!)
  }
  await db.completeJob(DB, ref.id, job.lease, { title: "Example", description: null, favicon: null, coverKey: null, tokens: pageTokens(0) as never })
  animationId = (await DB.prepare("SELECT id FROM animations LIMIT 1").first<{ id: string }>())!.id
  return { mf, DB, FILES, refId: ref.id, pageId: pageIds[0]!, animationId }
}

function metered(DB: D1Database, FILES: R2Bucket) {
  const m = { rowsRead: 0, rowsReturned: 0, d1Bytes: 0, r2Gets: 0, r2Bytes: 0 }
  const tally = (r: D1Result<unknown>) => {
    m.rowsRead += r.meta?.rows_read ?? 0
    m.rowsReturned += r.results?.length ?? 0
    m.d1Bytes += JSON.stringify(r.results ?? []).length
    return r
  }
  const wrap = (s: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(s, {
      get(t, k) {
        if (k === "bind") return (...a: unknown[]) => wrap(t.bind(...a))
        if (k === "all") return async () => tally(await t.all())
        if (k === "run") return async () => tally(await t.run())
        if (k === "first")
          return async (col?: string) => {
            const r = tally(await t.all<Record<string, unknown>>())
            const row = r.results[0] ?? null
            return col ? (row?.[col] ?? null) : row
          }
        if (k === "raw") return t.raw.bind(t)
        return Reflect.get(t, k)
      },
    })
  const DBm = new Proxy(DB, {
    get(t, k) {
      if (k === "prepare") return (sql: string) => wrap(t.prepare(sql))
      if (k === "batch") return async (stmts: D1PreparedStatement[]) => (await t.batch(stmts)).map(tally)
      return Reflect.get(t, k).bind?.(t) ?? Reflect.get(t, k)
    },
  })
  const FILESm = new Proxy(FILES, {
    get(t, k) {
      if (k === "get")
        return async (key: string, o?: R2GetOptions) => {
          const obj = await t.get(key, o)
          m.r2Gets++
          if (obj) m.r2Bytes += obj.range && "length" in obj.range && obj.range.length != null ? obj.range.length : obj.size
          return obj
        }
      const v = Reflect.get(t, k)
      return typeof v === "function" ? v.bind(t) : v
    },
  })
  return { m, env: { DB: DBm, FILES: FILESm, SESSION_SECRET: "bench-secret" } as unknown as Env }
}

async function call(env: Env, name: string, args: Record<string, unknown>) {
  const request = new Request("http://localhost/mcp", {
    method: "POST",
    headers: { host: "localhost", "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  })
  const res = await mcpApiHandler.fetch(request, env, { waitUntil() {}, props: { ownerId: "max" } } as unknown as ExecutionContext)
  const body = await res.text()
  const line = body.split("\n").find((l) => l.startsWith("data: "))
  const msg = JSON.parse(line ? line.slice(6) : body)
  if (msg.error || msg.result?.isError) throw new Error(`${name}: ${JSON.stringify(msg.error ?? msg.result.content)}`)
  return (msg.result.content[0].text as string).length
}

const rows: Record<string, unknown>[] = []
for (const n of PAGE_COUNTS) {
  const { mf, DB, FILES, refId, pageId, animationId } = await build(n)
  const cases: [string, string, Record<string, unknown>][] = [
    ["get_reference tokens", "get_reference", { id: refId, part: "tokens" }],
    ["get_reference tokens colors", "get_reference", { id: refId, part: "tokens", token_group: "colors" }],
    ["get_reference overview", "get_reference", { id: refId, part: "overview" }],
    ["get_reference pages", "get_reference", { id: refId, part: "pages" }],
    ["get_reference animations", "get_reference", { id: refId, part: "animations" }],
    ["get_page", "get_page", { page_id: pageId, image: "none" }],
    ["get_page_styles summary", "get_page_styles", { page_id: pageId }],
    ["get_page_styles elements", "get_page_styles", { page_id: pageId, section: "elements", limit: 40, offset: 2000 }],
    ["get_page_styles selector", "get_page_styles", { page_id: pageId, section: "elements", selector_contains: "nav-" }],
    ["get_page_styles text", "get_page_styles", { page_id: pageId, section: "elements", text_contains: "pricing" }],
    ["get_page_styles css_variables", "get_page_styles", { page_id: pageId, section: "css_variables" }],
    ["get_animation manifest", "get_animation", { animation_id: animationId, representation: "manifest" }],
  ]
  for (const [label, tool, args] of cases) {
    await call(metered(DB, FILES).env, tool, args) // warm up, then measure a second identical call
    const { m, env } = metered(DB, FILES)
    const start = performance.now()
    const responseBytes = await call(env, tool, args)
    rows.push({ pages: n, call: label, ...m, responseBytes, ms: Math.round(performance.now() - start) })
  }
  await mf.dispose()
}
console.table(rows)
console.log(JSON.stringify(rows))
