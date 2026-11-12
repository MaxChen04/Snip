import { test } from "node:test"
import assert from "node:assert/strict"
import { Miniflare, convertV4MiniflareOptions } from "miniflare"
import type { Page, PageUpload, Paged, Reference } from "../shared/types"
import { app } from "../worker/app"
import * as db from "../worker/db"
import { applyMigrations } from "./helpers/d1"

// The capture agent may flag a page it saved as blank or truncated; the Worker keeps the flags and returns them on the page.

const upload = (ord: number, extra: Record<string, unknown> = {}) => ({
  url: `https://example.com/${ord}`, path: `/${ord}`, title: `Page ${ord}`, ord,
  desktopKey: null, desktopThumbKey: null, desktopWidth: null, desktopHeight: null, mobileKey: null, mobileThumbKey: null, mobileWidth: null, mobileHeight: null,
  snapshotKey: null, stylesKey: null, tokens: null, animations: [], ...extra,
}) as PageUpload

test("page warnings round-trip from the agent's upload to the page, its website and the pages feed", async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ["DB"], r2Buckets: ["FILES"] }))
  try {
    const database = (await mf.getD1Database("DB")) as unknown as D1Database
    await applyMigrations(database)
    const env = { DB: database, SESSION_SECRET: "test-secret", DEV_LOGIN: "max", CAPTURE_TOKEN: "test-token" } as unknown as Env
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext
    const ref = await db.createReference(database, { url: "https://example.com", mode: "crawl", maxPages: 9 })
    const job = (await db.claimJob(database))!
    const send = (body: unknown) => app.request(`https://snip.test/agent/jobs/${ref.id}/pages`, { method: "POST", body: JSON.stringify(body),
      headers: { authorization: "Bearer test-token", "content-type": "application/json", "x-snip-capture-protocol": "4", "x-snip-capture-lease": job.lease } }, env, ctx)
    const read = async <T>(path: string) => (await app.request(`http://localhost${path}`, {}, env, ctx)).json() as Promise<T>

    // What the agent may send: nothing (an older agent), none, one or both codes.
    for (const [ord, warnings] of [[0, undefined], [1, []], [2, ["blank"]], [3, ["truncated"]], [4, ["truncated", "blank"]]] as const) {
      const res = await send(upload(ord, warnings ? { warnings } : {}))
      assert.equal(res.status, 200, JSON.stringify(warnings))
    }
    const { pages } = await read<{ reference: Reference; pages: Page[] }>(`/api/references/${ref.id}`)
    assert.deepEqual(pages.map((p) => p.warnings), [[], [], ["blank"], ["truncated"], ["truncated", "blank"]])
    const feed = await read<Paged<Page>>(`/api/pages?sort=oldest`)
    assert.deepEqual(feed.items.sort((a, b) => a.ord - b.ord).map((p) => p.warnings), pages.map((p) => p.warnings), "the pages feed carries them too")
    assert.deepEqual((await db.getPage(database, pages[2]!.id))!.warnings, ["blank"])
    const stored = await database.prepare("SELECT warnings_json FROM pages ORDER BY ord").all<{ warnings_json: string | null }>()
    assert.deepEqual(stored.results.map((r) => r.warnings_json), [null, null, '["blank"]', '["truncated"]', '["truncated","blank"]'], "a page without warnings stores nothing")

    // Anything else is refused and saves no page.
    for (const bad of [["empty"], ["blank", "blank"], "blank", [1], [null], null, { blank: true }, ["blank", "truncated", "blank"]]) {
      const res = await send(upload(9, { warnings: bad }))
      assert.deepEqual([res.status, await res.json()], [400, { error: "bad warnings" }], JSON.stringify(bad))
    }
    assert.equal((await database.prepare("SELECT count(*) AS n FROM pages").first<{ n: number }>())!.n, 5)
  } finally {
    await mf.dispose()
  }
})
