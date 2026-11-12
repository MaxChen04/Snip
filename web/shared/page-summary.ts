import type { Page } from "./types"

/**
 * What every serializer of a captured page says about it: who it is, and what the capture agent noticed (blank, truncated).
 * The MCP tools and the exported reference.json spread this and add their own fields, so a fact added here reaches all of them.
 */
export const pageSummary = (p: Pick<Page, "id" | "url" | "path" | "title" | "warnings">) => ({ id: p.id, url: p.url, path: p.path, title: p.title, warnings: p.warnings })
