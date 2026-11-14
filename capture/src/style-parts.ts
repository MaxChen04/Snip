// A page's computed styles, split so a small MCP request reads a small part.
//
// The capture agent writes the full styles file as before, plus one "parts" file next to it: a run of independent
// gzip members (index, rules, then elements in chunks of STYLE_CHUNK_ELEMENTS), each readable on its own with an R2
// range read. The summary, with the byte range of every member, goes into the page row (pages.styles_summary_json),
// so get_page_styles "summary" reads no file at all and a selector or text search reads the index and only the
// chunks holding the matches.
//
// This file has no imports so the capture agent can carry an identical copy (capture/src/style-parts.ts): released
// apps ship capture/src without web/shared. web/tests/style-parts.test.ts keeps the two equal.

export const STYLE_PARTS_VERSION = 1
/** Elements per chunk. A get_page_styles call returns at most 200, so it touches at most two chunks. */
export const STYLE_CHUNK_ELEMENTS = 250
/** Keyframe names kept in the summary. */
const SUMMARY_KEYFRAMES = 200

export interface StyleElement {
  sel?: string
  text?: string
  [k: string]: unknown
}

export interface CapturedStyles {
  viewport?: unknown
  document?: unknown
  elementCount?: number
  truncated?: boolean
  elements?: StyleElement[]
  keyframes?: { name: string; css: string }[]
  hoverRules?: string[]
  fontFaces?: string[]
  cssVariables?: Record<string, string>
}

/** One element in the search index: its selector and own text, lowercased, or null when it has none. */
export type StyleIndexEntry = [sel: string | null, text: string | null]

export interface StyleRules {
  keyframes: { name: string; css: string }[]
  hoverRules: string[]
  fontFaces: string[]
  cssVariables: Record<string, string>
}

/** [byte offset, byte length] of one gzip member in the parts file. */
export type ByteRange = [number, number]

export interface StylesSummary {
  v: typeof STYLE_PARTS_VERSION
  viewport: unknown
  document: unknown
  elements: number
  captureTruncated: boolean
  keyframes: string[]
  keyframeCount: number
  hoverRules: number
  fontFaces: number
  cssVariables: number
  chunkSize: number
  parts: { key: string; index: ByteRange; rules: ByteRange; elements: ByteRange[] }
}

/** The parts file sits next to the styles file: styles.json or styles.gz.json -> styles-parts.gzm. */
export function stylePartsKey(stylesKey: string): string | null {
  return /(^|\/)styles(\.gz)?\.json$/.test(stylesKey) ? stylesKey.replace(/styles(\.gz)?\.json$/, "styles-parts.gzm") : null
}

const lower = (v: unknown) => (typeof v === "string" ? v.toLowerCase() : null)

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** Builds the parts file and the summary that points into it. */
export async function packStyles(styles: CapturedStyles, key: string): Promise<{ bytes: Uint8Array; summary: StylesSummary }> {
  const elements = styles.elements ?? []
  const rules: StyleRules = {
    keyframes: styles.keyframes ?? [],
    hoverRules: styles.hoverRules ?? [],
    fontFaces: styles.fontFaces ?? [],
    cssVariables: styles.cssVariables ?? {},
  }
  const index: StyleIndexEntry[] = elements.map((e) => [lower(e.sel), lower(e.text)])
  const members = [JSON.stringify(index), JSON.stringify(rules)]
  for (let i = 0; i < elements.length; i += STYLE_CHUNK_ELEMENTS) members.push(JSON.stringify(elements.slice(i, i + STYLE_CHUNK_ELEMENTS)))
  const zipped = await Promise.all(members.map(gzip))
  const ranges: ByteRange[] = []
  let at = 0
  for (const z of zipped) {
    ranges.push([at, z.byteLength])
    at += z.byteLength
  }
  const bytes = new Uint8Array(at)
  zipped.forEach((z, i) => bytes.set(z, ranges[i]![0]))
  const names = [...new Set(rules.keyframes.map((k) => k.name))]
  return {
    bytes,
    summary: {
      v: STYLE_PARTS_VERSION,
      viewport: styles.viewport ?? null,
      document: styles.document ?? null,
      elements: elements.length,
      captureTruncated: !!styles.truncated,
      keyframes: names.slice(0, SUMMARY_KEYFRAMES),
      keyframeCount: names.length,
      hoverRules: rules.hoverRules.length,
      fontFaces: rules.fontFaces.length,
      cssVariables: Object.keys(rules.cssVariables).length,
      chunkSize: STYLE_CHUNK_ELEMENTS,
      parts: { key, index: ranges[0]!, rules: ranges[1]!, elements: ranges.slice(2) },
    },
  }
}

const isRange = (r: unknown): r is ByteRange =>
  Array.isArray(r) && r.length === 2 && r.every((n) => Number.isSafeInteger(n) && n >= 0) && (r[1] as number) > 0

/** Whether an uploaded summary is well formed and points at a parts file under the capture's own prefix. */
export function validStylesSummary(s: unknown, prefix: string): s is StylesSummary {
  if (!s || typeof s !== "object") return false
  const o = s as Partial<StylesSummary>
  const p = o.parts
  const count = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0
  return o.v === STYLE_PARTS_VERSION && count(o.elements) && count(o.keyframeCount) && count(o.hoverRules) && count(o.fontFaces) && count(o.cssVariables) &&
    o.chunkSize === STYLE_CHUNK_ELEMENTS && typeof o.captureTruncated === "boolean" &&
    Array.isArray(o.keyframes) && o.keyframes.length <= SUMMARY_KEYFRAMES && o.keyframes.every((k) => typeof k === "string" && k.length <= 200) &&
    !!p && typeof p.key === "string" && p.key.startsWith(prefix) && p.key.endsWith("/styles-parts.gzm") && !p.key.includes("..") &&
    isRange(p.index) && isRange(p.rules) && Array.isArray(p.elements) &&
    p.elements.length === Math.ceil((o.elements as number) / STYLE_CHUNK_ELEMENTS) && p.elements.every(isRange) &&
    JSON.stringify(s).length <= 16_000
}
