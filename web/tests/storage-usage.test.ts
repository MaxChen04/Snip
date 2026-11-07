import { test, type TestContext } from "node:test"
import assert from "node:assert/strict"
import { Miniflare, convertV4MiniflareOptions } from "miniflare"
import { app } from "../worker/app"
import { sign } from "../worker/auth"
import { applyMigrations } from "./helpers/d1"

async function setup(t: TestContext) {
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: 'export default {fetch(){return new Response("ok")}}',
    r2Buckets: ["FILES", "OTHER_FILES"],
    // Sessions are checked against the owners table (sign out all devices).
    d1Databases: ["DB"],
  }))
  const database = await mf.getD1Database("DB") as unknown as D1Database
  await applyMigrations(database)
  const cacheStorage = await mf.getCaches()
  const previousCaches = Object.getOwnPropertyDescriptor(globalThis, "caches")
  const setCaches = (value: unknown) => Object.defineProperty(globalThis, "caches", { value, configurable: true })
  let cacheOpens = 0
  setCaches({
    async open(name: string) {
      cacheOpens++
      return cacheStorage.open(name)
    },
  })
  t.after(async () => {
    if (previousCaches) Object.defineProperty(globalThis, "caches", previousCaches)
    else Reflect.deleteProperty(globalThis, "caches")
    await mf.dispose()
  })

  const files = await mf.getR2Bucket("FILES") as unknown as R2Bucket
  const otherFiles = await mf.getR2Bucket("OTHER_FILES") as unknown as R2Bucket
  let listings = 0
  let list = (options?: R2ListOptions) => files.list(options)
  const trackedFiles = new Proxy(files, {
    get(target, property, receiver) {
      if (property === "list") return (options?: R2ListOptions) => {
        listings++
        return list(options)
      }
      return Reflect.get(target, property, receiver)
    },
  })
  const call = async ({ authenticated = true, origin = "https://snip.example", secret = "test-secret", bucket = trackedFiles, query = "" } = {}) => {
    const headers = new Headers()
    if (authenticated) headers.set("cookie", `rs_session=${await sign(secret, `max|${Date.now() + 60_000}`)}`)
    const env = { DB: database, FILES: bucket, SESSION_SECRET: secret, ALLOWED_GITHUB_LOGINS: "max" } as unknown as Env
    return app.request(`${origin}/api/storage${query}`, { headers }, env)
  }
  return {
    files, otherFiles, call, setCaches,
    listings: () => listings,
    cacheOpens: () => cacheOpens,
    setList: (replacement: typeof list) => { list = replacement },
  }
}

test("authenticated menu reads reuse the summary; unauthenticated reads never touch cache or R2", async (t) => {
  const s = await setup(t)
  await s.files.put("refs/a/desktop.jpg", "12345")
  assert.equal((await s.call({ authenticated: false })).status, 401)
  assert.equal(s.listings(), 0)
  assert.equal(s.cacheOpens(), 0)

  const first = await s.call()
  assert.equal(first.status, 200)
  assert.equal(first.headers.get("cache-control"), "private, no-store")
  const usage = await first.json()
  assert.deepEqual(usage, { bytes: 5, objects: 1, partial: false, freeBytes: 10 * 1024 ** 3 })
  await s.files.put("refs/a/mobile.jpg", "123")

  const repeated = await s.call({ query: "?menu=open" })
  assert.equal(repeated.headers.get("cache-control"), "private, no-store")
  assert.deepEqual(await repeated.json(), usage)
  assert.equal(s.listings(), 1)
  const opens = s.cacheOpens()
  assert.equal((await s.call({ authenticated: false })).status, 401)
  assert.equal(s.listings(), 1)
  assert.equal(s.cacheOpens(), opens)
})

test("the summary refreshes after five minutes without extending expiry on a hit", async (t) => {
  const s = await setup(t)
  await s.files.put("refs/a/desktop.jpg", "12345")
  await s.call()
  await s.files.put("refs/a/mobile.jpg", "123")
  const start = Date.now()
  t.mock.method(Date, "now", () => start + 4 * 60_000)
  assert.equal((await (await s.call()).json()).bytes, 5)
  assert.equal(s.listings(), 1)
  t.mock.method(Date, "now", () => start + 5 * 60_000 + 1)
  assert.equal((await (await s.call()).json()).bytes, 8)
  assert.equal(s.listings(), 2)
})

test("bounded scans retain their partial flag in cached summaries", async (t) => {
  const s = await setup(t)
  await s.files.put("refs/a/desktop.jpg", "12345")
  const page = await s.files.list()
  s.setList(async (): Promise<R2Objects> => ({ ...page, truncated: true, cursor: "more" }))
  const usage = await (await s.call()).json()
  assert.deepEqual(usage, { bytes: 200, objects: 40, partial: true, freeBytes: 10 * 1024 ** 3 })
  assert.deepEqual(await (await s.call()).json(), usage)
  assert.equal(s.listings(), 40)
})

test("cache keys isolate origins and installations using different session secrets", async (t) => {
  const s = await setup(t)
  await s.files.put("refs/a/desktop.jpg", "12345")
  await s.otherFiles.put("refs/b/desktop.jpg", "123456789")
  assert.equal((await (await s.call()).json()).bytes, 5)
  assert.equal((await (await s.call({ secret: "other-instance", bucket: s.otherFiles })).json()).bytes, 9)
  await s.files.put("refs/a/mobile.jpg", "123")
  assert.equal((await (await s.call({ origin: "https://other.example" })).json()).bytes, 8)
  assert.equal((await (await s.call()).json()).bytes, 5)
  assert.equal(s.listings(), 2)
})

test("R2 failures are not cached and a later request can retry", async (t) => {
  const s = await setup(t)
  t.mock.method(console, "error", () => {})
  s.setList(async () => { throw new Error("R2 temporarily unavailable") })
  const failed = await s.call()
  assert.equal(failed.status, 500)
  assert.equal(failed.headers.get("cache-control"), "private, no-store")
  await s.files.put("refs/a/desktop.jpg", "12345")
  s.setList((options) => s.files.list(options))
  assert.equal((await (await s.call()).json()).bytes, 5)
  assert.equal((await (await s.call()).json()).bytes, 5)
  assert.equal(s.listings(), 2)
})

test("unavailable caches and cache read/write failures still return the storage summary", async (t) => {
  const s = await setup(t)
  await s.files.put("refs/a/desktop.jpg", "12345")
  Reflect.deleteProperty(globalThis, "caches")
  assert.equal((await (await s.call()).json()).bytes, 5)
  s.setCaches({ open: async () => { throw new Error("cache unavailable") } })
  assert.equal((await (await s.call()).json()).bytes, 5)
  s.setCaches({ open: async () => ({
    match: async () => { throw new Error("cache read failed") },
    put: async () => { throw new Error("cache write failed") },
  }) })
  assert.equal((await (await s.call()).json()).bytes, 5)
  assert.equal(s.listings(), 3)
})
