import type { Page, PageWarning } from "../../shared/types"

/** What a warning the capture agent put on a page says to the person looking at it. */
const WARNING_TEXT: Record<PageWarning, string> = {
  blank: "It looks blank: the site may not have loaded.",
  truncated: "The page was taller than Snip captures and was cut off.",
}

/** The sentences for one page's warnings, or an empty string when it has none. */
export const warningText = (page: Pick<Page, "warnings">) => page.warnings.map((w) => WARNING_TEXT[w]).join(" ")
