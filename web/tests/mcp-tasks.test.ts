import { test } from "node:test"
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { Miniflare, convertV4MiniflareOptions } from "miniflare"
import { mcpApiHandler } from "../worker/mcp"
import * as db from "../worker/db"
import { STOPPED_EMPTY } from "../shared/capture-errors"
import type { PageUpload } from "../shared/types"

const V = "2026-07-28"
const TASKS = "io.modelcontextprotocol/tasks"

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
  const env = { DB, FILES } as unknown as Env

  /** A 2026-07-28 request, optionally declaring the Tasks extension. */
  async function rpc(method: string, params: Record<string, unknown>, { tasks = true, name }: { tasks?: boolean; name?: string } = {}) {
    const headers: Record<string, string> = {
      host: "localhost", "content-type": "application/json", accept: "application/json, text/event-stream",
      "mcp-protocol-version": V, "mcp-method": method,
    }
    if (name) headers["mcp-name"] = name
    const _meta = {
      "io.modelcontextprotocol/protocolVersion": V,
      "io.modelcontextprotocol/clientInfo": { name: "test", version: "0" },
      "io.modelcontextprotocol/clientCapabilities": tasks ? { extensions: { [TASKS]: {} } } : {},
    }
    const request = new Request("http://localhost/mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta } }) })
    const response = await mcpApiHandler.fetch(request, env, { waitUntil() {}, props: { ownerId: "max" } } as unknown as ExecutionContext)
    const body = await response.text()
    const line = body.split("\n").find((l) => l.startsWith("data: "))
    return JSON.parse(line ? line.slice(6) : body) as { result?: Record<string, any>; error?: { code: number; message: string; data?: any } }
  }
  const call = (name: string, args: Record<string, unknown>, opts?: { tasks?: boolean }) => rpc("tools/call", { name, arguments: args }, { ...opts, name })
  const task = (method: string, taskId: string, opts?: { tasks?: boolean }) => rpc(method, { taskId }, { ...opts, name: taskId })

  /** Capture one page with a stored thumbnail and finish the job. */
  async function finish(id: string) {
    const job = (await db.claimJob(DB))!
    assert.equal(job.id, id)
    const key = `refs/${id}/${job.attempt}/p0/desktop-thumb.jpg`
    await FILES.put(key, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { httpMetadata: { contentType: "image/jpeg" } })
    const page: PageUpload = {
      url: "https://example.com/", path: "/", title: "Home", ord: 0,
      desktopKey: key, desktopThumbKey: key, desktopWidth: 100, desktopHeight: 100,
      mobileKey: null, mobileThumbKey: null, mobileWidth: null, mobileHeight: null,
      snapshotKey: null, stylesKey: null, tokens: null, animations: [],
    }
    assert.ok(await db.addPage(DB, id, job.attempt, page))
    assert.ok(await db.completeJob(DB, id, job.attempt, { title: "Example", description: null, favicon: null, coverKey: key, tokens: null }))
  }
  return { mf, DB, call, task, rpc, finish }
}

test("the server advertises the Tasks extension", async () => {
  const { mf, rpc } = await setup()
  try {
    const discover = await rpc("server/discover", {})
    assert.deepEqual(discover.result?.capabilities.extensions[TASKS], {})
  } finally {
    await mf.dispose()
  }
})

test("add_reference becomes a task that completes with thumbnails and a gallery link", async () => {
  const { mf, DB, call, task, finish } = await setup()
  try {
    await db.touchPresence(DB, "idle", null)
    const created = (await call("add_reference", { url: "https://example.com", mode: "crawl" })).result!
    assert.equal(created.resultType, "task")
    assert.equal(created.status, "working")
    assert.equal(created.ttlMs, null)
    assert.ok(created.pollIntervalMs > 0)
    const id = created.taskId as string

    const working = (await task("tasks/get", id)).result!
    assert.equal(working.status, "working")
    assert.equal(working.result, undefined)

    await finish(id)
    const done = (await task("tasks/get", id)).result!
    assert.equal(done.status, "completed")
    assert.equal(done.result.isError, undefined)
    assert.equal(done.result.structuredContent.galleryUrl, `http://localhost/r/${id}`)
    assert.equal(done.result.structuredContent.pageCount, 1)
    const images = done.result.content.filter((c: { type: string }) => c.type === "image")
    assert.equal(images.length, 1)
    assert.equal(images[0].mimeType, "image/jpeg")
  } finally {
    await mf.dispose()
  }
})

test("no task is returned when the client did not declare Tasks or no capture agent is online", async () => {
  const { mf, DB, call, task } = await setup()
  try {
    // Nobody has run the capture agent: answer now so the agent can tell the user.
    const offline = (await call("add_reference", { url: "https://offline.example" })).result!
    assert.notEqual(offline.resultType, "task")
    assert.match(offline.structuredContent.capture.advice, /npm run capture/)
    assert.match(offline.structuredContent.next, /wait_for_capture/)

    await db.touchPresence(DB, "idle", null)
    const plain = (await call("add_reference", { url: "https://plain.example" }, { tasks: false })).result!
    assert.equal(plain.resultType, "complete")
    assert.ok(plain.structuredContent.id)

    const refused = await task("tasks/get", plain.structuredContent.id, { tasks: false })
    assert.equal(refused.error?.code, -32021)
    assert.deepEqual(refused.error?.data.requiredCapabilities.extensions[TASKS], {})
  } finally {
    await mf.dispose()
  }
})

test("tasks/get on an unknown id is invalid params, and tasks/cancel stops the capture", async () => {
  const { mf, DB, call, task } = await setup()
  try {
    assert.equal((await task("tasks/get", "missing")).error?.code, -32602)
    await db.touchPresence(DB, "idle", null)
    const created = (await call("add_reference", { url: "https://example.com" })).result!
    assert.deepEqual(Object.keys((await task("tasks/cancel", created.taskId)).result!).filter((k) => k !== "_meta" && k !== "resultType"), [])
    const ref = await db.getReferenceRecord(DB, created.taskId)
    assert.equal(ref?.error, STOPPED_EMPTY)
    assert.equal((await task("tasks/get", created.taskId)).result!.status, "cancelled")
  } finally {
    await mf.dispose()
  }
})

test("a failed capture completes its task with a tool error, not a failed task", async () => {
  const { mf, DB, call, task } = await setup()
  try {
    await db.touchPresence(DB, "idle", null)
    const created = (await call("add_reference", { url: "https://example.com" })).result!
    const job = (await db.claimJob(DB))!
    await db.failJob(DB, created.taskId, job.attempt, "Navigation timeout")
    const done = (await task("tasks/get", created.taskId)).result!
    assert.equal(done.status, "completed")
    assert.equal(done.result.isError, true)
    assert.match(done.result.content[0].text, /Navigation timeout/)
  } finally {
    await mf.dispose()
  }
})

test("wait_for_capture returns the finished capture, or says whether to call again", async () => {
  const { mf, DB, call, finish } = await setup()
  try {
    const queued = (await call("add_reference", { url: "https://example.com" }, { tasks: false })).result!.structuredContent
    // No capture agent: return at once instead of waiting, and say not to call again.
    const offline = (await call("wait_for_capture", { reference_id: queued.id })).result!.structuredContent
    assert.equal(offline.done, false)
    assert.equal(offline.waitAgain, false)

    await db.touchPresence(DB, "idle", null)
    const started = Date.now()
    const pending = (await call("wait_for_capture", { reference_id: queued.id, timeout_seconds: 1 })).result!.structuredContent
    assert.equal(pending.done, false)
    assert.equal(pending.waitAgain, true)
    assert.ok(Date.now() - started < 4000)

    await finish(queued.id)
    const done = (await call("wait_for_capture", { reference_id: queued.id })).result!
    assert.equal(done.structuredContent.done, true)
    assert.equal(done.structuredContent.galleryUrl, `http://localhost/r/${queued.id}`)
    assert.equal(done.content.filter((c: { type: string }) => c.type === "image").length, 1)

    const none = (await call("wait_for_capture", { reference_id: queued.id, max_images: 0 })).result!
    assert.equal(none.content.filter((c: { type: string }) => c.type === "image").length, 0)
  } finally {
    await mf.dispose()
  }
})
