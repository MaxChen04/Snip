import { test } from "node:test"
import assert from "node:assert/strict"
import { Miniflare, convertV4MiniflareOptions } from "miniflare"
import { app } from "../worker/app"
import * as db from "../worker/db"
import { mcpApiHandler } from "../worker/mcp"
import type { AnimationMeta, DesignTokens, Job, MotionEntry, MotionProfile } from "../shared/types"
import { applyMigrations } from "./helpers/d1"

// Real local D1 and R2 bindings; no deployed resources are used.
test("page sections and logged motion are stored, checked and described over MCP", async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ["DB"], r2Buckets: ["FILES"] }))
  const pending: Promise<unknown>[] = []
  try {
    const database = (await mf.getD1Database("DB")) as unknown as D1Database
    const files = (await mf.getR2Bucket("FILES")) as unknown as R2Bucket
    await applyMigrations(database)
    const ctx = { waitUntil(p: Promise<unknown>) { pending.push(p) }, passThroughOnException() {}, props: { ownerId: "max" } } as unknown as ExecutionContext
    const env = { DB: database, FILES: files, SESSION_SECRET: "test-secret", DEV_LOGIN: "max", CAPTURE_TOKEN: "test-token" } as unknown as Env
    const agent = (path: string, init: RequestInit = {}) =>
      app.request(`http://localhost/agent${path}`, { ...init, headers: { authorization: "Bearer test-token", "x-snip-capture-protocol": "3", "content-type": "application/json", ...init.headers } }, env, ctx)

    const ref = await db.createReference(database, { url: "https://example.com", mode: "single" })
    const job = await (await agent("/jobs/claim", { method: "POST" })).json() as Job
    const p = `refs/${ref.id}/${job.attempt}/p0`
    const motion: MotionEntry[] = [{
      type: "transition", target: "div#card", property: "transform", durationMs: 300, delayMs: 50, easing: "ease-out", iterations: 1,
      keyframes: [{ offset: 0, transform: "none" }, { offset: 1, transform: "translateY(-8px)" }], startMs: 12, scrollY: 0,
    }]
    const meta: AnimationMeta = { version: 1, frameCount: 2, playbackMs: 900, timing: "measured", frames: [], sheet: null, observedStyles: null, motion }
    const profile: MotionProfile = {
      version: 1,
      tech: { libraries: ["three.js r175"], canvases: [{ context: "webgl2", width: 1120, height: 520, y: 80 }], viewTransitions: false, scrollDriven: false },
      tokens: [{ name: "--ease-fast", value: "cubic-bezier(.2,0,0,1)", kind: "easing" }],
      easings: [{ value: "cubic-bezier(0.2, 0, 0, 1)", shape: "strong ease-out", tokenCandidate: "--ease-fast", elements: 40, ran: 2 }, { value: "ease-out", shape: "ease-out: fast start, decelerates", elements: 3, ran: 1 }],
      durations: [{ ms: 300, elements: 40, ran: 1 }],
      staggers: [{ phase: "load", target: "p.word", property: "opacity", count: 40, durationMs: 403, easing: "ease-out", stepMs: 20, spanMs: 780, evenGaps: 39, gaps: 39, gapRangeMs: [19, 21], from: "start times" }],
      entrance: motion,
      hovers: [{ label: "card", target: "div#card", property: "transform", durationMs: 300, delayMs: 50, easing: "ease-out" }],
      pixelOnly: ["WebGL 2 1120×520 at y=80: drawn by script"],
      totals: { hovers: 45 },
    }
    const pageTokens: DesignTokens = { colors: [], fonts: [], fontSizes: [], spacing: [], radii: [], shadows: [], transitions: [], keyframes: [], cssVariables: {}, motion: profile }
    const page = {
      url: "https://example.com/", path: "/", title: "Home", ord: 0,
      desktopKey: `${p}/desktop.jpg`, desktopThumbKey: `${p}/desktop-thumb.jpg`, desktopWidth: 1440, desktopHeight: 1700,
      mobileKey: null, mobileThumbKey: null, mobileWidth: null, mobileHeight: null, snapshotKey: null, stylesKey: null, tokens: pageTokens,
      sections: [
        { kind: "header", label: "Header", y: 0, height: 80, key: `${p}/section-0.jpg` },
        { kind: "hero", label: "Ship faster", y: 80, height: 1620, key: `${p}/section-1.jpg`, live: { key: `${p}/section-1-live.webm`, height: 900, durationMs: 3000 } },
      ],
      altScheme: { scheme: "dark", desktopKey: `${p}/desktop-dark.jpg`, desktopThumbKey: `${p}/desktop-dark-thumb.jpg`, desktopWidth: 1440, desktopHeight: 1700, sectionKeys: [`${p}/section-0-dark.jpg`, null] },
      animations: [{ kind: "hover", label: "card", selector: "#card", viewport: "desktop", gifKey: `${p}/hover-0.webm`, width: 300, height: 200, sheetKey: null, meta }],
    }
    const addPage = (body: unknown) => agent(`/jobs/${ref.id}/pages`, { method: "POST", headers: { "x-snip-capture-attempt": job.attempt }, body: JSON.stringify(body) })
    const outside = (await addPage({ ...page, sections: [{ ...page.sections[0], key: "refs/other/a/p0/x.jpg" }] }))
    assert.equal(outside.status, 400, "a section file outside this job's folder is refused")
    assert.equal((await addPage({ ...page, sections: "nope" })).status, 400)
    assert.equal((await addPage({ ...page, sections: [{ ...page.sections[1], live: { key: "refs/other/a/p0/live.webm", height: 900, durationMs: 3000 } }] })).status, 400, "a live clip outside this job's folder is refused")
    assert.equal((await addPage({ ...page, sections: [{ ...page.sections[1], live: { height: 900 } }] })).status, 400)
    assert.equal((await addPage({ ...page, sections: [{ ...page.sections[1], y: -5 }] })).status, 400, "positions must be real numbers")
    assert.equal((await addPage({ ...page, sections: [{ ...page.sections[1], kind: "banner" }] })).status, 400)
    assert.equal((await addPage({ ...page, altScheme: { ...page.altScheme, desktopKey: "refs/other/a/p0/dark.jpg" } })).status, 400, "a dark screenshot outside this job's folder is refused")
    assert.equal((await addPage({ ...page, altScheme: { ...page.altScheme, scheme: "sepia" } })).status, 400)
    assert.equal((await addPage(page)).status, 200)
    await files.put(`${p}/desktop-dark-thumb.jpg`, new Uint8Array([0xff, 0xd8, 0xff, 0x01]), { httpMetadata: { contentType: "image/jpeg" } })
    await files.put(`${p}/section-1.jpg`, new Uint8Array([0xff, 0xd8, 0xff]), { httpMetadata: { contentType: "image/jpeg" } })

    const rpc = async (name: string, args: unknown) => {
      const request = new Request("http://localhost/mcp", {
        method: "POST",
        headers: { host: "localhost", "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      })
      const body = await (await mcpApiHandler.fetch(request, env, ctx)).text()
      return JSON.parse(body.split("\n").find((line) => line.startsWith("data: "))!.slice(6)).result
    }
    const { pages, animations } = (await db.getReference(database, ref.id))!
    const pageId = pages[0]!.id

    const listed = await rpc("get_page", { page_id: pageId, image: "none" })
    assert.deepEqual(listed.structuredContent.sections.map((s: { index: number; kind: string; label: string; y: number }) => [s.index, s.kind, s.label, s.y]), [[0, "header", "Header", 0], [1, "hero", "Ship faster", 80]])
    assert.equal(listed.structuredContent.sections[1].url, undefined, "no signed URLs unless asked")
    assert.equal(listed.structuredContent.sections[0].live, null)
    assert.deepEqual(listed.structuredContent.sections[1].live, { format: "webm", y: 80, height: 900, durationMs: 3000 })
    assert.equal(listed.structuredContent.sectionsUnavailable, undefined)
    const withUrls = (await rpc("get_page", { page_id: pageId, image: "none", include_section_urls: true })).structuredContent.sections[1]
    assert.ok(withUrls.url.includes("sig="))
    assert.ok(withUrls.live.url.includes("section-1-live.webm"))
    assert.equal(listed.content.length, 1)

    assert.equal(listed.structuredContent.otherScheme.scheme, "dark")
    assert.ok(listed.structuredContent.otherScheme.fullPageUrl.includes("desktop-dark.jpg"))
    const dark = await rpc("get_page", { page_id: pageId, scheme: "dark" })
    assert.equal(dark.content[1].mimeType, "image/jpeg", "the dark viewport screenshot is inlined")
    assert.equal(dark.structuredContent.schemeUnavailable, undefined)
    assert.equal((await rpc("get_page", { page_id: pageId, scheme: "light", image: "none" })).structuredContent.schemeUnavailable, undefined, "light is the scheme it was captured in")
    const darkSection = (await rpc("get_page", { page_id: pageId, section: 0, scheme: "dark" })).structuredContent.section
    assert.ok(darkSection.url.includes("section-0-dark.jpg"), "a section asked for in dark links to the dark image")
    const one = await rpc("get_page", { page_id: pageId, section: 1 })
    assert.deepEqual({ ...one.structuredContent.section, url: "" }, { index: 1, label: "Ship faster", included: true, url: "" })
    assert.ok(one.structuredContent.section.url.includes("section-1.jpg"), "the inlined section carries its own URL")
    assert.equal(one.content.length, 2, "only the section is inlined, not the viewport too")
    assert.equal(one.content[1].mimeType, "image/jpeg")
    const missing = await rpc("get_page", { page_id: pageId, section: 0 })
    assert.equal(missing.structuredContent.section.included, false, "a section file missing from storage says why")
    assert.match((await rpc("get_page", { page_id: pageId, section: 5 })).content[0].text, /from 0 to 1/)

    const anim = await rpc("get_animation", { animation_id: animations[0]!.id, representation: "manifest" })
    assert.deepEqual(anim.structuredContent.motion.items, motion)
    assert.equal(anim.structuredContent.motion.nextOffset, null)
    assert.deepEqual((await rpc("get_animation", { animation_id: animations[0]!.id, representation: "manifest", motion_offset: 1 })).structuredContent.motion.items, [], "motion pages on with motion_offset")
    assert.match(anim.structuredContent.motion.note, /real duration/)

    const overview = (await rpc("get_motion_profile", { reference_id: ref.id, page_id: pageId, limit: 1 })).structuredContent
    assert.deepEqual([overview.pageId, overview.path], [pageId, "/"], "scoped to the page asked for")
    assert.deepEqual(overview.tech, profile.tech)
    assert.deepEqual(overview.groups.easings, { total: 2, items: [profile.easings[0]] })
    assert.equal(overview.omitted.easings, 1, "what the overview left out is counted")
    assert.deepEqual(overview.cappedAtCapture.found, { hovers: 45 }, "lists the capture capped say how much they held")
    assert.match(overview.provenance.inferred, /tokenCandidate/)
    assert.match(overview.provenance.observed, /Read from the browser/)
    assert.equal(overview.recordings.total, 1)
    assert.equal(overview.recordings.items[0].kind, "hover")

    const first = (await rpc("get_motion_profile", { reference_id: ref.id, page_id: pageId, group: "easings", limit: 1 })).structuredContent
    assert.deepEqual(first.items, [profile.easings[0]])
    assert.match(first.provenance, /inferred/)
    const second = (await rpc("get_motion_profile", { reference_id: ref.id, page_id: pageId, group: "easings", limit: 1, cursor: first.nextCursor })).structuredContent
    assert.deepEqual([second.items, second.offset, second.nextCursor], [[profile.easings[1]], 1, null], "a group pages on with its cursor")
    assert.match((await rpc("get_motion_profile", { reference_id: ref.id, group: "easings", cursor: first.nextCursor })).content[0].text, /different reference, page or group/)
    const stag = (await rpc("get_motion_profile", { reference_id: ref.id, page_id: pageId, group: "staggers" })).structuredContent
    assert.match(stag.provenance, /^Inferred/)
    const recs = (await rpc("get_motion_profile", { reference_id: ref.id, page_id: pageId, group: "recordings" })).structuredContent
    assert.deepEqual([recs.total, recs.items[0].id, recs.nextCursor], [1, animations[0]!.id, null])

    assert.match((await rpc("get_motion_profile", { reference_id: ref.id })).structuredContent.unavailable, /saved when it finishes/, "the reference's merged profile comes with completion")
    assert.match((await rpc("get_motion_profile", { reference_id: ref.id, page_id: "nope" })).content[0].text, /No page/)
  } finally {
    await Promise.allSettled(pending)
    await mf.dispose()
  }
})

test("pages captured before sections and motion existed say so", async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ["DB"], r2Buckets: ["FILES"] }))
  try {
    const database = (await mf.getD1Database("DB")) as unknown as D1Database
    await applyMigrations(database)
    const ref = await db.createReference(database, { url: "https://example.com", mode: "single" })
    const job = (await db.claimJob(database))!
    await db.addPage(database, ref.id, job.attempt, {
      url: "https://example.com/", path: "/", title: null, ord: 0, desktopKey: null, desktopThumbKey: null, desktopWidth: null, desktopHeight: null,
      mobileKey: null, mobileThumbKey: null, mobileWidth: null, mobileHeight: null, snapshotKey: null, stylesKey: null, tokens: null, animations: [],
    })
    const page = (await db.getReference(database, ref.id))!.pages[0]!
    assert.deepEqual([page.sections, page.sectionsCaptured], [[], false])
    // A new capture of a page that doesn't break into sections is not "older".
    const job2 = (await db.claimJob(database))
    const ref2 = await db.createReference(database, { url: "https://example.org", mode: "single" })
    const claimed = job2 ?? (await db.claimJob(database))!
    await db.addPage(database, ref2.id, claimed.attempt, {
      url: "https://example.org/", path: "/", title: null, ord: 0, desktopKey: null, desktopThumbKey: null, desktopWidth: null, desktopHeight: null,
      mobileKey: null, mobileThumbKey: null, mobileWidth: null, mobileHeight: null, snapshotKey: null, stylesKey: null, tokens: null, sections: [], animations: [],
    })
    const page2 = (await db.getReference(database, ref2.id))!.pages[0]!
    assert.deepEqual([page2.sections, page2.sectionsCaptured, page2.altScheme], [[], true, null])
  } finally {
    await mf.dispose()
  }
})
