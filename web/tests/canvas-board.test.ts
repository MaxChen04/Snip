import { test } from "node:test"
import assert from "node:assert/strict"
import { Miniflare, convertV4MiniflareOptions } from "miniflare"
import type { BoardCanvas, BoardGroup, BoardItem, Collection, LibraryTypeCounts, Paged, SavedImage, SectionItem } from "../shared/types"
import { app } from "../worker/app"
import * as db from "../worker/db"
import { applyMigrations } from "./helpers/d1"

// Real local D1 and R2 bindings; no deployed resources are used.

// 1×1 images, real enough for the magic-byte sniffing.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64")
const WEBP = Buffer.from("UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=", "base64")
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
const AVIF = Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from("ftypmif1\0\0\0\0mif1avifmiaf")])

type Upload = { file?: Uint8Array; name?: string; type?: string; thumb?: Uint8Array; width?: string; height?: string; palette?: string; collectionId?: string }

function imageForm(o: Upload = {}) {
  const form = new FormData()
  form.set("file", new Blob([o.file ?? PNG], { type: o.type ?? "image/png" }), o.name ?? "Hero shot.png")
  form.set("thumb", new Blob([o.thumb ?? WEBP], { type: "image/webp" }), "thumb.webp")
  form.set("width", o.width ?? "1600")
  form.set("height", o.height ?? "900")
  form.set("palette", o.palette ?? JSON.stringify(["#AABBCC", "red", "#112233"]))
  if (o.collectionId) form.set("collectionId", o.collectionId)
  return form
}

async function setup() {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ["DB"], r2Buckets: ["FILES"] }))
  const database = (await mf.getD1Database("DB")) as unknown as D1Database
  const files = (await mf.getR2Bucket("FILES")) as unknown as R2Bucket
  await applyMigrations(database)
  const pending: Promise<unknown>[] = []
  const ctx = { waitUntil(p: Promise<unknown>) { pending.push(p) }, passThroughOnException() {} } as unknown as ExecutionContext
  const env = { DB: database, FILES: files, SESSION_SECRET: "test-secret", DEV_LOGIN: "max" } as unknown as Env
  const call = (path: string, method = "GET", body?: unknown) =>
    app.request(`http://localhost${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } }, env, ctx)
  const get = async <T>(path: string, method = "GET", body?: unknown) => {
    const res = await call(path, method, body)
    assert.ok(res.ok, `${method} ${path}: ${res.status} ${await res.clone().text()}`)
    return (await res.json()) as T
  }
  const upload = (o: Upload = {}, headers: Record<string, string> = { origin: "http://localhost" }) =>
    app.request("http://localhost/api/images", { method: "POST", body: imageForm(o), headers }, env, ctx)
  const uploaded = async (o: Upload = {}) => {
    const res = await upload(o)
    assert.equal(res.status, 201, await res.clone().text())
    return (await res.json()) as SavedImage
  }
  const board = async (name: string) => (await get<{ id: string }>("/api/collections", "POST", { name })).id
  const rows = async (sql: string, ...args: unknown[]) => (await database.prepare(sql).bind(...args).all<Record<string, unknown>>()).results
  return { mf, database, files, env, ctx, pending, call, get, upload, uploaded, board, rows }
}

/** A captured website with these pages, each cut into `sections` sections. */
async function capture(database: D1Database, url: string, pages: { path: string; sections?: number }[]) {
  const ref = await db.createReference(database, { url, mode: "crawl" })
  const job = (await db.claimJob(database))!
  for (const [i, p] of pages.entries()) {
    const base = `refs/${ref.id}/${job.attempt}/p${i}`
    await db.addPage(database, ref.id, job.lease, {
      url: new URL(p.path, url).toString(), path: p.path, title: `Page ${p.path}`, ord: i,
      desktopKey: `${base}/desktop.jpg`, desktopThumbKey: `${base}/desktop-thumb.webp`, desktopWidth: 1280, desktopHeight: 3000,
      mobileKey: null, mobileThumbKey: null, mobileWidth: null, mobileHeight: null, snapshotKey: null, stylesKey: null, tokens: null,
      sections: Array.from({ length: p.sections ?? 0 }, (_, s) => ({ kind: "section" as const, label: `Section ${s}`, y: s * 100, height: 100 + s, key: `${base}/section-${s}.jpg` })),
      animations: [],
    })
  }
  await db.completeJob(database, ref.id, job.lease, { title: url, description: null, favicon: null, coverKey: `refs/${ref.id}/${job.attempt}/cover.webp`, tokens: null })
  return (await db.getReference(database, ref.id))!
}

/** Every item of a paged feed, following cursors. */
async function all<T extends { id: string }>(get: <R>(path: string) => Promise<R>, path: string, limit: number) {
  const out: T[] = []
  let cursor: string | null = null
  do {
    const page: Paged<T> = await get(`${path}${path.includes("?") ? "&" : "?"}limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)
    out.push(...page.items)
    cursor = page.nextCursor
  } while (cursor)
  return out
}

// ---------- Images ----------

test("uploads are sniffed, bounded and stored under uploads/", async () => {
  const { mf, files, upload, uploaded, board } = await setup()
  try {
    const image = await uploaded()
    assert.match(image.id, /^[a-f0-9]{16}$/)
    assert.deepEqual(
      [image.title, image.key, image.thumbKey, image.mime, image.width, image.height, image.palette, image.collectionIds],
      ["Hero shot", `uploads/${image.id}/original.png`, `uploads/${image.id}/thumb.webp`, "image/png", 1600, 900, ["#aabbcc", "#112233"], []],
    )
    assert.equal((await files.head(image.key))!.httpMetadata!.contentType, "image/png")
    assert.equal((await files.head(image.thumbKey))!.httpMetadata!.contentType, "image/webp")

    // The bytes decide the format, not the name or the declared type.
    const webp = await uploaded({ file: WEBP, name: "renamed.png", type: "image/png" })
    assert.deepEqual([webp.mime, webp.key.split("/").pop()], ["image/webp", "original.webp"])
    assert.equal((await uploaded({ file: AVIF, name: "photo.avif" })).mime, "image/avif")
    const jpegThumb = await uploaded({ thumb: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]) })
    assert.ok(jpegThumb.thumbKey.endsWith("/thumb.jpg"))
    assert.equal((await uploaded({ name: `${"x".repeat(300)}.png` })).title!.length, 200)
    assert.equal((await uploaded({ palette: JSON.stringify(Array(9).fill("#ABCDEF")) })).palette.length, 6)
    assert.deepEqual((await uploaded({ palette: "not json" })).palette, [])
    const objects = (await files.list()).objects.length

    const refused: [string, Upload][] = [
      ["svg declared as png", { file: SVG, type: "image/png", name: "logo.png" }],
      ["svg", { file: SVG, type: "image/svg+xml", name: "logo.svg" }],
      ["text", { file: Buffer.from("hello"), type: "image/png" }],
      ["empty", { file: new Uint8Array() }],
      ["over 20 MB", { file: Buffer.concat([PNG, Buffer.alloc(20 * 1024 * 1024)]) }],
      ["png thumb", { thumb: PNG }],
      ["svg thumb", { thumb: SVG }],
      ["thumb over 2 MB", { thumb: Buffer.concat([WEBP, Buffer.alloc(2 * 1024 * 1024)]) }],
      ["zero width", { width: "0" }],
      ["too tall", { height: "20001" }],
      ["fractional", { width: "1.5" }],
      ["not a number", { height: "tall" }],
      ["unknown board", { collectionId: "missing" }],
    ]
    for (const [label, o] of refused) {
      const res = await upload(o)
      assert.equal(res.status, 400, label)
      assert.ok(((await res.json()) as { error: string }).error, label)
    }
    assert.equal((await files.list()).objects.length, objects, "refused uploads store nothing")

    const moodboard = await board("Moodboard")
    assert.deepEqual((await uploaded({ collectionId: moodboard })).collectionIds, [moodboard])

    // Multipart is let through only for the upload, and only from this origin.
    assert.equal((await upload({}, { origin: "https://evil.example" })).status, 403)
    assert.equal((await upload({}, { "sec-fetch-site": "cross-site" })).status, 403)
    // Neither header: nothing proves it came from this site.
    assert.equal((await upload({}, {})).status, 403)
    assert.equal((await upload({}, { "sec-fetch-site": "same-origin" })).status, 201)
    assert.equal((await upload({}, { origin: "http://localhost" })).status, 201)
  } finally {
    await mf.dispose()
  }
})

test("only the upload route accepts a multipart body", async () => {
  const { mf, env, ctx } = await setup()
  try {
    const res = await app.request("http://localhost/api/collections", { method: "POST", body: imageForm() }, env, ctx)
    assert.equal(res.status, 403)
    assert.match(((await res.json()) as { error: string }).error, /JSON/)
  } finally {
    await mf.dispose()
  }
})

test("images list newest first, filter by title and board, and serve only with a session", async () => {
  const { mf, env, ctx, files, pending, call, get, uploaded, board, rows } = await setup()
  try {
    const moodboard = await board("Moodboard")
    const alpha = await uploaded({ name: "alpha.png" })
    const beta = await uploaded({ name: "beta.png", collectionId: moodboard })
    const alphaTwo = await uploaded({ name: "alpha two.png" })

    const listed = await get<Paged<SavedImage>>("/api/images")
    const expected = [alpha, beta, alphaTwo].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).map((i) => i.id)
    assert.deepEqual(listed.items.map((i) => i.id), expected)
    assert.deepEqual((await all<SavedImage>(get, "/api/images", 1)).map((i) => i.id), expected, "pages without gaps")
    assert.deepEqual((await get<Paged<SavedImage>>("/api/images?q=alpha")).items.map((i) => i.title).sort(), ["alpha", "alpha two"])
    const onBoard = await get<Paged<SavedImage>>(`/api/images?collection=${moodboard}`)
    assert.deepEqual(onBoard.items.map((i) => [i.id, i.collectionIds]), [[beta.id, [moodboard]]])

    // Files: the session (DEV_LOGIN here) is required, and keys stay inside uploads/<id>/.
    const served = await call(`/files/${alpha.key}`)
    assert.equal(served.status, 200)
    assert.equal(served.headers.get("content-type"), "image/png")
    assert.equal(served.headers.get("x-content-type-options"), "nosniff")
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), PNG)
    const anonymous = { ...env, DEV_LOGIN: undefined } as unknown as Env
    assert.equal((await app.request(`http://localhost/files/${alpha.key}`, {}, anonymous, ctx)).status, 401)
    assert.equal((await call(`/files/uploads/${alpha.id}/..%2F..%2Frefs%2Fx`)).status, 404)
    assert.equal((await call(`/files/elsewhere/${alpha.id}/original.png`)).status, 404)

    // Board membership: bounded, 404 for an unknown board, unknown images skipped.
    assert.deepEqual(await get(`/api/collections/${moodboard}/images`, "POST", { imageIds: [alpha.id, alpha.id, "missing"], member: true }), { ok: true, changed: 1 })
    assert.deepEqual(await get(`/api/collections/${moodboard}/images`, "POST", { imageIds: [alpha.id], member: true }), { ok: true, changed: 0 })
    assert.deepEqual(await get(`/api/collections/${moodboard}/images`, "POST", { imageIds: [beta.id], member: false }), { ok: true, changed: 1 })
    assert.equal((await call(`/api/collections/missing/images`, "POST", { imageIds: [alpha.id] })).status, 404)
    assert.equal((await call(`/api/collections/${moodboard}/images`, "POST", { imageIds: [] })).status, 400)
    assert.equal((await call(`/api/collections/${moodboard}/images`, "POST", { imageIds: Array(201).fill(alpha.id) })).status, 400)
    assert.deepEqual((await get<Paged<SavedImage>>(`/api/images?collection=${moodboard}`)).items.map((i) => i.id), [alpha.id])

    // Deleting removes the row, its memberships and both files.
    assert.deepEqual(await get(`/api/images/${alpha.id}`, "DELETE"), { ok: true })
    await Promise.all(pending)
    assert.equal(await files.head(alpha.key), null)
    assert.equal(await files.head(alpha.thumbKey), null)
    assert.equal((await rows(`SELECT * FROM image_collections WHERE image_id = ?`, alpha.id)).length, 0)
    assert.equal((await rows(`SELECT * FROM capture_cleanup`)).length, 0, "cleanup finished")
    assert.equal((await call(`/api/images/${alpha.id}`, "DELETE")).status, 404)
    assert.ok(await files.head(beta.key), "other images keep their files")
  } finally {
    await mf.dispose()
  }
})

// ---------- Sections and counts ----------

test("sections flatten every page in order and page without gaps or repeats", async () => {
  const { mf, database, get, board } = await setup()
  try {
    const stripe = await capture(database, "https://stripe.com", [{ path: "/", sections: 3 }, { path: "/pricing", sections: 2 }, { path: "/old" }])
    const linear = await capture(database, "https://linear.app", [{ path: "/", sections: 4 }, { path: "/method", sections: 1 }])

    const full = await get<Paged<SectionItem>>("/api/sections?limit=100")
    assert.equal(full.items.length, 10)
    assert.equal(full.nextCursor, null)
    // Newest page first; each page's sections contiguous and top to bottom.
    const pages = [...stripe.pages, ...linear.pages].filter((p) => p.sections.length)
    const order = pages.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).flatMap((p) => p.sections.map((_, i) => `${p.id}:${i}`))
    assert.deepEqual(full.items.map((s) => s.id), order)
    for (const limit of [1, 2, 3, 4, 7]) assert.deepEqual((await all<SectionItem>(get, "/api/sections", limit)).map((s) => s.id), order, `limit ${limit}`)

    const pricing = stripe.pages[1]!
    const first = full.items.find((s) => s.id === `${pricing.id}:1`)!
    assert.deepEqual(first, {
      id: `${pricing.id}:1`, pageId: pricing.id, referenceId: stripe.reference.id, index: 1, kind: "section", label: "Section 1",
      key: pricing.sections[1]!.key, width: 1280, height: 101, path: "/pricing", url: "https://stripe.com/pricing",
      reference: { id: stripe.reference.id, title: "https://stripe.com", domain: "stripe.com", favicon: null }, createdAt: pricing.createdAt,
    })

    // Same q and collection semantics as the pages feed.
    assert.deepEqual((await get<Paged<SectionItem>>("/api/sections?q=pricing")).items.map((s) => s.id), [`${pricing.id}:0`, `${pricing.id}:1`])
    const saved = await board("Saved")
    await db.setPageCollection(database, saved, [pricing.id], true)
    await db.setReferenceCollection(database, linear.reference.id, saved, true)
    assert.equal((await get<Paged<SectionItem>>(`/api/sections?collection=${saved}`)).items.length, 2 + 5)
  } finally {
    await mf.dispose()
  }
})

test("counts match what each list endpoint returns for the same filter", async () => {
  const { mf, database, get, uploaded, board } = await setup()
  try {
    const stripe = await capture(database, "https://stripe.com", [{ path: "/", sections: 3 }, { path: "/pricing", sections: 2 }])
    await capture(database, "https://linear.app", [{ path: "/", sections: 1 }, { path: "/method" }])
    // The capture helper records no motion, so add one animation on Stripe's home page.
    await database.prepare(`INSERT INTO animations (id, reference_id, page_id, kind, viewport, gif_key, width, height, created_at) VALUES ('a1', ?, ?, 'scroll', 'desktop', 'k', 1, 1, ?)`)
      .bind(stripe.reference.id, stripe.pages[0]!.id, db.now()).run()
    const saved = await board("Saved")
    await db.setPageCollection(database, saved, [stripe.pages[1]!.id], true)
    await uploaded({ name: "pricing table.png", collectionId: saved })
    await uploaded({ name: "hero.png" })

    for (const query of ["", "q=pricing", `collection=${saved}`, "q=linear", `q=stripe&collection=${saved}`]) {
      const counts = await get<LibraryTypeCounts>(`/api/counts?${query}`)
      const length = async (path: string) => (await get<Paged<unknown>>(`/api/${path}?${query}&limit=100`)).items.length
      assert.deepEqual(counts, {
        websites: await length("references"),
        pages: await length("pages"),
        sections: await length("sections"),
        animations: await length("animations"),
        images: await length("images"),
      }, query || "everything")
    }
    assert.deepEqual(await get<LibraryTypeCounts>("/api/counts"), { websites: 2, pages: 4, sections: 6, animations: 1, images: 2 })
  } finally {
    await mf.dispose()
  }
})

// ---------- Boards ----------

test("a board lists every member kind with positions, notes and groups", async () => {
  const { mf, database, call, get, uploaded, board } = await setup()
  try {
    const moodboard = await board("Moodboard")
    const stripe = await capture(database, "https://stripe.com", [{ path: "/", sections: 1 }])
    const linear = await capture(database, "https://linear.app", [{ path: "/", sections: 1 }, { path: "/method", sections: 2 }])
    await db.setReferenceCollection(database, stripe.reference.id, moodboard, true)
    await db.setPageCollection(database, moodboard, [linear.pages[1]!.id], true)
    const image = await uploaded({ collectionId: moodboard })
    await uploaded({ name: "elsewhere.png" })
    const note = await get<BoardItem>(`/api/boards/${moodboard}/notes`, "POST", { text: "Warm, quiet", x: 5, y: -5 })

    const canvas = await get<BoardCanvas>(`/api/boards/${moodboard}`)
    assert.deepEqual([canvas.collection.id, canvas.collection.name, canvas.collection.referenceCount, canvas.collection.pageCount, canvas.collection.imageCount], [moodboard, "Moodboard", 1, 1, 1])
    // Bottom to top: what is placed, then the rest.
    assert.deepEqual(canvas.items.map((i) => [i.kind, i.id, i.x, i.y, i.z, i.w, i.groupId]), [
      ["note", note.id, 5, -5, 0, null, null],
      ["reference", stripe.reference.id, null, null, null, null, null],
      ["page", linear.pages[1]!.id, null, null, null, null, null],
      ["image", image.id, null, null, null, null, null],
    ])
    const [sticky, ref, page, img] = canvas.items
    assert.deepEqual(ref!.reference, (await db.listReferences(database, { collectionId: moodboard })).items[0])
    assert.deepEqual(ref!.reference!.previewKeys, [stripe.pages[0]!.desktopThumbKey])
    assert.deepEqual(page!.page, { ...(await db.getPage(database, linear.pages[1]!.id))!, reference: { id: linear.reference.id, title: "https://linear.app", domain: "linear.app", favicon: null } })
    assert.deepEqual(page!.page!.collectionIds, [moodboard])
    assert.deepEqual(img!.image, image)
    assert.equal(sticky!.text, "Warm, quiet")
    assert.deepEqual(canvas.groups, [])
    assert.equal((await call("/api/boards/missing")).status, 404)
  } finally {
    await mf.dispose()
  }
})

test("placements upsert, keep omitted fields, survive a recapture and reject anything not on the board", async () => {
  const { mf, database, call, get, uploaded, board, rows } = await setup()
  try {
    const moodboard = await board("Moodboard")
    const other = await board("Other")
    const stripe = await capture(database, "https://stripe.com", [{ path: "/pricing" }])
    await db.setReferenceCollection(database, stripe.reference.id, moodboard, true)
    await db.setPageCollection(database, moodboard, [stripe.pages[0]!.id], true)
    const image = await uploaded({ collectionId: moodboard })
    const outsider = await uploaded({ collectionId: other })
    const group = await get<BoardGroup>(`/api/boards/${moodboard}/groups`, "POST", { name: "Heroes", x: 0, y: 0, w: 800, h: 600, items: [] })
    const foreignGroup = await get<BoardGroup>(`/api/boards/${other}/groups`, "POST", { name: "Theirs", x: 0, y: 0, w: 10, h: 10, items: [] })
    const note = await get<BoardItem>(`/api/boards/${moodboard}/notes`, "POST", { text: "keep me", x: 0, y: 0, w: 200 })
    const placed = async () =>
      Object.fromEntries((await get<BoardCanvas>(`/api/boards/${moodboard}`)).items.map((i) => [i.kind, [i.x, i.y, i.w, i.groupId]]))

    assert.deepEqual(await get(`/api/boards/${moodboard}/items`, "PUT", { items: [
      { kind: "reference", id: stripe.reference.id, x: 10, y: 20, w: 300, groupId: group.id },
      { kind: "page", id: stripe.pages[0]!.id, x: -100.5, y: 40 },
      { kind: "image", id: image.id, x: 1e6, y: -1e6, w: null },
      { kind: "note", id: note.id, x: 9, y: 9 },
    ] }), { ok: true })
    assert.deepEqual(await placed(), { reference: [10, 20, 300, group.id], page: [-100.5, 40, null, null], image: [1e6, -1e6, null, null], note: [9, 9, 200, null] })
    assert.equal((await get<BoardCanvas>(`/api/boards/${moodboard}`)).items.find((i) => i.kind === "note")!.text, "keep me", "moving a note keeps its text")
    assert.equal((await call(`/api/boards/${other}/items`, "PUT", { items: [{ kind: "note", id: note.id, x: 0, y: 0 }] })).status, 400, "notes stay on their board")

    // Omitted w and groupId keep what is stored; null clears them.
    await get(`/api/boards/${moodboard}/items`, "PUT", { items: [{ kind: "reference", id: stripe.reference.id, x: 11, y: 21 }] })
    assert.deepEqual((await placed()).reference, [11, 21, 300, group.id])
    await get(`/api/boards/${moodboard}/items`, "PUT", { items: [{ kind: "reference", id: stripe.reference.id, x: 12, y: 22, w: null, groupId: null }] })
    assert.deepEqual((await placed()).reference, [12, 22, null, null])
    assert.deepEqual(await get(`/api/boards/${moodboard}/items`, "PUT", { items: [] }), { ok: true })

    // Anything invalid rejects the whole change.
    const valid = { kind: "image", id: image.id, x: 1, y: 1 }
    const refused: [string, unknown, number?][] = [
      ["not on this board", [valid, { kind: "image", id: outsider.id, x: 0, y: 0 }]],
      ["unknown kind", [{ kind: "video", id: image.id, x: 0, y: 0 }]],
      ["string x", [{ ...valid, x: "1" }]],
      ["far x", [{ ...valid, x: 1e6 + 1 }]],
      ["narrow", [{ ...valid, w: 39 }]],
      ["wide", [{ ...valid, w: 4001 }]],
      ["another board's group", [{ ...valid, groupId: foreignGroup.id }]],
      ["missing group", [{ ...valid, groupId: "nope" }]],
      ["empty group id", [{ ...valid, groupId: "" }]],
      ["too many", Array(201).fill(valid)],
      ["not a list", "nope"],
    ]
    for (const [label, items] of refused) assert.equal((await call(`/api/boards/${moodboard}/items`, "PUT", { items })).status, 400, label)
    assert.equal((await call(`/api/boards/missing/items`, "PUT", { items: [valid] })).status, 404)
    assert.deepEqual((await placed()).image, [1e6, -1e6, null, null], "nothing saved by a refused change")
    assert.equal((await rows(`SELECT * FROM board_items WHERE item_id = ?`, outsider.id)).length, 0)

    // A recapture replaces page rows; the position follows the page path, and the old id is gone.
    const oldPageId = stripe.pages[0]!.id
    await db.requeueReference(database, stripe.reference.id)
    const job = (await db.claimJob(database))!
    assert.equal(job.id, stripe.reference.id)
    await db.addPage(database, stripe.reference.id, job.lease, { url: "https://stripe.com/pricing", path: "/pricing", title: null, ord: 0, desktopKey: null, desktopThumbKey: null, desktopWidth: 1280, desktopHeight: 100, mobileKey: null, mobileThumbKey: null, mobileWidth: null, mobileHeight: null, snapshotKey: null, stylesKey: null, tokens: null, animations: [] })
    const pageItem = (await get<BoardCanvas>(`/api/boards/${moodboard}`)).items.find((i) => i.kind === "page")!
    assert.notEqual(pageItem.id, oldPageId)
    assert.deepEqual([pageItem.x, pageItem.y], [-100.5, 40])
    assert.equal((await call(`/api/boards/${moodboard}/items`, "PUT", { items: [{ kind: "page", id: oldPageId, x: 0, y: 0 }] })).status, 400)
    assert.deepEqual(await get(`/api/boards/${moodboard}/items`, "PUT", { items: [{ kind: "page", id: pageItem.id, x: 7, y: 8 }] }), { ok: true })
    assert.deepEqual((await placed()).page, [7, 8, null, null])
  } finally {
    await mf.dispose()
  }
})

test("stacking order is stored: z round-trips, ties break the same way every time, and new items land on top", async () => {
  const { mf, database, call, get, uploaded, board } = await setup()
  try {
    const moodboard = await board("Moodboard")
    const stripe = await capture(database, "https://stripe.com", [{ path: "/" }])
    await db.setReferenceCollection(database, stripe.reference.id, moodboard, true)
    const a = await uploaded({ name: "a.png", collectionId: moodboard })
    const b = await uploaded({ name: "b.png", collectionId: moodboard })
    const put = (items: unknown[]) => get(`/api/boards/${moodboard}/items`, "PUT", { items })
    const stack = async () => (await get<BoardCanvas>(`/api/boards/${moodboard}`)).items.map((i) => [i.id, i.z])
    const ref = stripe.reference.id

    // The order sent is the order loaded, whatever order the members are listed in.
    await put([{ kind: "image", id: a.id, x: 0, y: 0, z: 2 }, { kind: "reference", id: ref, x: 0, y: 0, z: 0 }, { kind: "image", id: b.id, x: 0, y: 0, z: 1 }])
    assert.deepEqual(await stack(), [[ref, 0], [b.id, 1], [a.id, 2]])
    // A save of one item re-stacks it and leaves the rest; omitted z keeps what is stored.
    await put([{ kind: "reference", id: ref, x: 5, y: 5, z: 3 }])
    await put([{ kind: "image", id: a.id, x: 9, y: 9 }])
    assert.deepEqual(await stack(), [[b.id, 1], [a.id, 2], [ref, 3]])
    // Equal z: by kind, then id.
    await put([{ kind: "image", id: a.id, x: 0, y: 0, z: 7 }, { kind: "image", id: b.id, x: 0, y: 0, z: 7 }, { kind: "reference", id: ref, x: 0, y: 0, z: 7 }])
    assert.deepEqual(await stack(), [...[a.id, b.id].sort().map((id) => [id, 7]), [ref, 7]])

    // New rows go on top: a note, a first placement without a z, and members a new group places.
    const note = await get<BoardItem>(`/api/boards/${moodboard}/notes`, "POST", { text: "top", x: 0, y: 0 })
    assert.equal(note.z, 8)
    const c = await uploaded({ name: "c.png", collectionId: moodboard })
    const d = await uploaded({ name: "d.png", collectionId: moodboard })
    const e = await uploaded({ name: "e.png", collectionId: moodboard })
    assert.deepEqual((await stack()).slice(3).map(([, z]) => z), [8, null, null, null], "unplaced items come last")
    await put([{ kind: "image", id: c.id, x: 0, y: 0 }])
    await get(`/api/boards/${moodboard}/groups`, "POST", { name: "G", x: 0, y: 0, w: 10, h: 10, items: [{ kind: "image", id: d.id }, { kind: "image", id: e.id }, { kind: "image", id: a.id }] })
    assert.deepEqual((await stack()).slice(2), [[ref, 7], [note.id, 8], [c.id, 9], [d.id, 10], [e.id, 11]], "grouping leaves a placed item's z alone")

    for (const z of [1.5, "1", null, 2 ** 60]) {
      assert.equal((await call(`/api/boards/${moodboard}/items`, "PUT", { items: [{ kind: "image", id: a.id, x: 0, y: 0, z }] })).status, 400, `z ${z}`)
    }
  } finally {
    await mf.dispose()
  }
})

test("a note can bring its own z, is checked like a placement, and goes on top without one", async () => {
  const { mf, call, get, board } = await setup()
  try {
    const moodboard = await board("Moodboard")
    const post = (z?: unknown) => call(`/api/boards/${moodboard}/notes`, "POST", { text: "n", x: 0, y: 0, ...(z === undefined ? {} : { z }) })
    const made = async (z?: unknown) => {
      const res = await post(z)
      assert.equal(res.status, 201)
      return ((await res.json()) as BoardItem).z
    }
    assert.equal(await made(5), 5)
    assert.equal(await made(), 6, "omitted z goes on top")
    assert.equal(await made(-2), -2)
    assert.equal(await made(0), 0)
    assert.equal(await made(), 7)
    for (const z of [1.5, "1", null, 2 ** 60]) assert.equal((await post(z)).status, 400, `z ${z}`)
    assert.deepEqual((await get<BoardCanvas>(`/api/boards/${moodboard}`)).items.map((i) => i.z), [-2, 0, 5, 6, 7], "stored in order, and a refused note left nothing")
  } finally {
    await mf.dispose()
  }
})

test("the z migration keeps the order boards loaded in before it", async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ["DB"] }))
  try {
    const database = (await mf.getD1Database("DB")) as unknown as D1Database
    await applyMigrations(database, (f) => !f.startsWith("0017"))
    const run = (sql: string) => database.prepare(sql).run()
    await run(`INSERT INTO collections (id, name, created_at) VALUES ('b1', 'One', '2026-01-01'), ('b2', 'Two', '2026-01-01')`)
    const stripe = await capture(database, "https://stripe.com", [{ path: "/" }, { path: "/pricing" }])
    const linear = await capture(database, "https://linear.app", [{ path: "/" }])
    await run(`UPDATE refs SET created_at = '2026-01-02' WHERE id = '${stripe.reference.id}'`)
    await run(`UPDATE refs SET created_at = '2026-01-03' WHERE id = '${linear.reference.id}'`)
    for (const [id, at] of [["i1", "2026-01-01"], ["i2", "2026-01-02"]]) {
      await run(`INSERT INTO images (id, file_key, thumb_key, width, height, mime, created_at) VALUES ('${id}', 'f', 't', 1, 1, 'image/png', '${at}')`)
      await run(`INSERT INTO image_collections (collection_id, image_id, added_at) VALUES ('b1', '${id}', '2026-01-01')`)
    }
    await run(`INSERT INTO reference_collections (collection_id, reference_id, added_at) VALUES ('b1', '${stripe.reference.id}', '2026-01-01'), ('b1', '${linear.reference.id}', '2026-01-01'), ('b2', '${stripe.reference.id}', '2026-01-01')`)
    await run(`INSERT INTO page_collections (collection_id, reference_id, page_path, added_at) VALUES ('b1', '${stripe.reference.id}', '/', '2026-01-01'), ('b1', '${stripe.reference.id}', '/pricing', '2026-01-02')`)
    // Rows written in no particular order; before z, a board loaded websites, pages, images (each newest first), then notes by id.
    const row = (board: string, kind: string, id: string, path = "") =>
      run(`INSERT INTO board_items (collection_id, kind, item_id, page_path, x, y, text, updated_at) VALUES ('${board}', '${kind}', '${id}', '${path}', 0, 0, ${kind === "note" ? "'n'" : "NULL"}, '2026-01-01')`)
    await row("b1", "note", "n2")
    await row("b1", "image", "i1")
    await row("b2", "note", "n9")
    await row("b1", "page", stripe.reference.id, "/")
    await row("b1", "reference", stripe.reference.id)
    await row("b1", "note", "n1")
    await row("b1", "image", "i2")
    await row("b2", "reference", stripe.reference.id)
    await row("b1", "page", stripe.reference.id, "/pricing")
    await row("b1", "reference", linear.reference.id)

    await applyMigrations(database, (f) => f.startsWith("0017"))
    const env = { DB: database, SESSION_SECRET: "test-secret", DEV_LOGIN: "max" } as unknown as Env
    const load = async (id: string) => ((await (await app.request(`http://localhost/api/boards/${id}`, {}, env)).json()) as BoardCanvas).items.map((i) => [i.kind, i.id, i.z])
    assert.deepEqual(await load("b1"), [
      ["reference", linear.reference.id, 1],
      ["reference", stripe.reference.id, 2],
      ["page", stripe.pages[1]!.id, 3],
      ["page", stripe.pages[0]!.id, 4],
      ["image", "i2", 5],
      ["image", "i1", 6],
      ["note", "n1", 7],
      ["note", "n2", 8],
    ])
    assert.deepEqual(await load("b2"), [["reference", stripe.reference.id, 1], ["note", "n9", 2]])
  } finally {
    await mf.dispose()
  }
})

test("an item that leaves the board between the membership check and the write is not placed", async () => {
  const { mf, database, env, ctx, board, rows } = await setup()
  try {
    const stripe = await capture(database, "https://stripe.com", [{ path: "/" }])
    const id = stripe.reference.id
    // Runs `leave` right after the route's membership check (its only batch) has answered.
    const racing = (leave: () => Promise<unknown>) => ({ ...env, DB: new Proxy(database, { get(target, name) {
      if (name === "batch") return async (statements: D1PreparedStatement[]) => { const results = await target.batch(statements); await leave(); return results }
      const value = Reflect.get(target, name, target)
      return typeof value === "function" ? value.bind(target) : value
    } }) })
    const send = (path: string, method: string, body: unknown, raceEnv: unknown) =>
      app.request(`http://localhost${path}`, { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } }, raceEnv as Env, ctx)

    const placed = await board("Placed")
    await db.setReferenceCollection(database, id, placed, true)
    await send(`/api/boards/${placed}/items`, "PUT", { items: [{ kind: "reference", id, x: 1, y: 2 }] }, racing(() => db.setReferenceCollection(database, id, placed, false)))
    assert.deepEqual(await rows("SELECT item_id FROM board_items WHERE collection_id = ?", placed), [])

    const grouped = await board("Grouped")
    await db.setReferenceCollection(database, id, grouped, true)
    let left = false
    const leaveOnce = async () => { if (!left) { left = true; await db.deleteReference(database, id) } }
    await send(`/api/boards/${grouped}/groups`, "POST", { name: "Heroes", x: 0, y: 0, w: 100, h: 100, items: [{ kind: "reference", id }] }, racing(leaveOnce))
    assert.deepEqual(await rows("SELECT item_id FROM board_items WHERE collection_id = ?", grouped), [])
  } finally {
    await mf.dispose()
  }
})

test("an item's style round-trips, is kept when omitted, cleared by null and checked strictly", async () => {
  const { mf, call, get, uploaded, board } = await setup()
  try {
    const moodboard = await board("Moodboard")
    const image = await uploaded({ collectionId: moodboard })
    const note = await get<BoardItem>(`/api/boards/${moodboard}/notes`, "POST", { text: "n", x: 0, y: 0 })
    const styleOf = async (kind: string) => (await get<BoardCanvas>(`/api/boards/${moodboard}`)).items.find((i) => i.kind === kind)!.style
    const style = { rot: -37.5, flip: true, op: 0.4, round: 0, blur: 20, crop: true, mask: false, outline: true, hidden: false, locked: true }

    assert.equal(await styleOf("image"), undefined, "no style until one is set")
    await get(`/api/boards/${moodboard}/items`, "PUT", { items: [{ kind: "image", id: image.id, x: 1, y: 2, style }, { kind: "note", id: note.id, x: 3, y: 4, style: { rot: 180 } }] })
    assert.deepEqual(await styleOf("image"), style)
    assert.deepEqual(await styleOf("note"), { rot: 180 })
    assert.equal((await get<BoardCanvas>(`/api/boards/${moodboard}`)).items.find((i) => i.kind === "note")!.text, "n")

    // Omitted keeps it; null and {} clear it.
    await get(`/api/boards/${moodboard}/items`, "PUT", { items: [{ kind: "image", id: image.id, x: 5, y: 6 }] })
    assert.deepEqual(await styleOf("image"), style)
    await get(`/api/boards/${moodboard}/items`, "PUT", { items: [{ kind: "image", id: image.id, x: 5, y: 6, style: null }, { kind: "note", id: note.id, x: 3, y: 4, style: {} }] })
    assert.equal(await styleOf("image"), undefined)
    assert.equal(await styleOf("note"), undefined)

    const valid = { kind: "image", id: image.id, x: 1, y: 1 }
    for (const [label, bad] of [
      ["unknown key", { rot: 0, scale: 2 }],
      ["inherited key", JSON.parse('{"constructor": 1}')],
      ["rot too far", { rot: 181 }],
      ["negative opacity", { op: -0.1 }],
      ["opacity over 1", { op: 1.5 }],
      ["round over 40", { round: 41 }],
      ["blur over 20", { blur: 21 }],
      ["string number", { rot: "45" }],
      ["flag as number", { locked: 1 }],
      ["a list", [1]],
      ["a string", "rotated"],
    ] as const) assert.equal((await call(`/api/boards/${moodboard}/items`, "PUT", { items: [{ ...valid, style: bad }] })).status, 400, label)
    assert.equal(await styleOf("image"), undefined, "a refused style saves nothing")
  } finally {
    await mf.dispose()
  }
})

test("notes are created, edited and deleted on their board only", async () => {
  const { mf, call, get, board } = await setup()
  try {
    const moodboard = await board("Moodboard")
    const other = await board("Other")
    const group = await get<BoardGroup>(`/api/boards/${moodboard}/groups`, "POST", { name: "Ideas", x: 0, y: 0, w: 400, h: 400, items: [] })
    const res = await call(`/api/boards/${moodboard}/notes`, "POST", { text: "", x: 1, y: 2, w: 240, groupId: group.id })
    assert.equal(res.status, 201)
    const note = (await res.json()) as BoardItem
    assert.deepEqual(note, { kind: "note", id: note.id, x: 1, y: 2, z: 0, w: 240, groupId: group.id, text: "" })

    assert.equal((await call(`/api/boards/${moodboard}/notes`, "POST", { text: "x".repeat(2001), x: 0, y: 0 })).status, 400)
    assert.equal((await call(`/api/boards/${moodboard}/notes`, "POST", { x: 0, y: 0 })).status, 400)
    assert.equal((await call(`/api/boards/${moodboard}/notes`, "POST", { text: "a", x: 0 })).status, 400)
    assert.equal((await call(`/api/boards/${moodboard}/notes`, "POST", { text: "a", x: 0, y: 0, w: 10 })).status, 400)
    assert.equal((await call(`/api/boards/${other}/notes`, "POST", { text: "a", x: 0, y: 0, groupId: group.id })).status, 400)
    assert.equal((await call(`/api/boards/${moodboard}/notes`, "POST", { text: "a", x: 0, y: 0, groupId: "" })).status, 400)
    assert.equal((await call(`/api/boards/missing/notes`, "POST", { text: "a", x: 0, y: 0 })).status, 404)

    assert.deepEqual(await get(`/api/boards/${moodboard}/notes/${note.id}`, "PATCH", { text: "Use the warm greys" }), { ok: true })
    assert.equal((await call(`/api/boards/${moodboard}/notes/${note.id}`, "PATCH", { text: "x".repeat(2001) })).status, 400)
    assert.equal((await call(`/api/boards/${other}/notes/${note.id}`, "PATCH", { text: "hijack" })).status, 404)
    const notes = (await get<BoardCanvas>(`/api/boards/${moodboard}`)).items
    assert.deepEqual(notes.map((i) => [i.kind, i.text]), [["note", "Use the warm greys"]])
    assert.equal((await get<BoardCanvas>(`/api/boards/${other}`)).items.length, 0)

    assert.equal((await call(`/api/boards/${other}/notes/${note.id}`, "DELETE")).status, 404)
    assert.deepEqual(await get(`/api/boards/${moodboard}/notes/${note.id}`, "DELETE"), { ok: true })
    assert.equal((await call(`/api/boards/${moodboard}/notes/${note.id}`, "DELETE")).status, 404)
    assert.equal((await get<BoardCanvas>(`/api/boards/${moodboard}`)).items.length, 0)
  } finally {
    await mf.dispose()
  }
})

test("groups frame items, move and rename, and leave their items in place when deleted", async () => {
  const { mf, database, call, get, uploaded, board } = await setup()
  try {
    const moodboard = await board("Moodboard")
    const stripe = await capture(database, "https://stripe.com", [{ path: "/" }])
    await db.setReferenceCollection(database, stripe.reference.id, moodboard, true)
    const image = await uploaded({ collectionId: moodboard })
    const note = await get<BoardItem>(`/api/boards/${moodboard}/notes`, "POST", { text: "n", x: 300, y: 300 })
    await get(`/api/boards/${moodboard}/items`, "PUT", { items: [{ kind: "reference", id: stripe.reference.id, x: 50, y: 60, w: 320 }] })

    const res = await call(`/api/boards/${moodboard}/groups`, "POST", { name: "  Heroes  ", x: 40, y: 30, w: 900, h: 500, items: [
      { kind: "reference", id: stripe.reference.id }, { kind: "image", id: image.id }, { kind: "note", id: note.id },
    ] })
    assert.equal(res.status, 201)
    const group = (await res.json()) as BoardGroup
    assert.deepEqual(group, { id: group.id, name: "Heroes", x: 40, y: 30, w: 900, h: 500 })
    const positions = async () => {
      const canvas = await get<BoardCanvas>(`/api/boards/${moodboard}`)
      return { groups: canvas.groups, items: Object.fromEntries(canvas.items.map((i) => [i.kind, [i.x, i.y, i.w, i.groupId]])) }
    }
    // Placed items keep their spot; the unplaced image starts at the group's corner.
    assert.deepEqual(await positions(), {
      groups: [group],
      items: { reference: [50, 60, 320, group.id], image: [40, 30, null, group.id], note: [300, 300, null, group.id] },
    })

    for (const [label, body] of [
      ["long name", { name: "x".repeat(121), x: 0, y: 0, w: 1, h: 1, items: [] }],
      ["zero size", { name: "a", x: 0, y: 0, w: 0, h: 1, items: [] }],
      ["no position", { name: "a", w: 1, h: 1, items: [] }],
      ["not a member", { name: "a", x: 0, y: 0, w: 1, h: 1, items: [{ kind: "image", id: "missing" }] }],
      ["bad item", { name: "a", x: 0, y: 0, w: 1, h: 1, items: [{ kind: "image" }] }],
    ] as const) assert.equal((await call(`/api/boards/${moodboard}/groups`, "POST", body)).status, 400, label)
    assert.equal((await call(`/api/boards/missing/groups`, "POST", { name: "a", x: 0, y: 0, w: 1, h: 1, items: [] })).status, 404)

    assert.deepEqual(await get(`/api/boards/${moodboard}/groups/${group.id}`, "PATCH", { name: "Hero sections", x: -10, h: 700 }), { ok: true })
    assert.deepEqual((await positions()).groups, [{ ...group, name: "Hero sections", x: -10, h: 700 }])
    assert.equal((await call(`/api/boards/${moodboard}/groups/${group.id}`, "PATCH", { w: -5 })).status, 400)
    assert.equal((await call(`/api/boards/${moodboard}/groups/${group.id}`, "PATCH", {})).status, 400)
    assert.equal((await call(`/api/boards/${moodboard}/groups/missing`, "PATCH", { x: 1 })).status, 404)
    const other = await board("Other")
    assert.equal((await call(`/api/boards/${other}/groups/${group.id}`, "PATCH", { x: 1 })).status, 404)
    assert.equal((await call(`/api/boards/${other}/groups/${group.id}`, "DELETE")).status, 404)

    assert.deepEqual(await get(`/api/boards/${moodboard}/groups/${group.id}`, "DELETE"), { ok: true })
    assert.deepEqual(await positions(), { groups: [], items: { reference: [50, 60, 320, null], image: [40, 30, null, null], note: [300, 300, null, null] } })
    assert.equal((await call(`/api/boards/${moodboard}/groups/${group.id}`, "DELETE")).status, 404)
  } finally {
    await mf.dispose()
  }
})

test("taking things off a board, or deleting them or the board, drops their positions", async () => {
  const { mf, database, pending, call, get, uploaded, board, rows } = await setup()
  try {
    const a = await board("A")
    const b = await board("B")
    const stripe = await capture(database, "https://stripe.com", [{ path: "/" }, { path: "/pricing" }])
    const linear = await capture(database, "https://linear.app", [{ path: "/" }])
    const image = await uploaded()
    const kept = await uploaded()
    for (const cid of [a, b]) {
      await db.setReferenceCollection(database, stripe.reference.id, cid, true)
      await db.setReferenceCollection(database, linear.reference.id, cid, true)
      await db.setPageCollection(database, cid, [stripe.pages[1]!.id, linear.pages[0]!.id], true)
      await get(`/api/collections/${cid}/images`, "POST", { imageIds: [image.id, kept.id], member: true })
      await get(`/api/boards/${cid}/items`, "PUT", { items: [
        { kind: "reference", id: stripe.reference.id, x: 0, y: 0 }, { kind: "reference", id: linear.reference.id, x: 0, y: 0 },
        { kind: "page", id: stripe.pages[1]!.id, x: 0, y: 0 }, { kind: "page", id: linear.pages[0]!.id, x: 0, y: 0 },
        { kind: "image", id: image.id, x: 0, y: 0 }, { kind: "image", id: kept.id, x: 0, y: 0 },
      ] })
    }
    const placedOn = async (cid: string) => (await rows(`SELECT kind, item_id FROM board_items WHERE collection_id = ? ORDER BY kind, item_id`, cid)).map((r) => `${r.kind}:${r.item_id}`)
    assert.equal((await placedOn(a)).length, 6)

    // Taking each kind off board A leaves board B alone.
    await call(`/api/references/${linear.reference.id}/collections/${a}`, "DELETE")
    await get(`/api/collections/${a}/pages`, "POST", { pageIds: [linear.pages[0]!.id], member: false })
    await get(`/api/collections/${a}/images`, "POST", { imageIds: [kept.id], member: false })
    assert.deepEqual(await placedOn(a), [`image:${image.id}`, `page:${stripe.reference.id}`, `reference:${stripe.reference.id}`])
    assert.equal((await placedOn(b)).length, 6)

    // Deleting a website or an image drops it (and the website's pages) from every board.
    await get(`/api/references/${stripe.reference.id}`, "DELETE")
    await get(`/api/images/${image.id}`, "DELETE")
    await Promise.all(pending)
    assert.deepEqual(await placedOn(a), [])
    assert.deepEqual(await placedOn(b), [`image:${kept.id}`, `page:${linear.reference.id}`, `reference:${linear.reference.id}`])

    // Deleting a board takes its positions, notes and groups with it.
    await get(`/api/boards/${b}/notes`, "POST", { text: "bye", x: 0, y: 0 })
    await get(`/api/boards/${b}/groups`, "POST", { name: "g", x: 0, y: 0, w: 1, h: 1, items: [] })
    await get(`/api/collections/${b}`, "DELETE")
    assert.equal((await rows(`SELECT * FROM board_items`)).length, 0)
    assert.equal((await rows(`SELECT * FROM board_groups`)).length, 0)
    assert.equal((await call(`/api/boards/${b}`)).status, 404)
  } finally {
    await mf.dispose()
  }
})

test("collections count images and use their thumbnails as covers", async () => {
  const { mf, database, get, uploaded, board } = await setup()
  try {
    const moodboard = await board("Moodboard")
    const stripe = await capture(database, "https://stripe.com", [{ path: "/" }, { path: "/pricing" }])
    await db.setReferenceCollection(database, stripe.reference.id, moodboard, true)
    await db.setPageCollection(database, moodboard, [stripe.pages[1]!.id], true)
    const older = await uploaded({ collectionId: moodboard })
    const newest = await uploaded({ collectionId: moodboard })
    // Pin the order: website, then page, then the two images, a minute apart.
    const at = (minute: number) => `2030-01-01T00:0${minute}:00.000Z`
    await database.batch([
      database.prepare(`UPDATE reference_collections SET added_at = ? WHERE collection_id = ?`).bind(at(1), moodboard),
      database.prepare(`UPDATE page_collections SET added_at = ? WHERE collection_id = ?`).bind(at(2), moodboard),
      database.prepare(`UPDATE image_collections SET added_at = ? WHERE image_id = ?`).bind(at(3), older.id),
      database.prepare(`UPDATE image_collections SET added_at = ? WHERE image_id = ?`).bind(at(4), newest.id),
    ])
    const [listed] = await get<Collection[]>("/api/collections")
    assert.deepEqual([listed!.referenceCount, listed!.pageCount, listed!.imageCount], [1, 1, 2])
    assert.deepEqual(listed!.coverKeys, [newest.thumbKey, older.thumbKey, stripe.pages[1]!.desktopThumbKey])
    assert.deepEqual((await get<BoardCanvas>(`/api/boards/${moodboard}`)).collection, listed)
  } finally {
    await mf.dispose()
  }
})
