import type { Animation, DesignTokens, Page, Reference } from "../../shared/types"

export interface PromptSelection {
  reference: Reference
  pages: Page[]
  animations: Animation[]
  /** Include the design tokens inline and point the agent at them. */
  tokens: boolean
}

const top = <T extends { count: number }>(xs: T[] | undefined, n: number) => (xs ?? []).slice(0, n)

/** A compact, paste-friendly digest of the tokens; the full set stays one get_reference call away. */
export function tokenDigest(t: DesignTokens): string {
  const line = (label: string, values: string[]) => (values.length ? `- ${label}: ${values.join(", ")}` : null)
  return [
    line("Colors", top(t.colors, 12).map((c) => c.value)),
    line("Fonts", top(t.fonts, 4).map((f) => f.family)),
    line("Type scale", top(t.fontSizes, 10).map((f) => f.value)),
    line("Spacing", top(t.spacing, 10).map((s) => s.value)),
    line("Radii", top(t.radii, 6).map((r) => r.value)),
    line("Shadows", top(t.shadows, 3).map((s) => s.value)),
    line("Transitions", top(t.transitions, 4).map((s) => s.value)),
    t.keyframes?.length ? `- Keyframes: ${t.keyframes.length} (full CSS in get_reference)` : null,
    Object.keys(t.cssVariables ?? {}).length ? `- CSS variables: ${Object.keys(t.cssVariables).length} (full list in get_reference)` : null,
  ]
    .filter(Boolean)
    .join("\n")
}

/**
 * Prewritten prompt that tells an agent exactly which Snip items to pull over MCP and what to study.
 * Tool names and arguments match web/worker/mcp.ts.
 */
export function buildAgentPrompt({ reference: r, pages, animations, tokens }: PromptSelection, allPages: Page[] = pages): string {
  const name = r.title || r.domain
  const pagePath = (id: string | null) => allPages.find((p) => p.id === id)?.path ?? null
  const out: string[] = [
    `Use the Snip MCP server to pull these design references before you design or build anything.`,
    ``,
    `Reference: ${name} (${r.url})`,
    `Snip reference id: ${r.id}`,
    ``,
    `1. Call get_reference with id "${r.id}" once. It returns the design tokens, every page and every animation GIF as signed URLs (valid 24 hours).`,
  ]
  let step = 2
  if (pages.length) {
    out.push(
      `${step++}. For each page below, call get_page with include_styles: true to see the screenshot and the computed styles. Add image: "mobile" when responsive behaviour matters, and include_html: true only if you need the markup.`,
      ...pages.map((p) => `   - ${p.title || p.path} (${p.path}): page_id "${p.id}"`),
    )
  }
  if (animations.length) {
    out.push(
      `${step++}. Study these animations. Find each by id in the get_reference result and open its GIF URL:`,
      ...animations.map((a) => {
        const where = pagePath(a.pageId)
        return `   - ${a.kind === "scroll" ? "Scroll" : "Hover"}${a.label ? ` "${a.label}"` : ""}${where ? ` on ${where}` : ""}: animation_id "${a.id}" (${a.width}×${a.height})`
      }),
    )
  }
  if (tokens && r.tokens) {
    out.push(
      `${step++}. Treat these design tokens as the source of truth (most used first). The full set, including keyframes and CSS variables, is in get_reference:`,
      tokenDigest(r.tokens)
        .split("\n")
        .map((l) => `   ${l}`)
        .join("\n"),
    )
  }
  out.push(
    ``,
    `What to look for:`,
    ...[
      pages.length && `- Layout: grid, container widths, section rhythm and spacing between elements`,
      (pages.length || tokens) && `- Typography: font pairing, type scale, weights, line heights and letter spacing`,
      (pages.length || tokens) && `- Color: palette, how accents and neutrals are used, contrast`,
      pages.length && `- Components: buttons, cards, navigation and forms (radius, borders, shadows, states)`,
      (animations.length || tokens) && `- Motion: easing, durations, scroll reveals and hover states`,
    ].filter(Boolean) as string[],
    ``,
    `Only pull the items listed above. Don't fetch other Snip references unless I ask.`,
  )
  return out.join("\n")
}
