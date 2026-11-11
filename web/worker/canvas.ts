import { Hono, type Context } from "hono"
import type { BoardCanvas, BoardGroup, BoardItem, BoardItemKind, BoardItemStyle, LibraryTypeCounts, PageSection, Paged, SavedImage, SectionItem } from "../shared/types"
import type { AppEnv } from "./auth"
import * as db from "./db"

// The canvas: uploaded images, sections listed on their own, per-kind counts for the filter dock,
// and where things sit on a board. Mounted on /api, so it shares the session and origin checks.

export const canvas = new Hono<AppEnv>()

const bad = (c: Context<AppEnv>, error: string) => c.json({ error }, 400)
const missing = (c: Context<AppEnv>, what = "board") => c.json({ error: `${what} not found` }, 404)
const jsonBody = async (c: Context<AppEnv>): Promise<Record<string, unknown>> => {
  const body: unknown = await c.req.json().catch(() => null)
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
}
const pageLimit = (limit: number | undefined) => Math.min(Math.max(limit || 60, 1), 100)
const feedFilter = (q: Record<string, string>): db.ListFilter => ({
  q: q.q || undefined,
  collectionId: q.collection || undefined,
  cursor: q.cursor || null,
  limit: Number(q.limit) || undefined,
})

// ---------- Images ----------

const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_THUMB_BYTES = 2 * 1024 * 1024
const MAX_DIMENSION = 20_000
const MAX_TITLE = 200

/**
 * The real format, from the file's first bytes; the declared type is never trusted. Only raster
 * formats a browser renders inertly: SVG can carry script, so it is never accepted.
 */
function sniffImage(bytes: Uint8Array): { mime: string; ext: string } | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to))
  if (ascii(0, 8) === "\x89PNG\r\n\x1a\n") return { mime: "image/png", ext: "png" }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" }
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return { mime: "image/gif", ext: "gif" }
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return { mime: "image/webp", ext: "webp" }
  if (ascii(4, 8) === "ftyp") {
    // ISO BMFF: the major brand at 8, then (after a 4-byte minor version) the compatible brands.
    const end = Math.min(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0), bytes.length)
    for (let i = 8; i + 4 <= end; i += i === 8 ? 8 : 4) {
      if (ascii(i, i + 4) === "avif" || ascii(i, i + 4) === "avis") return { mime: "image/avif", ext: "avif" }
    }
  }
  return null
}

const sniff = async (file: Blob) => sniffImage(new Uint8Array(await file.slice(0, 64).arrayBuffer()))
const dimension = (v: unknown) => (typeof v === "string" && /^\d{1,5}$/.test(v) && +v >= 1 && +v <= MAX_DIMENSION ? +v : null)
/** Up to 6 "#rrggbb" colours, lowercased; anything else is dropped. */
const cleanPalette = (v: unknown) => {
  const list = db.parse<unknown>(v)
  return Array.isArray(list) ? list.filter((s): s is string => typeof s === "string" && /^#[0-9a-f]{6}$/i.test(s)).map((s) => s.toLowerCase()).slice(0, 6) : []
}

const IMAGE_SELECT = `SELECT i.*, (SELECT group_concat(ic.collection_id) FROM image_collections ic WHERE ic.image_id = i.id) AS collection_ids FROM images i`

const toImage = (r: db.Row): SavedImage => ({
  id: r.id as string,
  title: (r.title as string) ?? null,
  key: r.file_key as string,
  thumbKey: r.thumb_key as string,
  width: r.width as number,
  height: r.height as number,
  mime: r.mime as string,
  palette: db.parse<string[]>(r.palette_json) ?? [],
  collectionIds: r.collection_ids ? String(r.collection_ids).split(",") : [],
  createdAt: r.created_at as string,
})

/** The images feed's q and collection filters. Alias images as `i`. */
function imageWhere(f: db.ListFilter): db.Where {
  const where: string[] = []
  const args: unknown[] = []
  if (f.q) {
    where.push(`i.title LIKE ?`)
    args.push(`%${f.q}%`)
  }
  if (f.collectionId) {
    where.push(`EXISTS (SELECT 1 FROM image_collections ic WHERE ic.image_id = i.id AND ic.collection_id = ?)`)
    args.push(f.collectionId)
  }
  return { where, args }
}

async function listImages(database: D1Database, f: db.ListFilter): Promise<Paged<SavedImage>> {
  const limit = pageLimit(f.limit)
  const { where, args } = imageWhere(f)
  const cur = db.decodeCursor(f.cursor)
  if (cur) {
    where.push(`(i.created_at < ? OR (i.created_at = ? AND i.id < ?))`)
    args.push(cur[0], cur[0], cur[1])
  }
  const { results } = await database.prepare(`${IMAGE_SELECT} ${db.whereSql(where)} ORDER BY i.created_at DESC, i.id DESC LIMIT ?`).bind(...args, limit + 1).all<db.Row>()
  const items = results.slice(0, limit).map(toImage)
  const last = items[items.length - 1]
  return { items, nextCursor: results.length > limit && last ? db.encodeCursor(last.createdAt, last.id) : null }
}

const getImage = async (database: D1Database, id: string) => {
  const r = await database.prepare(`${IMAGE_SELECT} WHERE i.id = ?`).bind(id).first<db.Row>()
  return r ? toImage(r) : null
}

canvas.get("/images", async (c) => c.json(await listImages(c.env.DB, feedFilter(c.req.query()))))

canvas.post("/images", async (c) => {
  // Refuse an oversized body before buffering it, when its size is declared.
  if (Number(c.req.header("content-length")) > MAX_IMAGE_BYTES + MAX_THUMB_BYTES + 64 * 1024) return c.json({ error: "Images are limited to 20 MB" }, 413)
  const form = await c.req.formData().catch(() => null)
  if (!form) return bad(c, "Expected a multipart form")
  const file = form.get("file")
  const thumb = form.get("thumb")
  if (!file || typeof file === "string" || !file.size) return bad(c, "file is required")
  if (file.size > MAX_IMAGE_BYTES) return bad(c, "Images are limited to 20 MB")
  const type = await sniff(file)
  if (!type) return bad(c, "Only PNG, JPEG, WebP, GIF and AVIF images can be uploaded")
  if (!thumb || typeof thumb === "string" || !thumb.size || thumb.size > MAX_THUMB_BYTES) return bad(c, "thumb is required, at most 2 MB")
  const thumbType = await sniff(thumb)
  if (thumbType?.ext !== "webp" && thumbType?.ext !== "jpg") return bad(c, "thumb must be WebP or JPEG")
  const width = dimension(form.get("width"))
  const height = dimension(form.get("height"))
  if (!width || !height) return bad(c, `width and height must be whole numbers from 1 to ${MAX_DIMENSION}`)
  const collectionId = form.get("collectionId")
  if (collectionId !== null && (typeof collectionId !== "string" || !(await c.env.DB.prepare(`SELECT 1 FROM collections WHERE id = ?`).bind(collectionId).first()))) {
    return bad(c, "collection not found")
  }

  const id = db.newId()
  const key = `uploads/${id}/original.${type.ext}`
  const thumbKey = `uploads/${id}/thumb.${thumbType.ext}`
  const ts = db.now()
  const stmts = [
    c.env.DB.prepare(`INSERT INTO images (id, title, file_key, thumb_key, width, height, mime, palette_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, file.name.replace(/\.[^.]*$/, "").trim().slice(0, MAX_TITLE) || null, key, thumbKey, width, height, type.mime, JSON.stringify(cleanPalette(form.get("palette"))), ts),
  ]
  if (collectionId) {
    stmts.push(c.env.DB.prepare(`INSERT OR IGNORE INTO image_collections (collection_id, image_id, added_at) SELECT id, ?, ? FROM collections WHERE id = ?`).bind(id, ts, collectionId))
  }
  // Files first, so a row never points at a missing file; a failed write takes its files with it.
  try {
    await Promise.all([
      c.env.FILES.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: type.mime } }),
      c.env.FILES.put(thumbKey, await thumb.arrayBuffer(), { httpMetadata: { contentType: thumbType.mime } }),
    ])
    await c.env.DB.batch(stmts)
  } catch (e) {
    await c.env.FILES.delete([key, thumbKey]).catch(() => {})
    throw e
  }
  return c.json(await getImage(c.env.DB, id), 201)
})

canvas.delete("/images/:id", async (c) => {
  const id = c.req.param("id")
  // Same retryable tombstone as a deleted website; board memberships cascade, positions go here.
  const [, , deleted] = await c.env.DB.batch([
    c.env.DB.prepare(`INSERT OR IGNORE INTO capture_cleanup (prefix) SELECT 'uploads/' || id || '/' FROM images WHERE id = ?`).bind(id),
    c.env.DB.prepare(`DELETE FROM board_items WHERE item_id = ? AND kind = 'image'`).bind(id),
    c.env.DB.prepare(`DELETE FROM images WHERE id = ?`).bind(id),
  ])
  if (!deleted!.meta.changes) return missing(c, "image")
  c.executionCtx.waitUntil(db.cleanupRetiredFiles(c.env.DB, c.env.FILES))
  return c.json({ ok: true })
})

// Put images on a board or take them off. Unknown image ids are skipped.
canvas.post("/collections/:cid/images", async (c) => {
  const body = await jsonBody(c)
  const imageIds = Array.isArray(body.imageIds) ? body.imageIds.filter((x): x is string => typeof x === "string") : []
  if (!imageIds.length) return bad(c, "imageIds is required")
  if (imageIds.length > db.MAX_PAGES_PER_CHANGE) return bad(c, `At most ${db.MAX_PAGES_PER_CHANGE} images at a time`)
  const cid = c.req.param("cid")
  const ids = JSON.stringify([...new Set(imageIds)])
  const board = `EXISTS (SELECT 1 FROM collections WHERE id = ?1)`
  const [exists, result] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT ${board} AS ok`).bind(cid),
    body.member === false
      ? c.env.DB.prepare(`DELETE FROM image_collections WHERE collection_id = ?1 AND image_id IN (SELECT value FROM json_each(?2))`).bind(cid, ids)
      : c.env.DB.prepare(`INSERT OR IGNORE INTO image_collections (collection_id, image_id, added_at)
          SELECT ?1, id, ?3 FROM images WHERE id IN (SELECT value FROM json_each(?2)) AND ${board}`).bind(cid, ids, db.now()),
    // Taking images off a board also drops their positions on its canvas.
    ...(body.member === false
      ? [c.env.DB.prepare(`DELETE FROM board_items WHERE collection_id = ?1 AND kind = 'image' AND item_id IN (SELECT value FROM json_each(?2))`).bind(cid, ids)]
      : []),
  ])
  if (!(exists!.results[0] as { ok: number }).ok) return missing(c, "collection")
  return c.json({ ok: true, changed: result!.meta.changes })
})

// ---------- Sections and counts ----------

/** Every section of every matching page: newest page first, each page's sections top to bottom. */
async function listSections(database: D1Database, f: db.ListFilter): Promise<Paged<SectionItem>> {
  const limit = pageLimit(f.limit)
  const { where, args } = db.childWhere("pages", f)
  const cur = db.decodeCursor(f.cursor)
  if (cur) {
    // The cursor is the last section returned: its page's created_at, then `${pageId}:${index}`.
    const at = cur[1].lastIndexOf(":")
    const pageId = cur[1].slice(0, at)
    where.push(`(t.created_at < ? OR (t.created_at = ? AND (t.id < ? OR (t.id = ? AND s.key > ?))))`)
    args.push(cur[0], cur[0], pageId, pageId, Number(cur[1].slice(at + 1)))
  }
  const { results } = await database
    .prepare(`SELECT t.id, t.reference_id, t.url, t.path, t.desktop_width, t.created_at, r.title AS ref_title, r.domain AS ref_domain, r.favicon AS ref_favicon, s.key AS idx, s.value AS section
      FROM pages t JOIN refs r ON r.id = t.reference_id JOIN json_each(t.sections_json) s
      ${db.whereSql(where)} ORDER BY t.created_at DESC, t.id DESC, s.key LIMIT ?`)
    .bind(...args, limit + 1)
    .all<db.Row>()
  const items = results.slice(0, limit).map((r): SectionItem => {
    const s = JSON.parse(r.section as string) as PageSection
    return {
      id: `${r.id}:${r.idx}`,
      pageId: r.id as string,
      referenceId: r.reference_id as string,
      index: r.idx as number,
      kind: s.kind,
      label: s.label,
      key: s.key,
      // Sections are cut from the desktop screenshot, which every page with sections has.
      width: (r.desktop_width as number) ?? 1440,
      height: s.height,
      path: r.path as string,
      url: r.url as string,
      reference: db.refSummary(r),
      createdAt: r.created_at as string,
    }
  })
  const last = items[items.length - 1]
  return { items, nextCursor: results.length > limit && last ? db.encodeCursor(last.createdAt, last.id) : null }
}

/** What each list endpoint would return in total for the same q and collection. */
async function typeCounts(database: D1Database, f: Pick<db.ListFilter, "q" | "collectionId">): Promise<LibraryTypeCounts> {
  const count = (sql: string, { where, args }: db.Where) => database.prepare(`${sql} ${db.whereSql(where)}`).bind(...args)
  const [websites, pages, animations, images] = await database.batch<{ n: number; sections: number }>([
    count(`SELECT count(*) AS n FROM refs r`, db.referenceWhere(f)),
    count(`SELECT count(*) AS n, coalesce(sum(json_array_length(t.sections_json)), 0) AS sections FROM pages t JOIN refs r ON r.id = t.reference_id`, db.childWhere("pages", f)),
    count(`SELECT count(*) AS n FROM animations t JOIN refs r ON r.id = t.reference_id`, db.childWhere("animations", f)),
    count(`SELECT count(*) AS n FROM images i`, imageWhere(f)),
  ])
  const n = (r: D1Result<{ n: number }> | undefined) => r?.results[0]?.n ?? 0
  return { websites: n(websites), pages: n(pages), sections: pages?.results[0]?.sections ?? 0, animations: n(animations), images: n(images) }
}

canvas.get("/sections", async (c) => c.json(await listSections(c.env.DB, feedFilter(c.req.query()))))
canvas.get("/counts", async (c) => {
  const { q, collectionId } = feedFilter(c.req.query())
  return c.json(await typeCounts(c.env.DB, { q, collectionId }))
})

// ---------- Boards ----------

const MAX_BOARD_ITEMS = 200
const MAX_GROUP_NAME = 120
const KINDS: readonly BoardItemKind[] = ["reference", "page", "image", "note"]
const coord = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 1e6
const extent = (v: unknown): v is number => coord(v) && v >= 1
const itemWidth = (v: unknown): v is number | null => v === null || (typeof v === "number" && v >= 40 && v <= 4000)
const groupId = (v: unknown): v is string | null => v === null || (typeof v === "string" && v.length > 0)
const itemRef = (v: unknown): v is { kind: BoardItemKind; id: string } =>
  !!v && typeof v === "object" && KINDS.includes((v as { kind: BoardItemKind }).kind) && typeof (v as { id: unknown }).id === "string"
const itemKey = (kind: string, itemId: string, pagePath: string) => `${kind}:${itemId}:${pagePath}`
// The look keys and what each may hold: numbers within [min, max], or booleans.
const STYLE_RANGES: Record<string, [number, number] | "flag"> = {
  rot: [-180, 180], op: [0, 1], round: [0, 40], blur: [0, 20],
  flip: "flag", crop: "flag", mask: "flag", outline: "flag", hidden: "flag", locked: "flag",
}
/** A style write: null clears it; anything but a plain object of known keys with in-range values is refused (undefined). */
function cleanStyle(v: unknown): BoardItemStyle | null | undefined {
  if (v === null) return null
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined
  const out: Record<string, number | boolean> = {}
  for (const [k, x] of Object.entries(v)) {
    const range = Object.hasOwn(STYLE_RANGES, k) ? STYLE_RANGES[k] : undefined // not inherited keys like "constructor"
    if (!range) return undefined
    if (range === "flag" ? typeof x !== "boolean" : typeof x !== "number" || !Number.isFinite(x) || x < range[0] || x > range[1]) return undefined
    out[k] = x as number | boolean
  }
  return out
}
const styleJson = (s: BoardItemStyle | null) => (s && Object.keys(s).length ? JSON.stringify(s) : null)
/**
 * The text column for an upsert from json_each rows `[kind, item_id, ...]` on board ?1. SQLite checks
 * CHECK before ON CONFLICT, so a note's candidate row carries its current text.
 */
const NOTE_TEXT = `CASE json_extract(value, '$[0]') WHEN 'note' THEN
  (SELECT n.text FROM board_items n WHERE n.collection_id = ?1 AND n.kind = 'note' AND n.item_id = json_extract(value, '$[1]')) END`

/** Whether (kind, item id, page path) is on board ?1. Resolving and writing share it, so a write places nothing that has just left the board. */
const onBoard = (kind: string, item: string, path: string) => `CASE ${kind}
  WHEN 'reference' THEN EXISTS (SELECT 1 FROM reference_collections WHERE collection_id = ?1 AND reference_id = ${item})
  WHEN 'page' THEN EXISTS (SELECT 1 FROM page_collections WHERE collection_id = ?1 AND reference_id = ${item} AND page_path = ${path})
  WHEN 'image' THEN EXISTS (SELECT 1 FROM image_collections WHERE collection_id = ?1 AND image_id = ${item})
  WHEN 'note' THEN EXISTS (SELECT 1 FROM board_items WHERE collection_id = ?1 AND kind = 'note' AND item_id = ${item})
END`
/** The same check for json_each rows `[kind, item_id, page_path, ...]`. */
const ROW_ON_BOARD = onBoard(`json_extract(value, '$[0]')`, `json_extract(value, '$[1]')`, `json_extract(value, '$[2]')`)

async function getBoard(database: D1Database, id: string): Promise<BoardCanvas | null> {
  const [board, placed, refs, pages, images, groups] = await database.batch<db.Row>([
    database.prepare(`${db.COLLECTION_SELECT} WHERE c.id = ?`).bind(id),
    database.prepare(`SELECT * FROM board_items WHERE collection_id = ?`).bind(id),
    database.prepare(`${db.REF_SELECT} WHERE r.id IN (SELECT reference_id FROM reference_collections WHERE collection_id = ?) ORDER BY r.created_at DESC, r.id DESC`).bind(id),
    // Saved pages point at (website, path); resolve them to the current page rows.
    database.prepare(`SELECT t.*, r.title AS ref_title, r.domain AS ref_domain, r.favicon AS ref_favicon, ${db.PAGE_COLLECTIONS} FROM page_collections pc
      JOIN pages t ON t.reference_id = pc.reference_id AND t.path = pc.page_path JOIN refs r ON r.id = t.reference_id
      WHERE pc.collection_id = ? ORDER BY pc.added_at DESC, t.id`).bind(id),
    database.prepare(`${IMAGE_SELECT} WHERE i.id IN (SELECT image_id FROM image_collections WHERE collection_id = ?) ORDER BY i.created_at DESC, i.id DESC`).bind(id),
    database.prepare(`SELECT id, name, x, y, w, h FROM board_groups WHERE collection_id = ? ORDER BY created_at, id`).bind(id),
  ])
  const row = board!.results[0]
  if (!row) return null
  const at = new Map(placed!.results.map((p) => [itemKey(p.kind as string, p.item_id as string, p.page_path as string), p]))
  const item = (kind: BoardItemKind, id: string, key: string): BoardItem => {
    const p = at.get(key)
    const style = db.parse<BoardItemStyle>(p?.style_json)
    return { kind, id, x: (p?.x as number) ?? null, y: (p?.y as number) ?? null, w: (p?.w as number) ?? null, groupId: (p?.group_id as string) ?? null, ...(style && { style }) }
  }
  return {
    collection: db.toCollection(row),
    items: [
      ...refs!.results.map((r) => ({ ...item("reference", r.id as string, itemKey("reference", r.id as string, "")), reference: db.toReference(r) })),
      ...pages!.results.map((r) => ({
        ...item("page", r.id as string, itemKey("page", r.reference_id as string, r.path as string)),
        page: { ...db.toPage(r), reference: db.refSummary(r) },
      })),
      ...images!.results.map((r) => ({ ...item("image", r.id as string, itemKey("image", r.id as string, "")), image: toImage(r) })),
      ...placed!.results.filter((p) => p.kind === "note").map((p) => ({ ...item("note", p.item_id as string, itemKey("note", p.item_id as string, "")), text: p.text as string })),
    ],
    groups: groups!.results as unknown as BoardGroup[],
  }
}

/**
 * Which of these items are on the board now, keyed `${kind}:${id}`, with the row each one's
 * position uses (pages: their website and path) and its stored width and group. Also whether
 * the board exists and its group ids.
 */
async function resolveItems(database: D1Database, boardId: string, items: { kind: BoardItemKind; id: string }[]) {
  const [board, members, groups] = await database.batch<db.Row>([
    database.prepare(`SELECT 1 FROM collections WHERE id = ?`).bind(boardId),
    database
      .prepare(`WITH input AS (
          SELECT DISTINCT json_extract(value, '$.kind') AS kind, json_extract(value, '$.id') AS id FROM json_each(?2)
        ), resolved AS (
          SELECT input.kind, input.id, CASE input.kind WHEN 'page' THEN p.reference_id ELSE input.id END AS item_id, coalesce(p.path, '') AS page_path
          FROM input LEFT JOIN pages p ON input.kind = 'page' AND p.id = input.id
          WHERE ${onBoard("input.kind", "coalesce(p.reference_id, input.id)", "p.path")}
        )
        SELECT resolved.*, b.w, b.group_id, b.style_json FROM resolved LEFT JOIN board_items b
          ON b.collection_id = ?1 AND b.kind = resolved.kind AND b.item_id = resolved.item_id AND b.page_path = resolved.page_path`)
      .bind(boardId, JSON.stringify(items.map(({ kind, id }) => ({ kind, id })))),
    database.prepare(`SELECT id FROM board_groups WHERE collection_id = ?`).bind(boardId),
  ])
  return {
    exists: board!.results.length > 0,
    members: new Map(members!.results.map((m) => [`${m.kind}:${m.id}`, m])),
    groups: new Set(groups!.results.map((g) => g.id as string)),
  }
}

const unknownItems = (members: Map<string, db.Row>, items: { kind: string; id: string }[]) => {
  const unknown = items.filter((i) => !members.has(`${i.kind}:${i.id}`))
  return unknown.length ? `Not on this board: ${unknown.map((i) => `${i.kind} ${i.id}`).join(", ")}` : null
}

canvas.get("/boards/:id", async (c) => {
  const board = await getBoard(c.env.DB, c.req.param("id"))
  return board ? c.json(board) : missing(c)
})

// Positions for up to 200 items at once. Every item must be on the board, or nothing is saved.
canvas.put("/boards/:id/items", async (c) => {
  const { items } = await jsonBody(c)
  if (!Array.isArray(items)) return bad(c, "items is required")
  if (items.length > MAX_BOARD_ITEMS) return bad(c, `At most ${MAX_BOARD_ITEMS} items at a time`)
  for (const p of items) {
    if (!itemRef(p)) return bad(c, "Each item needs a kind and an id")
    const { x, y, w, groupId: g, style } = p as Record<string, unknown>
    if (!coord(x) || !coord(y)) return bad(c, "x and y must be numbers within 1,000,000 of the origin")
    if (w !== undefined && !itemWidth(w)) return bad(c, "w must be null or from 40 to 4000")
    if (g !== undefined && !groupId(g)) return bad(c, "groupId must be a group id or null")
    if (style !== undefined && cleanStyle(style) === undefined) {
      return bad(c, "style must be null or an object of rot (-180..180), op (0..1), round (0..40), blur (0..20) and flip, crop, mask, outline, hidden, locked (true/false)")
    }
  }
  const placements = items as { kind: BoardItemKind; id: string; x: number; y: number; w?: number | null; groupId?: string | null; style?: unknown }[]
  const boardId = c.req.param("id")
  const { exists, members, groups } = await resolveItems(c.env.DB, boardId, placements)
  if (!exists) return missing(c)
  const unknown = unknownItems(members, placements)
  if (unknown) return bad(c, unknown)
  if (placements.some((p) => p.groupId && !groups.has(p.groupId))) return bad(c, "groupId is not a group on this board")
  if (!placements.length) return c.json({ ok: true })
  // Omitted width, group and style keep what is stored.
  const rows = placements.map((p) => {
    const m = members.get(`${p.kind}:${p.id}`)!
    const style = p.style === undefined ? m.style_json : styleJson(cleanStyle(p.style)!)
    return [p.kind, m.item_id, m.page_path, p.x, p.y, p.w === undefined ? m.w : p.w, p.groupId === undefined ? m.group_id : p.groupId, style]
  })
  await c.env.DB.prepare(`INSERT INTO board_items (collection_id, kind, item_id, page_path, x, y, w, group_id, style_json, text, updated_at)
      SELECT ?1, json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'),
        json_extract(value, '$[4]'), json_extract(value, '$[5]'), json_extract(value, '$[6]'), json_extract(value, '$[7]'), ${NOTE_TEXT}, ?2 FROM json_each(?3) WHERE ${ROW_ON_BOARD}
      ON CONFLICT (collection_id, kind, item_id, page_path) DO UPDATE SET x = excluded.x, y = excluded.y, w = excluded.w,
        group_id = excluded.group_id, style_json = excluded.style_json, updated_at = excluded.updated_at`)
    .bind(boardId, db.now(), JSON.stringify(rows))
    .run()
  return c.json({ ok: true })
})

// ---------- Notes (exist only on their board) ----------

const noteText = (v: unknown): v is string => typeof v === "string" && v.length <= db.MAX_NOTES

canvas.post("/boards/:id/notes", async (c) => {
  const { text, x, y, w = null, groupId: g = null } = await jsonBody(c)
  if (!noteText(text)) return bad(c, `text is required, at most ${db.MAX_NOTES} characters`)
  if (!coord(x) || !coord(y)) return bad(c, "x and y must be numbers within 1,000,000 of the origin")
  if (!itemWidth(w)) return bad(c, "w must be null or from 40 to 4000")
  if (!groupId(g)) return bad(c, "groupId must be a group id or null")
  const boardId = c.req.param("id")
  const found = await c.env.DB.prepare(`SELECT EXISTS (SELECT 1 FROM collections WHERE id = ?1) AS board, EXISTS (SELECT 1 FROM board_groups WHERE id = ?2 AND collection_id = ?1) AS grp`)
    .bind(boardId, g)
    .first<{ board: number; grp: number }>()
  if (!found?.board) return missing(c)
  if (g && !found.grp) return bad(c, "groupId is not a group on this board")
  const id = db.newId()
  await c.env.DB.prepare(`INSERT INTO board_items (collection_id, kind, item_id, x, y, w, group_id, text, updated_at) VALUES (?, 'note', ?, ?, ?, ?, ?, ?, ?)`)
    .bind(boardId, id, x, y, w, g, text, db.now())
    .run()
  return c.json({ kind: "note", id, x, y, w, groupId: g, text } satisfies BoardItem, 201)
})

canvas.patch("/boards/:id/notes/:noteId", async (c) => {
  const { text } = await jsonBody(c)
  if (!noteText(text)) return bad(c, `text is required, at most ${db.MAX_NOTES} characters`)
  const result = await c.env.DB.prepare(`UPDATE board_items SET text = ?, updated_at = ? WHERE collection_id = ? AND kind = 'note' AND item_id = ?`)
    .bind(text, db.now(), c.req.param("id"), c.req.param("noteId"))
    .run()
  return result.meta.changes ? c.json({ ok: true }) : missing(c, "note")
})

canvas.delete("/boards/:id/notes/:noteId", async (c) => {
  const result = await c.env.DB.prepare(`DELETE FROM board_items WHERE collection_id = ? AND kind = 'note' AND item_id = ?`).bind(c.req.param("id"), c.req.param("noteId")).run()
  return result.meta.changes ? c.json({ ok: true }) : missing(c, "note")
})

// ---------- Groups ----------

const groupName = (v: unknown): v is string => typeof v === "string" && v.trim().length <= MAX_GROUP_NAME

canvas.post("/boards/:id/groups", async (c) => {
  const { name, x, y, w, h, items = [] } = await jsonBody(c)
  if (!groupName(name)) return bad(c, `name is required, at most ${MAX_GROUP_NAME} characters`)
  if (!coord(x) || !coord(y)) return bad(c, "x and y must be numbers within 1,000,000 of the origin")
  if (!extent(w) || !extent(h)) return bad(c, "w and h must be positive numbers")
  if (!Array.isArray(items) || items.length > MAX_BOARD_ITEMS || !items.every(itemRef)) return bad(c, `items must be at most ${MAX_BOARD_ITEMS} { kind, id }`)
  const boardId = c.req.param("id")
  const { exists, members } = await resolveItems(c.env.DB, boardId, items)
  if (!exists) return missing(c)
  const unknown = unknownItems(members, items)
  if (unknown) return bad(c, unknown)
  const group: BoardGroup = { id: db.newId(), name: name.trim(), x, y, w, h }
  const ts = db.now()
  const rows = items.map((i) => {
    const m = members.get(`${i.kind}:${i.id}`)!
    return [i.kind, m.item_id, m.page_path]
  })
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO board_groups (id, collection_id, name, x, y, w, h, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(group.id, boardId, group.name, x, y, w, h, ts),
    // Members not placed yet start at the group's corner.
    c.env.DB.prepare(`INSERT INTO board_items (collection_id, kind, item_id, page_path, x, y, group_id, text, updated_at)
        SELECT ?1, json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), ?2, ?3, ?4, ${NOTE_TEXT}, ?5 FROM json_each(?6) WHERE ${ROW_ON_BOARD}
        ON CONFLICT (collection_id, kind, item_id, page_path) DO UPDATE SET group_id = excluded.group_id, updated_at = excluded.updated_at`)
      .bind(boardId, x, y, group.id, ts, JSON.stringify(rows)),
  ])
  return c.json(group, 201)
})

canvas.patch("/boards/:id/groups/:groupId", async (c) => {
  const body = await jsonBody(c)
  const set: string[] = []
  const args: unknown[] = []
  if ("name" in body) {
    if (!groupName(body.name)) return bad(c, `name must be at most ${MAX_GROUP_NAME} characters`)
    set.push("name = ?")
    args.push(body.name.trim())
  }
  for (const k of ["x", "y", "w", "h"] as const) {
    if (!(k in body)) continue
    if (!(k === "x" || k === "y" ? coord : extent)(body[k])) return bad(c, `${k} is out of range`)
    set.push(`${k} = ?`)
    args.push(body[k])
  }
  if (!set.length) return bad(c, "Nothing to change")
  const result = await c.env.DB.prepare(`UPDATE board_groups SET ${set.join(", ")} WHERE id = ? AND collection_id = ?`)
    .bind(...args, c.req.param("groupId"), c.req.param("id"))
    .run()
  return result.meta.changes ? c.json({ ok: true }) : missing(c, "group")
})

// Its items stay where they are: the foreign key sets their group_id to null.
canvas.delete("/boards/:id/groups/:groupId", async (c) => {
  const result = await c.env.DB.prepare(`DELETE FROM board_groups WHERE id = ? AND collection_id = ?`).bind(c.req.param("groupId"), c.req.param("id")).run()
  return result.meta.changes ? c.json({ ok: true }) : missing(c, "group")
})
