import {
  type AgentPresence,
  type Animation,
  type AnimationMeta,
  type CaptureControl,
  type CaptureMode,
  type CaptureOptions,
  type CaptureStatus,
  type Collection,
  type CrawlState,
  DESKTOP_WIDTHS,
  type DesignTokens,
  type Job,
  type JobComplete,
  type Page,
  type PageUpload,
  type Paged,
  type Reference,
  type StorageUsage,
} from "../shared/types"
import { STOPPED_EMPTY } from "../shared/capture-errors"

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
    status: r.capture_control === "paused" ? "paused" : (r.status as Reference["status"]),
    control: r.status === "capturing" && (r.capture_control === "pause" || r.capture_control === "stop") ? (r.capture_control as CaptureControl) : null,
    progress: (r.progress as string) ?? null,
    error: (r.error as string) ?? null,
    coverKey: (r.cover_key as string) ?? null,
    previewKeys: r.preview_keys ? String(r.preview_keys).split("|") : [],
    pageCount: r.page_count as number,
    animationCount: r.animation_count as number,
    tokens: parse<DesignTokens>(r.tokens_json),
    collectionIds: r.collection_ids ? String(r.collection_ids).split(",") : [],
    notes: (r.notes as string) ?? null,
    options: parse<CaptureOptions>(r.capture_options),
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    claimedAt: (r.claimed_at as string) ?? null,
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
    collectionIds: r.collection_ids ? String(r.collection_ids).split(",") : [],
    createdAt: r.created_at as string,
  }
}

/** Selects a page row plus the collections it was saved to individually. Alias the pages table as `t`. */
const PAGE_COLLECTIONS = `(SELECT group_concat(pc.collection_id) FROM page_collections pc WHERE pc.reference_id = t.reference_id AND pc.page_path = t.path) AS collection_ids`

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
    sheetKey: (r.sheet_key as string) ?? null,
    meta: parse<AnimationMeta>(r.meta_json),
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
    where.push(`(r.title LIKE ? OR r.url LIKE ? OR r.description LIKE ? OR r.notes LIKE ?)`)
    const like = `%${f.q}%`
    args.push(like, like, like, like)
  }
  if (f.collectionId) {
    where.push(`EXISTS (SELECT 1 FROM reference_collections rc WHERE rc.reference_id = r.id AND rc.collection_id = ?)`)
    args.push(f.collectionId)
  }
  if (f.domain) {
    where.push(`r.domain = ?`)
    args.push(f.domain)
  }
  if (f.status === "paused") where.push(`r.capture_control = 'paused'`)
  else if (f.status) {
    where.push(`r.status = ? AND coalesce(r.capture_control, '') != 'paused'`)
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

export async function getReferenceRecord(db: D1Database, id: string) {
  const r = await db.prepare(`${REF_SELECT} WHERE r.id = ?`).bind(id).first<Row>()
  return r ? toReference(r) : null
}

export async function getReference(db: D1Database, id: string) {
  const r = await getReferenceRecord(db, id)
  if (!r) return null
  const [pages, anims] = await Promise.all([
    db.prepare(`SELECT t.*, ${PAGE_COLLECTIONS} FROM pages t WHERE t.reference_id = ? ORDER BY t.ord, t.created_at`).bind(id).all<Row>(),
    db.prepare(`SELECT * FROM animations WHERE reference_id = ? ORDER BY created_at`).bind(id).all<Row>(),
  ])
  return {
    reference: r,
    pages: pages.results.map(toPage),
    animations: anims.results.map(toAnimation),
  }
}

export async function getAnimation(db: D1Database, id: string) {
  const r = await db.prepare(`SELECT * FROM animations WHERE id = ?`).bind(id).first<Row>()
  return r ? toAnimation(r) : null
}

export async function getPage(db: D1Database, id: string) {
  const r = await db.prepare(`SELECT t.*, ${PAGE_COLLECTIONS} FROM pages t WHERE t.id = ?`).bind(id).first<Row>()
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
    // In a collection: everything from websites saved whole, plus pages saved on their own
    // (and, for animations, the motion captured on those pages).
    const pinned =
      table === "pages"
        ? `EXISTS (SELECT 1 FROM page_collections pc WHERE pc.reference_id = t.reference_id AND pc.page_path = t.path AND pc.collection_id = ?)`
        : `EXISTS (SELECT 1 FROM pages p JOIN page_collections pc ON pc.reference_id = p.reference_id AND pc.page_path = p.path WHERE p.id = t.page_id AND pc.collection_id = ?)`
    where.push(`(EXISTS (SELECT 1 FROM reference_collections rc WHERE rc.reference_id = t.reference_id AND rc.collection_id = ?) OR ${pinned})`)
    args.push(f.collectionId, f.collectionId)
  }
  const asc = f.sort === "oldest"
  const cur = decodeCursor(f.cursor)
  if (cur) {
    where.push(asc ? `(t.created_at > ? OR (t.created_at = ? AND t.id > ?))` : `(t.created_at < ? OR (t.created_at = ? AND t.id < ?))`)
    args.push(cur[0], cur[0], cur[1])
  }
  const dir = asc ? "ASC" : "DESC"
  const sql = `SELECT t.*, r.title AS ref_title, r.domain AS ref_domain${table === "pages" ? `, ${PAGE_COLLECTIONS}` : ""} FROM ${table} t JOIN refs r ON r.id = t.reference_id ${
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

export const MAX_NOTES = 2000

/** Keeps only known options with valid values; null when nothing differs from the defaults. */
export function cleanOptions(input: unknown): CaptureOptions | null {
  if (!input || typeof input !== "object") return null
  const o = input as Record<string, unknown>
  const out: CaptureOptions = {}
  if (o.colorScheme === "dark") out.colorScheme = "dark"
  if (typeof o.desktopWidth === "number" && (DESKTOP_WIDTHS as readonly number[]).includes(o.desktopWidth) && o.desktopWidth !== 1440) out.desktopWidth = o.desktopWidth
  if (o.signedIn === true) out.signedIn = true
  return Object.keys(out).length ? out : null
}

const cleanNotes = (notes: unknown) => (typeof notes === "string" && notes.trim() ? notes.trim().slice(0, MAX_NOTES) : null)

/** The most recent reference already saved for this URL, if any. */
export async function findReferenceByUrl(db: D1Database, input: string): Promise<Reference | null> {
  const url = normalizeUrl(input).toString()
  const r = await db.prepare(`${REF_SELECT} WHERE r.url = ? ORDER BY r.created_at DESC LIMIT 1`).bind(url).first<Row>()
  return r ? toReference(r) : null
}

export async function setNotes(db: D1Database, id: string, notes: unknown) {
  const result = await db.prepare(`UPDATE refs SET notes = ?, updated_at = ? WHERE id = ?`).bind(cleanNotes(notes), now(), id).run()
  return result.meta.changes > 0
}

export async function createReference(
  db: D1Database,
  input: { url: string; mode: CaptureMode; maxPages?: number; collectionIds?: string[]; notes?: string | null; options?: CaptureOptions | null },
): Promise<Reference> {
  const url = normalizeUrl(input.url)
  const id = newId()
  const ts = now()
  const maxPages = input.mode === "single" ? 1 : Math.min(Math.max(input.maxPages ?? 25, 1), 200)
  const options = cleanOptions(input.options)
  const stmts = [
    db
      .prepare(
        `INSERT INTO refs (id, url, domain, mode, max_pages, status, progress, notes, capture_options, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'queued', 'Waiting for your Mac', ?, ?, ?, ?)`,
      )
      .bind(id, url.toString(), url.hostname.replace(/^www\./, ""), input.mode, maxPages, cleanNotes(input.notes), options ? JSON.stringify(options) : null, ts, ts),
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
    db.prepare(`INSERT OR IGNORE INTO capture_cleanup (prefix) SELECT 'refs/' || id || '/' || coalesce(capture_attempt || '/', 'p') FROM refs WHERE id = ?`).bind(id),
    db.prepare(`DELETE FROM pages WHERE reference_id = ?`).bind(id), // animations cascade
    db
      .prepare(
        `UPDATE refs SET status = 'queued', progress = 'Waiting for your Mac', error = NULL, page_count = 0, animation_count = 0, cover_key = NULL, tokens_json = NULL, claimed_at = NULL, capture_control = NULL, crawl_state = NULL, updated_at = ? WHERE id = ?`,
      )
      .bind(now(), id),
  ])
}

export async function deleteReference(db: D1Database, id: string) {
  // Keep a retryable tombstone even if storage deletion fails after the database delete.
  const prefix = `refs/${id}/`
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO capture_cleanup (prefix) SELECT ? FROM refs WHERE id = ?`).bind(prefix, id),
    db.prepare(`DELETE FROM refs WHERE id = ?`).bind(id),
  ])
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
        (SELECT count(*) FROM page_collections pc WHERE pc.collection_id = c.id
          AND EXISTS (SELECT 1 FROM pages p WHERE p.reference_id = pc.reference_id AND p.path = pc.page_path)) AS page_count,
        (SELECT group_concat(k, '|') FROM (
          SELECT k FROM (
            SELECT r.cover_key AS k, rc.added_at AS at FROM reference_collections rc JOIN refs r ON r.id = rc.reference_id
              WHERE rc.collection_id = c.id AND r.cover_key IS NOT NULL
            UNION ALL
            SELECT coalesce(p.desktop_thumb_key, p.mobile_thumb_key) AS k, pc.added_at AS at FROM page_collections pc
              JOIN pages p ON p.reference_id = pc.reference_id AND p.path = pc.page_path
              WHERE pc.collection_id = c.id AND coalesce(p.desktop_thumb_key, p.mobile_thumb_key) IS NOT NULL
          ) ORDER BY at DESC LIMIT 3)) AS cover_keys
      FROM collections c ORDER BY lower(c.name)`,
    )
    .all<Row>()
  return results.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    description: (r.description as string) ?? null,
    referenceCount: r.reference_count as number,
    pageCount: r.page_count as number,
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
  await db.prepare(`DELETE FROM collections WHERE id = ?`).bind(id).run() // memberships cascade
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

export const MAX_PAGES_PER_CHANGE = 200

export class StalePagesError extends Error {
  constructor(readonly missing: string[]) {
    super("Some pages changed or were removed. Reload this page and try again. No collection changes were saved.")
  }
}

/**
 * Save pages to a collection (member=true) or take them out. The collection points at each page
 * in its website, so the page keeps its files and stays in every other collection.
 * Returns the changed count, or null for a missing collection. Stale page IDs reject the entire change.
 */
export async function setPageCollection(db: D1Database, collectionId: string, pageIds: string[], member: boolean) {
  const ids = JSON.stringify([...new Set(pageIds)])
  // json_each keeps this to one bound parameter per list (D1 caps bound parameters per query).
  const selection = `WITH selected AS (
    SELECT id, reference_id, path FROM pages WHERE id IN (SELECT value FROM json_each(?1))
  ), valid AS (
    SELECT EXISTS (SELECT 1 FROM collections WHERE id = ?2) AS collection_exists,
      (SELECT count(*) FROM selected) = json_array_length(?1) AS pages_exist
  )`
  const canWrite = `(SELECT collection_exists AND pages_exist FROM valid)`
  const mutation = member
    ? db
        .prepare(`${selection} INSERT OR IGNORE INTO page_collections (collection_id, reference_id, page_path, added_at)
          SELECT DISTINCT ?2, reference_id, path, ?3 FROM selected WHERE ${canWrite}`)
        .bind(ids, collectionId, now())
    : db
        .prepare(`${selection} DELETE FROM page_collections WHERE collection_id = ?2
          AND (reference_id, page_path) IN (SELECT reference_id, path FROM selected) AND ${canWrite}`)
        .bind(ids, collectionId)
  // Validation and the guarded write share one D1 transaction, so a recapture cannot replace
  // pages between checking their IDs and changing membership. A stale batch changes nothing.
  const [validation, result] = await db.batch<{ collection_exists: number; pages_exist: number; missing: string }>([
    db.prepare(`${selection} SELECT *, (
      SELECT json_group_array(value) FROM json_each(?1) WHERE value NOT IN (SELECT id FROM selected)
    ) AS missing FROM valid`).bind(ids, collectionId),
    mutation,
  ])
  const valid = validation!.results[0]!
  if (!valid.collection_exists) return null
  if (!valid.pages_exist) throw new StalePagesError(JSON.parse(valid.missing) as string[])
  return result!.meta.changes
}

// Capture queue

const STALE_MINUTES = 30

export async function cleanupRetiredFiles(db: D1Database, files: R2Bucket) {
  const tasks = await db.prepare(`SELECT prefix, attempts FROM capture_cleanup WHERE next_attempt IS NULL OR next_attempt <= ? LIMIT 20`)
    .bind(now()).all<{ prefix: string; attempts: number }>()
  for (const { prefix, attempts } of tasks.results) {
    try {
      // Sweep even with unresolved writers, but never discard the tombstone while
      // one may still put an object after this listing.
      await deletePrefix(files, prefix)
      const deleted = await db.prepare(`DELETE FROM capture_cleanup WHERE prefix = ? AND NOT EXISTS
        (SELECT 1 FROM capture_uploads WHERE substr(object_key, 1, length(?)) = ?)`)
        .bind(prefix, prefix, prefix).run()
      if (deleted.meta.changes) continue
    } catch (error) {
      console.error("capture cleanup failed", error)
    }
    const delay = Math.min(3600, 30 * 2 ** Math.min(attempts, 7))
    await db.prepare(`UPDATE capture_cleanup SET attempts = attempts + 1, next_attempt = ? WHERE prefix = ?`)
      .bind(new Date(Date.now() + delay * 1000).toISOString(), prefix).run()
  }
}

export async function claimJob(db: D1Database): Promise<Job | null> {
  const stale = new Date(Date.now() - STALE_MINUTES * 60_000).toISOString()
  const ts = now()
  const attempt = crypto.randomUUID().replace(/-/g, "")
  const candidate = `SELECT id FROM refs WHERE (status = 'queued' AND coalesce(capture_control, '') != 'paused') OR (status = 'capturing' AND claimed_at < ?) ORDER BY created_at LIMIT 1`
  // A resumed crawl (crawl_state set) keeps its attempt, pages and files. Anything else starts over.
  const fresh = (yes: string, no: string) => `CASE WHEN crawl_state IS NULL OR capture_attempt IS NULL THEN ${yes} ELSE ${no} END`
  // D1 batches are transactions. Record the old namespace before replacing the lease,
  // and remove old pages within the same transaction as the claim.
  const results = await db.batch([
    db.prepare(`INSERT OR IGNORE INTO capture_cleanup (prefix) SELECT 'refs/' || id || '/' || coalesce(capture_attempt || '/', 'p') FROM refs WHERE id = (${candidate}) AND (crawl_state IS NULL OR capture_attempt IS NULL)`).bind(stale),
    db.prepare(`SELECT crawl_state FROM refs WHERE id = (${candidate}) AND capture_attempt IS NOT NULL`).bind(stale),
    db.prepare(`UPDATE refs SET status = 'capturing', capture_attempt = ${fresh("?1", "capture_attempt")}, claimed_at = ?2, updated_at = ?2,
      progress = ${fresh("'Starting capture'", "'Resuming capture'")}, cover_key = ${fresh("NULL", "cover_key")}, page_count = ${fresh("0", "page_count")},
      animation_count = ${fresh("0", "animation_count")}, tokens_json = NULL, capture_control = NULL, crawl_state = NULL
      WHERE id = (${candidate.replace("?", "?3")}) RETURNING id, url, mode, max_pages, capture_attempt, capture_options`).bind(attempt, ts, stale),
    db.prepare(`DELETE FROM pages WHERE reference_id IN (SELECT id FROM refs WHERE capture_attempt = ? AND status = 'capturing')`).bind(attempt),
  ])
  const r = results[2]?.results[0] as Row | undefined
  if (!r) return null
  const state = (results[1]?.results[0] as Row | undefined)?.crawl_state
  return {
    id: r.id as string,
    url: r.url as string,
    mode: r.mode as CaptureMode,
    maxPages: r.max_pages as number,
    attempt: r.capture_attempt as string,
    resume: parse<CrawlState>(state),
    options: parse<CaptureOptions>(r.capture_options),
  }
}

// Admission and reference state are checked atomically, before any R2 write.
export async function beginUpload(db: D1Database, id: string, attempt: string, key: string) {
  const upload = crypto.randomUUID()
  const result = await db.prepare(`INSERT INTO capture_uploads (id, object_key)
    SELECT ?, ? WHERE EXISTS (SELECT 1 FROM refs WHERE id = ? AND status = 'capturing' AND capture_attempt = ?)`)
    .bind(upload, key, id, attempt).run()
  return result.meta.changes ? upload : null
}

export async function finishUpload(db: D1Database, upload: string) {
  await db.prepare(`DELETE FROM capture_uploads WHERE id = ?`).bind(upload).run()
}

export async function isCapturing(db: D1Database, id: string, attempt: string) {
  return !!(await db.prepare(`SELECT 1 FROM refs WHERE id = ? AND status = 'capturing' AND capture_attempt = ?`).bind(id, attempt).first())
}

export async function setProgress(db: D1Database, id: string, attempt: string, progress: string) {
  const result = await db.prepare(`UPDATE refs SET progress = ?, claimed_at = ?, updated_at = ? WHERE id = ? AND status = 'capturing' AND capture_attempt = ?`).bind(progress.slice(0, 300), now(), now(), id, attempt).run()
  return result.meta.changes > 0
}

export async function renewLease(db: D1Database, id: string, attempt: string) {
  const result = await db.prepare(`UPDATE refs SET claimed_at = ? WHERE id = ? AND status = 'capturing' AND capture_attempt = ?`).bind(now(), id, attempt).run()
  return result.meta.changes > 0
}

export async function addPage(db: D1Database, referenceId: string, attempt: string, p: PageUpload) {
  const pageId = newId()
  const ts = now()
  const stmts = [
    db
      .prepare(
        `INSERT INTO pages (id, reference_id, url, path, title, ord, desktop_key, desktop_thumb_key, desktop_width, desktop_height,
          mobile_key, mobile_thumb_key, mobile_width, mobile_height, snapshot_key, styles_key, tokens_json, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM refs WHERE id = ? AND status = 'capturing' AND capture_attempt = ?)`,
      )
      .bind(
        pageId, referenceId, p.url, p.path, p.title, p.ord,
        p.desktopKey, p.desktopThumbKey, p.desktopWidth, p.desktopHeight,
        p.mobileKey, p.mobileThumbKey, p.mobileWidth, p.mobileHeight,
        p.snapshotKey, p.stylesKey, p.tokens ? JSON.stringify(p.tokens) : null, ts, referenceId, attempt,
      ),
  ]
  for (const a of p.animations) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO animations (id, reference_id, page_id, kind, label, selector, viewport, gif_key, width, height, sheet_key, meta_json, created_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM pages WHERE id = ?)`,
        )
        .bind(
          newId(), referenceId, pageId, a.kind, a.label, a.selector, a.viewport, a.gifKey, a.width, a.height,
          a.sheetKey ?? null, a.meta ? JSON.stringify(a.meta) : null, ts, pageId,
        ),
    )
  }
  stmts.push(
    db
      .prepare(
        `UPDATE refs SET page_count = (SELECT count(*) FROM pages WHERE reference_id = ?1),
          animation_count = (SELECT count(*) FROM animations WHERE reference_id = ?1),
          cover_key = coalesce(cover_key, ?2), updated_at = ?3 WHERE id = ?1 AND status = 'capturing' AND capture_attempt = ?4`,
      )
      .bind(referenceId, p.desktopThumbKey, ts, attempt),
  )
  const results = await db.batch(stmts)
  return results[0]?.meta.changes ? pageId : null
}

export async function completeJob(db: D1Database, id: string, attempt: string, c: JobComplete) {
  const result = await db
    .prepare(
      `UPDATE refs SET status = 'ready', progress = NULL, error = NULL, capture_control = NULL, title = coalesce(?, title), description = coalesce(?, description),
        favicon = coalesce(?, favicon), cover_key = coalesce(?, cover_key), tokens_json = ?, updated_at = ? WHERE id = ? AND status = 'capturing' AND capture_attempt = ?`,
    )
    .bind(c.title, c.description, c.favicon, c.coverKey, c.tokens ? JSON.stringify(c.tokens) : null, now(), id, attempt)
    .run()
  return result.meta.changes > 0
}

export async function failJob(db: D1Database, id: string, attempt: string, error: string) {
  const result = await db.prepare(`UPDATE refs SET status = 'failed', progress = NULL, error = ?, capture_control = NULL, updated_at = ? WHERE id = ? AND status = 'capturing' AND capture_attempt = ?`).bind(error.slice(0, 1000), now(), id, attempt).run()
  return result.meta.changes > 0
}

// ---------- Pause, resume and stop ----------
// The agent finishes the page it is on, then asks for its control before the next one.


/** Pause a capture. A queued one pauses now; a running one pauses after its current page. */
export async function requestPause(db: D1Database, id: string) {
  const ts = now()
  const [queued, running] = await db.batch([
    db.prepare(`UPDATE refs SET capture_control = 'paused', progress = 'Paused', updated_at = ? WHERE id = ? AND status = 'queued' AND capture_control IS NULL`).bind(ts, id),
    db.prepare(`UPDATE refs SET capture_control = 'pause', updated_at = ? WHERE id = ? AND status = 'capturing' AND capture_control IS NULL`).bind(ts, id),
  ])
  return !!(queued!.meta.changes || running!.meta.changes)
}

/** Resume a paused capture, or cancel a pause that has not taken effect yet. */
export async function resumeReference(db: D1Database, id: string) {
  const ts = now()
  const [paused, pending] = await db.batch([
    db.prepare(`UPDATE refs SET capture_control = NULL, progress = 'Waiting for your Mac', updated_at = ? WHERE id = ? AND status = 'queued' AND capture_control = 'paused'`).bind(ts, id),
    db.prepare(`UPDATE refs SET capture_control = NULL, updated_at = ? WHERE id = ? AND status = 'capturing' AND capture_control = 'pause'`).bind(ts, id),
  ])
  return !!(paused!.meta.changes || pending!.meta.changes)
}

/**
 * Stop a capture and keep the pages it has. A running one stops after its current page.
 * A paused one (or one resumed but not picked up yet) finishes here, from the metadata and tokens saved when it paused.
 */
export async function requestStop(db: D1Database, id: string) {
  const ts = now()
  const results = await db.batch([
    db.prepare(`UPDATE refs SET status = 'ready', progress = NULL, error = NULL, capture_control = NULL,
      title = coalesce(json_extract(crawl_state, '$.meta.title'), title), description = coalesce(json_extract(crawl_state, '$.meta.description'), description),
      favicon = coalesce(json_extract(crawl_state, '$.meta.favicon'), favicon), tokens_json = json_extract(crawl_state, '$.tokens'), crawl_state = NULL, updated_at = ?
      WHERE id = ? AND status = 'queued' AND crawl_state IS NOT NULL AND page_count > 0`).bind(ts, id),
    db.prepare(`UPDATE refs SET status = 'failed', progress = NULL, error = ?, capture_control = NULL, crawl_state = NULL, updated_at = ?
      WHERE id = ? AND status = 'queued'`).bind(STOPPED_EMPTY, ts, id),
    db.prepare(`UPDATE refs SET capture_control = 'stop', updated_at = ? WHERE id = ? AND status = 'capturing'`).bind(ts, id),
  ])
  return results.some((r) => r.meta.changes > 0)
}

/** What the agent should do before its next page. Null means the job is gone. */
export async function getControl(db: D1Database, id: string, attempt: string): Promise<{ control: CaptureControl | null } | null> {
  const r = await db.prepare(`SELECT capture_control FROM refs WHERE id = ? AND status = 'capturing' AND capture_attempt = ?`).bind(id, attempt).first<Row>()
  if (!r) return null
  return { control: r.capture_control === "pause" || r.capture_control === "stop" ? r.capture_control : null }
}

/**
 * The agent pauses at a page boundary and hands back where it was. Only applies while a pause is
 * still requested, so a stop or resume that arrived meanwhile wins: "changed" tells the agent to check again.
 */
export async function pauseJob(db: D1Database, id: string, attempt: string, state: CrawlState): Promise<"paused" | "changed" | "gone"> {
  const result = await db.prepare(`UPDATE refs SET status = 'queued', capture_control = 'paused', crawl_state = ?, progress = 'Paused', claimed_at = NULL, updated_at = ?
    WHERE id = ? AND status = 'capturing' AND capture_attempt = ? AND capture_control = 'pause'`).bind(JSON.stringify(state), now(), id, attempt).run()
  if (result.meta.changes) return "paused"
  return (await isCapturing(db, id, attempt)) ? "changed" : "gone"
}

// ---------- Capture worker presence ----------

const PRESENCE_ID = "capture"
const PRESENCE_WRITE_SECONDS = 20
const RECENT_SECONDS = 90

/** Record that the capture worker contacted the server. Throttled so idle polling costs at most a few writes a minute. */
export async function touchPresence(db: D1Database, activity: "idle" | "busy", jobId: string | null) {
  const ts = now()
  const before = new Date(Date.now() - PRESENCE_WRITE_SECONDS * 1000).toISOString()
  await db
    .prepare(
      `INSERT INTO worker_presence (id, last_seen_at, activity, job_id) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (id) DO UPDATE SET last_seen_at = ?2, activity = ?3, job_id = ?4
       WHERE worker_presence.last_seen_at < ?5 OR worker_presence.activity != ?3 OR coalesce(worker_presence.job_id, '') != coalesce(?4, '')`,
    )
    .bind(PRESENCE_ID, ts, activity, jobId, before)
    .run()
}

export async function getPresence(db: D1Database): Promise<AgentPresence> {
  const w = await db.prepare(`SELECT * FROM worker_presence WHERE id = ?`).bind(PRESENCE_ID).first<Row>()
  const lastSeenAt = (w?.last_seen_at as string) ?? null
  const seconds = lastSeenAt ? (Date.now() - Date.parse(lastSeenAt)) / 1000 : null
  return {
    lastSeenAt,
    freshness: seconds == null ? "never" : seconds <= RECENT_SECONDS ? "recent" : "stale",
    activity: (w?.activity as "idle" | "busy") ?? null,
  }
}

// ---------- Storage ----------

const R2_FREE_BYTES = 10 * 1024 ** 3
// Free-plan Workers get 50 subrequests; a listing page holds up to 1,000 objects.
const STORAGE_LIST_PAGES = 40

/** Bytes stored in R2, counted from listings (cheap Class A operations, no downloads). */
export async function storageUsage(files: R2Bucket): Promise<StorageUsage> {
  let bytes = 0
  let objects = 0
  let cursor: string | undefined
  for (let i = 0; i < STORAGE_LIST_PAGES; i++) {
    const page = await files.list({ cursor, limit: 1000 })
    for (const o of page.objects) {
      bytes += o.size
      objects++
    }
    if (!page.truncated) return { bytes, objects, partial: false, freeBytes: R2_FREE_BYTES }
    cursor = page.cursor
  }
  return { bytes, objects, partial: true, freeBytes: R2_FREE_BYTES }
}

export async function getCaptureStatus(db: D1Database, ref: Reference): Promise<CaptureStatus> {
  const w = await db.prepare(`SELECT * FROM worker_presence WHERE id = ?`).bind(PRESENCE_ID).first<Row>()
  const lastSeenAt = (w?.last_seen_at as string) ?? null
  const secondsSinceSeen = lastSeenAt ? Math.max(0, Math.round((Date.now() - Date.parse(lastSeenAt)) / 1000)) : null
  const freshness = secondsSinceSeen == null ? "never" : secondsSinceSeen <= RECENT_SECONDS ? "recent" : "stale"
  const activity = (w?.activity as "idle" | "busy") ?? null
  const currentJobId = (w?.job_id as string) ?? null
  const claimedAt = ref.claimedAt
  let advice: string
  let pollAfterSeconds: number | null = null
  switch (ref.status) {
    case "ready":
      advice = "Capture finished. Use get_reference with part \"overview\" to see what was captured."
      break
    case "paused":
      advice = `The user paused this capture after ${ref.pageCount} ${ref.pageCount === 1 ? "page" : "pages"}. They can resume or stop it from the Snip app. Stop polling.`
      break
    case "failed":
      advice = `Capture failed${ref.error ? `: ${ref.error}` : ""}. Tell the user; they can recapture from the Snip app.`
      break
    case "queued":
      // Queued means "waiting for this Mac", whether the agent is busy or absent.
      // The phrase matches the gallery card, so an agent relays it verbatim.
      if (freshness === "recent") {
        advice =
          activity === "busy"
            ? "Waiting for your Mac: the capture agent is finishing another job and will pick this up next."
            : "Waiting for your Mac: the capture agent is online and should pick this up shortly."
        pollAfterSeconds = activity === "busy" ? 60 : 15
      } else {
        advice =
          freshness === "never"
            ? "Waiting for your Mac: no capture agent has ever contacted Snip. Ask the user to run `npm run capture` on their Mac. Stop polling until they do."
            : `Waiting for your Mac: the capture agent was last seen ${secondsSinceSeen}s ago and is probably not running. Ask the user to start \`npm run capture\`. Stop polling until they do.`
      }
      break
    case "capturing": {
      const progressAge = claimedAt ? Math.round((Date.now() - Date.parse(claimedAt)) / 1000) : null
      if (freshness !== "recent") {
        advice = `The capture was in progress but the worker has not been seen for ${secondsSinceSeen ?? "?"}s. It may have stopped; it will be retried when a worker reconnects. Ask the user to check \`npm run capture\`.`
      } else if (currentJobId && currentJobId !== ref.id) {
        advice = "The worker is online but busy with a different job; this capture may have been interrupted and will be retried."
        pollAfterSeconds = 60
      } else {
        advice =
          progressAge != null && progressAge > 300
            ? `The worker is online but this capture has not reported progress for ${progressAge}s. A slow page can cause this; keep polling slowly.`
            : "Capturing. Progress shows the current page."
        pollAfterSeconds = progressAge != null && progressAge > 300 ? 120 : 20
      }
      break
    }
  }
  return {
    state: ref.status,
    progress: ref.progress,
    error: ref.error,
    // claimed_at is refreshed on every progress report, so it is the last progress time, not the attempt start.
    lastProgressAt: ref.status === "capturing" ? claimedAt : null,
    worker: { lastSeenAt, secondsSinceSeen, freshness, activity, currentJobId },
    pollAfterSeconds,
    advice,
  }
}

// ---------- Owner and library counts (cloud status and the transfer surface) ----------

export type LibraryCounts = { refs: number; pages: number; animations: number; collections: number }

export async function libraryCounts(db: D1Database): Promise<LibraryCounts> {
  const row = await db
    .prepare(
      `SELECT (SELECT count(*) FROM refs) AS refs, (SELECT count(*) FROM pages) AS pages,
              (SELECT count(*) FROM animations) AS animations, (SELECT count(*) FROM collections) AS collections`,
    )
    .first<LibraryCounts>()
  return row ?? { refs: 0, pages: 0, animations: 0, collections: 0 }
}

/**
 * The install's owner: its first identity. Contracts §4.2.1 requires the engine to mint the owner
 * link for exactly this id when an adopted library already has one, so the ordering has to be
 * stable and this must never invent a row.
 */
export async function firstOwner(db: D1Database): Promise<{ id: string; label: string | null } | null> {
  return db.prepare(`SELECT id, label FROM owners ORDER BY created_at, id LIMIT 1`).first<{ id: string; label: string | null }>()
}

export async function hasPasskeys(db: D1Database): Promise<boolean> {
  return !!(await db.prepare(`SELECT 1 AS present FROM passkeys LIMIT 1`).first<{ present: number }>())
}

// Challenges and link nonces are short-lived: they exist to be burned, and a pull that copied
// them would compare numbers that legitimately move between the manifest and the dump. They are
// named in the manifest rather than silently dropped, so the engine can see what was left out.
const EPHEMERAL_TABLES = new Set(["owner_nonces", "webauthn_challenges"])

export type TableCounts = { tables: Record<string, number>; excluded: string[] }

/** Row counts for every table a move or pull copies, plus the short-lived ones it does not. */
export async function tableCounts(db: D1Database): Promise<TableCounts> {
  const { results } = await db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name`)
    .all<{ name: string }>()
  const all = results.map((r) => r.name)
  const names = all.filter((name) => !EPHEMERAL_TABLES.has(name))
  const excluded = all.filter((name) => EPHEMERAL_TABLES.has(name))
  if (!names.length) return { tables: {}, excluded }
  const counts = await db.batch(names.map((name) => db.prepare(`SELECT count(*) AS n FROM "${name.replace(/"/g, '""')}"`)))
  const tables: Record<string, number> = {}
  names.forEach((name, i) => {
    const rows = counts[i]?.results as { n: number }[] | undefined
    tables[name] = rows?.[0]?.n ?? 0
  })
  return { tables, excluded }
}

// ---------- Owners and passkeys ----------

export type OwnerRow = { id: string; label: string | null; created_at: string; sessions_epoch: number }

export async function getOwner(db: D1Database, id: string): Promise<OwnerRow | null> {
  return db.prepare(`SELECT id, label, created_at, sessions_epoch FROM owners WHERE id = ?`).bind(id).first<OwnerRow>()
}

export type PasskeyRecord = {
  id: string
  ownerId: string
  publicKey: ArrayBuffer
  counter: number
  transports: string[]
  deviceLabel: string | null
  createdAt: string
  lastUsedAt: string | null
}

type PasskeyRow = {
  id: string
  owner_id: string
  public_key: ArrayBuffer | number[]
  counter: number
  transports: string | null
  device_label: string | null
  created_at: string
  last_used_at: string | null
}

const toPasskey = (r: PasskeyRow): PasskeyRecord => ({
  id: r.id,
  ownerId: r.owner_id,
  publicKey: r.public_key instanceof ArrayBuffer ? r.public_key : new Uint8Array(r.public_key as number[]).buffer,
  counter: r.counter,
  transports: parse<string[]>(r.transports) ?? [],
  deviceLabel: r.device_label,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
})

export async function listPasskeys(db: D1Database, ownerId?: string): Promise<PasskeyRecord[]> {
  const rows = ownerId
    ? await db.prepare(`SELECT * FROM passkeys WHERE owner_id = ? ORDER BY created_at`).bind(ownerId).all<PasskeyRow>()
    : await db.prepare(`SELECT * FROM passkeys ORDER BY created_at`).all<PasskeyRow>()
  return rows.results.map(toPasskey)
}

export async function getPasskey(db: D1Database, id: string): Promise<PasskeyRecord | null> {
  const row = await db.prepare(`SELECT * FROM passkeys WHERE id = ?`).bind(id).first<PasskeyRow>()
  return row ? toPasskey(row) : null
}

/**
 * Everything passkey sign-in needs before it verifies a signature: the credential, its owner, and
 * the install's current revocation epoch. One round trip instead of three, because this runs on
 * every sign-in and D1 latency is the whole cost of the route.
 */
export async function getPasskeyLogin(
  db: D1Database,
  id: string,
): Promise<{ passkey: PasskeyRecord; owner: { id: string; label: string | null }; epoch: number } | null> {
  const row = await db
    .prepare(
      `SELECT p.*, o.label AS owner_label, o.id AS owner_row_id, (SELECT max(sessions_epoch) FROM owners) AS epoch
       FROM passkeys p LEFT JOIN owners o ON o.id = p.owner_id WHERE p.id = ?`,
    )
    .bind(id)
    .first<PasskeyRow & { owner_label: string | null; owner_row_id: string | null; epoch: number | null }>()
  if (!row || !row.owner_row_id) return null
  return {
    passkey: toPasskey(row),
    owner: { id: row.owner_row_id, label: row.owner_label },
    epoch: row.epoch ?? 0,
  }
}

/**
 * Stores a credential, or refreshes the one row with that id.
 *
 * Registration can slip past `excludeCredentials` — a stale options blob, a second tab — and then
 * the same credential arrives twice. A plain INSERT would hit the PRIMARY KEY and surface as a
 * 500, so the second write upserts: the authenticator just proved possession again, so the key,
 * counter, transports and last-used time are current. `owner_id`, `device_label` and `created_at`
 * are deliberately untouched, so an existing credential is never reassigned to another owner and
 * the device keeps the name it was given (contracts §4.2.1).
 *
 * `"other-owner"` is the one case that writes nothing: a credential id already held by a different
 * owner is refused rather than silently overwritten. That cannot happen through the UI (an
 * authenticator mints a distinct credential per user and per RP), but a corrupted or forged
 * response must not be able to take over someone else's row.
 */
export async function addPasskey(
  db: D1Database,
  passkey: { id: string; ownerId: string; publicKey: ArrayBuffer; counter: number; transports?: string[]; deviceLabel?: string | null },
): Promise<"created" | "refreshed" | "other-owner"> {
  const existing = await db.prepare(`SELECT owner_id FROM passkeys WHERE id = ?`).bind(passkey.id).first<{ owner_id: string }>()
  if (existing && existing.owner_id !== passkey.ownerId) return "other-owner"
  await db
    .prepare(
      `INSERT INTO passkeys (id, owner_id, public_key, counter, transports, device_label, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT (id) DO UPDATE SET
         public_key = excluded.public_key,
         counter = excluded.counter,
         transports = excluded.transports,
         -- Re-registering is a fresh proof of possession, so it counts as a use. A brand-new row
         -- keeps last_used_at NULL and reads "Never used" until the first sign-in.
         last_used_at = excluded.created_at`,
    )
    .bind(passkey.id, passkey.ownerId, passkey.publicKey, passkey.counter, JSON.stringify(passkey.transports ?? []), passkey.deviceLabel ?? null, now())
    .run()
  return existing ? "refreshed" : "created"
}

export async function touchPasskey(db: D1Database, id: string, counter: number): Promise<void> {
  await db.prepare(`UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?`).bind(counter, now(), id).run()
}

/** Removes one device. Scoped by owner so a session can only delete its own owner's passkeys. */
export async function deletePasskey(db: D1Database, ownerId: string, id: string): Promise<boolean> {
  const result = await db.prepare(`DELETE FROM passkeys WHERE id = ? AND owner_id = ?`).bind(id, ownerId).run()
  return result.meta.changes === 1
}
