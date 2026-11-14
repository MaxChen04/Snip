import type { Reference } from "../../shared/types"

/**
 * What the capture agent reports while it works on a page: "Capturing 7/25: /enterprise", or "Capturing page 1: /" while a
 * crawl has not yet found how many pages it will take, so there is no total (and no fraction) to show. Null for a capture that
 * is not on a page.
 */
export function parseProgress(r: Pick<Reference, "status" | "progress">) {
  const m = r.status === "capturing" ? r.progress?.match(/^Capturing (?:(\d+)\/(\d+)|page (\d+)): (.+)$/) : null
  return m ? { n: Number(m[1] ?? m[3]), total: m[2] ? Number(m[2]) : null, path: m[4]! } : null
}
