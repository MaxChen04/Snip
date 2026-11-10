import { test } from "node:test"
import assert from "node:assert/strict"
import { gunzipSync, gzipSync } from "node:zlib"
import { Miniflare, convertV4MiniflareOptions } from "miniflare"
import { app } from "../worker/app"
import * as db from "../worker/db"
import { getFile, readText } from "../worker/files"
import { mcpApiHandler } from "../worker/mcp"
import { exportPlan } from "../src/lib/export-reference"
import { gzipKey, isGzipKey, ungzipKey, type Job, type PageUpload } from "../shared/types"
import { SnipApi, uploadText } from "../../capture/src/api"
import { applyMigrations } from "./helpers/d1"

// Real local D1 and R2 (Miniflare); the engine's own SnipApi talks to the Worker through app.request.

test("the engine and the Worker agree on the gzip name", async () => {
  for (const name of ["snapshot.html", "styles.json"]) {
    const key = `refs/abc/${"a".repeat(32)}/p0/${name}`
    assert.equal(isGzipKey(key), false)
    assert.equal(isGzipKey(gzipKey(key)), true)
    assert.equal(ungzipKey(gzipKey(key)), key)
    // The engine keeps its own copy of the rule (released apps ship capture/src without web/shared).
    const stored: string[] = []
    await uploadText({ upload: async (k) => { stored.push(k); return k } }, key, "x", "text/plain", true)
    assert.equal(stored[0], gzipKey(key))
  }
})

test("only the two text files take the gzip name; everything else is left alone", () => {
  for (const key of ["refs/a/b/p0/desktop.jpg", "refs/a/b/p0/scroll.webm", "refs/a/b/p0/hover-0.gif", "refs/a/b/p0/section-1.jpg", "uploads/u/x.png", "refs/a/b/p0/snapshot.gz.txt", "refs/a/b/p0/snapshot.html.gz"]) {
    assert.equal(isGzipKey(key), false, key)
    assert.equal(gzipKey(key), key, key)
  }
})

/** R2 in Node needs a known length for a stream; the deployed binding takes the request body directly. */
const buffered = (bucket: R2Bucket): R2Bucket => new Proxy(bucket, {
  get(target, name) {
    if (name === "put") return async (key: string, body: unknown, options?: R2PutOptions) => target.put(key, body instanceof ReadableStream ? await new Response(body).arrayBuffer() : (body as string | ArrayBuffer), options)
    const value = Reflect.get(target, name, target)
    return typeof value === "function" ? value.bind(target) : value
  },
})

const HTML = `<!doctype html><html><head><title>Café — 日本語 😀</title></head><body>${"<p class=\"x\" style=\"color:#123456\">héllo wörld — 日本語 😀 &amp; more</p>\n".repeat(2500)}</body></html>`
const STYLES = {
  viewport: { width: 1440, height: 900 },
  document: { title: "Café", lang: "fr" },
  elementCount: 3,
  elements: [
    { sel: "nav > a.pricing", text: "Pricing", rect: [0, 0, 80, 20], styles: { color: "rgb(0, 0, 0)" } },
    { sel: "button.cta", text: "Commencer — 無料", rect: [0, 40, 120, 40], styles: { background: "rgb(17, 17, 17)" } },
    { sel: "footer", text: "© 2026", rect: [0, 900, 1440, 80], styles: {} },
  ],
  keyframes: [{ name: "fade", css: "@keyframes fade{from{opacity:0}to{opacity:1}}" }],
  hoverRules: [".cta:hover{background:#333}"],
  fontFaces: ['@font-face{font-family:"X";src:url("data:font/woff2;base64,' + "A".repeat(400) + '")}'],
  cssVariables: { "--brand": "#fa0" },
  truncated: false,
}
const STYLES_JSON = JSON.stringify(STYLES)
const HTML_TYPE = "text/html; charset=utf-8"
const STYLE_SECTIONS = ["summary", "elements", "keyframes", "hover_rules", "font_faces", "css_variables"]

async function open() {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ["DB"], r2Buckets: ["FILES", "OTHER_FILES"] }))
  const database = (await mf.getD1Database("DB")) as unknown as D1Database
  await applyMigrations(database)
  const files = (await mf.getR2Bucket("FILES")) as unknown as R2Bucket
  const otherFiles = (await mf.getR2Bucket("OTHER_FILES")) as unknown as R2Bucket
  const pending: Promise<unknown>[] = []
  const ctx = { waitUntil(p: Promise<unknown>) { pending.push(p) }, passThroughOnException() {}, props: { ownerId: "max" } } as unknown as ExecutionContext
  const env = { DB: database, FILES: buffered(files), SESSION_SECRET: "test-secret", DEV_LOGIN: "max", CAPTURE_TOKEN: "test-token", TRANSFER_TOKEN: "transfer-token", OWNER_LINK_SECRET: "owner-secret" } as unknown as Env
  // The same Worker with nobody signed in: only a signed URL or the transfer token gets through.
  const anonymous = { ...env, DEV_LOGIN: undefined } as unknown as Env
  const otherEnv = { ...env, FILES: buffered(otherFiles) } as unknown as Env
  const realFetch = globalThis.fetch
  const call = (path: string, init: RequestInit = {}, e: Env = env) => app.request(`http://localhost${path}`, init, e, ctx)
  /** Runs the engine's SnipApi against the Worker, the way `npm run capture` talks to a deployed one. */
  const asEngine = async <T>(run: (api: SnipApi) => Promise<T>) => {
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => app.request(String(input), init, env, ctx)) as typeof fetch
    try {
      return await run(new SnipApi("http://localhost", "test-token"))
    } finally {
      globalThis.fetch = realFetch
    }
  }
  const rpc = async (name: string, args: unknown) => {
    const request = new Request("http://localhost/mcp", {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    })
    const body = await (await mcpApiHandler.fetch(request, env, ctx)).text()
    return JSON.parse(body.split("\n").find((line) => line.startsWith("data: "))!.slice(6)).result as { structuredContent: Record<string, any> }
  }
  return { mf, database, files, otherFiles, env, anonymous, otherEnv, call, asEngine, rpc, pending }
}
type Library = Awaited<ReturnType<typeof open>>

async function withLibrary(fn: (lib: Library) => Promise<void>) {
  const lib = await open()
  try {
    await fn(lib)
  } finally {
    await Promise.allSettled(lib.pending)
    await lib.mf.dispose()
  }
}

/**
 * One page captured the way an engine does it: claim, upload, register, complete.
 * - "negotiated": the current engine, which gzips when the claim's features say the Worker reads it
 *   (`features` replaces them, to play a Worker older than the flag, or "absent" for one with none at all).
 * - "plain": the engine as it was before: upload() with the plain names, whatever the claim says.
 */
async function capture(lib: Library, url: string, engine: "negotiated" | "plain", features?: Job["features"] | "absent") {
  const ref = await db.createReference(lib.database, { url, mode: "single" })
  return lib.asEngine(async (api) => {
    const job = (await api.claim())!
    assert.equal(job.id, ref.id)
    if (features === "absent") delete job.features
    else if (features) job.features = features
    const p = `refs/${job.id}/${job.attempt}/p0`
    const image = await api.upload(`${p}/desktop.jpg`, Buffer.from([0xff, 0xd8, 0xff, 0xd9]), "image/jpeg")
    const gzip = !!job.features?.includes("gzip")
    const snapshotKey = engine === "plain" ? await api.upload(`${p}/snapshot.html`, HTML, HTML_TYPE) : await uploadText(api, `${p}/snapshot.html`, HTML, HTML_TYPE, gzip)
    const stylesKey = engine === "plain" ? await api.upload(`${p}/styles.json`, STYLES_JSON, "application/json") : await uploadText(api, `${p}/styles.json`, STYLES_JSON, "application/json", gzip)
    const page: PageUpload = {
      url, path: "/", title: "Café", ord: 0, desktopKey: image, desktopThumbKey: image, desktopWidth: 1440, desktopHeight: 900,
      mobileKey: null, mobileThumbKey: null, mobileWidth: null, mobileHeight: null, snapshotKey, stylesKey, tokens: null, animations: [],
    }
    await api.addPage(job.id, page)
    await api.complete(job.id, { title: "Café", description: null, favicon: null, coverKey: image, tokens: null })
    const detail = (await db.getReference(lib.database, ref.id))!
    return { job, ref: detail.reference, page: detail.pages[0]!, detail, snapshotKey, stylesKey }
  })
}
type Captured = Awaited<ReturnType<typeof capture>>

/**
 * Everything that reads a page's HTML snapshot or styles file, which must see exactly the captured text.
 * Returns what the MCP style tool answered, so two pages can be compared.
 */
async function assertReadsBack(lib: Library, c: Captured, label: string) {
  const { call, anonymous, rpc } = lib

  // /files/*: the page viewer's HTML and CSS tabs, the Open link, the JSON download, the export zip, the desktop smoke test.
  const snapshot = await call(`/files/${c.snapshotKey}`)
  assert.equal(snapshot.status, 200, label)
  assert.ok(Buffer.from(await snapshot.arrayBuffer()).equals(Buffer.from(HTML)), `${label}: /files serves the captured bytes`)
  assert.equal(snapshot.headers.get("content-type"), HTML_TYPE, label)
  assert.equal(snapshot.headers.get("content-encoding"), null, `${label}: a plain response, never a content-encoding the runtime might apply twice`)
  assert.equal(snapshot.headers.get("cache-control"), "private, max-age=86400, immutable", label)
  assert.equal(snapshot.headers.get("x-content-type-options"), "nosniff", label)
  assert.equal(snapshot.headers.get("content-security-policy"), "sandbox allow-popups; script-src 'none'; object-src 'none'; base-uri *", `${label}: captured HTML stays sandboxed`)
  assert.equal((await call(`/files/${c.snapshotKey}`, { headers: { "accept-encoding": "gzip, br" } })).headers.get("content-encoding"), null, label)
  const styles = await call(`/files/${c.stylesKey}?download=1`)
  assert.equal(await styles.text(), STYLES_JSON, label)
  assert.equal(styles.headers.get("content-type"), "application/json", label)
  assert.equal(styles.headers.get("content-disposition"), `attachment; filename="p0-styles.json"`, `${label}: the saved file keeps its ordinary name`)
  assert.equal(styles.headers.get("content-security-policy"), null, label)
  assert.equal((await call(`/files/${c.snapshotKey}`, {}, anonymous)).status, 401, `${label}: still needs a session or a signature`)

  // MCP: get_page (HTML, paged), get_page_styles, and the signed URLs agents are handed.
  const page = await rpc("get_page", { page_id: c.page.id, image: "none", include_html: true })
  const first = page.structuredContent.html
  assert.equal(first.included, true, label)
  assert.equal(first.totalChars, HTML.length, label)
  assert.equal(first.content, HTML.slice(0, first.content.length), label)
  assert.ok(first.nextOffset, `${label}: the snapshot is long enough to page`)
  const second = (await rpc("get_page", { page_id: c.page.id, image: "none", include_html: true, html_offset: first.nextOffset })).structuredContent.html
  assert.equal(second.content, HTML.slice(first.nextOffset, first.nextOffset + second.content.length), label)
  const answers: Record<string, unknown> = { html: { ...first, content: first.content.length, nextOffset: first.nextOffset } }
  for (const section of STYLE_SECTIONS) {
    const { structuredContent } = await rpc("get_page_styles", { page_id: c.page.id, section })
    assert.equal(structuredContent.unavailable, undefined, `${label} ${section}`)
    answers[section] = { ...structuredContent, pageId: undefined }
  }
  const filtered = await rpc("get_page_styles", { page_id: c.page.id, section: "elements", selector_contains: "button" })
  assert.equal(filtered.structuredContent.items.length, 1, label)
  for (const [field, expected, type] of [["htmlSnapshotUrl", HTML, HTML_TYPE], ["computedStylesUrl", STYLES_JSON, "application/json"]] as const) {
    const signed = new URL(page.structuredContent[field])
    const res = await call(signed.pathname + signed.search, {}, anonymous)
    assert.equal(res.status, 200, `${label} ${field}`)
    assert.equal(await res.text(), expected, `${label} ${field}`)
    assert.equal(res.headers.get("content-type"), type, label)
  }

  // Export: the archive's file names come from the keys, and its bytes from /files.
  const plan = exportPlan(c.ref, c.detail.pages, c.detail.animations)
  const text = plan.files.filter((f) => /snapshot|styles/.test(f.path))
  assert.deepEqual(text.map((f) => f.path), ["pages/01-home/snapshot.html", "pages/01-home/styles.json"], `${label}: same archive names`)
  for (const f of text) {
    const bytes = Buffer.from(await (await call(`/files/${f.key}`)).arrayBuffer())
    assert.ok(bytes.equals(Buffer.from(f.path.endsWith(".html") ? HTML : STYLES_JSON)), `${label}: export reads ${f.path}`)
  }
  return answers
}

test("a gzipped capture reads back identically through every consumer, and so does one stored plain", () =>
  withLibrary(async (lib) => {
    const gz = await capture(lib, "https://gz.example/", "negotiated")
    assert.deepEqual(gz.job.features, ["sections", "live", "schemes", "gzip"], "the Worker advertises it")
    assert.equal(gz.snapshotKey, gzipKey(`refs/${gz.job.id}/${gz.job.attempt}/p0/snapshot.html`))
    assert.equal(gz.page.snapshotKey, gz.snapshotKey, "the page row points at the gzip name")
    const legacy = await capture(lib, "https://plain.example/", "plain")
    assert.equal(legacy.snapshotKey, `refs/${legacy.job.id}/${legacy.job.attempt}/p0/snapshot.html`)

    const fromGzip = await assertReadsBack(lib, gz, "gzipped")
    const fromPlain = await assertReadsBack(lib, legacy, "plain")
    assert.deepEqual(fromGzip, fromPlain, "the MCP tools answer the same for both")

    // At rest: the gzip name holds real gzip bytes and is much smaller; the plain one is untouched.
    const stored = async (key: string) => Buffer.from(await (await lib.files.get(key))!.arrayBuffer())
    assert.ok(gunzipSync(await stored(gz.snapshotKey)).equals(Buffer.from(HTML)))
    assert.ok(gunzipSync(await stored(gz.stylesKey)).equals(Buffer.from(STYLES_JSON)))
    assert.ok((await stored(legacy.snapshotKey)).equals(Buffer.from(HTML)), "a legacy object is never rewritten")
    assert.ok((await stored(gz.snapshotKey)).length * 10 < Buffer.byteLength(HTML))
    assert.ok((await stored(gz.stylesKey)).length < Buffer.byteLength(STYLES_JSON))

    // The storage summary counts what is stored, so a gzipped page takes less.
    const usage = await db.storageUsage(lib.files)
    const listed = (await lib.files.list()).objects
    assert.equal(usage.bytes, listed.reduce((sum, o) => sum + o.size, 0))
    const bytesOf = (c: Captured) => listed.filter((o) => o.key.startsWith(`refs/${c.job.id}/`)).reduce((sum, o) => sum + o.size, 0)
    assert.ok(bytesOf(gz) * 5 < bytesOf(legacy), `${bytesOf(gz)} vs ${bytesOf(legacy)}`)
  }))

test("other files keep their byte ranges, and a gzipped file is always sent whole", () =>
  withLibrary(async (lib) => {
    const plain = await capture(lib, "https://plain.example/", "plain")
    const gz = await capture(lib, "https://gz.example/", "negotiated")
    const cut = await lib.call(`/files/${plain.snapshotKey}`, { headers: { range: "bytes=2-9" } })
    assert.equal(cut.status, 206)
    assert.equal(cut.headers.get("accept-ranges"), "bytes")
    assert.equal(cut.headers.get("content-range"), `bytes 2-9/${Buffer.byteLength(HTML)}`)
    assert.equal(await cut.text(), HTML.slice(2, 10))
    const whole = await lib.call(`/files/${gz.snapshotKey}`, { headers: { range: "bytes=2-9" } })
    assert.equal(whole.status, 200, "a range on a gzipped file would cut compressed bytes, so it is ignored")
    assert.equal(whole.headers.get("accept-ranges"), "none")
    assert.equal(whole.headers.get("content-range"), null)
    assert.equal(await whole.text(), HTML)
    assert.equal((await lib.call(`/files/${gzipKey(plain.snapshotKey).replace("snapshot", "nothing")}`)).status, 404)
  }))

test("library transfer carries a gzipped file byte for byte and the copy reads the same", () =>
  withLibrary(async (lib) => {
    const gz = await capture(lib, "https://gz.example/", "negotiated")
    const plain = await capture(lib, "https://plain.example/", "plain")
    const bearer = { authorization: "Bearer transfer-token" }
    const manifest = (await (await lib.call("/transfer/manifest", { headers: bearer })).json()) as { keys: { key: string; size: number; contentType: string }[] }
    const entry = (key: string) => manifest.keys.find((k) => k.key === key)!
    const storedGz = Buffer.from(await (await lib.files.get(gz.snapshotKey))!.arrayBuffer())
    assert.equal(entry(gz.snapshotKey).size, storedGz.length, "the manifest lists the stored size, like any object")
    assert.equal(entry(plain.snapshotKey).size, Buffer.byteLength(HTML))

    // What the provisioning engine does for each key: GET from one side, PUT the same bytes to the other.
    for (const c of [gz, plain]) {
      for (const key of [c.snapshotKey, c.stylesKey]) {
        const res = await lib.call(`/transfer/file/${key}`, { headers: bearer })
        const body = Buffer.from(await res.arrayBuffer())
        assert.equal(body.length, entry(key).size, `${key}: the bytes match the manifest size`)
        const put = await lib.call(`/transfer/file/${key}`, { method: "PUT", body, headers: { ...bearer, "content-type": res.headers.get("content-type")!, "content-length": String(body.length) } }, lib.otherEnv)
        assert.equal(put.status, 200, key)
      }
    }
    assert.ok(Buffer.from(await (await lib.otherFiles.get(gz.snapshotKey))!.arrayBuffer()).equals(storedGz), "stored bytes survive the copy")
    // The copy is a working library: the destination Worker reads both kinds the same way.
    for (const c of [gz, plain]) {
      assert.equal(await (await lib.call(`/files/${c.snapshotKey}`, {}, lib.otherEnv)).text(), HTML)
      assert.equal(await (await lib.call(`/files/${c.stylesKey}`, {}, lib.otherEnv)).text(), STYLES_JSON)
    }
  }))

test("any engine and Worker version pair stores something every reader can open", () =>
  withLibrary(async (lib) => {
    // Older engine, newer Worker: the engine ignores `features` and uploads the plain names.
    const older = await capture(lib, "https://old-engine.example/", "plain")
    assert.equal(isGzipKey(older.snapshotKey), false)
    await assertReadsBack(lib, older, "old engine")

    // Newer engine, older Worker: the claim carries no features, or none of them is "gzip".
    const cases: [string, Job["features"] | "absent"][] = [["no features property", "absent"], ["empty features", []], ["sections only", ["sections"]], ["before the flag", ["sections", "live", "schemes"]]]
    for (const [i, [name, features]] of cases.entries()) {
      const c = await capture(lib, `https://old-worker-${i}.example/`, "negotiated", features)
      assert.equal(c.snapshotKey, `refs/${c.job.id}/${c.job.attempt}/p0/snapshot.html`, `${name}: the engine sends the plain names an older Worker serves as they are`)
      assert.equal(await (await lib.files.get(c.snapshotKey))!.text(), HTML, `${name}: stored as it always was`)
      await assertReadsBack(lib, c, name)
    }
  }))

test("the Worker's reader: gzip names are unzipped, other names untouched, missing is null, corrupt data is an error", async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', r2Buckets: ["FILES"] }))
  try {
    const files = (await mf.getR2Bucket("FILES")) as unknown as R2Bucket
    await files.put("refs/a/b/p0/snapshot.gz.html", gzipSync("héllo"), { httpMetadata: { contentType: HTML_TYPE } })
    await files.put("refs/a/b/p0/empty.gz.json", gzipSync(""))
    await files.put("refs/a/b/p0/snapshot.html", "héllo")
    await files.put("refs/a/b/p0/broken.gz.html", "this was never gzipped")
    // A legacy object whose bytes happen to be gzip is still just bytes: only the name decides.
    await files.put("refs/a/b/p0/odd.html", gzipSync("not unzipped"))
    assert.equal(await readText(files, "refs/a/b/p0/snapshot.gz.html"), "héllo")
    assert.equal(await readText(files, "refs/a/b/p0/snapshot.html"), "héllo")
    assert.equal(await readText(files, "refs/a/b/p0/empty.gz.json"), "", "an empty file is empty text, not missing")
    assert.equal(await readText(files, "refs/a/b/p0/nope.gz.html"), null)
    assert.equal(await getFile(files, "refs/a/b/p0/nope.html"), null)
    await assert.rejects(readText(files, "refs/a/b/p0/broken.gz.html"), "garbage under a gzip name fails loudly instead of being passed on")
    assert.ok(Buffer.from(await new Response((await getFile(files, "refs/a/b/p0/odd.html"))!.body).arrayBuffer()).equals(gzipSync("not unzipped")))
    assert.equal((await getFile(files, "refs/a/b/p0/snapshot.gz.html"))!.object.size, gzipSync("héllo").length, "object describes the stored bytes")
  } finally {
    await mf.dispose()
  }
})
