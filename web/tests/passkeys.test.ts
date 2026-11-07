import { test } from "node:test"
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { Miniflare, convertV4MiniflareOptions } from "miniflare"
import { app } from "../worker/app"
import { SESSION_COOKIE } from "../worker/auth"
import { createAssertion, createCredential, type Credential } from "./helpers/webauthn"

// End-to-end passkeys with a software authenticator: real CBOR, real ECDSA, real D1 challenges.
// This is the path a browser takes, so a broken verify shape fails here rather than in Safari.

const PUBLIC_URL = "https://snip.test"
const RP_ID = "snip.test"

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext

async function setup() {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ["DB"] }))
  const db = (await mf.getD1Database("DB")) as unknown as D1Database
  const dir = new URL("../migrations/", import.meta.url)
  for (const migration of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = await readFile(new URL(migration, dir), "utf8")
    const statements = sql.replace(/^--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean)
    await db.batch(statements.map((statement) => db.prepare(statement)))
  }
  await db.prepare(`INSERT INTO owners (id, label, created_at) VALUES ('max', 'Max', '2026-01-01T00:00:00Z')`).run()
  const env = { DB: db, SESSION_SECRET: "session-secret", OWNER_LINK_SECRET: "owner-link-secret", PUBLIC_URL } as unknown as Env

  /** http://localhost makes DEV_LOGIN apply, standing in for the owner's session cookie. */
  const local = (path: string, init: RequestInit = {}, dev = "max") =>
    app.request(`http://localhost${path}`, init, { ...env, DEV_LOGIN: dev } as Env, ctx)
  const call = (path: string, init: RequestInit = {}) => app.request(`${PUBLIC_URL}${path}`, init, env, ctx)
  const post = (path: string, body: unknown, dev = "max") =>
    local(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }, dev)

  return { mf, db, env, call, local, post }
}

type Ctx = Awaited<ReturnType<typeof setup>>

async function withWorker(fn: (ctx: Ctx) => Promise<void>) {
  const ctx = await setup()
  try {
    await fn(ctx)
  } finally {
    await ctx.mf.dispose()
  }
}

async function register(ctx: Ctx, label?: string): Promise<{ credential: Credential; options: { challenge: string } }> {
  const options = (await (await ctx.local("/auth/passkey/register/options")).json()) as { challenge: string; rp: { id: string } }
  assert.equal(options.rp.id, RP_ID)
  const { response, credential } = await createCredential({ rpID: RP_ID, origin: PUBLIC_URL, challenge: options.challenge })
  const res = await ctx.post("/auth/passkey/register/verify", { response, deviceLabel: label })
  assert.equal(res.status, 200, await res.clone().text())
  assert.deepEqual(await res.json(), { ok: true })
  return { credential, options }
}

test("a passkey registers, signs in, and is listed as a device", () =>
  withWorker(async (ctx) => {
    const { credential } = await register(ctx, "MacBook Pro")

    const stored = await ctx.db.prepare(`SELECT id, owner_id, public_key, counter, transports, device_label FROM passkeys`).first<{
      id: string
      owner_id: string
      public_key: ArrayBuffer
      counter: number
      transports: string
      device_label: string
    }>()
    assert.equal(stored!.id, credential.id)
    assert.equal(stored!.owner_id, "max")
    assert.equal(stored!.device_label, "MacBook Pro")
    assert.deepEqual(JSON.parse(stored!.transports), ["internal"])
    assert.equal(new Uint8Array(stored!.public_key).length, credential.publicKey.length, "the COSE key is stored whole")

    const options = (await (await ctx.call("/auth/passkey/login/options")).json()) as { challenge: string; allowCredentials: { id: string }[] }
    assert.deepEqual(options.allowCredentials.map((c) => c.id), [credential.id])
    const assertion = await createAssertion({ rpID: RP_ID, origin: PUBLIC_URL, challenge: options.challenge, credential })
    const login = await ctx.call("/auth/passkey/login/verify", { method: "POST", body: JSON.stringify({ response: assertion.response }), headers: { "content-type": "application/json" } })
    assert.equal(login.status, 200, await login.clone().text())
    assert.deepEqual(await login.json(), { ok: true })

    const cookie = login.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`))
    assert.ok(cookie, "sign-in sets the session")
    const me = await ctx.call("/api/me", { headers: { cookie: cookie!.split(";")[0]! } })
    assert.deepEqual(await me.json(), { login: "max", ownerId: "max", method: "passkey" })

    // The counter moved to the value the authenticator reported.
    const after = await ctx.db.prepare(`SELECT counter, last_used_at FROM passkeys WHERE id = ?`).bind(credential.id).first<{ counter: number; last_used_at: string }>()
    assert.equal(after!.counter, assertion.counter)
    assert.ok(after!.last_used_at)

    const devices = (await (await ctx.local("/api/passkeys")).json()) as { devices: { id: string; label: string; lastUsedAt: string | null }[] }
    assert.deepEqual(devices.devices.map((d) => [d.id, d.label]), [[credential.id, "MacBook Pro"]])
  }))

test("a challenge is single use, so a captured assertion cannot be replayed", () =>
  withWorker(async (ctx) => {
    const { credential } = await register(ctx)
    const options = (await (await ctx.call("/auth/passkey/login/options")).json()) as { challenge: string }
    const assertion = await createAssertion({ rpID: RP_ID, origin: PUBLIC_URL, challenge: options.challenge, credential })

    const first = await ctx.call("/auth/passkey/login/verify", { method: "POST", body: JSON.stringify({ response: assertion.response }), headers: { "content-type": "application/json" } })
    assert.equal(first.status, 200)
    const replay = await ctx.call("/auth/passkey/login/verify", { method: "POST", body: JSON.stringify({ response: assertion.response }), headers: { "content-type": "application/json" } })
    assert.equal(replay.status, 400)
    assert.deepEqual(replay.headers.getSetCookie(), [], "a failed replay sets no session")
    assert.match(await replay.text(), /challenge/i)
  }))

test("an assertion for another origin or RP ID is refused", () =>
  withWorker(async (ctx) => {
    const { credential } = await register(ctx)

    const otherOrigin = (await (await ctx.call("/auth/passkey/login/options")).json()) as { challenge: string }
    const wrongOrigin = await createAssertion({ rpID: RP_ID, origin: "https://evil.example", challenge: otherOrigin.challenge, credential })
    const a = await ctx.call("/auth/passkey/login/verify", { method: "POST", body: JSON.stringify({ response: wrongOrigin.response }), headers: { "content-type": "application/json" } })
    assert.equal(a.status, 400)

    const otherRp = (await (await ctx.call("/auth/passkey/login/options")).json()) as { challenge: string }
    const wrongRp = await createAssertion({ rpID: "evil.example", origin: PUBLIC_URL, challenge: otherRp.challenge, credential })
    const b = await ctx.call("/auth/passkey/login/verify", { method: "POST", body: JSON.stringify({ response: wrongRp.response }), headers: { "content-type": "application/json" } })
    assert.equal(b.status, 400)
  }))

test("an expired challenge is refused before any signature check", () =>
  withWorker(async (ctx) => {
    const { credential } = await register(ctx)
    const options = (await (await ctx.call("/auth/passkey/login/options")).json()) as { challenge: string }
    await ctx.db.prepare(`UPDATE webauthn_challenges SET exp = 1 WHERE kind = 'login'`).run()
    const assertion = await createAssertion({ rpID: RP_ID, origin: PUBLIC_URL, challenge: options.challenge, credential })
    const res = await ctx.call("/auth/passkey/login/verify", { method: "POST", body: JSON.stringify({ response: assertion.response }), headers: { "content-type": "application/json" } })
    assert.equal(res.status, 400)
  }))

test("an unknown credential id is refused without touching the challenge table", () =>
  withWorker(async (ctx) => {
    await register(ctx)
    const options = (await (await ctx.call("/auth/passkey/login/options")).json()) as { challenge: string }
    const stranger = await createCredential({ rpID: RP_ID, origin: PUBLIC_URL, challenge: options.challenge })
    const assertion = await createAssertion({ rpID: RP_ID, origin: PUBLIC_URL, challenge: options.challenge, credential: stranger.credential })
    const res = await ctx.call("/auth/passkey/login/verify", { method: "POST", body: JSON.stringify({ response: assertion.response }), headers: { "content-type": "application/json" } })
    assert.equal(res.status, 400)
    assert.match(await res.text(), /not registered/)
    const left = await ctx.db.prepare(`SELECT count(*) AS n FROM webauthn_challenges WHERE kind = 'login'`).first<{ n: number }>()
    assert.equal(left!.n, 1, "the challenge stays for the genuine attempt")
  }))

test("a GitHub session that is not the owner cannot enrol a passkey", () =>
  withWorker(async (ctx) => {
    const options = await ctx.local("/auth/passkey/register/options", {}, "second-person")
    assert.equal(options.status, 403)
    assert.equal((await ctx.db.prepare(`SELECT count(*) AS n FROM webauthn_challenges`).first<{ n: number }>())!.n, 0)
  }))

test("removing a device deletes only that passkey, and only for its owner", () =>
  withWorker(async (ctx) => {
    const first = await register(ctx, "Laptop")
    const second = await register(ctx, "Phone")
    assert.equal((await ctx.local(`/api/passkeys/${first.credential.id}`, { method: "DELETE" })).status, 200)
    const left = await ctx.db.prepare(`SELECT id FROM passkeys`).all<{ id: string }>()
    assert.deepEqual(left.results.map((r) => r.id), [second.credential.id])
    // Signing in with the removed credential is now impossible: it is not in the allow list.
    const options = (await (await ctx.call("/auth/passkey/login/options")).json()) as { allowCredentials: { id: string }[] }
    assert.deepEqual(options.allowCredentials.map((c) => c.id), [second.credential.id])
  }))
