import { test } from "node:test"
import assert from "node:assert/strict"
import { Miniflare, convertV4MiniflareOptions } from "miniflare"
import { app } from "../worker/app"
import * as db from "../worker/db"
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
  return { mf: { dispose }, database, env, ctx, writes, refuse, status }
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
