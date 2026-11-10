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
 * unchanged: the id still exists in the current capture.
 * recaptured: the id is gone, and the same item was found in the new capture under a new id.
 * missing: the id is gone and nothing in the current capture matches.
 */
export type Match = "unchanged" | "recaptured" | "missing"

const normPath = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p)
const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase()

/** Same kind and label, nearest to where it was; else the same index when its kind still matches. */
function matchSection(sections: PageSection[], want: CopiedSection, sameCapture: boolean): { index: number; how: "same" | "label" | "position" } | null {
  const at = sections[want.index]
  if (sameCapture && at) return { index: want.index, how: "same" }
  const byLabel = sections
    .map((s, index) => ({ s, index }))
    .filter(({ s }) => s.kind === want.kind && norm(s.label) === norm(want.label))
    .sort((a, b) => Math.abs(a.index - want.index) - Math.abs(b.index - want.index))[0]
  if (byLabel) return { index: byLabel.index, how: byLabel.index === want.index ? "same" : "label" }
  if (at && at.kind === want.kind && want.kind !== "section") return { index: want.index, how: "position" }
  return null
}

export function resolveSelection(sel: CopiedSelection, current: { reference: Reference; pages: Page[]; animations: Animation[] }) {
  const { reference: r, pages, animations } = current
  const recaptured = r.captureRun !== sel.capture_run
  const byId = new Map(pages.map((p) => [p.id, p]))
  const byPath = new Map(pages.map((p) => [normPath(p.path), p]))
  const pathOf = new Map(pages.map((p) => [p.id, p.path]))

  const resolvedPages = (sel.pages ?? []).map((want) => {
    const same = byId.get(want.page_id)
    const p = same ?? byPath.get(normPath(want.path))
    const match: Match = same ? "unchanged" : p ? "recaptured" : "missing"
    if (!p) return { copied: { page_id: want.page_id, path: want.path }, match, pageId: null }
    const viewport = want.viewport ?? "desktop"
    const captured = capturedScheme(p.altScheme, r.options)
    const scheme = want.scheme ?? captured
    const schemeAvailable = viewport === "desktop" ? scheme === captured || p.altScheme?.scheme === scheme : scheme === captured
    const sections = (want.sections ?? []).map((s) => {
      const m = matchSection(p.sections, s, !!same)
      return m
        ? { copied: s, index: m.index, label: p.sections[m.index]!.label, match: m.how }
        : { copied: s, index: null, match: "missing" as const }
    })
    const schemeArg = scheme !== captured && schemeAvailable ? `, scheme "${scheme}"` : ""
    const next =
      viewport === "mobile"
        ? [`get_page(page_id "${p.id}", image "mobile")`]
        : sections.some((s) => s.index != null)
          ? sections.flatMap((s) => (s.index == null ? [] : [`get_page(page_id "${p.id}", section ${s.index}${schemeArg})`]))
          : [`get_page(page_id "${p.id}"${schemeArg})`]
    return {
      copied: { page_id: want.page_id, path: want.path },
      match,
      pageId: p.id,
      path: p.path,
      viewport: { requested: viewport, available: viewport === "desktop" ? !!p.desktopKey : !!p.mobileKey },
      scheme: { requested: scheme, captured, available: schemeAvailable },
      ...(sections.length ? { sections } : {}),
      ...(sections.length && !p.sectionsCaptured ? { sectionsUnavailable: "The current capture has no sections for this page." } : {}),
      next,
    }
  })

  const resolvedAnimations = (sel.animations ?? []).map((want) => {
    const same = animations.find((a) => a.id === want.animation_id)
    let a = same
    if (!a) {
      const candidates = animations.filter(
        (x) => x.kind === want.kind && x.viewport === want.viewport && normPath(pathOf.get(x.pageId ?? "") ?? "") === normPath(want.page_path ?? ""),
      )
      a =
        candidates.find((x) => want.selector && x.selector === want.selector && norm(x.label) === norm(want.label)) ??
        candidates.find((x) => want.selector && x.selector === want.selector) ??
        candidates.find((x) => want.label && norm(x.label) === norm(want.label)) ??
        // A page records one scroll animation per viewport, so kind, viewport and page pin it down.
        (want.kind === "scroll" && candidates.length === 1 ? candidates[0] : undefined)
    }
    const match: Match = same ? "unchanged" : a ? "recaptured" : "missing"
    return {
      copied: { animation_id: want.animation_id, kind: want.kind, label: want.label },
      match,
      animationId: a?.id ?? null,
      ...(a ? { label: a.label, selector: a.selector, next: [`get_animation(animation_id "${a.id}")`] } : {}),
    }
  })

  const tokens = sel.tokens
    ? r.tokens
      ? recaptured
        ? { stale: true, note: `Token values in the prompt are from capture run ${sel.capture_run}; the reference is now on run ${r.captureRun}. Discard them and use the current values.`, next: [`get_reference(id "${r.id}", part "tokens")`] }
        : { stale: false }
      : { stale: recaptured, unavailable: r.status === "ready" ? "The current capture has no tokens." : `Capture is ${r.status}; tokens are saved when it finishes.` }
    : undefined

  const missing = [...resolvedPages, ...resolvedAnimations].filter((x) => x.match === "missing").length
  return {
    referenceId: r.id,
    copiedRun: sel.capture_run,
    captureRun: r.captureRun,
    recaptured,
    state: r.status,
    ...(r.status !== "ready" ? { capturing: `The reference is ${r.status}. Items may still be on their way; call again when it is ready.` } : {}),
    pages: resolvedPages,
    animations: resolvedAnimations,
    ...(tokens ? { tokens } : {}),
    summary: missing
      ? `${missing} item${missing === 1 ? "" : "s"} could not be found in the current capture. Tell the user rather than substituting something else.`
      : recaptured
        ? "Every item was found in the current capture. Use the new ids."
        : "Nothing changed since the prompt was copied.",
  }
}
