import type { Page, Reference, RefSummary } from "../shared/types"
import { childWhere, PAGE_COLLECTIONS, REF_SELECT, referenceWhere, refSummary, toPage, toReference, type ListFilter, type Row } from "./db"

// Relevance search for agents (search_references and search_pages with a query). The gallery's own
// filter stays a plain substring match in db.ts.
//
// A query is split into terms, and a reference or page is ranked first by how many terms it matches
// anywhere, then by where they matched. Where a term matched is a bit, so a term's score is a bitmask
// whose order is the ranking: the user's note on the website outranks a section label, which
// outranks the page title or path, the website's own title, URL or description, and last the page's
// visible text. Results say which terms matched and where, the section that matched best, and a short
// excerpt, so an agent can tell a strong hit from a weak one before opening it.
//
// ponytail: each term is a LIKE scan over the library's pages (one row read per page per search). FTS5
// would index it, but `wrangler d1 export`, which moves and backs up a library, refuses virtual tables.
// An inverted-index table is the upgrade if libraries outgrow a scan.

export const FIELDS = { notes: 16, section_labels: 8, page_title: 4, site: 2, page_text: 1 } as const
export type MatchField = keyof typeof FIELDS

export interface SearchMatch {
  /** Query terms (lowercased, crudely stemmed) that matched, and those that matched nowhere. */
  matched: string[]
  unmatched: string[]
  /** Where any term matched, strongest first. */
  in: MatchField[]
}

export interface PageHit {
  page: Page
  reference: RefSummary
  /** The website's note: why the user saved it. */
  notes: string | null
  match: SearchMatch
  /** The section whose label or text matched the most terms: pass its index to get_page(page_id, section). */
  section: { index: number; label: string } | null
  /** A few lines of the page's text around the first term that matched it. */
  excerpt: string | null
}

export interface ReferenceHit {
  reference: Reference
  match: SearchMatch
  /** The page of this website that matched best, when any page matched. */
  bestPage: { id: string; path: string } | null
}

const MAX_TERMS = 8
const STOP = new Set([
  "a", "an", "the", "and", "or", "of", "for", "with", "to", "in", "on", "at", "by", "from", "as", "is", "it", "its",
  "my", "me", "i", "we", "our", "you", "your", "us", "are", "be", "can", "do", "how", "what", "which", "this", "that", "these", "those", "some", "any", "like", "use", "using", "find", "show",
])

/** Crude suffix stripping, so a substring match on the stem also finds the other forms (cards, card; pricing, price). */
function stem(w: string) {
  if (w.length > 6 && w.endsWith("ing")) return w.slice(0, -3)
  if (w.length > 5 && w.endsWith("ies")) return w.slice(0, -3)
  if (w.length > 5 && w.endsWith("ed")) return w.slice(0, -2)
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1)
  return w
}

/** The terms a query is matched by: words of two or more letters or digits, without stop words, at most eight. */
export function searchTerms(query: string): string[] {
  const out: string[] = []
  for (const w of query.toLowerCase().normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (w.length < 2 || STOP.has(w)) continue
    const t = stem(w)
    if (!out.includes(t)) out.push(t)
    if (out.length === MAX_TERMS) break
  }
  return out
}

function decodeMatch(terms: string[], masks: number[]): SearchMatch {
  const all = masks.reduce((a, m) => a | m, 0)
  return {
    matched: terms.filter((_, i) => masks[i]! > 0),
    unmatched: terms.filter((_, i) => !masks[i]),
    in: (Object.keys(FIELDS) as MatchField[]).filter((f) => all & FIELDS[f]),
  }
}

/** Numbered placeholders, so one bound term serves every field it is compared with. */
function binder() {
  const args: unknown[] = []
  const bind = (v: unknown) => `?${args.push(v)}`
  /** db.ts filters use plain `?`; renumber them in order. */
  const adopt = (where: string[], values: unknown[]) => {
    let i = 0
    return where.map((w) => w.replace(/\?/g, () => bind(values[i++])))
  }
  return { args, bind, adopt }
}

const like = (t: string) => `%${t}%`
const offsetFrom = (cursor?: string | null) => {
  try {
    const m = cursor ? /^rel:(\d+)$/.exec(atob(cursor)) : null
    return m ? Number(m[1]) : 0
  } catch {
    return 0
  }
}
const cursorAt = (offset: number) => btoa(`rel:${offset}`)

/** Ties go to the newest website, and within one website to its earlier pages (the start page first). */
const rankSql = (n: number, tie: string) => {
  const cols = Array.from({ length: n }, (_, i) => `m${i}`)
  return {
    cols: cols.join(", "),
    any: cols.join(" + ") + " > 0",
    order: `${cols.map((c) => `(${c} > 0)`).join(" + ")} DESC, ${cols.join(" + ")} DESC, ${tie}`,
  }
}

/** A term's bitmask for one page; `t` is the page, `r` its website, `x` its page_text row. */
const pageMask = (p: string) =>
  `(CASE WHEN r.notes LIKE ${p} THEN 16 ELSE 0 END + CASE WHEN x.sections LIKE ${p} THEN 8 ELSE 0 END` +
  ` + CASE WHEN t.title LIKE ${p} OR t.path LIKE ${p} THEN 4 ELSE 0 END` +
  ` + CASE WHEN r.title LIKE ${p} OR r.url LIKE ${p} OR r.description LIKE ${p} THEN 2 ELSE 0 END + CASE WHEN x.body LIKE ${p} THEN 1 ELSE 0 END)`

export async function searchPages(
  db: D1Database,
  f: ListFilter & { q: string },
): Promise<{ items: PageHit[]; nextCursor: string | null; terms: string[] }> {
  const terms = searchTerms(f.q)
  const limit = Math.min(Math.max(f.limit ?? 20, 1), 100)
  const offset = offsetFrom(f.cursor)
  const { args, bind, adopt } = binder()
  const params = terms.map((t) => bind(like(t)))
  const base = childWhere("pages", { collectionId: f.collectionId, referenceId: f.referenceId })
  const where = adopt(base.where, base.args)
  const rank = rankSql(terms.length, "ref_created DESC, reference_id DESC, ord, id")
  const { results } = await db
    .prepare(
      `SELECT id, ${rank.cols} FROM (SELECT t.id, t.reference_id, t.ord, r.created_at AS ref_created, ${params.map((p, i) => `${pageMask(p)} AS m${i}`).join(", ")}
        FROM pages t JOIN refs r ON r.id = t.reference_id LEFT JOIN page_text x ON x.page_id = t.id
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""})
      WHERE ${rank.any} ORDER BY ${rank.order} LIMIT ${bind(limit + 1)} OFFSET ${bind(offset)}`,
    )
    .bind(...args)
    .all<Row>()
  const ranked = results.slice(0, limit)
  if (!ranked.length) return { items: [], nextCursor: null, terms }

  // Details only for the pages returned: the excerpt and the best section.
  const d = binder()
  const dp = terms.map((t) => d.bind(like(t)))
  const lower = terms.map((t) => d.bind(t))
  const sectionScore = dp.map((p) => `(CASE WHEN json_extract(l.value, '$.label') LIKE ${p} OR json_extract(l.value, '$.kind') LIKE ${p} THEN 2 ELSE 0 END + CASE WHEN st.value LIKE ${p} THEN 1 ELSE 0 END)`).join(" + ")
  const ids = ranked.map((r) => d.bind(r.id))
  const { results: rows } = await db
    .prepare(
      `SELECT t.*, r.title AS ref_title, r.domain AS ref_domain, r.favicon AS ref_favicon, r.notes AS ref_notes, ${PAGE_COLLECTIONS},
        CASE WHEN x.body IS NULL THEN NULL ELSE substr(x.body, max(1, coalesce(${lower.map((p) => `nullif(instr(lower(x.body), ${p}), 0)`).join(", ")}, 1) - 80), 240) END AS excerpt,
        (SELECT k FROM (SELECT l.key AS k, ${sectionScore} AS sc FROM json_each(coalesce(t.sections_json, '[]')) l
          LEFT JOIN json_each(coalesce(x.section_text_json, '[]')) st ON st.key = l.key) WHERE sc > 0 ORDER BY sc DESC, k LIMIT 1) AS best_section
      FROM pages t JOIN refs r ON r.id = t.reference_id LEFT JOIN page_text x ON x.page_id = t.id WHERE t.id IN (${ids.join(", ")})`,
    )
    .bind(...d.args)
    .all<Row>()
  const byId = new Map(rows.map((r) => [r.id as string, r]))
  const items: PageHit[] = []
  for (const hit of ranked) {
    const r = byId.get(hit.id as string)
    if (!r) continue // deleted between the two reads
    const page = toPage({ ...r, tokens_json: null })
    const best = r.best_section == null ? null : Number(r.best_section)
    const section = best != null && page.sections[best] ? { index: best, label: page.sections[best]!.label } : null
    const match = decodeMatch(terms, terms.map((_, i) => Number(hit[`m${i}`])))
    // Only when a term is in the text: otherwise the start of the page says nothing about the match.
    const excerpt = match.in.includes("page_text") && typeof r.excerpt === "string" ? r.excerpt.replace(/\s+/g, " ").trim() || null : null
    items.push({
      page,
      reference: refSummary(r),
      notes: (r.ref_notes as string | null) ?? null,
      match,
      section,
      excerpt,
    })
  }
  return { items, nextCursor: results.length > limit ? cursorAt(offset + limit) : null, terms }
}

export async function searchReferences(
  db: D1Database,
  f: ListFilter & { q: string },
): Promise<{ items: ReferenceHit[]; nextCursor: string | null; terms: string[] }> {
  const terms = searchTerms(f.q)
  const limit = Math.min(Math.max(f.limit ?? 20, 1), 100)
  const offset = offsetFrom(f.cursor)
  const { args, bind, adopt } = binder()
  const params = terms.map((t) => bind(like(t)))
  const base = referenceWhere({ collectionId: f.collectionId, domain: f.domain, status: f.status })
  const where = adopt(base.where, base.args)
  const mask = (p: string) =>
    `(CASE WHEN r.notes LIKE ${p} THEN 16 ELSE 0 END` +
    ` + CASE WHEN EXISTS (SELECT 1 FROM page_text x WHERE x.reference_id = r.id AND x.sections LIKE ${p}) THEN 8 ELSE 0 END` +
    ` + CASE WHEN EXISTS (SELECT 1 FROM pages t WHERE t.reference_id = r.id AND (t.title LIKE ${p} OR t.path LIKE ${p})) THEN 4 ELSE 0 END` +
    ` + CASE WHEN r.title LIKE ${p} OR r.url LIKE ${p} OR r.description LIKE ${p} THEN 2 ELSE 0 END` +
    ` + CASE WHEN EXISTS (SELECT 1 FROM page_text x WHERE x.reference_id = r.id AND x.body LIKE ${p}) THEN 1 ELSE 0 END)`
  const rank = rankSql(terms.length, "created_at DESC, id DESC")
  const { results } = await db
    .prepare(
      `SELECT id, ${rank.cols} FROM (SELECT r.id, r.created_at, ${params.map((p, i) => `${mask(p)} AS m${i}`).join(", ")} FROM refs r
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""})
      WHERE ${rank.any} ORDER BY ${rank.order} LIMIT ${bind(limit + 1)} OFFSET ${bind(offset)}`,
    )
    .bind(...args)
    .all<Row>()
  const ranked = results.slice(0, limit)
  if (!ranked.length) return { items: [], nextCursor: null, terms }

  const d = binder()
  const dp = terms.map((t) => d.bind(like(t)))
  const pageScore = dp.map((p, i) => `(CASE WHEN x.sections LIKE ${p} THEN 8 ELSE 0 END + CASE WHEN t.title LIKE ${p} OR t.path LIKE ${p} THEN 4 ELSE 0 END + CASE WHEN x.body LIKE ${p} THEN 1 ELSE 0 END) AS s${i}`)
  const cols = terms.map((_, i) => `s${i}`)
  const ids = ranked.map((r) => d.bind(r.id))
  const { results: rows } = await db
    .prepare(
      `SELECT * FROM (${REF_SELECT} WHERE r.id IN (${ids.join(", ")})) refs_hit LEFT JOIN (
        SELECT reference_id AS best_ref, id AS best_page_id, path AS best_page_path FROM (
          SELECT t.reference_id, t.id, t.path, row_number() OVER (PARTITION BY t.reference_id ORDER BY ${cols.map((c) => `(${c} > 0)`).join(" + ")} DESC, ${cols.join(" + ")} DESC, t.ord) AS n
          FROM (SELECT t.reference_id, t.id, t.path, t.ord, ${pageScore.join(", ")} FROM pages t LEFT JOIN page_text x ON x.page_id = t.id
            WHERE t.reference_id IN (${ids.join(", ")})) t WHERE ${cols.join(" + ")} > 0)
        WHERE n = 1) best ON best.best_ref = refs_hit.id`,
    )
    .bind(...d.args)
    .all<Row>()
  const byId = new Map(rows.map((r) => [r.id as string, r]))
  const items: ReferenceHit[] = []
  for (const hit of ranked) {
    const r = byId.get(hit.id as string)
    if (!r) continue
    items.push({
      reference: toReference(r),
      match: decodeMatch(terms, terms.map((_, i) => Number(hit[`m${i}`]))),
      bestPage: r.best_page_id ? { id: r.best_page_id as string, path: r.best_page_path as string } : null,
    })
  }
  return { items, nextCursor: results.length > limit ? cursorAt(offset + limit) : null, terms }
}
