import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile, readdir } from "node:fs/promises"
import { Miniflare, convertV4MiniflareOptions } from "miniflare"
import { app } from "../worker/app"
import * as db from "../worker/db"
import { mcpApiHandler } from "../worker/mcp"
import { isVideoKey } from "../shared/types"

test("isVideoKey tells WebM recordings from older GIFs", () => {
  assert.equal(isVideoKey("refs/r1/a/p0/scroll.webm"), true)
  assert.equal(isVideoKey("refs/r1/a/p0/hover-0.gif"), false)
})

// Real local D1 and R2 bindings; no deployed resources are used.
test("WebM recordings are served in byte ranges and described over MCP, next to older GIFs", async () => {
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

    const ref = await db.createReference(database, { url: "https://example.com", mode: "single" })
    const job = (await db.claimJob(database))!
    const p = `refs/${ref.id}/${job.attempt}/p0`
    const anim = (kind: "scroll" | "hover", gifKey: string) => ({ kind, label: kind, selector: null, viewport: "desktop" as const, gifKey, width: 720, height: 450, sheetKey: null, meta: null })
    await db.addPage(database, ref.id, job.attempt, {
      url: "https://example.com/", path: "/", title: "Home", ord: 0,
      desktopKey: `${p}/desktop.jpg`, desktopThumbKey: `${p}/desktop-thumb.jpg`, desktopWidth: 1440, desktopHeight: 900,
      mobileKey: null, mobileThumbKey: null, mobileWidth: null, mobileHeight: null, snapshotKey: null, stylesKey: null, tokens: null,
      animations: [anim("scroll", `${p}/scroll.webm`), anim("hover", `${p}/hover-0.gif`)],
    })
    await db.completeJob(database, ref.id, job.attempt, { title: null, description: null, favicon: null, coverKey: null, tokens: null })
    const video = new Uint8Array(1000).map((_, i) => i % 256)
    await files.put(`${p}/scroll.webm`, video, { httpMetadata: { contentType: "video/webm" } })
    await files.put(`${p}/hover-0.gif`, new TextEncoder().encode("GIF89a"), { httpMetadata: { contentType: "image/gif" } })

    const ctx = { waitUntil() {}, passThroughOnException() {}, props: { ownerId: "max" } } as unknown as ExecutionContext
    const env = { DB: database, FILES: files, SESSION_SECRET: "test-secret", DEV_LOGIN: "max" } as unknown as Env
    const get = (key: string, headers: Record<string, string> = {}) => app.request(`http://localhost/files/${key}`, { headers }, env, ctx)

    const whole = await get(`${p}/scroll.webm`)
    assert.equal(whole.status, 200)
    assert.equal(whole.headers.get("accept-ranges"), "bytes")
    assert.equal(whole.headers.get("content-type"), "video/webm")
    assert.equal((await whole.arrayBuffer()).byteLength, 1000)
    const part = await get(`${p}/scroll.webm`, { range: "bytes=10-19" })
    assert.equal(part.status, 206)
    assert.equal(part.headers.get("content-range"), "bytes 10-19/1000")
    assert.deepEqual([...new Uint8Array(await part.arrayBuffer())], [...video.subarray(10, 20)])
    const open = await get(`${p}/scroll.webm`, { range: "bytes=990-" })
    assert.equal(open.headers.get("content-range"), "bytes 990-999/1000")
    const tail = await get(`${p}/scroll.webm`, { range: "bytes=-4" })
    assert.equal(tail.headers.get("content-range"), "bytes 996-999/1000")
    assert.equal((await tail.arrayBuffer()).byteLength, 4)

    const rpc = async (name: string, args: unknown) => {
      const request = new Request("http://localhost/mcp", {
        method: "POST",
        headers: { host: "localhost", "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      })
      const body = await (await mcpApiHandler.fetch(request, env, ctx)).text()
      return JSON.parse(body.split("\n").find((line) => line.startsWith("data: "))!.slice(6)).result
    }
    const [scroll, hover] = (await db.getReference(database, ref.id))!.animations.sort((a, b) => a.kind.localeCompare(b.kind)).reverse()
    assert.equal(scroll!.kind, "scroll")

    const s = await rpc("get_animation", { animation_id: scroll!.id, representation: "gif" })
    assert.equal(s.structuredContent.recording.format, "webm")
    assert.ok(s.structuredContent.recording.url.includes("sig="))
    assert.equal(s.structuredContent.gif, null)
    assert.equal(s.structuredContent.representations.gif, false)
    assert.equal(s.structuredContent.returned.included, false)
    assert.equal(s.content.length, 1, "a video is never inlined as an image")

    const h = await rpc("get_animation", { animation_id: hover!.id, representation: "gif" })
    assert.equal(h.structuredContent.recording.format, "gif")
    assert.equal(h.structuredContent.gif.url, h.structuredContent.recording.url)
    assert.equal(h.content[1].mimeType, "image/gif")
  } finally {
    await mf.dispose()
  }
})
