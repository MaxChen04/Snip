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
  type PageSection,
  type AltScheme,
  type PageUpload,
  type Paged,
  type RefSummary,
  type Reference,
  type StorageUsage,
} from "../shared/types"
import { ABANDONED, STOPPED_EMPTY, WAITING } from "../shared/capture-errors"

// Data access shared by the HTTP API and the MCP server.

export const now = () => new Date().toISOString()
export const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 16)

export const parse = <T>(s: unknown): T | null => {
  if (typeof s !== "string" || !s) return null
  try {
    return JSON.parse(s) as T
  } catch {
    return null
  }
}

export type Row = Record<string, unknown>

/** A saved icon is a file key. Older captures hold the site's own icon URL, which Snip no longer loads. */
const iconKey = (v: unknown) => (typeof v === "string" && v.startsWith("refs/") ? v : null)

export function toReference(r: Row): Reference {
  return {
    id: r.id as string,
    url: r.url as string,
    domain: r.domain as string,
    title: (r.title as string) ?? null,
    description: (r.description as string) ?? null,
    favicon: iconKey(r.favicon),
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
    quietSince: r.status === "capturing" && typeof r.claimed_at === "string" && r.claimed_at < staleBefore(now()) ? r.claimed_at : null,
    captureRun: (r.capture_run as number) ?? 1,
  }
}

export function toPage(r: Row): Page {
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
    sections: parse<PageSection[]>(r.sections_json) ?? [],
    sectionsCaptured: r.sections_json != null,
    altScheme: parse<AltScheme>(r.alt_scheme_json),
    collectionIds: r.collection_ids ? String(r.collection_ids).split(",") : [],
    createdAt: r.created_at as string,
  }
}

/** Selects a page row plus the collections it was saved to individually. Alias the pages table as `t`. */
export const PAGE_COLLECTIONS = `(SELECT group_concat(pc.collection_id) FROM page_collections pc WHERE pc.reference_id = t.reference_id AND pc.page_path = t.path) AS collection_ids`

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

// Cursor = base64 of the UTF-8 bytes of "<sortValue>|<id>"
export const encodeCursor = (v: string | number, id: string) => btoa(String.fromCharCode(...new TextEncoder().encode(`${v}|${id}`)))
export const decodeCursor = (c?: string | null): [string, string] | null => {
  if (!c) return null
  try {
    const s = new TextDecoder().decode(Uint8Array.from(atob(c), (ch) => ch.charCodeAt(0)))
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

export const REF_SELECT = `SELECT r.*, (SELECT group_concat(collection_id) FROM reference_collections rc WHERE rc.reference_id = r.id) AS collection_ids,
  (SELECT group_concat(k, '|') FROM (SELECT coalesce(p.desktop_thumb_key, p.mobile_thumb_key) AS k FROM pages p
    WHERE p.reference_id = r.id AND coalesce(p.desktop_thumb_key, p.mobile_thumb_key) IS NOT NULL ORDER BY p.ord LIMIT 3)) AS preview_keys
  FROM refs r`

export type Where = { where: string[]; args: unknown[] }
export const whereSql = (where: string[]) => (where.length ? "WHERE " + where.join(" AND ") : "")

/** The websites feed's filters, everything but the cursor. Alias refs as `r`. */
export function referenceWhere(f: ListFilter): Where {
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
  return { where, args }
}

export async function listReferences(db: D1Database, f: ListFilter): Promise<Paged<Reference>> {
  const limit = Math.min(Math.max(f.limit ?? 24, 1), 100)
  const { where, args } = referenceWhere(f)
  // One expression is the sort key: it orders the rows, bounds the next page and is read back for the cursor.
  const key = f.sort === "name" ? `lower(coalesce(r.title, r.domain))` : `r.created_at`
  const [dir, after] = f.sort === "name" || f.sort === "oldest" ? ["ASC", ">"] : ["DESC", "<"]
  const cur = decodeCursor(f.cursor)
  if (cur) {
    where.push(`(${key} ${after} ? OR (${key} = ? AND r.id ${after} ?))`)
    args.push(cur[0], cur[0], cur[1])
  }
  const sql = `${REF_SELECT.replace("SELECT", `SELECT ${key} AS sort_key,`)} ${whereSql(where)} ORDER BY ${key} ${dir}, r.id ${dir} LIMIT ?`
  const { results } = await db.prepare(sql).bind(...args, limit + 1).all<Row>()
  const last = results.length > limit ? results[limit - 1] : null
  return { items: results.slice(0, limit).map(toReference), nextCursor: last ? encodeCursor(last.sort_key as string, last.id as string) : null }
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

/** The pages or animations feed's q and collection filters. Alias the table as `t` and its refs row as `r`. */
export function childWhere(table: "pages" | "animations", f: ListFilter): Where {
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
  return { where, args }
}

/** The website a page, section or recording came from, for a tile to label itself. Needs ref_title, ref_domain and ref_favicon in the row. */
export const refSummary = (r: Row): RefSummary => ({ id: r.reference_id as string, title: (r.ref_title as string) ?? null, domain: r.ref_domain as string, favicon: iconKey(r.ref_favicon) })

// Cross-reference feeds for the "Pages" and "Animations" gallery views.
async function listChildren<T>(
  db: D1Database,
  table: "pages" | "animations",
  map: (r: Row) => T,
  f: ListFilter,
): Promise<Paged<T & { reference: RefSummary }>> {
  const limit = Math.min(Math.max(f.limit ?? 24, 1), 100)
  const { where, args } = childWhere(table, f)
  const asc = f.sort === "oldest"
  const cur = decodeCursor(f.cursor)
  if (cur) {
    where.push(asc ? `(t.created_at > ? OR (t.created_at = ? AND t.id > ?))` : `(t.created_at < ? OR (t.created_at = ? AND t.id < ?))`)
    args.push(cur[0], cur[0], cur[1])
  }
  const dir = asc ? "ASC" : "DESC"
  const sql = `SELECT t.*, r.title AS ref_title, r.domain AS ref_domain, r.favicon AS ref_favicon${table === "pages" ? `, ${PAGE_COLLECTIONS}` : ""} FROM ${table} t JOIN refs r ON r.id = t.reference_id ${whereSql(where)} ORDER BY t.created_at ${dir}, t.id ${dir} LIMIT ?`
  const { results } = await db.prepare(sql).bind(...args, limit + 1).all<Row>()
  const page = results.slice(0, limit)
  const items = page.map((r) => ({
    ...map(r),
    reference: refSummary(r),
  }))
  const last = page[page.length - 1]
  return {
    items,
    nextCursor: results.length > limit && last ? encodeCursor(last.created_at as string, last.id as string) : null,
  }
}

// Lists leave out each page's design tokens (about 26 KB a page, most of the response); getPage and getReference carry them.
// ponytail: the row is still read with tokens_json; select columns explicitly if the D1 read ever shows up.
export const listPages = (db: D1Database, f: ListFilter) => listChildren(db, "pages", (r) => toPage({ ...r, tokens_json: null }), f)
export const listAnimations = (db: D1Database, f: ListFilter) => listChildren(db, "animations", toAnimation, f)

/**
 * The one check for a URL the user adds. Input with no scheme at all gets https://; then it must be http or https, carry no
 * username or password, have no whitespace and name a host (with a dot, localhost or an IP literal). Anything else throws a sentence
 * the user can read. Loopback and private addresses pass: the capture agent's own egress guard decides those.
 */
export function normalizeUrl(input: string): URL {
  const raw = input.trim()
  if (!raw) throw new Error("Enter a web address")
  if (/\s/.test(raw)) throw new Error("A web address cannot contain spaces")
  // "localhost:3000" and "example.com:8080" start with a host and a port, not a scheme.
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[^/?#]*:\d+(?:[/?#]|$)/.test(raw)
  let url: URL
  try {
    url = new URL(hasScheme ? raw : `https://${raw}`)
  } catch {
    throw new Error("That is not a valid web address")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http and https addresses can be captured")
  if (url.username || url.password) throw new Error("A web address cannot contain a username or password")
  if (!url.hostname.includes(".") && url.hostname !== "localhost" && !url.hostname.startsWith("[")) throw new Error("A web address needs a host name, like example.com")
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

/** The site a URL belongs to: its host in lower case without a leading www. */
const domainOf = (url: URL) => url.hostname.replace(/^www\./, "")

/**
 * What makes two URLs the same site URL, for the duplicate check only (the stored URL stays as the user gave it).
 * Ignored: the scheme (http or https), a leading www., the fragment, a trailing slash on the path, the order of the query,
 * and the tracking parameters utm_*, gclid, fbclid and ref.
 */
function siteKey(url: URL): string {
  const query = [...url.searchParams]
    .filter(([name]) => !/^(utm_.*|gclid|fbclid|ref)$/i.test(name))
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .sort()
    .join("&")
  return `${domainOf(url)}${url.port && `:${url.port}`}${url.pathname.replace(/\/$/, "")}?${query}`
}

/**
 * The most recent reference already saved for this site URL, if any. The key is computed here, on both sides, so it needs
 * no stored column and covers references saved before it existed: the SQL only narrows to the same site.
 */
export async function findReferenceByUrl(db: D1Database, input: string): Promise<Reference | null> {
  const url = normalizeUrl(input)
  const key = siteKey(url)
  const { results } = await db.prepare(`SELECT id, url FROM refs WHERE domain = ? ORDER BY created_at DESC`).bind(domainOf(url)).all<{ id: string; url: string }>()
  const match = results.find((r) => siteKey(new URL(r.url)) === key)
  return match ? getReferenceRecord(db, match.id) : null
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
        `INSERT INTO refs (id, url, domain, mode, max_pages, status, progress, notes, capture_options, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'queued', '${WAITING}', ?, ?, ?, ?)`,
      )
      .bind(id, url.toString(), domainOf(url), input.mode, maxPages, cleanNotes(input.notes), options ? JSON.stringify(options) : null, ts, ts),
  ]
  for (const cid of input.collectionIds ?? []) {
    stmts.push(
      db.prepare(`INSERT OR IGNORE INTO reference_collections (reference_id, collection_id, added_at) SELECT ?, id, ? FROM collections WHERE id = ?`).bind(id, ts, cid),
    )
  }
  await db.batch(stmts)
  return (await getReference(db, id))!.reference
}

/** Recapture a finished reference. False when it does not exist or its capture is still waiting, running or paused. */
export async function requeueReference(db: D1Database, id: string) {
  const finished = `id = ? AND status IN ('ready', 'failed')`
  const results = await db.batch([
    db.prepare(`INSERT OR IGNORE INTO capture_cleanup (prefix) SELECT 'refs/' || id || '/' || coalesce(capture_attempt || '/', 'p') FROM refs WHERE ${finished}`).bind(id),
    db.prepare(`DELETE FROM pages WHERE reference_id IN (SELECT id FROM refs WHERE ${finished})`).bind(id), // animations cascade
    db
      .prepare(
        `UPDATE refs SET status = 'queued', progress = '${WAITING}', error = NULL, page_count = 0, animation_count = 0, cover_key = NULL, favicon = NULL, tokens_json = NULL, claimed_at = NULL, capture_control = NULL, crawl_state = NULL, stale_reclaims = 0, capture_run = capture_run + 1, updated_at = ? WHERE ${finished}`,
      )
      .bind(now(), id),
  ])
  return results[2]!.meta.changes > 0
}

export async function deleteReference(db: D1Database, id: string) {
  // Keep a retryable tombstone even if storage deletion fails after the database delete.
  const prefix = `refs/${id}/`
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO capture_cleanup (prefix) SELECT ? FROM refs WHERE id = ?`).bind(prefix, id),
    // Board positions of the website and of its pages (keyed by reference id) on every board.
    db.prepare(`DELETE FROM board_items WHERE item_id = ? AND kind IN ('reference', 'page')`).bind(id),
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

export const COLLECTION_SELECT = `SELECT c.*, (SELECT count(*) FROM reference_collections rc WHERE rc.collection_id = c.id) AS reference_count,
    (SELECT count(*) FROM page_collections pc WHERE pc.collection_id = c.id
      AND EXISTS (SELECT 1 FROM pages p WHERE p.reference_id = pc.reference_id AND p.path = pc.page_path)) AS page_count,
    (SELECT count(*) FROM image_collections ic WHERE ic.collection_id = c.id) AS image_count,
    (SELECT group_concat(k, '|') FROM (
      SELECT k FROM (
        SELECT r.cover_key AS k, rc.added_at AS at FROM reference_collections rc JOIN refs r ON r.id = rc.reference_id
          WHERE rc.collection_id = c.id AND r.cover_key IS NOT NULL
        UNION ALL
        SELECT coalesce(p.desktop_thumb_key, p.mobile_thumb_key) AS k, pc.added_at AS at FROM page_collections pc
          JOIN pages p ON p.reference_id = pc.reference_id AND p.path = pc.page_path
          WHERE pc.collection_id = c.id AND coalesce(p.desktop_thumb_key, p.mobile_thumb_key) IS NOT NULL
        UNION ALL
        SELECT i.thumb_key AS k, ic.added_at AS at FROM image_collections ic JOIN images i ON i.id = ic.image_id
          WHERE ic.collection_id = c.id
      ) ORDER BY at DESC LIMIT 3)) AS cover_keys
  FROM collections c`

export const toCollection = (r: Row): Collection => ({
  id: r.id as string,
  name: r.name as string,
  description: (r.description as string) ?? null,
  referenceCount: r.reference_count as number,
  pageCount: r.page_count as number,
  imageCount: r.image_count as number,
  coverKeys: r.cover_keys ? String(r.cover_keys).split("|") : [],
  createdAt: r.created_at as string,
})

export async function listCollections(db: D1Database): Promise<Collection[]> {
  const { results } = await db.prepare(`${COLLECTION_SELECT} ORDER BY lower(c.name)`).all<Row>()
  return results.map(toCollection)
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
    await db.batch([
      db.prepare(`DELETE FROM reference_collections WHERE reference_id = ? AND collection_id = ?`).bind(referenceId, collectionId),
      db.prepare(`DELETE FROM board_items WHERE item_id = ? AND collection_id = ? AND kind = 'reference'`).bind(referenceId, collectionId),
    ])
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
  // Taking pages off a board also drops their positions on its canvas.
  const unplace = db
    .prepare(`${selection} DELETE FROM board_items WHERE collection_id = ?2 AND kind = 'page'
      AND (item_id, page_path) IN (SELECT reference_id, path FROM selected) AND ${canWrite}`)
    .bind(ids, collectionId)
  const [validation, result] = await db.batch<{ collection_exists: number; pages_exist: number; missing: string }>([
    db.prepare(`${selection} SELECT *, (
      SELECT json_group_array(value) FROM json_each(?1) WHERE value NOT IN (SELECT id FROM selected)
    ) AS missing FROM valid`).bind(ids, collectionId),
    mutation,
    ...(member ? [] : [unplace]),
  ])
  const valid = validation!.results[0]!
  if (!valid.collection_exists) return null
  if (!valid.pages_exist) throw new StalePagesError(JSON.parse(valid.missing) as string[])
  return result!.meta.changes
}

// Capture queue

/**
 * The heartbeat (every 30 s, and every progress report) is the one sign an agent is alive: a capture whose last one is older
 * than this is the agent's no more. Six missed beats. Safe to be short because every claim issues a new lease, so a replaced agent is refused.
 */
const STALE_MINUTES = 3

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

/** Whether a refs row has saved pages. A capture with pages is resumed in its attempt; one without starts fresh. */
const HAS_PAGES = `EXISTS (SELECT 1 FROM pages WHERE reference_id = refs.id)`
/** Reclaims in a row that saved no page in between. A page saved under the lease starts the count again (addPage), so a Mac that sleeps now and then is not abandoned. */
const MAX_STALE_RECLAIMS = 3

/** Ends the captures matching `where` (its bound values in `args`) with what they have: ready with their pages, stopped-empty without. */
const settleStopped = (db: D1Database, where: string, args: unknown[], ts: string) => [
  db.prepare(`UPDATE refs SET status = 'ready', progress = NULL, error = NULL, capture_control = NULL, capture_lease = NULL,
    title = coalesce(json_extract(crawl_state, '$.meta.title'), title), description = coalesce(json_extract(crawl_state, '$.meta.description'), description),
    favicon = CASE WHEN instr(json_extract(crawl_state, '$.meta.favicon'), 'refs/' || id || '/' || capture_attempt || '/') = 1 THEN json_extract(crawl_state, '$.meta.favicon') ELSE favicon END,
    tokens_json = json_extract(crawl_state, '$.tokens'), crawl_state = NULL, updated_at = ?
    WHERE ${where} AND ${HAS_PAGES}`).bind(ts, ...args),
  db.prepare(`UPDATE refs SET status = 'failed', progress = NULL, error = ?, capture_control = NULL, capture_lease = NULL, crawl_state = NULL, updated_at = ? WHERE ${where}`).bind(STOPPED_EMPTY, ts, ...args),
]

/** A capture whose agent has not renewed its claim since the bound time. */
const STALE_CAPTURE = `status = 'capturing' AND claimed_at < ?`
const staleBefore = (ts: string) => new Date(Date.parse(ts) - STALE_MINUTES * 60_000).toISOString()

/**
 * Settles what an agent that went silent left behind: a stop it never acted on ends the capture with its pages, a pause it never
 * took parks it, and a capture already reclaimed too often fails. `id` limits this to one capture. A claim, a stop or pause request
 * and the hourly sweep all run it, so a request lands at once on an agent that is already gone and within the hour on one that goes quiet later.
 */
const settleAbandoned = (db: D1Database, ts: string, id: string | null = null) => {
  const abandoned = `${STALE_CAPTURE} AND id = coalesce(?, id)`
  const args = [staleBefore(ts), id]
  return [
    ...settleStopped(db, `${abandoned} AND capture_control = 'stop'`, args, ts),
    db.prepare(`UPDATE refs SET status = 'queued', capture_control = 'paused', progress = 'Paused', claimed_at = NULL, capture_lease = NULL, updated_at = ? WHERE ${abandoned} AND capture_control = 'pause'`).bind(ts, ...args),
    db.prepare(`UPDATE refs SET status = 'failed', progress = NULL, error = ?, crawl_state = NULL, capture_lease = NULL, updated_at = ? WHERE ${abandoned} AND stale_reclaims >= ${MAX_STALE_RECLAIMS}`).bind(ABANDONED, ts, ...args),
  ]
}

export const sweepAbandoned = (db: D1Database) => db.batch(settleAbandoned(db, now()))

/**
 * The last checkpoint brought up to the pages saved since: they count as captured and are not visited again.
 * The agent numbers a page, and names its files, by its place in `visited`, so `visited` is filled up to each
 * saved page's ord: the next page takes a number, and a file prefix, no saved page has.
 */
function resumeState(checkpoint: CrawlState | null, pages: [url: string, ord: number][]): CrawlState {
  const base = checkpoint ?? { version: 1, queue: [], visited: [], captured: 0, failures: 0, navLinksQueued: false, hoverSeen: [], meta: null, tokens: null }
  const since = pages.slice(base.captured)
  const visited = [...base.visited]
  for (const [url, ord] of since) do visited.push(url); while (visited.length <= ord)
  return { ...base, queue: base.queue.filter((url) => !since.some(([saved]) => saved === url)), visited, captured: pages.length }
}

export async function claimJob(db: D1Database): Promise<Job | null> {
  const ts = now()
  const stale = staleBefore(ts)
  const token = () => crypto.randomUUID().replace(/-/g, "")
  const candidate = `SELECT id FROM refs WHERE (status = 'queued' AND coalesce(capture_control, '') != 'paused') OR (${STALE_CAPTURE}) ORDER BY created_at LIMIT 1`
  // D1 batches are transactions. Record the old namespace before the claim replaces the attempt.
  const results = await db.batch([
    ...settleAbandoned(db, ts),
    db.prepare(`INSERT OR IGNORE INTO capture_cleanup (prefix) SELECT 'refs/' || id || '/' || coalesce(capture_attempt || '/', 'p') FROM refs WHERE id = (${candidate}) AND NOT ${HAS_PAGES}`).bind(stale),
    // Every claim, a stale reclaim and a resume included, issues a new lease: the attempt only names the files.
    db.prepare(`UPDATE refs SET stale_reclaims = stale_reclaims + (status = 'capturing'), status = 'capturing', claimed_at = ?2, updated_at = ?2, capture_lease = ?4,
      capture_attempt = CASE WHEN ${HAS_PAGES} THEN capture_attempt ELSE ?1 END, progress = CASE WHEN ${HAS_PAGES} THEN 'Resuming capture' ELSE 'Starting capture' END
      WHERE id = (${candidate.replace("?", "?3")}) RETURNING id, url, mode, max_pages, capture_attempt, capture_lease, capture_options, crawl_state,
      (SELECT json_group_array(json_array(url, ord)) FROM (SELECT url, ord FROM pages WHERE reference_id = refs.id ORDER BY ord)) AS pages`).bind(token(), ts, stale, token()),
  ])
  const r = results[results.length - 1]?.results[0] as Row | undefined
  if (!r) return null
  const pages = parse<[string, number][]>(r.pages) ?? []
  return {
    id: r.id as string,
    url: r.url as string,
    mode: r.mode as CaptureMode,
    maxPages: r.max_pages as number,
    attempt: r.capture_attempt as string,
    lease: r.capture_lease as string,
    resume: pages.length ? resumeState(parse<CrawlState>(r.crawl_state), pages) : null,
    options: parse<CaptureOptions>(r.capture_options),
  }
}

// Admission and reference state are checked atomically, before any R2 write.
export async function beginUpload(db: D1Database, id: string, lease: string, key: string) {
  const upload = crypto.randomUUID()
  const result = await db.prepare(`INSERT INTO capture_uploads (id, object_key)
    SELECT ?, ? WHERE EXISTS (SELECT 1 FROM refs WHERE id = ? AND status = 'capturing' AND capture_lease = ?)`)
    .bind(upload, key, id, lease).run()
  return result.meta.changes ? upload : null
}

export async function finishUpload(db: D1Database, upload: string) {
  await db.prepare(`DELETE FROM capture_uploads WHERE id = ?`).bind(upload).run()
}

export async function isCapturing(db: D1Database, id: string, lease: string) {
  return !!(await db.prepare(`SELECT 1 FROM refs WHERE id = ? AND status = 'capturing' AND capture_lease = ?`).bind(id, lease).first())
}

/** The file namespace of the capture this lease holds; null once another claim or a finish has taken it. */
export async function leasedAttempt(db: D1Database, id: string, lease: string) {
  const r = await db.prepare(`SELECT capture_attempt FROM refs WHERE id = ? AND status = 'capturing' AND capture_lease = ?`).bind(id, lease).first<Row>()
  return (r?.capture_attempt as string | undefined) ?? null
}

export async function setProgress(db: D1Database, id: string, lease: string, progress: string) {
  const result = await db.prepare(`UPDATE refs SET progress = ?, claimed_at = ?, updated_at = ? WHERE id = ? AND status = 'capturing' AND capture_lease = ?`).bind(progress.slice(0, 300), now(), now(), id, lease).run()
  return result.meta.changes > 0
}

export async function renewLease(db: D1Database, id: string, lease: string) {
  const result = await db.prepare(`UPDATE refs SET claimed_at = ? WHERE id = ? AND status = 'capturing' AND capture_lease = ?`).bind(now(), id, lease).run()
  return result.meta.changes > 0
}

export async function addPage(db: D1Database, referenceId: string, lease: string, p: PageUpload) {
  const pageId = newId()
  const ts = now()
  const stmts = [
    db
      .prepare(
        `INSERT INTO pages (id, reference_id, url, path, title, ord, desktop_key, desktop_thumb_key, desktop_width, desktop_height,
          mobile_key, mobile_thumb_key, mobile_width, mobile_height, snapshot_key, styles_key, tokens_json, sections_json, alt_scheme_json, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM refs WHERE id = ? AND status = 'capturing' AND capture_lease = ?)`,
      )
      .bind(
        pageId, referenceId, p.url, p.path, p.title, p.ord,
        p.desktopKey, p.desktopThumbKey, p.desktopWidth, p.desktopHeight,
        p.mobileKey, p.mobileThumbKey, p.mobileWidth, p.mobileHeight,
        p.snapshotKey, p.stylesKey, p.tokens ? JSON.stringify(p.tokens) : null, Array.isArray(p.sections) ? JSON.stringify(p.sections) : null, p.altScheme ? JSON.stringify(p.altScheme) : null, ts, referenceId, lease,
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
          cover_key = coalesce(cover_key, ?2), crawl_state = coalesce(?5, crawl_state), stale_reclaims = 0, updated_at = ?3 WHERE id = ?1 AND status = 'capturing' AND capture_lease = ?4`,
      )
      .bind(referenceId, p.desktopThumbKey, ts, lease, p.state ? JSON.stringify(p.state) : null),
  )
  const results = await db.batch(stmts)
  return results[0]?.meta.changes ? pageId : null
}

export async function completeJob(db: D1Database, id: string, lease: string, c: JobComplete) {
  const result = await db
    .prepare(
      `UPDATE refs SET status = 'ready', progress = NULL, error = NULL, capture_control = NULL, capture_lease = NULL, crawl_state = NULL, title = coalesce(?, title), description = coalesce(?, description),
        favicon = coalesce(?, favicon), cover_key = coalesce(?, cover_key), tokens_json = ?, updated_at = ? WHERE id = ? AND status = 'capturing' AND capture_lease = ?`,
    )
    .bind(c.title, c.description, c.favicon, c.coverKey, c.tokens ? JSON.stringify(c.tokens) : null, now(), id, lease)
    .run()
  return result.meta.changes > 0
}

export async function failJob(db: D1Database, id: string, lease: string, error: string) {
  const result = await db.prepare(`UPDATE refs SET status = 'failed', progress = NULL, error = ?, capture_control = NULL, capture_lease = NULL, crawl_state = NULL, updated_at = ? WHERE id = ? AND status = 'capturing' AND capture_lease = ?`).bind(error.slice(0, 1000), now(), id, lease).run()
  return result.meta.changes > 0
}

// ---------- Pause, resume and stop ----------
// The agent finishes the page it is on, then asks for its control before the next one.


/** Pause a capture. A queued one pauses now; a running one pauses after its current page, or now when its agent is already gone. */
export async function requestPause(db: D1Database, id: string) {
  const ts = now()
  const [queued, running] = await db.batch([
    db.prepare(`UPDATE refs SET capture_control = 'paused', progress = 'Paused', updated_at = ? WHERE id = ? AND status = 'queued' AND capture_control IS NULL`).bind(ts, id),
    db.prepare(`UPDATE refs SET capture_control = 'pause', updated_at = ? WHERE id = ? AND status = 'capturing' AND capture_control IS NULL`).bind(ts, id),
    ...settleAbandoned(db, ts, id),
  ])
  return !!(queued!.meta.changes || running!.meta.changes)
}

/** Resume a paused capture, or cancel a pause that has not taken effect yet. */
export async function resumeReference(db: D1Database, id: string) {
  const ts = now()
  const [paused, pending] = await db.batch([
    db.prepare(`UPDATE refs SET capture_control = NULL, progress = '${WAITING}', updated_at = ? WHERE id = ? AND status = 'queued' AND capture_control = 'paused'`).bind(ts, id),
    db.prepare(`UPDATE refs SET capture_control = NULL, updated_at = ? WHERE id = ? AND status = 'capturing' AND capture_control = 'pause'`).bind(ts, id),
  ])
  return !!(paused!.meta.changes || pending!.meta.changes)
}

/**
 * Stop a capture and keep the pages it has. A running one stops after its current page.
 * A paused one (or one resumed but not picked up yet) finishes here, from the metadata and tokens saved when it paused,
 * and so does a running one whose agent is already gone.
 */
export async function requestStop(db: D1Database, id: string) {
  const ts = now()
  const results = await db.batch([
    ...settleStopped(db, `id = ? AND status = 'queued'`, [id], ts),
    db.prepare(`UPDATE refs SET capture_control = 'stop', updated_at = ? WHERE id = ? AND status = 'capturing'`).bind(ts, id),
    ...settleAbandoned(db, ts, id),
  ])
  return results.some((r) => r.meta.changes > 0)
}

/** What the agent should do before its next page. Null means the job is gone. */
export async function getControl(db: D1Database, id: string, lease: string): Promise<{ control: CaptureControl | null } | null> {
  const r = await db.prepare(`SELECT capture_control FROM refs WHERE id = ? AND status = 'capturing' AND capture_lease = ?`).bind(id, lease).first<Row>()
  if (!r) return null
  return { control: r.capture_control === "pause" || r.capture_control === "stop" ? r.capture_control : null }
}

/**
 * The agent pauses at a page boundary and hands back where it was. Only applies while a pause is
 * still requested, so a stop or resume that arrived meanwhile wins: "changed" tells the agent to check again.
 * With `release` the agent itself is stopping: when nothing is requested the capture goes back to the queue, to be resumed by the next claim.
 */
export async function pauseJob(db: D1Database, id: string, lease: string, state: CrawlState, release = false): Promise<"paused" | "changed" | "gone"> {
  const result = await db.prepare(`UPDATE refs SET status = 'queued', crawl_state = ?1, claimed_at = NULL, capture_lease = NULL, updated_at = ?2,
    progress = CASE WHEN capture_control = 'pause' THEN 'Paused' ELSE '${WAITING}' END, capture_control = CASE WHEN capture_control = 'pause' THEN 'paused' END
    WHERE id = ?3 AND status = 'capturing' AND capture_lease = ?4 AND (capture_control = 'pause' OR (?5 AND capture_control IS NULL))`).bind(JSON.stringify(state), now(), id, lease, release ? 1 : 0).run()
  if (result.meta.changes) return "paused"
  return (await isCapturing(db, id, lease)) ? "changed" : "gone"
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

/** Bytes stored in R2, counted from paginated Class A listings (no downloads). */
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
      // Queued means waiting for the capture agent, whether it is busy or absent.
      // The phrase matches the gallery card, so an agent relays it verbatim.
      if (freshness === "recent") {
        advice =
          activity === "busy"
            ? `${WAITING}: it is finishing another job and will pick this up next.`
            : `${WAITING}: it is online and should pick this up shortly.`
        pollAfterSeconds = activity === "busy" ? 60 : 15
      } else {
        advice =
          freshness === "never"
            ? `${WAITING}: none has ever contacted Snip. Ask the user to run \`npm run capture\` on their Mac. Stop polling until they do.`
            : `${WAITING}: it was last seen ${secondsSinceSeen}s ago and is probably not running. Ask the user to start \`npm run capture\`. Stop polling until they do.`
      }
      break
    case "capturing": {
      if (freshness !== "recent") {
        advice = `The capture was in progress but the worker has not been seen for ${secondsSinceSeen ?? "?"}s. It may have stopped; it will be retried when a worker reconnects. Ask the user to check \`npm run capture\`.`
      } else if (currentJobId && currentJobId !== ref.id) {
        advice = "The worker is online but busy with a different job; this capture may have been interrupted and will be retried."
        pollAfterSeconds = 60
      } else {
        // A heartbeat renews claimed_at, so a worker that is online never leaves its capture silent past the stale window.
        advice = "Capturing. Progress shows the current page."
        pollAfterSeconds = 20
      }
      break
    }
  }
  return {
    state: ref.status,
    progress: ref.progress,
    error: ref.error,
    // claimed_at is refreshed on every heartbeat and progress report, so it is the last sign of life, not the attempt start.
    lastProgressAt: ref.status === "capturing" ? ref.claimedAt : null,
    worker: { lastSeenAt, secondsSinceSeen, freshness, activity, currentJobId },
    pollAfterSeconds,
    advice,
  }
}

// ---------- Owner and library counts (cloud status and the transfer surface) ----------

export type LibraryCounts = { refs: number; pages: number; animations: number; collections: number; images: number }

export async function libraryCounts(db: D1Database): Promise<LibraryCounts> {
  const row = await db
    .prepare(
      `SELECT (SELECT count(*) FROM refs) AS refs, (SELECT count(*) FROM pages) AS pages,
              (SELECT count(*) FROM animations) AS animations, (SELECT count(*) FROM collections) AS collections,
              (SELECT count(*) FROM images) AS images`,
    )
    .first<LibraryCounts>()
  return row ?? { refs: 0, pages: 0, animations: 0, collections: 0, images: 0 }
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

// Tables a move copies as schema but never as rows, named in the manifest rather than silently
// dropped, so the engine can skip them instead of inferring which numbers may differ.
//
// - owner_nonces, webauthn_challenges: short-lived and single-use. Copying them would carry live
//   nonces across a trust boundary, and their counts move for reasons a copy cannot reproduce.
// - d1_migrations: the destination writes its own ledger by applying migrations before the dump
//   is loaded (contracts §4.5). Replaying the source's rows clashes on the primary key, and even
//   when it does not, the ledger would not describe the schema actually applied. This one is also
//   why a version skew breaks pulls: an older remote has fewer ledger rows than the freshly
//   migrated staged copy, so comparing them fails a correct copy forever.
//
// `owners` and `passkeys` are deliberately absent: they are the owner's credentials and must
// survive a move or a pull.
const EPHEMERAL_TABLES = new Set(["owner_nonces", "webauthn_challenges", "d1_migrations"])

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
