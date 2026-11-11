import { test } from "node:test"
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { Miniflare, convertV4MiniflareOptions } from "miniflare"
import { app } from "../worker/app"
import { mintOwnerLink, ownerSecretHash, sign, signOutAll, SESSION_COOKIE } from "../worker/auth"

// Owner identity, the owner link, sessions_epoch, passkeys and the transfer surface.
// Real local D1 and R2; no deployed resources.

const SECRETS = {
  SESSION_SECRET: "session-secret",
  OWNER_LINK_SECRET: "owner-link-secret",
  CAPTURE_TOKEN: "capture-token",
  PUBLIC_URL: "https://snip.test",
}

const ctx0 = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext

// Synthetic object keys: an obviously fake ref id and attempt segment that satisfy
// the transfer key pattern ([a-z0-9]{16} and [A-Za-z0-9._/-]+). Nothing here names a
// real library.
const REF_ID = "testref000000001"
const ATTEMPT = "00000000000000000000000000000a01"
const keyFor = (page = "p0/desktop.jpg") => `refs/${REF_ID}/${ATTEMPT}/${page}`
// Distinct ref ids for the pagination and batching tests, same obviously-fake shape.
const refIdFor = (n: number) => `testref${n.toString().padStart(9, "0")}`

async function setup() {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ["DB"], r2Buckets: ["FILES"] }))
  const database = (await mf.getD1Database("DB")) as unknown as D1Database
  const files = (await mf.getR2Bucket("FILES")) as unknown as R2Bucket
  const dir = new URL("../migrations/", import.meta.url)
  for (const migration of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = await readFile(new URL(migration, dir), "utf8")
    const statements = sql.replace(/^--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean)
    await database.batch(statements.map((statement) => database.prepare(statement)))
  }
  const env = { ...SECRETS, DB: database, FILES: files } as unknown as Env

  type Overrides = Record<string, unknown>
  /** https://snip.test — the deployed origin: secure cookies, no DEV_LOGIN short-circuit. */
  const call = (path: string, init: RequestInit = {}, overrides: Overrides = {}) =>
    app.request(`https://snip.test${path}`, init, { ...env, ...overrides } as Env, ctx0)
  /** http://localhost — where DEV_LOGIN applies. */
  const local = (path: string, init: RequestInit = {}, overrides: Overrides = {}) =>
    app.request(`http://localhost${path}`, init, { ...env, ...overrides } as Env, ctx0)
  const json = (path: string, body: unknown, init: RequestInit & { overrides?: Overrides } = {}) => {
    const { overrides, ...rest } = init
    return call(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" }, ...rest }, overrides)
  }
  const localJson = (path: string, body: unknown) =>
    local(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }, { DEV_LOGIN: "max" })
  return { mf, database, files, env, call, local, json, localJson }
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

const cookieFrom = (res: Response) => {
  const header = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`))
  return header ? header.split(";")[0]! : null
}

/** Signs a session the way the Worker does, without going through a sign-in route. */
async function cookie(env: Env, session: { ownerId: string; method?: string; epoch?: number }, exp = Date.now() + 86_400_000) {
  const payload = `owner:${session.ownerId}|${exp}|${session.method ?? "owner"}|${session.epoch ?? 0}`
  return `${SESSION_COOKIE}=${await sign(env.SESSION_SECRET, payload)}`
}

// ---------- Sessions ----------

test("a legacy login cookie still signs in and reports itself as GitHub", () =>
  withWorker(async ({ database, env, call }) => {
    const legacy = `${SESSION_COOKIE}=${await sign(env.SESSION_SECRET, `fixture-login|${Date.now() + 86_400_000}`)}`
    const me = await call("/api/me", { headers: { cookie: legacy } }, { ALLOWED_GITHUB_LOGINS: "Fixture-Login" })
    assert.equal(me.status, 200, "a deploy must not sign existing sessions out")
    assert.deepEqual(await me.json(), { login: "fixture-login", ownerId: "fixture-login", method: "github" })
    // No owners row yet: epoch 0 is the implicit value, so the legacy cookie is valid.
    assert.equal((await database.prepare("SELECT count(*) AS n FROM owners").first<{ n: number }>())!.n, 0)
  }))

test("a GitHub session ends when its login leaves ALLOWED_GITHUB_LOGINS", () =>
  withWorker(async ({ env, call }) => {
    const github = await cookie(env, { ownerId: "second-person", method: "github" })
    assert.equal((await call("/api/me", { headers: { cookie: github } }, { ALLOWED_GITHUB_LOGINS: "max, second-person" })).status, 200)
    assert.equal((await call("/api/me", { headers: { cookie: github } }, { ALLOWED_GITHUB_LOGINS: "max" })).status, 401)
    assert.equal((await call("/api/me", { headers: { cookie: github } })).status, 401)
    // Other sign-in methods never consult the list.
    const passkey = await cookie(env, { ownerId: "second-person", method: "passkey" })
    assert.equal((await call("/api/me", { headers: { cookie: passkey } }, { ALLOWED_GITHUB_LOGINS: "max" })).status, 200)
  }))

test("the new cookie carries owner and method, and tampering or expiry is refused", () =>
  withWorker(async ({ database, env, call }) => {
    await database.prepare(`INSERT INTO owners (id, label, created_at) VALUES ('max', 'Max', '2026-01-01T00:00:00Z')`).run()
    const good = await cookie(env, { ownerId: "max", method: "passkey", epoch: 0 })
    assert.deepEqual(await (await call("/api/me", { headers: { cookie: good } })).json(), { login: "max", ownerId: "max", method: "passkey" })

    const forged = good.replace(/\.[^.]*$/, ".deadbeef")
    assert.equal((await call("/api/me", { headers: { cookie: forged } })).status, 401)
    const expired = await cookie(env, { ownerId: "max" }, Date.now() - 1000)
    assert.equal((await call("/api/me", { headers: { cookie: expired } })).status, 401)
    // The label comes from the owners row, so a signed session for an unknown identity falls back
    // to its id instead of inventing a display name.
    const other = await cookie(env, { ownerId: "second-person", epoch: 0 })
    assert.deepEqual(await (await call("/api/me", { headers: { cookie: other } })).json(), { login: "second-person", ownerId: "second-person", method: "owner" })
  }))

test("sign out all devices revokes every cookie minted before it", () =>
  withWorker(async ({ database, env, call }) => {
    await database.prepare(`INSERT INTO owners (id, label, created_at) VALUES ('max', 'Max', '2026-01-01T00:00:00Z')`).run()
    const before = await cookie(env, { ownerId: "max", epoch: 0 })
    assert.equal((await call("/api/cloud-status", { headers: { cookie: before } })).status, 200)

    const bumped = await call("/api/sign-out-all", { method: "POST", body: "{}", headers: { cookie: before, "content-type": "application/json" } })
    assert.equal(bumped.status, 200)
    assert.deepEqual(await bumped.json(), { ok: true, epoch: 1 })

    assert.equal((await call("/api/cloud-status", { headers: { cookie: before } })).status, 401)
    const after = await cookie(env, { ownerId: "max", epoch: 1 })
    assert.equal((await call("/api/cloud-status", { headers: { cookie: after } })).status, 200)

    // A second bump keeps moving the counter; the epoch-1 cookie dies too.
    assert.equal((await call("/api/sign-out-all", { method: "POST", body: "{}", headers: { cookie: after, "content-type": "application/json" } })).status, 200)
    assert.equal((await call("/api/cloud-status", { headers: { cookie: after } })).status, 401)
  }))

test("sign out all devices with no owner row still revokes epoch-0 sessions", () =>
  withWorker(async ({ database, env, call }) => {
    const epoch = await signOutAll(env, { ownerId: "max", label: "max", method: "owner", epoch: 0 })
    assert.equal(epoch, 1)
    assert.equal((await database.prepare(`SELECT sessions_epoch FROM owners WHERE id = 'max'`).first<{ sessions_epoch: number }>())!.sessions_epoch, 1)
    const stale = await cookie(env, { ownerId: "max", epoch: 0 })
    assert.equal((await call("/api/cloud-status", { headers: { cookie: stale } })).status, 401)
  }))

test("DEV_LOGIN short-circuits on localhost with epoch -1 and never checks the counter", () =>
  withWorker(async ({ database, local }) => {
    await database.prepare(`INSERT INTO owners (id, label, created_at, sessions_epoch) VALUES ('max', 'Max', '2026-01-01T00:00:00Z', 7)`).run()
    const res = await local("/api/me", {}, { DEV_LOGIN: "local-dev" })
    assert.deepEqual(await res.json(), { login: "local-dev", ownerId: "local-dev", method: "owner" })
    assert.equal((await local("/api/cloud-status", {}, { DEV_LOGIN: "local-dev" })).status, 200)
    // DEV_LOGIN never applies on a deployed origin.
    assert.equal((await local("/api/me", {}, { DEV_LOGIN: "" })).status, 401)
  }))

// ---------- Owner link ----------

test("the owner link GET renders a form, sets no cookie and asks for no referrer", () =>
  withWorker(async ({ env, call }) => {
    const { token } = await mintOwnerLink(env, { ownerId: "max", port: 43111 })
    const res = await call(`/auth/owner?t=${encodeURIComponent(token)}`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get("referrer-policy"), "no-referrer")
    assert.equal(res.headers.get("cache-control"), "no-store")
    const csp = res.headers.get("content-security-policy")!
    assert.match(csp, /form-action 'self'/)
    assert.match(csp, /script-src 'sha256-[A-Za-z0-9+/]+=*'/)
    assert.deepEqual(res.headers.getSetCookie(), [], "a GET must never set a session")
    const html = await res.text()
    assert.match(html, /<form id="snip-owner" method="post" action="\/auth\/owner">/)
    assert.ok(html.includes(token), "the form carries the signed token")
    // The expiry/one-use note appears once; the body says what the button does.
    assert.equal(html.match(/once/g)?.length, 1)
    assert.match(html, /Continue to sign this browser in to your Snip library\./)
  }))

test("an expired owner link is 410, an invalid one is 400, and neither sets a cookie", () =>
  withWorker(async ({ env, call }) => {
    const { token } = await mintOwnerLink(env, { ownerId: "max", ttlSeconds: -1 })
    const expired = await call(`/auth/owner?t=${encodeURIComponent(token)}`)
    assert.equal(expired.status, 410)
    assert.deepEqual(expired.headers.getSetCookie(), [])

    assert.equal((await call("/auth/owner?t=snip-owner-v1%7Cmax%7C9999999999%7Cnothex%7C0.forged")).status, 400)
    assert.equal((await call(`/auth/owner?t=snip-owner-v1%7Cmax%7C9999999999%7C${ATTEMPT}%7C0`)).status, 400)
  }))

test("the owner link POST burns the nonce, creates the owner and hands the session to the loopback", () =>
  withWorker(async ({ database, env, call }) => {
    const { token, nonce } = await mintOwnerLink(env, { ownerId: "max", port: 43111 })
    const res = await call("/auth/owner", { method: "POST", body: new URLSearchParams({ t: token }), headers: { "content-type": "application/x-www-form-urlencoded" } })
    assert.equal(res.status, 302)
    const location = res.headers.get("location")!
    assert.match(location, /^http:\/\/127\.0\.0\.1:43111\/done#token=/)
    const cookie = cookieFrom(res)
    assert.ok(cookie, "POST sets the session")
    assert.match(res.headers.getSetCookie().join("\n"), /HttpOnly/i)
    assert.match(res.headers.getSetCookie().join("\n"), /SameSite=Lax/i)
    assert.equal(res.headers.get("referrer-policy"), "no-referrer")

    // The fragment token is the same signed session the cookie holds.
    const fragment = decodeURIComponent(location.split("#token=")[1]!)
    assert.equal(decodeURIComponent(cookie!.split("=").slice(1).join("=")), fragment)
    // Electron injects the same value raw, without Hono's cookie serialiser.
    assert.equal((await call("/api/me", { headers: { cookie: `${SESSION_COOKIE}=${fragment}` } })).status, 200)

    const owner = await database.prepare(`SELECT * FROM owners WHERE id = 'max'`).first<{ label: string; sessions_epoch: number; owner_secret_hash: string }>()
    assert.equal(owner!.label, "max")
    assert.equal(owner!.sessions_epoch, 0)
    assert.equal(owner!.owner_secret_hash, await ownerSecretHash(env.OWNER_LINK_SECRET))
    assert.equal((await database.prepare(`SELECT count(*) AS n FROM owner_nonces WHERE nonce = ?`).bind(nonce).first<{ n: number }>())!.n, 1)
    assert.equal((await call("/api/me", { headers: { cookie: cookie! } })).status, 200)
  }))

test("a replayed owner link is refused and sets nothing", () =>
  withWorker(async ({ env, call }) => {
    const { token } = await mintOwnerLink(env, { ownerId: "max" })
    const post = () => call("/auth/owner", { method: "POST", body: new URLSearchParams({ t: token }), headers: { "content-type": "application/x-www-form-urlencoded" } })
    assert.equal((await post()).status, 302)
    const again = await post()
    assert.equal(again.status, 409)
    assert.deepEqual(again.headers.getSetCookie(), [])
  }))

test("two simultaneous redemptions of one link: exactly one wins", () =>
  withWorker(async ({ env, call }) => {
    const { token } = await mintOwnerLink(env, { ownerId: "max" })
    const post = () => call("/auth/owner", { method: "POST", body: new URLSearchParams({ t: token }), headers: { "content-type": "application/x-www-form-urlencoded" } })
    const [a, b] = await Promise.all([post(), post()])
    assert.deepEqual([a.status, b.status].sort(), [302, 409], "the D1 burn admits exactly one redeemer")
    assert.equal([a, b].filter((r) => r.headers.getSetCookie().length > 0).length, 1)
  }))

test("the owner link POST accepts the null origin Chromium sends with no-referrer, but not a foreign one", () =>
  withWorker(async ({ env, call }) => {
    const post = (token: string, origin?: string) =>
      call("/auth/owner", {
        method: "POST",
        body: new URLSearchParams({ t: token }),
        headers: { "content-type": "application/x-www-form-urlencoded", ...(origin ? { origin } : {}) },
      })

    // Chromium: a form POST from a `Referrer-Policy: no-referrer` document carries Origin: null.
    const first = await mintOwnerLink(env, { ownerId: "max" })
    assert.equal((await post(first.token, "null")).status, 302, "the real browser path works")

    const second = await mintOwnerLink(env, { ownerId: "max" })
    const foreign = await post(second.token, "https://evil.example")
    assert.equal(foreign.status, 403, "a foreign origin is still refused")
    assert.deepEqual(foreign.headers.getSetCookie(), [])
    // The token was not burned by the refused attempt.
    assert.equal((await post(second.token, "null")).status, 302)

    const crossSite = await call("/auth/owner", {
      method: "POST",
      body: new URLSearchParams({ t: (await mintOwnerLink(env, { ownerId: "max" })).token }),
      headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "cross-site" },
    })
    assert.equal(crossSite.status, 403, "a cross-site fetch is refused even without an origin")
  }))

test("an owner link without a port redirects home instead of to a listener", () =>
  withWorker(async ({ env, call }) => {
    const { token } = await mintOwnerLink(env, { ownerId: "max", port: 0 })
    const res = await call("/auth/owner", { method: "POST", body: new URLSearchParams({ t: token }), headers: { "content-type": "application/x-www-form-urlencoded" } })
    assert.equal(res.status, 302)
    assert.equal(res.headers.get("location"), "/")
  }))

// ---------- Transfer ----------

const transfer = { TRANSFER_TOKEN: "transfer-token" }
const bearer = { authorization: "Bearer transfer-token" }

test("the transfer surface is invisible without a token and refuses a wrong one", () =>
  withWorker(async ({ call }) => {
    for (const path of ["/transfer/status", "/transfer/manifest", "/transfer/file/refs/a/b/p0/desktop.jpg"]) {
      assert.equal((await call(path, { headers: bearer })).status, 404, `${path} without a configured token`)
    }
    assert.equal((await call("/transfer/resume", { method: "POST", body: "{}", headers: { ...bearer, "content-type": "application/json" } })).status, 404)
    assert.equal((await call("/transfer/status", { headers: { authorization: "Bearer wrong" } }, transfer)).status, 401)
    assert.equal((await call("/transfer/status", {}, transfer)).status, 401, "no token at all is 401, not 404")
    assert.equal((await call("/transfer/status", { headers: bearer }, transfer)).status, 200)
  }))

/** Miniflare's R2 binding needs a fixed-length stream; production workerd takes request.body. */
function bufferedFiles(files: R2Bucket): R2Bucket {
  return new Proxy(files, {
    get(target, name) {
      if (name === "put") {
        return async (key: string, body: ReadableStream | ArrayBuffer | string, options?: R2PutOptions) => {
          const value = typeof body === "string" || body instanceof ArrayBuffer ? body : await new Response(body).arrayBuffer()
          return target.put(key, value, options)
        }
      }
      const value = Reflect.get(target, name, target)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

test("transfer status and manifest describe the library, and files round-trip", () =>
  withWorker(async ({ files, call, localJson }) => {
    const uploadFiles = bufferedFiles(files)
    await localJson("/api/references", { url: "https://linear.app", mode: "single" })
    const key = keyFor("p0/desktop.jpg")
    await files.put(key, "12345")

    const status = (await (await call("/transfer/status", { headers: bearer }, transfer)).json()) as { hasOwner: boolean; counts: { refs: number }; ownerSecretHash: string | null; version: string }
    assert.equal(status.hasOwner, false)
    assert.equal(status.counts.refs, 1)
    assert.equal(status.ownerSecretHash, await ownerSecretHash("owner-link-secret"))
    assert.ok(status.version)

    const manifest = (await (await call("/transfer/manifest", { headers: bearer }, transfer)).json()) as {
      version: number
      tables: Record<string, number>
      excluded: string[]
      keys: { key: string; size: number; contentType: string }[]
      totalBytes: number
    }
    assert.equal(manifest.version, 1)
    assert.equal(manifest.tables.refs, 1)
    assert.deepEqual(manifest.keys, [{ key, size: 5, contentType: "application/octet-stream" }])
    assert.equal(manifest.totalBytes, 5)
    assert.equal(manifest.tables.owner_nonces, undefined, "ephemeral tables are not counted")
    // `excluded` is computed from the database, so it names the short-lived tables that exist in
    // this fixture. d1_migrations has its own test, where the ledger is really there.
    assert.deepEqual(manifest.excluded, ["owner_nonces", "webauthn_challenges"], "and the omission is named, not silent")
    assert.ok("owners" in manifest.tables && "passkeys" in manifest.tables, "owner data is part of the library")

    const head = await call(`/transfer/file/${key}`, { method: "HEAD", headers: bearer }, transfer)
    assert.equal(head.status, 200)

    const mobile = keyFor("p0/mobile.jpg")
    const transferPut = (path: string, body: string, init: RequestInit = {}) => call(path, { method: "PUT", body, headers: { ...bearer, "content-type": "image/jpeg" }, ...init }, { ...transfer, FILES: uploadFiles })
    const put = await transferPut(`/transfer/file/${mobile}`, "abcdef")
    assert.equal(put.status, 200)
    assert.deepEqual(await put.json(), { ok: true, size: 6 })
    assert.equal(await (await call(`/transfer/file/${mobile}`, { headers: bearer }, transfer)).text(), "abcdef")
    assert.equal((await transferPut(`/transfer/file/${mobile}`, "other")).status, 409)
    assert.equal((await transferPut(`/transfer/file/${mobile}?overwrite=1`, "other")).status, 200)
    assert.equal(await (await call(`/transfer/file/${mobile}`, { headers: bearer }, transfer)).text(), "other")

    for (const bad of ["refs/AB/p0/x.jpg", "refs/nope", "refs/a/../p0/x.jpg", "notrefs/a/b.jpg"]) {
      assert.equal((await transferPut(`/transfer/file/${encodeURIComponent(bad)}`, "x")).status, 400, bad)
    }
  }))

test("a transfer body declared over 100 MB is refused with 413", () =>
  withWorker(async ({ env }) => {
    const key = keyFor("p0/huge.jpg")
    const request = new Request(`https://snip.test/transfer/file/${key}`, {
      method: "PUT",
      body: "x",
      headers: { ...bearer, "content-length": String(100 * 1024 * 1024 + 1) },
    })
    const res = await app.fetch(request, { ...env, ...transfer } as Env, ctx0)
    assert.equal(res.status, 413)
  }))

test("transfer download streams the object and never buffers it", () =>
  withWorker(async ({ env }) => {
    const key = keyFor("p0/desktop.jpg")
    const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])]
    let reads = 0
    // The stub has no arrayBuffer(): a route that buffered would fail here.
    const streamed = {
      key,
      size: 5,
      httpEtag: '"etag-1"',
      httpMetadata: { contentType: "image/jpeg" },
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          const next = chunks[reads++]
          if (next) controller.enqueue(next)
          else controller.close()
        },
      }),
      arrayBuffer() {
        throw new Error("the download route must stream, not buffer")
      },
    }
    const files = { get: async (k: string) => (k === key ? streamed : null), head: async () => null } as unknown as R2Bucket
    const res = await app.fetch(new Request(`https://snip.test/transfer/file/${key}`, { headers: bearer }), { ...env, ...transfer, FILES: files } as Env, ctx0)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get("content-type"), "image/jpeg")
    assert.equal(res.headers.get("content-length"), "5")
    assert.equal(res.headers.get("etag"), '"etag-1"')
    assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [1, 2, 3, 4, 5])

    assert.equal((await app.fetch(new Request(`https://snip.test/transfer/file/${key}`, { headers: { authorization: "Bearer wrong" } }), { ...env, ...transfer, FILES: files } as Env, ctx0)).status, 401)
    assert.equal(
      (await app.fetch(new Request(`https://snip.test/transfer/file/refs/${REF_ID}/x/p0/missing.jpg`, { headers: bearer }), { ...env, ...transfer, FILES: files } as Env, ctx0)).status,
      404,
    )
  }))

test("transfer upload keeps the contentType the manifest reported", () =>
  withWorker(async ({ files, call, localJson }) => {
    const uploadFiles = bufferedFiles(files)
    await localJson("/api/references", { url: "https://linear.app", mode: "single" })
    const key = keyFor("p0/mobile.jpg")
    const put = await call(`/transfer/file/${key}`, { method: "PUT", body: "png-bytes", headers: { ...bearer, "content-type": "image/png" } }, { ...transfer, FILES: uploadFiles })
    assert.equal(put.status, 200)

    const manifest = (await (await call("/transfer/manifest", { headers: bearer }, transfer)).json()) as { keys: { key: string; contentType: string }[] }
    assert.deepEqual(manifest.keys, [{ key, size: 9, contentType: "image/png" }])
    const download = await call(`/transfer/file/${key}`, { headers: bearer }, transfer)
    assert.equal(download.headers.get("content-type"), "image/png")
    assert.equal(await download.text(), "png-bytes")
  }))

test("the manifest lists every bucket page, orphans included, and never reads D1 for keys", () =>
  withWorker(async ({ database, env }) => {
    // 2,500 objects over three pages, including one that no row references.
    const objects = Array.from({ length: 2500 }, (_, i) => ({
      key: `refs/${refIdFor(i)}/p/p0/desktop.jpg`,
      size: i + 1,
      // list() reports no httpMetadata here, so the route falls back to HEAD per key.
      httpMetadata: {},
      httpEtag: `"${i}"`,
    }))
    const pages = [objects.slice(0, 1000), objects.slice(1000, 2000), objects.slice(2000)]
    let calls = 0
    const files = {
      list: async (options: { cursor?: string; limit?: number } = {}) => {
        assert.equal(options.limit, 1000)
        const index = options.cursor ? Number(options.cursor) : 0
        calls++
        const page = pages[index]!
        return { objects: page, truncated: index < pages.length - 1, cursor: String(index + 1) }
      },
      head: async (key: string) => ({ key, size: 1, httpEtag: '"x"', httpMetadata: { contentType: "image/jpeg" } }),
    } as unknown as R2Bucket

    const res = await app.fetch(new Request("https://snip.test/transfer/manifest", { headers: bearer }), { ...env, ...transfer, FILES: files } as Env, ctx0)
    assert.equal(res.status, 200)
    const manifest = (await res.json()) as { keys: { key: string; size: number; contentType: string }[]; totalBytes: number; tables: Record<string, number>; heads: number; keyCount: number }
    assert.equal(calls, 3, "every page is listed")
    assert.equal(manifest.keys.length, 2500)
    assert.equal(manifest.keyCount, 2500)
    assert.equal(manifest.totalBytes, (2500 * 2501) / 2)
    assert.deepEqual(manifest.keys[0], { key: objects[0]!.key, size: 1, contentType: "image/jpeg" })
    assert.equal(manifest.keys[2499]!.key, objects[2499]!.key)
    assert.equal(manifest.heads, 2500, "one fallback HEAD per object, reported so a hosted regression is visible")
    // Tables still come from D1.
    assert.equal(manifest.tables.refs, 0)
    void database
  }))

test("the migration ledger is excluded from the copy, so a version skew cannot fail a correct pull", () =>
  withWorker(async ({ database, env, call, local, localJson }) => {
    const files = { list: async () => ({ objects: [], truncated: false, cursor: "" }) } as unknown as R2Bucket
    const withFiles = { ...transfer, FILES: files }

    await localJson("/api/references", { url: "https://linear.app", mode: "single" })

    // A remote deployed by an older Snip: its ledger stops before the migrations this release
    // applies, so its row count is legitimately smaller than the staged copy's.
    await database.prepare(`CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`).run()
    for (const name of ["0001_init.sql", "0002_mcp_media_status.sql", "0006_notes_and_options.sql"]) {
      await database.prepare(`INSERT INTO d1_migrations (name) VALUES (?)`).bind(name).run()
    }

    const manifest = (await (await app.fetch(new Request("https://snip.test/transfer/manifest", { headers: bearer }), { ...env, ...withFiles } as Env, ctx0)).json()) as {
      tables: Record<string, number>
      excluded: string[]
    }
    assert.equal("d1_migrations" in manifest.tables, false, "a ledger row count must never reach pull-verify")
    assert.ok(manifest.excluded.includes("d1_migrations"), "and the omission is named so the engine can skip it")

    // The two credential tables must still travel: a move that dropped them would lock the owner out.
    assert.equal("owners" in manifest.tables, true)
    assert.equal("passkeys" in manifest.tables, true)
    assert.equal(manifest.excluded.includes("owners") || manifest.excluded.includes("passkeys"), false)

    // /transfer/status and /api/cloud-status read counts from libraryCounts, which names its
    // tables explicitly, so the ledger cannot disturb guard, verify or the Settings copy.
    const status = (await (await call("/transfer/status", { headers: bearer }, withFiles)).json()) as { counts: Record<string, number> }
    assert.deepEqual(status.counts, { refs: 1, pages: 0, animations: 0, collections: 0, images: 0 })
    const cloud = (await (await local("/api/cloud-status", {}, { DEV_LOGIN: "max" })).json()) as { counts: Record<string, number> }
    assert.deepEqual(cloud.counts, { refs: 1, pages: 0, animations: 0, collections: 0, images: 0 })
  }))

test("the content-type fallback is batched, and costs nothing when the listing carries it", () =>
  withWorker(async ({ env }) => {
    let inFlight = 0
    let peak = 0
    let heads = 0
    const objects = Array.from({ length: 40 }, (_, i) => ({
      key: `refs/${refIdFor(i)}/p0/page.jpg`,
      size: 10,
      httpMetadata: {},
      httpEtag: `"${i}"`,
    }))
    const files = {
      list: async () => ({ objects, truncated: false, cursor: "" }),
      head: async (key: string) => {
        heads++
        inFlight++
        peak = Math.max(peak, inFlight)
        // A microtask is enough to let the other workers overlap; a truly serial loop never peaks above 1.
        await new Promise((resolve) => setTimeout(resolve, 1))
        inFlight--
        return { key, size: 10, httpEtag: '"x"', httpMetadata: { contentType: "image/png" } }
      },
    } as unknown as R2Bucket

    const batched = (await (await app.fetch(new Request("https://snip.test/transfer/manifest", { headers: bearer }), { ...env, ...transfer, FILES: files } as Env, ctx0)).json()) as { heads: number; keys: { contentType: string }[] }
    assert.equal(heads, 40)
    assert.equal(batched.heads, 40)
    assert.equal(peak, 8, "concurrency is exactly 8, not one await per object")
    assert.ok(batched.keys.every((k) => k.contentType === "image/png"))

    // When the listing has the metadata (real R2), no HEAD happens at all.
    heads = 0
    const withMetadata = {
      list: async () => ({ objects: objects.map((o) => ({ ...o, httpMetadata: { contentType: "image/jpeg" } })), truncated: false, cursor: "" }),
      head: async () => {
        heads++
        throw new Error("no HEAD should be needed")
      },
    } as unknown as R2Bucket
    const direct = (await (await app.fetch(new Request("https://snip.test/transfer/manifest", { headers: bearer }), { ...env, ...transfer, FILES: withMetadata } as Env, ctx0)).json()) as { heads: number; keys: { contentType: string }[] }
    assert.equal(heads, 0)
    assert.equal(direct.heads, 0)
    assert.ok(direct.keys.every((k) => k.contentType === "image/jpeg"))
  }))

test("transfer resume un-pauses through db.resumeReference and is idempotent", () =>
  withWorker(async ({ database, json, localJson, local }) => {
    const paused = (await (await localJson("/api/references", { url: "https://linear.app", mode: "single" })).json()) as { id: string }
    const running = (await (await localJson("/api/references", { url: "https://stripe.com", mode: "single" })).json()) as { id: string }
    await database.prepare(`UPDATE refs SET capture_control = 'paused', progress = 'Paused' WHERE id = ?`).bind(paused.id).run()
    await database.prepare(`UPDATE refs SET status = 'capturing', capture_control = 'pause' WHERE id = ?`).bind(running.id).run()

    const first = await json("/transfer/resume", { ids: [paused.id, running.id, "ffffffffffffffff"] }, { headers: bearer, overrides: transfer })
    assert.equal(first.status, 200)
    assert.deepEqual(await first.json(), { resumed: 2, skipped: ["ffffffffffffffff"] })

    const row = await database.prepare(`SELECT status, capture_control, progress FROM refs WHERE id = ?`).bind(paused.id).first<{ status: string; capture_control: string | null; progress: string }>()
    assert.deepEqual(row, { status: "queued", capture_control: null, progress: "Waiting for your Mac" })

    const second = await json("/transfer/resume", { ids: [paused.id, running.id, "ffffffffffffffff"] }, { headers: bearer, overrides: transfer })
    assert.deepEqual(await second.json(), { resumed: 0, skipped: [paused.id, running.id, "ffffffffffffffff"] }, "a second call changes nothing")

    const tooMany = Array.from({ length: 101 }, (_, i) => i.toString(16).padStart(16, "0"))
    for (const ids of [[], ["short"], ["ABCDEF0123456789"], tooMany, "x"]) {
      assert.equal((await json("/transfer/resume", { ids }, { headers: bearer, overrides: transfer })).status, 400, JSON.stringify(ids).slice(0, 40))
    }
    assert.equal((await json("/transfer/resume", { ids: [paused.id] }, { headers: { authorization: "Bearer nope" }, overrides: transfer })).status, 401)

    // The app's own pause and resume routes still work for an owner session, which is what the
    // engine's local quiesce uses (DEV_LOGIN on localhost).
    assert.equal((await local(`/api/references/${running.id}/pause`, { method: "POST" }, { DEV_LOGIN: "max" })).status, 200)
    assert.equal((await local(`/api/references/${running.id}/resume`, { method: "POST" }, { DEV_LOGIN: "max" })).status, 200)
  }))

// ---------- Cloud status and passkeys ----------

test("one Worker version, reported identically by the transfer and app status routes", () =>
  withWorker(async ({ call, local }) => {
    const { WORKER_VERSION } = await import("../worker/version")
    // Contracts §5.4 + §4.6: the engine records this at deploy and compares against its record.
    const status = (await (await call("/transfer/status", { headers: bearer }, transfer)).json()) as { version: string }
    assert.equal(status.version, WORKER_VERSION)
    const cloud = (await (await local("/api/cloud-status", {}, { DEV_LOGIN: "max" })).json()) as { version: string }
    assert.equal(cloud.version, WORKER_VERSION)
  }))

test("ensureOwner upserts in place and never undoes sign-out-all or touches passkeys", () =>
  withWorker(async ({ database, env }) => {
    const { ensureOwner } = await import("../worker/auth")
    await ensureOwner(env, "max", "max", "hash-1")
    const created = await database.prepare(`SELECT * FROM owners WHERE id = 'max'`).first<{ sessions_epoch: number; label: string; owner_secret_hash: string }>()
    assert.deepEqual([created!.sessions_epoch, created!.label, created!.owner_secret_hash], [0, "max", "hash-1"])

    // The owner signs out everywhere, then signs in again through a fresh link.
    await database.prepare(`UPDATE owners SET sessions_epoch = 3 WHERE id = 'max'`).run()
    await database
      .prepare(`INSERT INTO passkeys (id, owner_id, public_key, counter, created_at) VALUES ('k1', 'max', ?2, 0, '2026-01-01T00:00:00Z')`)
      .bind("k1", new Uint8Array([1, 2, 3]))
      .run()

    await ensureOwner(env, "max", null, null)
    const after = await database.prepare(`SELECT * FROM owners WHERE id = 'max'`).first<{ sessions_epoch: number; label: string; owner_secret_hash: string }>()
    assert.equal(after!.sessions_epoch, 3, "signing in again must not restore sessions the owner ended")
    assert.equal(after!.label, "max", "an existing label is kept")
    assert.equal(after!.owner_secret_hash, "hash-1", "and so is the recorded secret hash")
    assert.equal((await database.prepare(`SELECT count(*) AS n FROM passkeys`).first<{ n: number }>())!.n, 1, "passkeys are never touched")

    // `owner rotate` supplies a new hash; that one replaces the old value.
    await ensureOwner(env, "max", "Max", "hash-2")
    assert.equal((await database.prepare(`SELECT owner_secret_hash FROM owners WHERE id = 'max'`).first<{ owner_secret_hash: string }>())!.owner_secret_hash, "hash-2")

    // A brand-new identity inherits the current epoch instead of resetting the counter to 0.
    await ensureOwner(env, "second", "second")
    assert.equal((await database.prepare(`SELECT sessions_epoch FROM owners WHERE id = 'second'`).first<{ sessions_epoch: number }>())!.sessions_epoch, 3)
  }))

test("an adopted library's owner is the id the engine must mint links for", () =>
  withWorker(async ({ database, call }) => {
    const status = async () => {
      const body = (await (await call("/transfer/status", { headers: bearer }, transfer)).json()) as { hasOwner: boolean; ownerId: string | null }
      return { hasOwner: body.hasOwner, ownerId: body.ownerId }
    }
    assert.deepEqual(await status(), { hasOwner: false, ownerId: null }, "a legacy install with no owner row falls back to decision 15")

    // Two rows, the later one created first in wall-clock terms: the install's first identity wins.
    await database.prepare(`INSERT INTO owners (id, label, created_at) VALUES ('max', 'max', '2026-01-01T00:00:00Z')`).run()
    await database.prepare(`INSERT INTO owners (id, label, created_at) VALUES ('second-person', 'second-person', '2026-02-01T00:00:00Z')`).run()
    assert.deepEqual(await status(), { hasOwner: true, ownerId: "max" }, "§4.2.1: the exact ownerId, never a default")
  }))

test("cloud status reports the owner, methods, counts and the capture agent", () =>
  withWorker(async ({ database, local }) => {
    const initial = (await (await local("/api/cloud-status", {}, { DEV_LOGIN: "max" })).json()) as Record<string, unknown>
    assert.deepEqual(Object.keys(initial).sort(), ["counts", "hasOwner", "lastCapture", "methods", "ownerId", "version"])
    assert.equal(initial.hasOwner, false)
    assert.deepEqual(initial.methods, [], "no GitHub credentials and no passkeys")
    assert.deepEqual(initial.counts, { refs: 0, pages: 0, animations: 0, collections: 0, images: 0 })
    assert.deepEqual(initial.lastCapture, { at: null, activity: null, stale: true })

    await database.prepare(`INSERT INTO owners (id, label, created_at) VALUES ('max', 'Max', '2026-01-01T00:00:00Z')`).run()
    await database.prepare(`INSERT INTO passkeys (id, owner_id, public_key, counter, created_at) VALUES ('k1', 'max', ?2, 0, '2026-01-01T00:00:00Z')`).bind("k1", new Uint8Array([1, 2, 3])).run()
    const withPasskey = (await (await local("/api/cloud-status", {}, { DEV_LOGIN: "max" })).json()) as { hasOwner: boolean; ownerId: string; methods: string[] }
    assert.deepEqual([withPasskey.hasOwner, withPasskey.ownerId, withPasskey.methods], [true, "max", ["passkey"]])

    const withGitHub = await local("/api/cloud-status", {}, { DEV_LOGIN: "max", GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret" })
    assert.deepEqual(((await withGitHub.json()) as { methods: string[] }).methods, ["passkey", "github"])
  }))

test("passkeys are owner-only: enrolment needs a session and the owner row", () =>
  withWorker(async ({ database, call, local }) => {
    assert.equal((await call("/auth/passkey/register/options")).status, 401)
    // A GitHub session whose login is not the owner cannot enrol a passkey.
    assert.equal((await local("/auth/passkey/register/options", {}, { DEV_LOGIN: "someone" })).status, 403)

    await database.prepare(`INSERT INTO owners (id, label, created_at) VALUES ('max', 'Max', '2026-01-01T00:00:00Z')`).run()
    const options = await local("/auth/passkey/register/options", {}, { DEV_LOGIN: "max" })
    assert.equal(options.status, 200)
    const body = (await options.json()) as { rp: { id: string; name: string }; challenge: string; user: { name: string } }
    assert.equal(body.rp.id, "snip.test", "RP ID comes from PUBLIC_URL, never the request host")
    assert.equal(body.user.name, "max")
    assert.ok(body.challenge)
    assert.equal((await database.prepare(`SELECT count(*) AS n FROM webauthn_challenges WHERE kind = 'register'`).first<{ n: number }>())!.n, 1)

    // A challenge is single use: the second burn removes nothing.
    const stored = await database.prepare(`SELECT challenge FROM webauthn_challenges WHERE kind = 'register'`).first<{ challenge: string }>()
    assert.equal((await database.prepare(`DELETE FROM webauthn_challenges WHERE challenge = ?`).bind(stored!.challenge).run()).meta.changes, 1)
    assert.equal((await database.prepare(`DELETE FROM webauthn_challenges WHERE challenge = ?`).bind(stored!.challenge).run()).meta.changes, 0)
  }))

test("passkey sign-in needs a registered credential and devices never expose the public key", () =>
  withWorker(async ({ database, call, local }) => {
    const empty = await call("/auth/passkey/login/options")
    assert.equal(empty.status, 400)
    assert.match(await empty.text(), /owner link or GitHub/)

    await database.prepare(`INSERT INTO owners (id, label, created_at) VALUES ('max', 'Max', '2026-01-01T00:00:00Z')`).run()
    await database.prepare(`INSERT INTO passkeys (id, owner_id, public_key, counter, transports, created_at) VALUES ('k1', 'max', ?2, 0, '["internal"]', '2026-01-01T00:00:00Z')`).bind("k1", new Uint8Array([1, 2, 3])).run()
    const options = await call("/auth/passkey/login/options")
    assert.equal(options.status, 200)
    const body = (await options.json()) as { challenge: string; rpId: string; allowCredentials: { id: string; transports: string[] }[] }
    assert.equal(body.rpId, "snip.test")
    assert.deepEqual(body.allowCredentials, [{ id: "k1", type: "public-key", transports: ["internal"] }])

    const devices = (await (await local("/api/passkeys", {}, { DEV_LOGIN: "max" })).json()) as { devices: Record<string, unknown>[] }
    assert.deepEqual(devices.devices.map((d) => d.id), ["k1"])
    assert.equal("publicKey" in devices.devices[0]!, false)

    assert.equal((await local("/api/passkeys/k1", { method: "DELETE" }, { DEV_LOGIN: "max" })).status, 200)
    assert.equal((await database.prepare(`SELECT count(*) AS n FROM passkeys`).first<{ n: number }>())!.n, 0)
    assert.equal((await local("/api/passkeys/k1", { method: "DELETE" }, { DEV_LOGIN: "max" })).status, 404)
  }))

test("GitHub mounts only with both credentials and keeps its allowlist behaviour", () =>
  withWorker(async ({ call, local }) => {
    assert.equal((await call("/auth/login")).status, 404)
    assert.equal((await call("/auth/callback")).status, 404)

    // Contracts §5.2: a client id without its secret cannot complete a sign-in, so the routes do
    // not mount and cloud-status does not advertise GitHub as a method.
    const halfConfigured = { GITHUB_CLIENT_ID: "id", ALLOWED_GITHUB_LOGINS: "max" }
    assert.equal((await call("/auth/login", {}, halfConfigured)).status, 404)
    assert.equal((await call("/auth/callback", {}, halfConfigured)).status, 404)
    const methods = (await (await local("/api/cloud-status", {}, { DEV_LOGIN: "max", ...halfConfigured })).json()) as { methods: string[] }
    assert.deepEqual(methods.methods, [], "a method that cannot finish must not be offered")

    const github = { GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret", ALLOWED_GITHUB_LOGINS: "max, second-person" }
    const login = await call("/auth/login", {}, github)
    assert.equal(login.status, 302)
    assert.match(login.headers.get("location")!, /^https:\/\/github\.com\/login\/oauth\/authorize\?/)

    // A second person's login is still accepted by the allowlist parser.
    const { allowedLogins } = await import("../worker/auth")
    assert.deepEqual(allowedLogins(github as unknown as Env), ["max", "second-person"])

    const noLogins = await call("/auth/login", {}, { GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret", ALLOWED_GITHUB_LOGINS: "your-github-login" })
    assert.equal(noLogins.status, 503)
  }))
