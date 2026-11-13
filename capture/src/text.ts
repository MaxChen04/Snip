import type { PageUpload } from "../../web/shared/types"

/** Characters of page text sent for search, in total and per section. The Worker enforces the same caps. */
export const TEXT_LIMITS = { body: 12_000, section: 1_500, blocks: 3_000 }

export type TextBlock = { y: number; t: string }

/**
 * A page's visible text for search: the whole page in reading order, and each section's share of it,
 * matched to sections by where the text sits on the desktop page. Repeated lines (a nav item that is also
 * a footer link) are kept once in the body so they don't crowd out the rest.
 */
export function pageText(blocks: TextBlock[], cuts: { y: number; height: number }[]): NonNullable<PageUpload["text"]> {
  const ordered = [...blocks].sort((a, b) => a.y - b.y)
  const seen = new Set<string>()
  let body = ""
  for (const b of ordered) {
    const key = b.t.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const next = body ? `${body}\n${b.t}` : b.t
    if (next.length > TEXT_LIMITS.body) break
    body = next
  }
  const sections = cuts.map((s) => {
    let text = ""
    for (const b of ordered) {
      if (b.y < s.y || b.y >= s.y + s.height) continue
      const next = text ? `${text}\n${b.t}` : b.t
      if (next.length > TEXT_LIMITS.section) break
      text = next
    }
    return text
  })
  return { body, sections }
}
