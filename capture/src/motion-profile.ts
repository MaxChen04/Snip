import type { MotionEasing, MotionEntry, MotionProfile } from "../../web/shared/types"

/** What inpage/tech.js reports. */
export interface PageTech {
  libraries: string[]
  contexts: Record<string, number>
  canvases: { context: string | null; width: number; height: number; y: number }[]
  shaders: { count: number; sources: string[] }
}

export interface MotionInput {
  load: MotionEntry[]
  scroll: MotionEntry[]
  hovers: { label: string; motion: MotionEntry[] }[]
  tech: PageTech | null
  files: { kind: string; url: string }[]
  cssVariables: Record<string, string>
  keyframes: string[]
  motionRules: { scrollDriven: string[]; viewTransitions: boolean } | null
}

const KEYWORDS: Record<string, [number, number, number, number]> = {
  ease: [0.25, 0.1, 0.25, 1],
  "ease-in": [0.42, 0, 1, 1],
  "ease-out": [0, 0, 0.58, 1],
  "ease-in-out": [0.42, 0, 0.58, 1],
}

/** How an easing moves: its shape, and how far past the end it goes. Exported for tests. */
export function easingShape(easing: string): Pick<MotionEasing, "shape" | "overshoot"> {
  const e = easing.trim()
  if (e === "linear" || /^linear\(\s*0\s*,\s*1\s*\)$/.test(e)) return { shape: "linear" }
  if (/^steps|^step-/.test(e)) return { shape: "steps" }
  if (e.startsWith("linear(")) {
    // linear(0, 0.03 7%, …, 1): the outputs are the first number of each stop.
    const ys = e.slice(7, -1).split(",").map((stop) => parseFloat(stop)).filter((n) => Number.isFinite(n))
    const over = Math.max(...ys) - 1
    const under = -Math.min(...ys)
    const mid = ys[Math.floor(ys.length / 2)] ?? 0.5
    if (over > 0.005 || under > 0.005) return { shape: "spring", overshoot: round(Math.max(over, 0), 3) }
    return { shape: mid > 0.6 ? "ease-out" : mid < 0.4 ? "ease-in" : "ease-in-out" }
  }
  const m = e.match(/^cubic-bezier\(([^)]+)\)$/)
  const pts = m ? m[1]!.split(",").map(Number) : KEYWORDS[e]
  if (!pts || pts.length !== 4 || pts.some((n) => !Number.isFinite(n))) return { shape: "unknown" }
  const [x1, y1, x2, y2] = pts as [number, number, number, number]
  const bez = (a: number, b: number, t: number) => 3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t ** 2 * b + t ** 3
  let maxY = 1
  for (let t = 0; t <= 1; t += 0.02) maxY = Math.max(maxY, bez(y1, y2, t))
  if (maxY > 1.005) return { shape: "spring", overshoot: round(maxY - 1, 3) }
  // Progress a fifth and four fifths of the way through its time: a fast start is an ease-out, a slow start
  // and a slow end an ease-in-out, a slow start into a fast end an ease-in.
  const yAt = (x: number) => {
    let t = x
    for (let i = 0; i < 24; i++) {
      const slope = 3 * (1 - t) ** 2 * x1 + 6 * (1 - t) * t * (x2 - x1) + 3 * t ** 2 * (1 - x2)
      t = Math.min(1, Math.max(0, t - (bez(x1, x2, t) - x) / Math.max(0.05, slope)))
    }
    return bez(y1, y2, t)
  }
  const early = yAt(0.2) - 0.2
  const late = yAt(0.8) - 0.8
  return { shape: early > 0.08 ? "ease-out" : late < -0.05 ? "ease-in" : "ease-in-out" }
}

const round = (n: number, digits = 0) => Math.round(n * 10 ** digits) / 10 ** digits

const TOKEN_NAME = /ease|easing|duration|delay|spring|motion|timing|stagger|transition|bounce/i

/** Sums up a page's motion. Pure: everything it reads is passed in. */
export function motionProfile(input: MotionInput): MotionProfile {
  const hoverMotion = input.hovers.flatMap((h) => h.motion)
  const phases: [string, MotionEntry[]][] = [["load", input.load], ["scroll", input.scroll], ["hover", hoverMotion]]
  const all = phases.flatMap(([, list]) => list)
  const weight = (e: MotionEntry) => e.count ?? 1

  const easingCounts = new Map<string, number>()
  const durationCounts = new Map<number, number>()
  const effects = { transitions: 0, animations: 0, webAnimations: 0 }
  for (const e of all) {
    // Looping effects (spinners, shimmers) run linear by design; they'd swamp the easing mix.
    if (e.iterations !== "infinite") easingCounts.set(e.easing, (easingCounts.get(e.easing) ?? 0) + weight(e))
    if (e.durationMs > 0) durationCounts.set(e.durationMs, (durationCounts.get(e.durationMs) ?? 0) + weight(e))
    effects[e.type === "transition" ? "transitions" : e.type === "animation" ? "animations" : "webAnimations"] += weight(e)
  }
  const easings = [...easingCounts].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([easing, count]) => ({ easing, count, ...easingShape(easing) }))
  const durations = [...durationCounts].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([ms, count]) => ({ ms, count }))

  // A stagger: one effect (same kind, property, duration, easing, keyframes) started with three or more evenly spaced delays.
  const staggers: MotionProfile["staggers"] = []
  for (const [phase, list] of phases) {
    const groups = new Map<string, { e: MotionEntry; delays: Set<number> }>()
    for (const e of list) {
      const key = JSON.stringify([e.type, e.property, e.durationMs, e.easing, e.keyframes])
      const g = groups.get(key) ?? { e, delays: new Set<number>() }
      g.delays.add(e.delayMs)
      groups.set(key, g)
    }
    for (const { e, delays } of groups.values()) {
      const sorted = [...delays].sort((a, b) => a - b)
      if (sorted.length < 3) continue
      const steps = sorted.slice(1).map((d, i) => d - sorted[i]!).sort((a, b) => a - b)
      const stepMs = steps[Math.floor(steps.length / 2)]!
      if (stepMs <= 0) continue
      staggers.push({ property: e.property, stepMs, items: sorted.length, durationMs: e.durationMs, easing: e.easing, phase })
    }
  }
  // Opacity and transform staggered together are one reveal.
  const merged: MotionProfile["staggers"] = []
  for (const s of staggers) {
    const same = merged.find((m) => m.phase === s.phase && m.stepMs === s.stepMs && m.items === s.items && m.durationMs === s.durationMs)
    if (same) same.property = [same.property, s.property].filter(Boolean).join(", ")
    else merged.push({ ...s })
  }
  merged.sort((a, b) => b.items - a.items).splice(12)

  const tokens = Object.fromEntries(Object.entries(input.cssVariables).filter(([k]) => !k.startsWith("--tw-") && TOKEN_NAME.test(k)).slice(0, 60))

  const tech = input.tech
  const canvases = tech?.canvases ?? []
  const pixelOnly: string[] = []
  const gl = canvases.filter((c) => c.context && /webgl|webgpu/.test(c.context))
  const twoD = canvases.filter((c) => c.context === "2d")
  if (gl.length) pixelOnly.push(`${gl.length} WebGL/WebGPU canvas${gl.length > 1 ? "es" : ""} (${gl.map((c) => `${c.width}x${c.height} at y=${c.y}`).join(", ")}): only the shader sources and loaded files are readable, not the scene's motion.`)
  if (twoD.length) pixelOnly.push(`${twoD.length} 2D canvas${twoD.length > 1 ? "es" : ""} (${twoD.map((c) => `${c.width}x${c.height} at y=${c.y}`).join(", ")}): drawn by script frame by frame; only the frames show it.`)
  const unknownCanvas = canvases.filter((c) => !c.context).length
  if (unknownCanvas) pixelOnly.push(`${unknownCanvas} canvas${unknownCanvas > 1 ? "es" : ""} with no context seen (drawn from a worker, or not yet drawn).`)
  const videos = input.files.filter((f) => f.kind === "video").length
  if (videos) pixelOnly.push(`${videos} video${videos > 1 ? "s" : ""}: motion baked into footage.`)
  if (tech?.libraries.some((l) => /^GSAP|Lenis|Locomotive/.test(l)))
    pixelOnly.push("A script animation library is present: motion it writes frame by frame (GSAP tweens, smooth scroll) does not appear among the effects, only in the frames.")

  const observations: string[] = []
  // linear() springs run to hundreds of characters; the full curve stays in easings.
  const short = (easing: string) => (easing.length > 48 ? `${easing.slice(0, 45)}…` : easing)
  const easeTotal = easings.reduce((n, e) => n + e.count, 0)
  if (easings[0] && easeTotal) observations.push(`Most common easing: ${short(easings[0].easing)} (${easings[0].shape}, ${Math.round((easings[0].count / easeTotal) * 100)}% of effects).`)
  const springs = easings.filter((e) => e.shape === "spring")
  if (springs.length) observations.push(`Overshooting (spring/back) curves: ${springs.map((s) => `${short(s.easing)} (+${round((s.overshoot ?? 0) * 100, 1)}%)`).join("; ")}.`)
  const hoverDur = hoverMotion.filter((e) => e.type === "transition").map((e) => e.durationMs).sort((a, b) => a - b)
  const enterDur = [...input.load, ...input.scroll].filter((e) => e.iterations !== "infinite").map((e) => e.durationMs).sort((a, b) => a - b)
  const median = (xs: number[]) => xs[Math.floor(xs.length / 2)]
  if (hoverDur.length) observations.push(`Hover feedback runs ${hoverDur[0]}–${hoverDur.at(-1)} ms (median ${median(hoverDur)} ms).`)
  if (enterDur.length) observations.push(`Load and scroll effects run ${enterDur[0]}–${enterDur.at(-1)} ms (median ${median(enterDur)} ms).`)
  for (const s of merged.slice(0, 3)) observations.push(`Staggered ${s.phase} ${s.property ?? "effect"}: ${s.items} items, ${s.stepMs} ms apart, each ${s.durationMs} ms on ${short(s.easing)}.`)
  const tokenCount = Object.keys(tokens).length
  if (tokenCount) observations.push(`${tokenCount} named motion tokens on :root (see tokens).`)
  if (input.motionRules?.scrollDriven.length) observations.push(`${input.motionRules.scrollDriven.length} CSS rules drive animations from scroll position (animation-timeline).`)
  if (!all.length && !canvases.length) observations.push("No browser animations were seen during the capture.")

  const compact = (list: MotionEntry[]) =>
    list.slice(0, 24).map((e) => ({ ...e, keyframes: e.keyframes.length > 2 ? [e.keyframes[0]!, e.keyframes.at(-1)!] : e.keyframes }))
  return {
    version: 1,
    tech: {
      libraries: tech?.libraries ?? [],
      cssKeyframes: input.keyframes.length,
      effects,
      scrollDriven: input.motionRules?.scrollDriven ?? [],
      viewTransitions: !!input.motionRules?.viewTransitions || !!tech?.libraries.some((l) => l.includes("view transitions")),
      canvases,
      shaders: tech?.shaders ?? { count: 0, sources: [] },
      files: input.files.slice(0, 30),
    },
    tokens,
    easings,
    durations,
    staggers: merged,
    load: compact(input.load),
    scroll: compact(input.scroll),
    hovers: input.hovers
      .filter((h) => h.motion.length)
      .slice(0, 12)
      .map((h) => ({ label: h.label, motion: h.motion.slice(0, 8).map(({ type, property, durationMs, delayMs, easing }) => ({ type, property, durationMs, delayMs, easing })) })),
    pixelOnly,
    observations,
  }
}

/** Which motion file a response is, by its URL and content type, or null. */
export function motionFileKind(url: string, contentType: string): string | null {
  const path = url.split(/[?#]/)[0]!.toLowerCase()
  if (path.endsWith(".riv")) return "rive"
  if (path.endsWith(".lottie") || (path.endsWith(".json") && /lottie|bodymovin/.test(path))) return "lottie"
  if (path.endsWith(".splinecode")) return "spline"
  if (/\.(glb|gltf)$/.test(path)) return "3d-model"
  if (/unicorn\.studio|unicornstudio/.test(url)) return "unicorn-studio"
  if (contentType.startsWith("video/") || /\.(mp4|webm|mov)$/.test(path)) return "video"
  return null
}
