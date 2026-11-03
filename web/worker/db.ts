import type {
  Animation,
  CaptureMode,
  Collection,
  DesignTokens,
  Job,
  JobComplete,
  Page,
  PageUpload,
  Paged,
  Reference,
} from "../shared/types"

// Data access shared by the HTTP API and the MCP server.

const now = () => new Date().toISOString()
export const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 16)

const parse = <T>(s: unknown): T | null => {
  if (typeof s !== "string" || !s) return null
  try {
    return JSON.parse(s) as T
  } catch {
    return null
  }
}

type Row = Record<string, unknown>

function toReference(r: Row): Reference {
  return {
    id: r.id as string,
    url: r.url as string,
    domain: r.domain as string,
    title: (r.title as string) ?? null,
    description: (r.description as string) ?? null,
    favicon: (r.favicon as string) ?? null,
    mode: r.mode as CaptureMode,
    maxPages: r.max_pages as number,
    status: r.status as Reference["status"],
    progress: (r.progress as string) ?? null,
    error: (r.error as string) ?? null,
    coverKey: (r.cover_key as string) ?? null,
    previewKeys: r.preview_keys ? String(r.preview_keys).split("|") : [],
    pageCount: r.page_count as number,
    animationCount: r.animation_count as number,
    tokens: parse<DesignTokens>(r.tokens_json),
    collectionIds: r.collection_ids ? String(r.collection_ids).split(",") : [],
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  }
}

function toPage(r: Row): Page {
  return {
    id: r.id as string,
    referenceId: r.reference_id as string,
    url: r.url as string,
    path: r.path as string,
    title: (r.title as string) ?? null,
    ord: r.ord as number,
    desktopKey: (r.desktop_key as string) ?? null,
    desktopThumbKey: (r.desktop_thumb_key as string) ?? null,
    desktopWidth: (r.desktop_width as number) ?? null,
    desktopHeight: (r.desktop_height as number) ?? null,
    mobileKey: (r.mobile_key as string) ?? null,
    mobileThumbKey: (r.mobile_thumb_key as string) ?? null,
    mobileWidth: (r.mobile_width as number) ?? null,
    mobileHeight: (r.mobile_height as number) ?? null,
    snapshotKey: (r.snapshot_key as string) ?? null,
    stylesKey: (r.styles_key as string) ?? null,
    tokens: parse<DesignTokens>(r.tokens_json),
    createdAt: r.created_at as string,
  }
}

function toAnimation(r: Row): Animation {
  return {
    id: r.id as string,
    referenceId: r.reference_id as string,
    pageId: (r.page_id as string) ?? null,
    kind: r.kind as Animation["kind"],
    label: (r.label as string) ?? null,
    selector: (r.selector as string) ?? null,
    viewport: r.viewport as Animation["viewport"],
    gifKey: r.gif_key as string,
    width: r.width as number,
    height: r.height as number,
    createdAt: r.created_at as string,
  }
}

// Cursor = base64("<sortValue>|<id>")
const encodeCursor = (v: string | number, id: string) => btoa(`${v}|${id}`)
const decodeCursor = (c?: string | null): [string, string] | null => {
  if (!c) return null
  try {
    const s = atob(c)
    const i = s.lastIndexOf("|")
    return [s.slice(0, i), s.slice(i + 1)]
  } catch {
    return null
  }
}

export type SortOrder = "newest" | "oldest" | "name"

export interface ListFilter {
  q?: string
  collectionId?: string
  domain?: string
  status?: string
  sort?: SortOrder
  limit?: number
  cursor?: string | null
}

const REF_SELECT = `SELECT r.*, (SELECT group_concat(collection_id) FROM reference_collections rc WHERE rc.reference_id = r.id) AS collection_ids,
  (SELECT group_concat(k, '|') FROM (SELECT coalesce(p.desktop_thumb_key, p.mobile_thumb_key) AS k FROM pages p
    WHERE p.reference_id = r.id AND coalesce(p.desktop_thumb_key, p.mobile_thumb_key) IS NOT NULL ORDER BY p.ord LIMIT 3)) AS preview_keys
  FROM refs r`

export async function listReferences(db: D1Database, f: ListFilter): Promise<Paged<Reference>> {
  const limit = Math.min(Math.max(f.limit ?? 24, 1), 100)
  const where: string[] = []
  const args: unknown[] = []
  if (f.q) {
    where.push(`(r.title LIKE ? OR r.url LIKE ? OR r.description LIKE ?)`)
    const like = `%${f.q}%`
    args.push(like, like, like)
  }
  if (f.collectionId) {
    where.push(`EXISTS (SELECT 1 FROM reference_collections rc WHERE rc.reference_id = r.id AND rc.collection_id = ?)`)
    args.push(f.collectionId)
  }
  if (f.domain) {
    where.push(`r.domain = ?`)
    args.push(f.domain)
  }
  if (f.status) {
    where.push(`r.status = ?`)
    args.push(f.status)
  }
  const sort = f.sort ?? "newest"
  const cur = decodeCursor(f.cursor)
  let order: string
  if (sort === "name") {
    order = `ORDER BY lower(coalesce(r.title, r.domain)) ASC, r.id ASC`
    if (cur) {
      where.push(`(lower(coalesce(r.title, r.domain)) > ? OR (lower(coalesce(r.title, r.domain)) = ? AND r.id > ?))`)
      args.push(cur[0], cur[0], cur[1])
    }
  } else if (sort === "oldest") {
    order = `ORDER BY r.created_at ASC, r.id ASC`
    if (cur) {
      where.push(`(r.created_at > ? OR (r.created_at = ? AND r.id > ?))`)
      args.push(cur[0], cur[0], cur[1])
    }
  } else {
    order = `ORDER BY r.created_at DESC, r.id DESC`
    if (cur) {
      where.push(`(r.created_at < ? OR (r.created_at = ? AND r.id < ?))`)
      args.push(cur[0], cur[0], cur[1])
    }
  }
  const sql = `${REF_SELECT} ${where.length ? "WHERE " + where.join(" AND ") : ""} ${order} LIMIT ?`
  const { results } = await db.prepare(sql).bind(...args, limit + 1).all<Row>()
  const rows = results.slice(0, limit).map(toReference)
  const last = rows[rows.length - 1]
  const nextCursor =
    results.length > limit && last
      ? encodeCursor(sort === "name" ? (last.title ?? last.domain).toLowerCase() : last.createdAt, last.id)
      : null
  return { items: rows, nextCursor }
}

export async function getReference(db: D1Database, id: string) {
  const r = await db.prepare(`${REF_SELECT} WHERE r.id = ?`).bind(id).first<Row>()
  if (!r) return null
  const [pages, anims] = await Promise.all([
    db.prepare(`SELECT * FROM pages WHERE reference_id = ? ORDER BY ord, created_at`).bind(id).all<Row>(),
    db.prepare(`SELECT * FROM animations WHERE reference_id = ? ORDER BY created_at`).bind(id).all<Row>(),
  ])
  return {
    reference: toReference(r),
    pages: pages.results.map(toPage),
    animations: anims.results.map(toAnimation),
  }
}

export async function getPage(db: D1Database, id: string) {
  const r = await db.prepare(`SELECT * FROM pages WHERE id = ?`).bind(id).first<Row>()
  return r ? toPage(r) : null
}

// Cross-reference feeds for the "Pages" and "Animations" gallery views.
async function listChildren<T>(
  db: D1Database,
  table: "pages" | "animations",
  map: (r: Row) => T,
  f: ListFilter,
): Promise<Paged<T & { reference: { id: string; title: string | null; domain: string } }>> {
  const limit = Math.min(Math.max(f.limit ?? 24, 1), 100)
  const where: string[] = []
  const args: unknown[] = []
  if (f.q) {
    where.push(`(r.title LIKE ? OR r.url LIKE ? ${table === "pages" ? "OR t.title LIKE ? OR t.path LIKE ?" : "OR t.label LIKE ?"})`)
    const like = `%${f.q}%`
    args.push(like, like, like)
    if (table === "pages") args.push(like)
  }
  if (f.collectionId) {
    where.push(`EXISTS (SELECT 1 FROM reference_collections rc WHERE rc.reference_id = t.reference_id AND rc.collection_id = ?)`)
    args.push(f.collectionId)
  }
  const asc = f.sort === "oldest"
  const cur = decodeCursor(f.cursor)
  if (cur) {
    where.push(asc ? `(t.created_at > ? OR (t.created_at = ? AND t.id > ?))` : `(t.created_at < ? OR (t.created_at = ? AND t.id < ?))`)
    args.push(cur[0], cur[0], cur[1])
  }
  const dir = asc ? "ASC" : "DESC"
  const sql = `SELECT t.*, r.title AS ref_title, r.domain AS ref_domain FROM ${table} t JOIN refs r ON r.id = t.reference_id ${
    where.length ? "WHERE " + where.join(" AND ") : ""
  } ORDER BY t.created_at ${dir}, t.id ${dir} LIMIT ?`
  const { results } = await db.prepare(sql).bind(...args, limit + 1).all<Row>()
  const page = results.slice(0, limit)
  const items = page.map((r) => ({
    ...map(r),
    reference: { id: r.reference_id as string, title: (r.ref_title as string) ?? null, domain: r.ref_domain as string },
  }))
  const last = page[page.length - 1]
  return {
    items,
    nextCursor: results.length > limit && last ? encodeCursor(last.created_at as string, last.id as string) : null,
  }
}

export const listPages = (db: D1Database, f: ListFilter) => listChildren(db, "pages", toPage, f)
export const listAnimations = (db: D1Database, f: ListFilter) => listChildren(db, "animations", toAnimation, f)

export function normalizeUrl(input: string): URL {
  const raw = input.trim()
  const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http(s) URLs are supported")
  url.hash = ""
  return url
}

export async function createReference(
  db: D1Database,
  input: { url: string; mode: CaptureMode; maxPages?: number; collectionIds?: string[] },
): Promise<Reference> {
  const url = normalizeUrl(input.url)
  const id = newId()
  const ts = now()
  const maxPages = input.mode === "single" ? 1 : Math.min(Math.max(input.maxPages ?? 25, 1), 200)
  const stmts = [
    db
      .prepare(
        `INSERT INTO refs (id, url, domain, mode, max_pages, status, progress, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'queued', 'Waiting for the capture agent', ?, ?)`,
      )
      .bind(id, url.toString(), url.hostname.replace(/^www\./, ""), input.mode, maxPages, ts, ts),
  ]
  for (const cid of input.collectionIds ?? []) {
    stmts.push(
      db.prepare(`INSERT OR IGNORE INTO reference_collections (reference_id, collection_id, added_at) SELECT ?, id, ? FROM collections WHERE id = ?`).bind(id, ts, cid),
    )
  }
  await db.batch(stmts)
  return (await getReference(db, id))!.reference
}

export async function requeueReference(db: D1Database, id: string) {
  await db.batch([
    db.prepare(`DELETE FROM pages WHERE reference_id = ?`).bind(id),
    db.prepare(`DELETE FROM animations WHERE reference_id = ?`).bind(id),
    db
      .prepare(
        `UPDATE refs SET status = 'queued', progress = 'Waiting for the capture agent', error = NULL, page_count = 0, animation_count = 0, claimed_at = NULL, updated_at = ? WHERE id = ?`,
      )
      .bind(now(), id),
  ])
}

export async function deleteReference(db: D1Database, files: R2Bucket, id: string) {
  await db.batch([
    db.prepare(`DELETE FROM animations WHERE reference_id = ?`).bind(id),
    db.prepare(`DELETE FROM pages WHERE reference_id = ?`).bind(id),
    db.prepare(`DELETE FROM reference_collections WHERE reference_id = ?`).bind(id),
    db.prepare(`DELETE FROM refs WHERE id = ?`).bind(id),
  ])
  await deletePrefix(files, `refs/${id}/`)
}

export async function deletePrefix(files: R2Bucket, prefix: string) {
  let cursor: string | undefined
  do {
    const list = await files.list({ prefix, cursor })
    if (list.objects.length) await files.delete(list.objects.map((o) => o.key))
    cursor = list.truncated ? list.cursor : undefined
  } while (cursor)
}

// Collections

export async function listCollections(db: D1Database): Promise<Collection[]> {
  const { results } = await db
    .prepare(
      `SELECT c.*, (SELECT count(*) FROM reference_collections rc WHERE rc.collection_id = c.id) AS reference_count,
        (SELECT group_concat(cover_key, '|') FROM (SELECT r.cover_key FROM reference_collections rc JOIN refs r ON r.id = rc.reference_id
          WHERE rc.collection_id = c.id AND r.cover_key IS NOT NULL ORDER BY rc.added_at DESC LIMIT 3)) AS cover_keys
      FROM collections c ORDER BY lower(c.name)`,
    )
    .all<Row>()
  return results.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    description: (r.description as string) ?? null,
    referenceCount: r.reference_count as number,
    coverKeys: r.cover_keys ? String(r.cover_keys).split("|") : [],
    createdAt: r.created_at as string,
  }))
}

export async function createCollection(db: D1Database, name: string, description?: string | null) {
  const id = newId()
  await db.prepare(`INSERT INTO collections (id, name, description, created_at) VALUES (?, ?, ?, ?)`).bind(id, name.trim(), description ?? null, now()).run()
  return id
}

export async function updateCollection(db: D1Database, id: string, name: string, description?: string | null) {
  await db.prepare(`UPDATE collections SET name = ?, description = ? WHERE id = ?`).bind(name.trim(), description ?? null, id).run()
}

export async function deleteCollection(db: D1Database, id: string) {
  await db.batch([
    db.prepare(`DELETE FROM reference_collections WHERE collection_id = ?`).bind(id),
    db.prepare(`DELETE FROM collections WHERE id = ?`).bind(id),
  ])
}

export async function setReferenceCollection(db: D1Database, referenceId: string, collectionId: string, member: boolean) {
  if (member) {
    await db
      .prepare(`INSERT OR IGNORE INTO reference_collections (reference_id, collection_id, added_at) VALUES (?, ?, ?)`)
      .bind(referenceId, collectionId, now())
      .run()
  } else {
    await db.prepare(`DELETE FROM reference_collections WHERE reference_id = ? AND collection_id = ?`).bind(referenceId, collectionId).run()
  }
}

// Capture queue

const STALE_MINUTES = 30

export async function claimJob(db: D1Database): Promise<Job | null> {
  const stale = new Date(Date.now() - STALE_MINUTES * 60_000).toISOString()
  const ts = now()
  const r = await db
    .prepare(
      `UPDATE refs SET status = 'capturing', claimed_at = ?, updated_at = ?, progress = 'Starting capture'
       WHERE id = (
         SELECT id FROM refs
         WHERE status = 'queued' OR (status = 'capturing' AND claimed_at < ?)
         ORDER BY created_at LIMIT 1
       )
       RETURNING id, url, mode, max_pages`,
    )
    .bind(ts, ts, stale)
    .first<Row>()
  if (!r) return null
  // A reclaimed stale job starts over.
  await db.batch([
    db.prepare(`DELETE FROM animations WHERE reference_id = ?`).bind(r.id),
    db.prepare(`DELETE FROM pages WHERE reference_id = ?`).bind(r.id),
  ])
  return { id: r.id as string, url: r.url as string, mode: r.mode as CaptureMode, maxPages: r.max_pages as number }
}

export async function setProgress(db: D1Database, id: string, progress: string) {
  await db.prepare(`UPDATE refs SET progress = ?, claimed_at = ?, updated_at = ? WHERE id = ? AND status = 'capturing'`).bind(progress.slice(0, 300), now(), now(), id).run()
}

export async function addPage(db: D1Database, referenceId: string, p: PageUpload) {
  const pageId = newId()
  const ts = now()
  const stmts = [
    db
      .prepare(
        `INSERT INTO pages (id, reference_id, url, path, title, ord, desktop_key, desktop_thumb_key, desktop_width, desktop_height,
          mobile_key, mobile_thumb_key, mobile_width, mobile_height, snapshot_key, styles_key, tokens_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        pageId, referenceId, p.url, p.path, p.title, p.ord,
        p.desktopKey, p.desktopThumbKey, p.desktopWidth, p.desktopHeight,
        p.mobileKey, p.mobileThumbKey, p.mobileWidth, p.mobileHeight,
        p.snapshotKey, p.stylesKey, p.tokens ? JSON.stringify(p.tokens) : null, ts,
      ),
  ]
  for (const a of p.animations) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO animations (id, reference_id, page_id, kind, label, selector, viewport, gif_key, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(newId(), referenceId, pageId, a.kind, a.label, a.selector, a.viewport, a.gifKey, a.width, a.height, ts),
    )
  }
  stmts.push(
    db
      .prepare(
        `UPDATE refs SET page_count = (SELECT count(*) FROM pages WHERE reference_id = ?1),
          animation_count = (SELECT count(*) FROM animations WHERE reference_id = ?1),
          cover_key = coalesce(cover_key, ?2), updated_at = ?3 WHERE id = ?1`,
      )
      .bind(referenceId, p.desktopThumbKey, ts),
  )
  await db.batch(stmts)
  return pageId
}

export async function completeJob(db: D1Database, id: string, c: JobComplete) {
  await db
    .prepare(
      `UPDATE refs SET status = 'ready', progress = NULL, error = NULL, title = coalesce(?, title), description = coalesce(?, description),
        favicon = coalesce(?, favicon), cover_key = coalesce(?, cover_key), tokens_json = ?, updated_at = ? WHERE id = ?`,
    )
    .bind(c.title, c.description, c.favicon, c.coverKey, c.tokens ? JSON.stringify(c.tokens) : null, now(), id)
    .run()
}

export async function failJob(db: D1Database, id: string, error: string) {
  await db.prepare(`UPDATE refs SET status = 'failed', progress = NULL, error = ?, updated_at = ? WHERE id = ?`).bind(error.slice(0, 1000), now(), id).run()
}
