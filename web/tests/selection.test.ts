import { test } from "node:test"
import assert from "node:assert/strict"
import { Miniflare, convertV4MiniflareOptions } from "miniflare"
import * as db from "../worker/db"
import { mcpApiHandler } from "../worker/mcp"
import { buildAgentPrompt } from "../src/lib/agent-prompt"
import { pruneSelection, togglePage, withPageView, EMPTY_SELECTION } from "../src/lib/selection-state"
import { copiedPage } from "../shared/selection"
import type { DesignTokens, PageSection, PageUpload } from "../shared/types"
import { applyMigrations } from "./helpers/d1"

const tokens = (color: string): DesignTokens => ({
  colors: [{ value: color, count: 9 }], fonts: [], fontSizes: [], spacing: [], radii: [], shadows: [], transitions: [], keyframes: [], cssVariables: {},
})
const section = (kind: PageSection["kind"], label: string, y: number, key: string): PageSection => ({ kind, label, y, height: 100, key })

function pageUpload(prefix: string, path: string, sections: PageSection[], hover: string): PageUpload {
  return {
    url: `https://example.com${path}`, path, title: path, ord: 0,
    desktopKey: `${prefix}/desktop.jpg`, desktopThumbKey: `${prefix}/desktop-thumb.jpg`, desktopWidth: 1440, desktopHeight: 1000,
    mobileKey: `${prefix}/mobile.jpg`, mobileThumbKey: `${prefix}/mobile-thumb.jpg`, mobileWidth: 390, mobileHeight: 2000,
    snapshotKey: null, stylesKey: null, tokens: null, sections,
    altScheme: { scheme: "dark", desktopKey: `${prefix}/dark.jpg`, desktopThumbKey: `${prefix}/dark-thumb.jpg`, desktopWidth: 1440, desktopHeight: 1000, sectionKeys: sections.map(() => null) },
    animations: [{ kind: "hover", label: "Buy", selector: hover, viewport: "desktop", gifKey: `${prefix}/hover.webm`, width: 200, height: 80, sheetKey: null, meta: null }],
  } as PageUpload
}

test("a copied prompt names the view and capture run, and its Selection finds every item again after a recapture", async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ["DB"], r2Buckets: ["FILES"] }))
  try {
    const database = (await mf.getD1Database("DB")) as unknown as D1Database
    const files = (await mf.getR2Bucket("FILES")) as unknown as R2Bucket
    await applyMigrations(database)
    const env = { DB: database, FILES: files, SESSION_SECRET: "test-secret", DEV_LOGIN: "max" } as unknown as Env
    const ctx = { waitUntil() {}, passThroughOnException() {}, props: { ownerId: "max" } } as unknown as ExecutionContext
    const rpc = async (name: string, args: unknown) => {
      const request = new Request("http://localhost/mcp", {
        method: "POST",
        headers: { host: "localhost", "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      })
      const body = await (await mcpApiHandler.fetch(request, env, ctx)).text()
      return JSON.parse(body.split("\n").find((line) => line.startsWith("data: "))!.slice(6)).result
    }

    // First capture: /pricing with a header, a "Plans" section and a footer.
    const ref = await db.createReference(database, { url: "https://example.com", mode: "single" })
    const job = (await db.claimJob(database))!
    const p1 = `refs/${ref.id}/${job.attempt}/p0`
    await db.addPage(database, ref.id, job.attempt, pageUpload(p1, "/pricing", [section("header", "Header", 0, `${p1}/s0.jpg`), section("section", "Plans", 100, `${p1}/s1.jpg`), section("footer", "Footer", 200, `${p1}/s2.jpg`)], "button.buy"))
    await db.completeJob(database, ref.id, job.attempt, { title: "Example", description: null, favicon: null, coverKey: null, tokens: tokens("#111") } as never)
    const first = (await db.getReference(database, ref.id))!
    const page = first.pages[0]!

    // The user picks the Plans section in dark from the page viewer, plus the hover and tokens.
    let sel = withPageView(EMPTY_SELECTION, page.id, { viewport: "desktop", scheme: "dark", sections: [1] })
    sel = { ...sel, animations: [first.animations[0]!.id], tokens: true }
    const prompt = buildAgentPrompt({ reference: first.reference, pages: [page], animations: first.animations, tokens: true, mcpUrl: "http://localhost/mcp", views: sel.views }, first.pages)
    assert.ok(prompt.includes("Capture run: 1."))
    assert.ok(prompt.includes(`page_id "${page.id}", desktop, dark theme, section 1 "Plans"`), prompt)
    assert.ok(prompt.includes("(desktop): animation_id"))
    assert.ok(prompt.includes("design tokens from capture run 1"))
    const copied = JSON.parse(prompt.split("\n").find((l) => l.startsWith("Selection: "))!.slice("Selection: ".length))
    assert.deepEqual(copied.pages, [{ page_id: page.id, path: "/pricing", viewport: "desktop", scheme: "dark", sections: [{ index: 1, kind: "section", label: "Plans" }] }])

    // Every single-item read says which capture it came from.
    const got = (await rpc("get_page", { page_id: page.id, image: "none" })).structuredContent
    assert.deepEqual([got.captureRun, got.capturedScheme], [1, "light"])
    assert.equal((await rpc("get_animation", { animation_id: first.animations[0]!.id, representation: "manifest" })).structuredContent.captureRun, 1)
    const same = (await rpc("resolve_selection", copied)).structuredContent
    assert.equal(same.recaptured, false)
    assert.equal(same.pages[0].match, "unchanged")
    assert.deepEqual(same.tokens, { stale: false })

    // Recapture: new ids, a new "Announcement" section pushes Plans down, new token values.
    await db.requeueReference(database, ref.id)
    const job2 = (await db.claimJob(database))!
    const p2 = `refs/${ref.id}/${job2.attempt}/p0`
    await db.addPage(database, ref.id, job2.attempt, pageUpload(p2, "/pricing/", [section("header", "Header", 0, `${p2}/s0.jpg`), section("section", "Announcement", 100, `${p2}/s1.jpg`), section("section", "Plans", 200, `${p2}/s2.jpg`), section("footer", "Footer", 300, `${p2}/s3.jpg`)], "button.buy"))
    await db.completeJob(database, ref.id, job2.attempt, { title: "Example", description: null, favicon: null, coverKey: null, tokens: tokens("#222") } as never)
    const second = (await db.getReference(database, ref.id))!

    const gone = await rpc("get_page", { page_id: page.id })
    assert.equal(gone.isError, true)
    assert.match(gone.content[0].text, /resolve_selection/)

    const res = (await rpc("resolve_selection", copied)).structuredContent
    assert.deepEqual([res.copiedRun, res.captureRun, res.recaptured], [1, 2, true])
    const rp = res.pages[0]
    assert.equal(rp.match, "recaptured")
    assert.equal(rp.pageId, second.pages[0]!.id)
    assert.deepEqual(rp.scheme, { requested: "dark", captured: "light", available: true })
    assert.deepEqual(rp.sections.map((s: { index: number; match: string }) => [s.index, s.match]), [[2, "label"]], "Plans is found by its label at its new index")
    assert.deepEqual(rp.next, [`get_page(page_id "${second.pages[0]!.id}", section 2, scheme "dark")`])
    assert.equal(res.animations[0].match, "recaptured")
    assert.equal(res.animations[0].animationId, second.animations[0]!.id)
    assert.equal(res.tokens.stale, true)

    // A page that's gone from the new capture is reported, not substituted.
    const lost = (await rpc("resolve_selection", { ...copied, pages: [{ ...copied.pages[0], page_id: "old", path: "/about" }] })).structuredContent
    assert.equal(lost.pages[0].match, "missing")
    assert.match(lost.summary, /could not be found/)

    // The app forgets picks the recapture replaced.
    const pruned = pruneSelection(sel, second.pages, second.animations)
    assert.deepEqual([pruned.pages, pruned.animations, pruned.views], [[], [], {}])
    assert.equal(pruneSelection(pruned, second.pages, second.animations), pruned, "an unchanged selection keeps its identity")
  } finally {
    await mf.dispose()
  }
})

test("a page's view is normalized for the prompt", () => {
  const page = {
    id: "p", path: "/", mobileKey: "m.jpg", altScheme: null,
    sections: [{ kind: "hero", label: "Hero", y: 0, height: 10, key: "k" }],
  } as never
  // No dark version: the captured scheme is used, and sections only apply on desktop.
  assert.deepEqual(copiedPage(page, { viewport: "desktop", scheme: "dark", sections: [0, 0, 5] }, null), { page_id: "p", path: "/", viewport: "desktop", scheme: "light", sections: [{ index: 0, kind: "hero", label: "Hero" }] })
  assert.deepEqual(copiedPage(page, { viewport: "mobile", sections: [0] }, { colorScheme: "dark" }), { page_id: "p", path: "/", viewport: "mobile", scheme: "dark" })
  // Picking from the grid after the viewer drops the viewer's view.
  const sel = togglePage(withPageView(EMPTY_SELECTION, "p", { viewport: "mobile" }), "p")
  assert.deepEqual([sel.pages, sel.views], [[], {}])
})
