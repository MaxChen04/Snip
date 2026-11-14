import { checkSiteUrl } from "../../shared/site-url"

/** The address in `raw`, normalised, or null when it is not one. The rule, and the sentence for each way to break it, are shared/site-url.ts. */
export function parseSiteUrl(raw: string): URL | null {
  const checked = checkSiteUrl(raw)
  return "url" in checked ? checked.url : null
}

const parts = (text: string) => text.split(/[\s,]+/).filter(Boolean)
const distinct = (urls: URL[]) => [...new Map(urls.map((u) => [u.href, u])).values()]

/** The links in pasted text, whatever else it says: a sentence, one per line, or separated by spaces or commas. */
export function extractUrls(text: string): URL[] {
  return distinct(parts(text).flatMap((part) => parseSiteUrl(part) ?? []))
}

/**
 * The addresses in what was typed (separated by spaces or commas), or the sentence for the first one that is not an
 * address. Nothing is left out: a typo cannot turn into a capture of something else.
 */
export function typedUrls(text: string): { urls: URL[]; error: string | null } {
  const urls: URL[] = []
  for (const part of parts(text)) {
    const checked = checkSiteUrl(part)
    if ("error" in checked) return { urls: [], error: checked.error }
    urls.push(checked.url)
  }
  return { urls: distinct(urls), error: null }
}

/** The page caps a crawl can be set to, in the Add dialog and on the capture card. */
export const CRAWL_LIMITS = [10, 25, 50, 100]
