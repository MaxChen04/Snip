import { test } from "node:test"
import assert from "node:assert/strict"
import { Miniflare, convertV4MiniflareOptions } from "miniflare"
import type { Reference } from "../shared/types"
import { app } from "../worker/app"
import * as db from "../worker/db"
import { applyMigrations } from "./helpers/d1"

// Adding a website: what counts as the same site URL, and which URLs are refused.

async function setup() {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ["DB"], r2Buckets: ["FILES"] }))
  const database = (await mf.getD1Database("DB")) as unknown as D1Database
  await applyMigrations(database)
  const env = { DB: database, SESSION_SECRET: "test-secret", DEV_LOGIN: "max" } as unknown as Env
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext
  /** POST /api/references the way the app does, and the status with the JSON body. */
  const add = async (url: unknown, extra: Record<string, unknown> = {}) => {
    const res = await app.request("http://localhost/api/references", { method: "POST", body: JSON.stringify({ url, mode: "single", ...extra }), headers: { "content-type": "application/json" } }, env, ctx)
    return { status: res.status, body: (await res.json()) as Reference & { error?: string; existing?: Reference } }
  }
  return { mf, database, add }
}

test("the same site URL is a duplicate however it is written; a different page or query is not", async () => {
  const { mf, database, add } = await setup()
  try {
    const saved = await add("ando.so")
    assert.equal(saved.status, 201)
    assert.equal(saved.body.url, "https://ando.so/", "the stored URL is the one given, made absolute")

    for (const same of [
      "ando.so", "ando.so/", "https://ando.so", "https://www.ando.so/", "www.ando.so", "http://ando.so", "http://www.ando.so/", "HTTPS://ANDO.SO/",
      "https://ando.so/#pricing", "https://ando.so/?utm_source=newsletter&utm_medium=email", "https://ando.so/?UTM_Campaign=x", "https://www.ando.so/?gclid=abc&fbclid=def&ref=producthunt",
      "  https://ando.so/  ", "https://ando.so:443/", "http://ando.so:80/",
    ]) {
      const again = await add(same)
      assert.equal(again.status, 409, `${same} is already saved`)
      assert.equal(again.body.existing?.id, saved.body.id)
      assert.equal(again.body.error, "This URL is already saved")
    }

    for (const different of ["https://ando.so/pricing", "https://blog.ando.so/", "https://ando.so/?page=2", "https://ando.so/?referrer=x", "https://ando.so:8080/", "https://ando.so.example.com/"]) {
      assert.equal((await add(different)).status, 201, `${different} is a different site URL`)
    }
    const count = await database.prepare("SELECT count(*) AS n FROM refs").first<{ n: number }>()
    assert.equal(count!.n, 7)
  } finally {
    await mf.dispose()
  }
})

test("paths and queries are compared on their own: a trailing slash and the order of the query do not matter, the rest does", async () => {
  const { mf, add } = await setup()
  try {
    const pricing = await add("https://www.example.com/pricing/?b=2&a=1&utm_source=x")
    assert.equal(pricing.status, 201)
    for (const same of ["http://example.com/pricing?a=1&b=2", "https://example.com/pricing/?a=1&b=2", "example.com/pricing?a=1&b=2&ref=home#plans"]) {
      assert.equal((await add(same)).status, 409, same)
    }
    for (const different of ["https://example.com/pricing?a=1", "https://example.com/pricing?a=1&b=3", "https://example.com/Pricing?a=1&b=2", "https://example.com/pricing/team?a=1&b=2"]) {
      assert.equal((await add(different)).status, 201, different)
    }
  } finally {
    await mf.dispose()
  }
})

test("a reference saved before the check existed is found too, and allowDuplicate still adds another", async () => {
  const { mf, database, add } = await setup()
  try {
    // Written the way an older version stored it: http, with a tracking parameter and the query in another order.
    await database.prepare(`INSERT INTO refs (id, url, domain, mode, max_pages, status, created_at, updated_at) VALUES ('legacy0000000001', 'http://www.legacy.example/docs/?b=2&utm_source=a&a=1', 'legacy.example', 'single', 1, 'ready', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`).run()
    const again = await add("https://legacy.example/docs?a=1&b=2")
    assert.equal(again.status, 409)
    assert.equal(again.body.existing?.id, "legacy0000000001")

    const copy = await add("https://legacy.example/docs?a=1&b=2", { allowDuplicate: true })
    assert.equal(copy.status, 201)
    assert.equal(copy.body.url, "https://legacy.example/docs?a=1&b=2", "the stored URL is what the user gave")
    assert.equal((await add("legacy.example/docs?a=1&b=2")).body.existing?.id, copy.body.id, "the newest copy is the one reported")
  } finally {
    await mf.dispose()
  }
})

test("a URL that cannot be captured is a 400 with a sentence, and nothing is saved", async () => {
  const { mf, database, add } = await setup()
  try {
    const refused: [input: unknown, says: RegExp][] = [
      ["https://user:pw@example.com", /username or password/],
      ["https://user@example.com/", /username or password/],
      ["file:///etc/passwd", /Only http and https/],
      ["ftp://example.com/file", /Only http and https/],
      ["javascript:alert(1)", /Only http and https/],
      ["mailto:someone@example.com", /Only http and https/],
      ["data:text/html;base64,PGgxPmhpPC9oMT4=", /Only http and https/],
      ["not a url", /spaces/],
      ["https://example.com/some path", /spaces/],
      ["https://exa mple.com", /spaces/],
      ["intranet", /host name/],
      ["https://intranet/", /host name/],
      ["https://", /not a valid web address/],
      ["", /Enter a web address/],
      ["   ", /Enter a web address/],
      [42, /url is required/],
    ]
    for (const [input, says] of refused) {
      const res = await add(input)
      assert.equal(res.status, 400, `${JSON.stringify(input)} is refused`)
      assert.match(res.body.error ?? "", says, JSON.stringify(input))
      assert.doesNotMatch(res.body.error ?? "", /Invalid URL|is not a function|string did not match/i, "the message is a sentence, not a parser error")
    }
    assert.equal((await database.prepare("SELECT count(*) AS n FROM refs").first<{ n: number }>())!.n, 0)

    // What is accepted: no scheme at all gets https, and local fixtures and IP literals stay allowed.
    for (const [input, stored] of [
      ["example.com", "https://example.com/"],
      ["  Example.COM/Path?q=1#frag  ", "https://example.com/Path?q=1"],
      ["HTTP://upper.example.com", "http://upper.example.com/"],
      ["localhost:3000/app", "https://localhost:3000/app"],
      ["http://localhost:8787", "http://localhost:8787/"],
      ["example.com:8080/x", "https://example.com:8080/x"],
      ["http://127.0.0.1:4173/", "http://127.0.0.1:4173/"],
      ["192.168.1.20", "https://192.168.1.20/"],
      ["http://[::1]:5173/", "http://[::1]:5173/"],
    ] as const) {
      const res = await add(input)
      assert.equal(res.status, 201, `${input}: ${res.body.error}`)
      assert.equal(res.body.url, stored)
    }
  } finally {
    await mf.dispose()
  }
})

test("adding several URLs one by one reports each failure and keeps the valid ones", async () => {
  const { mf, database, add } = await setup()
  try {
    const list = ["https://one.example", "https://user:pw@two.example", "three example", "file:///etc/passwd", "https://www.one.example/?utm_source=x", "https://four.example/pricing"]
    const results = []
    for (const url of list) results.push(await add(url))
    assert.deepEqual(results.map((r) => r.status), [201, 400, 400, 400, 409, 201])
    assert.deepEqual(results.map((r) => r.body.error).filter(Boolean), [
      "A web address cannot contain a username or password",
      "A web address cannot contain spaces",
      "Only http and https addresses can be captured",
      "This URL is already saved",
    ])
    const saved = await database.prepare("SELECT url FROM refs ORDER BY created_at").all<{ url: string }>()
    assert.deepEqual(saved.results.map((r) => r.url), ["https://one.example/", "https://four.example/pricing"])
  } finally {
    await mf.dispose()
  }
})
