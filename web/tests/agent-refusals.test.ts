import { test } from "node:test"
import assert from "node:assert/strict"
import { Miniflare, convertV4MiniflareOptions } from "miniflare"
import { app } from "../worker/app"
import * as db from "../worker/db"
import { mcpApiHandler } from "../worker/mcp"
import { applyMigrations } from "./helpers/d1"
import type { AgentPresence } from "../shared/types"

// An agent the Worker turns away (426) is not offline: the banner has to say its version is wrong, so the Worker remembers the last refusal.

async function setup() {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ["DB"], r2Buckets: ["FILES"] }))
  const database = await mf.getD1Database("DB") as unknown as D1Database
  const files = await mf.getR2Bucket("FILES") as unknown as R2Bucket
  await applyMigrations(database)
  const pending: Promise<unknown>[] = []
  const ctx = { waitUntil(p: Promise<unknown>) { pending.push(p) }, passThroughOnException() {} } as unknown as ExecutionContext
  // Every row the refusal's row is given, counted by D1 itself: what the rate limit is about.
  await database.batch([
    database.prepare("CREATE TABLE presence_writes (id TEXT)"),
    database.prepare("CREATE TRIGGER presence_inserted AFTER INSERT ON worker_presence BEGIN INSERT INTO presence_writes VALUES (new.id); END"),
    database.prepare("CREATE TRIGGER presence_updated AFTER UPDATE ON worker_presence BEGIN INSERT INTO presence_writes VALUES (new.id); END"),
  ])
  const writes = async (id = "refused") => (await database.prepare("SELECT count(*) AS n FROM presence_writes WHERE id = ?").bind(id).first<{ n: number }>())!.n
  const env = { DB: database, FILES: files, SESSION_SECRET: "test-secret", DEV_LOGIN: "max", CAPTURE_TOKEN: "test-token" } as unknown as Env
  const refuse = async (protocol: string | null, token = "test-token") => {
    const response = await app.request("http://localhost/agent/jobs/claim", { method: "POST", headers: { authorization: `Bearer ${token}`, ...(protocol === null ? {} : { "x-snip-capture-protocol": protocol }) } }, env, ctx)
    await Promise.allSettled(pending.splice(0))
    return response
  }
  const status = async () => (await (await app.request("http://localhost/api/agent", {}, env, ctx)).json()) as AgentPresence
  const dispose = async () => { await Promise.allSettled(pending); await mf.dispose() }
  /** An MCP tool call as the owner's assistant makes it, on the local origin where the cloud setup tool exists. */
  const tool = async (name: string, args: Record<string, unknown>) => {
    const request = new Request("http://localhost:5173/mcp", {
      method: "POST",
      headers: { host: "localhost:5173", "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    })
    const response = await mcpApiHandler.fetch(request, env, { waitUntil() {}, props: { ownerId: "max" } } as unknown as ExecutionContext)
    const body = await response.text()
    const data = body.split("\n").find((line) => line.startsWith("data: "))
    return (JSON.parse(data ? data.slice(6) : body) as { result: { structuredContent: any } }).result.structuredContent
  }
  return { mf: { dispose }, database, env, ctx, writes, refuse, status, tool }
}

test("the status API names the last agent that was refused for its version, and says which half is old", async () => {
  const { mf, refuse, status } = await setup()
  try {
    assert.equal((await status()).refused, null, "nothing refused yet")
    assert.equal((await refuse("3")).status, 426)
    const old = await status()
    assert.deepEqual({ seen: old.lastSeenAt, freshness: old.freshness, activity: old.activity }, { seen: null, freshness: "never", activity: null }, "a refused agent is not presence")
    assert.equal(old.refused?.protocol, 3)
    assert.equal(old.refused?.outdated, "app")
    assert.ok(Math.abs(Date.now() - Date.parse(old.refused!.at)) < 10_000)

    assert.equal((await refuse("5")).status, 426)
    const newer = await status()
    assert.equal(newer.refused?.protocol, 5, "the latest refusal replaces the one before")
    assert.equal(newer.refused?.outdated, "cloud", "an agent newer than the Worker means the cloud library is the old half")

    assert.equal((await refuse(null)).status, 426)
    const silent = await status()
    assert.equal(silent.refused?.protocol, null, "an agent too old to send its protocol")
    assert.equal(silent.refused?.outdated, "app")
  } finally {
    await mf.dispose()
  }
})

test("a refusal is remembered for as long as an agent counts as alive, and no longer", async () => {
  const { mf, database, refuse, status } = await setup()
  try {
    await refuse("3")
    const age = (seconds: number) => database.prepare("UPDATE worker_presence SET last_seen_at = ? WHERE id = 'refused'").bind(new Date(Date.now() - seconds * 1000).toISOString()).run()
    await age(80)
    assert.equal((await status()).refused?.protocol, 3, "80 s: an agent polling every minute is still turned away")
    await age(95)
    assert.equal((await status()).refused, null, "95 s: three missed polls, as for any agent")
  } finally {
    await mf.dispose()
  }
})

test("refused polls are not written to D1 each time: one write per window, at once when the protocol changes", async () => {
  const { mf, database, writes, refuse, status } = await setup()
  try {
    for (let i = 0; i < 10; i++) assert.equal((await refuse("3")).status, 426)
    assert.equal(await writes(), 1, "ten polls in a row, one write")
    const first = (await status()).refused!.at

    assert.equal((await refuse("5")).status, 426)
    assert.equal(await writes(), 2, "another protocol is news")

    await database.prepare("UPDATE worker_presence SET last_seen_at = ? WHERE id = 'refused'").bind(new Date(Date.now() - 25_000).toISOString()).run()
    const aged = await writes() // the update above is the test's own
    await refuse("5")
    assert.equal(await writes(), aged + 1, "past the window the time moves on")
    assert.ok((await status()).refused!.at > first)
  } finally {
    await mf.dispose()
  }
})

test("a refusal does not need the database, and a wrong token leaves no trace", async () => {
  const { mf, database, env, ctx, refuse, status } = await setup()
  try {
    assert.equal((await refuse("3", "wrong-token")).status, 401)
    assert.equal((await status()).refused, null, "only an agent that holds the capture token is remembered")

    const broken = { ...env, DB: new Proxy(database, { get: (target, key) => (key === "prepare" ? () => { throw new Error("D1 is down") } : Reflect.get(target, key)) }) } as unknown as Env
    const response = await app.request("http://localhost/agent/jobs/claim", { method: "POST", headers: { authorization: "Bearer test-token", "x-snip-capture-protocol": "3" } }, broken, ctx)
    assert.equal(response.status, 426, "the agent still hears why")
  } finally {
    await mf.dispose()
  }
})

test("an agent on the Worker's protocol is presence, and presence leaves the refusal row alone", async () => {
  const { mf, database, env, ctx, refuse, status } = await setup()
  try {
    await refuse("3")
    const claim = await app.request("http://localhost/agent/jobs/claim", { method: "POST", headers: { authorization: "Bearer test-token", "x-snip-capture-protocol": "4" } }, env, ctx)
    assert.equal(claim.status, 204)
    const after = await status()
    assert.equal(after.freshness, "recent")
    assert.equal(after.activity, "idle")
    assert.equal(after.refused?.protocol, 3)
    assert.equal(await db.getPresence(database).then((p) => p.freshness), "recent")
  } finally {
    await mf.dispose()
  }
})

test("after a 426 the assistant is told the agent was turned away and which update fixes it, never to start the agent", async () => {
  const { mf, database, refuse, tool } = await setup()
  try {
    const ref = await db.createReference(database, { url: "https://example.com", mode: "single" })
    const ask = async () => {
      const capture = await tool("get_capture_status", { reference_id: ref.id })
      const setup = await tool("get_cloud_setup_status", {})
      const agent = setup.checks.find((c: { id: string }) => c.id === "capture-agent")
      return { capture, agent }
    }

    const before = await ask()
    assert.match(before.capture.advice, /npm run capture/, "no agent has ever come: starting one is the advice")
    assert.equal(before.capture.worker.refused, null)

    assert.equal((await refuse("3")).status, 426)
    const old = await ask()
    assert.match(old.capture.advice, /^Waiting for the capture agent: /, "the phrase the gallery card shows")
    assert.match(old.capture.advice, /turned away because it is older than the cloud library/)
    assert.match(old.capture.advice, /update the Snip app/i)
    assert.match(old.capture.advice, /Stop polling/)
    assert.equal(old.capture.pollAfterSeconds, null, "only the user can move it")
    assert.deepEqual({ ...old.capture.worker.refused, at: typeof old.capture.worker.refused.at }, { at: "string", protocol: 3, outdated: "app" })
    assert.equal(old.capture.worker.freshness, "never", "a refused agent is still not presence")
    assert.equal(old.agent.ok, false)
    assert.match(old.agent.detail, /turned away because it is older than the cloud library/)
    for (const said of [old.capture.advice, old.agent.detail]) assert.doesNotMatch(said, /npm run capture|never contacted|last seen|probably not running/, said)

    assert.equal((await refuse("5")).status, 426)
    const newer = await ask()
    assert.match(newer.capture.advice, /turned away because it is newer than the cloud library/)
    assert.match(newer.capture.advice, /update the cloud library \(`npm run update`\)/i)
    assert.equal(newer.capture.worker.refused.outdated, "cloud")
    assert.match(newer.agent.detail, /update the cloud library|newer than the cloud library/)
    assert.doesNotMatch(newer.capture.advice + newer.agent.detail, /npm run capture|Snip app/)

    // The overview of the reference carries the same capture block.
    const overview = await tool("get_reference", { id: ref.id, part: "overview" })
    assert.equal(overview.capture.advice, newer.capture.advice)

    // Another agent that does work with this Worker is checking in: nothing is asked of the user, and the refusal still shows what it is.
    await db.touchPresence(database, "idle", null)
    const online = await ask()
    assert.doesNotMatch(online.capture.advice, /turned away|update|npm run/i, online.capture.advice)
    assert.equal(online.capture.pollAfterSeconds, 15)
    assert.equal(online.agent.ok, true)
    assert.equal(online.capture.worker.refused.outdated, "cloud")
  } finally {
    await mf.dispose()
  }
})

test("a capture that was running when its agent was turned away says so, and a refusal that has aged out is offline again", async () => {
  const { mf, database, refuse, tool } = await setup()
  try {
    const ref = await db.createReference(database, { url: "https://example.com", mode: "single" })
    await db.claimJob(database)
    await db.touchPresence(database, "busy", ref.id)
    await database.prepare("UPDATE worker_presence SET last_seen_at = ? WHERE id = 'capture'").bind(new Date(Date.now() - 5 * 60_000).toISOString()).run()
    assert.equal((await refuse("5")).status, 426)
    const turned = await tool("get_capture_status", { reference_id: ref.id })
    assert.equal(turned.state, "capturing")
    assert.match(turned.advice, /^The capture was in progress/)
    assert.match(turned.advice, /turned away because it is newer than the cloud library/)
    assert.doesNotMatch(turned.advice, /npm run capture|last seen/)
    assert.equal(turned.pollAfterSeconds, null)

    // 95 s later the refusal no longer counts, and what is left is an agent that went quiet.
    await database.prepare("UPDATE worker_presence SET last_seen_at = ? WHERE id = 'refused'").bind(new Date(Date.now() - 95_000).toISOString()).run()
    const quiet = await tool("get_capture_status", { reference_id: ref.id })
    assert.match(quiet.advice, /last seen \d+s ago/)
    assert.match(quiet.advice, /npm run capture/)
    assert.equal(quiet.worker.refused, null)
  } finally {
    await mf.dispose()
  }
})
