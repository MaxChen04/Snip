// What a copied Snip prompt hands an agent, and how the Worker finds those items again after a recapture.
// The web app writes it (src/lib/agent-prompt.ts) and the MCP tool resolve_selection reads it (worker/mcp.ts).

import type { Animation, AltScheme, CaptureOptions, Page, PageSection, Reference } from "./types"

export type Viewport = "desktop" | "mobile"
export type Scheme = "light" | "dark"

/** How the user was looking at a page when they picked it: viewport, color scheme and, optionally, sections. */
export interface PageView {
  viewport: Viewport
  /** Desktop only: the color scheme shown. Absent means the scheme it was captured in. */
  scheme?: Scheme
  /** Indexes into page.sections. Absent or empty means the whole page. */
  sections?: number[]
}

/** The color scheme a page's main screenshots were taken in. */
export const capturedScheme = (alt: AltScheme | null, options: CaptureOptions | null): Scheme =>
  alt ? (alt.scheme === "dark" ? "light" : "dark") : (options?.colorScheme ?? "light")

/** Ids plus everything needed to find each item again when a recapture gives it a new id. */
export interface CopiedSelection {
  reference_id: string
  capture_run: number
  pages?: CopiedPage[]
  animations?: CopiedAnimation[]
  tokens?: boolean
}
export interface CopiedPage {
  page_id: string
  path: string
  viewport?: Viewport
  scheme?: Scheme
  sections?: CopiedSection[]
}
export interface CopiedSection {
  index: number
  kind: PageSection["kind"]
  label: string
}
export interface CopiedAnimation {
  animation_id: string
  kind: Animation["kind"]
  viewport: Viewport
  label: string | null
  selector: string | null
  page_path: string | null
}

/** A page view as it goes into a prompt: the scheme always spelled out, sections with their labels. */
export function copiedPage(p: Page, view: PageView | undefined, options: CaptureOptions | null): CopiedPage {
  const viewport = view?.viewport === "mobile" && p.mobileKey ? "mobile" : "desktop"
  const captured = capturedScheme(p.altScheme, options)
  const scheme = viewport === "desktop" && view?.scheme && (view.scheme === captured || p.altScheme?.scheme === view.scheme) ? view.scheme : captured
  const sections = viewport === "desktop"
    ? [...new Set(view?.sections ?? [])].sort((a, b) => a - b).flatMap((i) => (p.sections[i] ? [{ index: i, kind: p.sections[i]!.kind, label: p.sections[i]!.label }] : []))
    : []
  return { page_id: p.id, path: p.path, viewport, scheme, ...(sections.length ? { sections } : {}) }
}

export function copiedAnimation(a: Animation, pagePath: string | null): CopiedAnimation {
  return { animation_id: a.id, kind: a.kind, viewport: a.viewport, label: a.label, selector: a.selector, page_path: pagePath }
}

// ---------- Resolving after a recapture ----------

/**
 * Each item is found by its key, never by position or by the nearest likely candidate:
 * unchanged: the id still exists in the current capture.
 * recaptured: the id is gone, and exactly one item in the new capture has the same key.
 * missing: nothing in the current capture has that key.
 * ambiguous: more than one item has that key; the candidates are listed and none is chosen.
 * unavailable: the page was found, but not in the viewport or color scheme that was picked.
 */
export type ItemStatus = "unchanged" | "recaptured" | "missing" | "ambiguous" | "unavailable"
export type SectionStatus = "found" | "missing" | "ambiguous"

const normPath = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p)
const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase()

/** All items with this key: one is a match, none is missing, more is ambiguous. */
function unique<T>(candidates: T[]): { status: "found"; item: T } | { status: "missing" } | { status: "ambiguous"; candidates: T[] } {
  if (candidates.length === 1) return { status: "found", item: candidates[0]! }
  return candidates.length ? { status: "ambiguous", candidates } : { status: "missing" }
}

export function resolveSelection(sel: CopiedSelection, current: { reference: Reference; pages: Page[]; animations: Animation[] }) {
  const { reference: r, pages, animations } = current
  const recaptured = r.captureRun !== sel.capture_run
  const pathOf = new Map(pages.map((p) => [p.id, p.path]))

  const resolvedPages = (sel.pages ?? []).map((want) => {
    const copied = { page_id: want.page_id, path: want.path }
    const same = pages.find((p) => p.id === want.page_id)
    const found = same ? { status: "found" as const, item: same } : unique(pages.filter((p) => normPath(p.path) === normPath(want.path)))
    if (found.status === "missing") return { copied, status: "missing" as ItemStatus, pageId: null }
    if (found.status === "ambiguous") return { copied, status: "ambiguous" as ItemStatus, pageId: null, candidates: found.candidates.map((p) => ({ pageId: p.id, path: p.path, title: p.title })) }
    const p = found.item

    const viewport = want.viewport ?? "desktop"
    const captured = capturedScheme(p.altScheme, r.options)
    const scheme = want.scheme ?? captured
    const unavailable = [
      !(viewport === "desktop" ? p.desktopKey : p.mobileKey) && `The current capture has no ${viewport} screenshot of this page.`,
      scheme !== captured && (viewport !== "desktop" || p.altScheme?.scheme !== scheme) && `The current capture has no ${scheme} version of this page${viewport === "mobile" ? " on mobile" : ""}; it was captured in ${captured}.`,
    ].filter(Boolean) as string[]

    // The same capture keeps its indexes; a new one is searched by kind and label.
    const sections = (want.sections ?? []).map((s) => {
      const m = same ? (p.sections[s.index] ? { status: "found" as const, item: s.index } : { status: "missing" as const }) : unique(p.sections.flatMap((x, i) => (x.kind === s.kind && norm(x.label) === norm(s.label) ? [i] : [])))
      if (m.status === "found") return { copied: s, status: "found" as SectionStatus, index: m.item, label: p.sections[m.item]!.label }
      if (m.status === "ambiguous") return { copied: s, status: "ambiguous" as SectionStatus, index: null, candidates: m.candidates.map((i) => ({ index: i, label: p.sections[i]!.label })) }
      return { copied: s, status: "missing" as SectionStatus, index: null }
    })

    const schemeArg = scheme !== captured ? `, scheme "${scheme}"` : ""
    // Nothing stands in for what wasn't found: no whole page for missing sections, no other view for an unavailable one.
    const next = unavailable.length
      ? []
      : viewport === "mobile"
        ? [`get_page(page_id "${p.id}", image "mobile")`]
        : sections.length
          ? sections.flatMap((s) => (s.index == null ? [] : [`get_page(page_id "${p.id}", section ${s.index}${schemeArg})`]))
          : [`get_page(page_id "${p.id}"${schemeArg})`]
    return {
      copied,
      status: (unavailable.length ? "unavailable" : same ? "unchanged" : "recaptured") as ItemStatus,
      pageId: p.id,
      path: p.path,
      viewport,
      scheme,
      ...(unavailable.length ? { unavailable } : {}),
      ...(sections.length ? { sections } : {}),
      next,
    }
  })

  const resolvedAnimations = (sel.animations ?? []).map((want) => {
    const copied = { animation_id: want.animation_id, kind: want.kind, label: want.label }
    const same = animations.find((a) => a.id === want.animation_id)
    // An animation's key: its page, kind, viewport, element selector and label, all equal.
    const found = same
      ? { status: "found" as const, item: same }
      : unique(
          animations.filter(
            (x) =>
              x.kind === want.kind &&
              x.viewport === want.viewport &&
              normPath(pathOf.get(x.pageId ?? "") ?? "") === normPath(want.page_path ?? "") &&
              (x.selector ?? null) === (want.selector ?? null) &&
              norm(x.label) === norm(want.label),
          ),
        )
    if (found.status === "found") return { copied, status: (same ? "unchanged" : "recaptured") as ItemStatus, animationId: found.item.id, label: found.item.label, selector: found.item.selector, next: [`get_animation(animation_id "${found.item.id}")`] }
    if (found.status === "ambiguous") return { copied, status: "ambiguous" as ItemStatus, animationId: null, candidates: found.candidates.map((a) => ({ animationId: a.id, label: a.label, selector: a.selector })) }
    return { copied, status: "missing" as ItemStatus, animationId: null }
  })

  const tokens = sel.tokens
    ? r.tokens
      ? recaptured
        ? { stale: true, note: `Token values in the prompt are from capture run ${sel.capture_run}; the reference is now on run ${r.captureRun}. Discard them and use the current values.`, next: [`get_reference(id "${r.id}", part "tokens")`] }
        : { stale: false }
      : { stale: recaptured, unavailable: r.status === "ready" ? "The current capture has no tokens." : `Capture is ${r.status}; tokens are saved when it finishes.` }
    : undefined

  const problems = [
    ...[...resolvedPages, ...resolvedAnimations].filter((x) => x.status !== "unchanged" && x.status !== "recaptured").map((x) => x.status),
    ...resolvedPages.flatMap((p) => ((p as { sections?: { status: SectionStatus }[] }).sections ?? []).filter((s) => s.status !== "found").map((s) => `section ${s.status}`)),
  ]
  const counts = Object.entries(problems.reduce<Record<string, number>>((n, k) => ({ ...n, [k]: (n[k] ?? 0) + 1 }), {})).map(([k, n]) => `${n} ${k}`)
  return {
    referenceId: r.id,
    copiedRun: sel.capture_run,
    captureRun: r.captureRun,
    recaptured,
    state: r.status,
    ...(r.status !== "ready" ? { capturing: `The reference is ${r.status}. Items may still be on their way; call again when it is ready.` } : {}),
    resolved: problems.length === 0,
    pages: resolvedPages,
    animations: resolvedAnimations,
    ...(tokens ? { tokens } : {}),
    summary: problems.length
      ? `Not everything could be recovered (${counts.join(", ")}). Fetch only what has a next call, and tell the user what is missing, ambiguous or unavailable rather than substituting something else.`
      : recaptured
        ? "Every item was found in the current capture. Use the new ids."
        : "Nothing changed since the prompt was copied.",
  }
}
