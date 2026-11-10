import type { DesignTokens, MotionEntry, MotionPhase, MotionProfile } from "../../web/shared/types"

/** What inpage/motion.js reports for { op: "tech" }. */
export interface MotionTech {
  libraries: string[]
  canvases: { context: string | null; width: number; height: number; y: number }[]
  contexts: Record<string, number>
  viewTransitions: boolean
  scrollDriven: boolean
}

const MAX_TOKENS = 40
const MAX_EASINGS = 16
const MAX_DURATIONS = 16
const MAX_STAGGERS = 20
const MAX_ENTRANCE = 30
const MAX_HOVERS = 30
const TOKEN_NAME = /ease|easing|duration|delay|spring|bounce|motion|stagger|timing|transition|animation/i

/** "cubic-bezier(.2,0,0,1)" and "cubic-bezier(0.2, 0, 0, 1)" are the same curve: compare them in one spelling. */
export function normalizeEasing(v: string): string {
  const s = v.trim().replace(/\s+/g, " ")
  const m = /^cubic-bezier\(([^)]*)\)$/i.exec(s)
  if (m) return `cubic-bezier(${m[1]!.split(",").map((n) => String(Number(n.trim()))).join(", ")})`
  if (/^linear\(/i.test(s)) return s.replace(/\s*,\s*/g, ", ")
  return s.toLowerCase()
}

/** Duration in ms from "300ms", "0.3s" or ".3s"; null when it isn't one. */
export function parseDuration(v: string): number | null {
  const m = /^(-?[\d.]+)(ms|s)$/i.exec(v.trim())
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n)) return null
  return Math.round(m[2]!.toLowerCase() === "s" ? n * 1000 : n)
}

const isEasing = (v: string) => /^(cubic-bezier|linear|steps)\(|^(ease|ease-in|ease-out|ease-in-out|linear|step-start|step-end)$/i.test(v.trim())

/** A cubic Bézier easing as a function of progress x, plus its lowest and highest output (overshoot, anticipation). */
function bezier(x1: number, y1: number, x2: number, y2: number) {
  const at = (t: number, a: number, b: number) => 3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t * t * b + t ** 3
  let lo = 0
  let hi = 1
  for (let i = 0; i <= 50; i++) {
    const y = at(i / 50, y1, y2)
    lo = Math.min(lo, y)
    hi = Math.max(hi, y)
  }
  const y = (x: number) => {
    let a = 0
    let b = 1
    for (let i = 0; i < 40; i++) {
      const t = (a + b) / 2
      if (at(t, x1, x2) < x) a = t
      else b = t
    }
    return at((a + b) / 2, y1, y2)
  }
  return { y, lo, hi }
}

const KEYWORD_SHAPES: Record<string, string> = {
  linear: "linear: constant speed",
  ease: "ease: quick start, soft landing",
  "ease-in": "ease-in: slow start, accelerates",
  "ease-out": "ease-out: fast start, decelerates",
  "ease-in-out": "ease-in-out: slow at both ends",
  "step-start": "steps: jumps, no tween",
  "step-end": "steps: jumps, no tween",
}

/** A plain-words description of an easing curve, so an agent can tell a spring from a soft ease-out. */
export function easingShape(value: string): string {
  const v = normalizeEasing(value)
  if (KEYWORD_SHAPES[v]) return KEYWORD_SHAPES[v]!
  if (v.startsWith("steps(")) return "steps: jumps, no tween"
  const bez = /^cubic-bezier\(([^)]*)\)$/.exec(v)
  if (bez) {
    const [x1, y1, x2, y2] = bez[1]!.split(",").map(Number) as [number, number, number, number]
    const { y, lo, hi } = bezier(x1, y1, x2, y2)
    const parts: string[] = []
    if (hi > 1.001) parts.push(`overshoots to ${hi.toFixed(2)} (back)`)
    if (lo < -0.001) parts.push(`pulls back to ${lo.toFixed(2)} first (anticipation)`)
    // Judged by how far along it is at a quarter, half and three quarters of the time.
    const [q1, mid, q3] = [y(0.25), y(0.5), y(0.75)]
    const kind = mid >= 0.6 ? "ease-out" : mid <= 0.4 ? "ease-in" : q1 < 0.2 && q3 > 0.8 ? "ease-in-out" : "near linear"
    const strong = (kind === "ease-out" && mid >= 0.8) || (kind === "ease-in" && mid <= 0.2) || (kind === "ease-in-out" && q1 < 0.1)
    return `${strong ? "strong " : ""}${kind}${parts.length ? ", " + parts.join(", ") : ""}`
  }
  if (v.startsWith("linear(")) {
    // linear(0, 0.2 10%, 1.04, 1): the first number of each stop is its output value.
    const outs = v.slice(7, -1).split(",").map((s) => Number(s.trim().split(/\s+/)[0])).filter(Number.isFinite)
    const hi = Math.max(...outs)
    const lo = Math.min(...outs)
    if (outs.length >= 8 && hi > 1.001) return `spring (linear() curve, overshoots to ${hi.toFixed(3)}${lo < -0.001 ? `, dips to ${lo.toFixed(3)} first` : ""})`
    if (hi > 1.001) return `custom curve, overshoots to ${hi.toFixed(3)}`
    return "custom curve (linear() stops)"
  }
  return "custom"
}

/** Entries as reported, plus the phase they were logged in. */
export interface PhasedMotion {
  phase: MotionPhase
  entries: MotionEntry[]
  /** Hover recordings carry the label of the element hovered. */
  label?: string
}

export function buildMotionProfile(tokens: DesignTokens, motion: PhasedMotion[], tech: MotionTech | null): MotionProfile {
  const vars = Object.entries(tokens.cssVariables ?? {}).filter(([name, value]) => TOKEN_NAME.test(name) && value)
  const profileTokens = vars.slice(0, MAX_TOKENS).map(([name, value]) => ({
    name,
    value: value.length > 300 ? value.slice(0, 300) + "…" : value,
    kind: (parseDuration(value) != null ? "duration" : isEasing(value) ? "easing" : "other") as "duration" | "easing" | "other",
  }))
  const easingToken = new Map<string, string>()
  const durationToken = new Map<number, string>()
  for (const [name, value] of vars) {
    const ms = parseDuration(value)
    if (ms != null && !durationToken.has(ms)) durationToken.set(ms, name)
    else if (isEasing(value) && !easingToken.has(normalizeEasing(value))) easingToken.set(normalizeEasing(value), name)
  }

  const easings = new Map<string, { elements: number; ran: number }>()
  const durations = new Map<number, { elements: number; ran: number }>()
  const bump = <K>(m: Map<K, { elements: number; ran: number }>, k: K, field: "elements" | "ran", n: number) => {
    const e = m.get(k) ?? { elements: 0, ran: 0 }
    e[field] += n
    m.set(k, e)
  }
  // Computed transitions, "<property> <duration> <easing>", by how many elements carry them.
  for (const t of tokens.transitions ?? []) {
    const m = /^(\S+) (\S+) (.+)$/.exec(t.value)
    if (!m) continue
    const ms = parseDuration(m[2]!)
    if (ms != null) bump(durations, ms, "elements", t.count)
    bump(easings, normalizeEasing(m[3]!), "elements", t.count)
  }
  const all = motion.flatMap((p) => p.entries.map((e) => ({ ...e, phase: p.phase, label: p.label })))
  for (const e of all) {
    const n = e.count ?? 1
    if (e.durationMs > 0) bump(durations, Math.round(e.durationMs), "ran", n)
    if (e.easing) bump(easings, normalizeEasing(e.easing), "ran", n)
  }
  const ranked = <K>(m: Map<K, { elements: number; ran: number }>) =>
    [...m.entries()].sort((a, b) => b[1].elements + b[1].ran - (a[1].elements + a[1].ran))

  const staggers = all
    .filter((e) => e.stagger)
    .sort((a, b) => (b.count ?? 1) - (a.count ?? 1))
    .slice(0, MAX_STAGGERS)
    .map((e) => ({ phase: e.phase, target: e.target, property: e.property, count: e.count ?? 1, stepMs: e.stagger!.stepMs, durationMs: e.durationMs, easing: e.easing }))

  const hovers = motion
    .filter((p) => p.phase === "hover")
    .flatMap((p) => p.entries.map((e) => ({ label: p.label ?? "", target: e.target, property: e.property, durationMs: e.durationMs, delayMs: e.delayMs, easing: e.easing })))
    // Entering and leaving usually run the same transition: list it once.
    .filter((h, i, list) => list.findIndex((o) => JSON.stringify(o) === JSON.stringify(h)) === i)
    .slice(0, MAX_HOVERS)

  const pixelOnly: string[] = []
  const names: Record<string, string> = { webgl: "WebGL", webgl2: "WebGL 2", webgpu: "WebGPU", "2d": "2D canvas", bitmap: "bitmap canvas" }
  for (const c of tech?.canvases ?? []) {
    const kind = c.context ? names[c.context] ?? c.context : "canvas (context not seen)"
    pixelOnly.push(`${kind} ${c.width}×${c.height} at y=${c.y}: drawn by script; only its pixels are captured (see the page's live section clips)`)
  }
  const scripted = (tech?.libraries ?? []).filter((l) => /^(GSAP|Lenis|Locomotive)/.test(l))
  if (scripted.length) pixelOnly.push(`${scripted.join(", ")}: writes styles frame by frame, so those tweens are not in the motion log`)

  return {
    version: 1,
    tech: {
      libraries: tech?.libraries ?? [],
      canvases: tech?.canvases ?? [],
      viewTransitions: !!tech?.viewTransitions,
      scrollDriven: !!tech?.scrollDriven,
    },
    tokens: profileTokens,
    easings: ranked(easings).slice(0, MAX_EASINGS).map(([value, c]) => ({ value, shape: easingShape(value), ...(easingToken.has(value) ? { token: easingToken.get(value) } : {}), ...c })),
    durations: ranked(durations).slice(0, MAX_DURATIONS).map(([ms, c]) => ({ ms, ...(durationToken.has(ms) ? { token: durationToken.get(ms) } : {}), ...c })),
    staggers,
    entrance: motion.filter((p) => p.phase === "load").flatMap((p) => p.entries).slice(0, MAX_ENTRANCE).map((e) => ({ ...e, keyframes: e.keyframes.slice(0, 4) })),
    hovers,
    pixelOnly,
  }
}

/** One profile for a reference: counts add up, lists are joined without repeats, the first page's entrance leads. */
export function mergeMotionProfiles(list: MotionProfile[]): MotionProfile | undefined {
  if (!list.length) return undefined
  const uniq = <T>(items: T[], key: (t: T) => string, n: number) => {
    const seen = new Set<string>()
    return items.filter((t) => !seen.has(key(t)) && seen.add(key(t))).slice(0, n)
  }
  const sum = <K, T extends { elements: number; ran: number }>(items: T[], key: (t: T) => K, n: number) => {
    const m = new Map<K, T>()
    for (const t of items) {
      const k = key(t)
      const e = m.get(k)
      m.set(k, e ? { ...e, elements: e.elements + t.elements, ran: e.ran + t.ran } : { ...t })
    }
    return [...m.values()].sort((a, b) => b.elements + b.ran - (a.elements + a.ran)).slice(0, n)
  }
  const flat = <T>(pick: (p: MotionProfile) => T[]) => list.flatMap(pick)
  return {
    version: 1,
    tech: {
      libraries: [...new Set(flat((p) => p.tech.libraries))],
      canvases: uniq(flat((p) => p.tech.canvases), (c) => `${c.context}|${c.width}|${c.height}`, 12),
      viewTransitions: list.some((p) => p.tech.viewTransitions),
      scrollDriven: list.some((p) => p.tech.scrollDriven),
    },
    tokens: uniq(flat((p) => p.tokens), (t) => t.name, MAX_TOKENS),
    easings: sum(flat((p) => p.easings), (e) => e.value, MAX_EASINGS),
    durations: sum(flat((p) => p.durations), (d) => d.ms, MAX_DURATIONS),
    staggers: uniq(flat((p) => p.staggers), (s) => `${s.target}|${s.property}|${s.stepMs}`, MAX_STAGGERS),
    entrance: uniq(flat((p) => p.entrance), (e) => `${e.target}|${e.property}|${e.durationMs}|${e.easing}`, MAX_ENTRANCE),
    hovers: uniq(flat((p) => p.hovers), (h) => `${h.target}|${h.property}|${h.durationMs}|${h.easing}`, MAX_HOVERS),
    pixelOnly: uniq(flat((p) => p.pixelOnly), (s) => s, 12),
  }
}
