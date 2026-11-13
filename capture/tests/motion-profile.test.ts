import { test } from "node:test"
import assert from "node:assert/strict"
import type { DesignTokens, MotionEntry } from "../../web/shared/types"
import { buildMotionProfile, easingShape, mergeMotionProfiles, normalizeEasing, parseDuration } from "../src/motion-profile"

const entry = (o: Partial<MotionEntry>): MotionEntry => ({
  type: "transition", target: "a.link", property: "opacity", durationMs: 200, delayMs: 0, easing: "ease-out", iterations: 1, keyframes: [], startMs: 0, scrollY: 0, ...o,
})

const tokens: DesignTokens = {
  colors: [], fonts: [], fontSizes: [], spacing: [], radii: [], shadows: [], keyframes: ["rise"],
  transitions: [{ value: "transform 0.2s cubic-bezier(0.2, 0, 0, 1)", count: 40 }, { value: "opacity 150ms ease", count: 12 }],
  cssVariables: { "--color-bg": "#fff", "--duration-hover": "200ms", "--ease-fast": "cubic-bezier(.2,0,0,1)", "--ease-spring": "linear(0, 0.4 10%, 0.8, 1.04 40%, 1.02, 0.99, 1, 1)" },
}

test("easing curves are compared in one spelling and described in plain words", () => {
  assert.equal(normalizeEasing("cubic-bezier(.2,0,0,1)"), normalizeEasing("cubic-bezier(0.2, 0, 0, 1)"))
  assert.equal(parseDuration(".3s"), 300)
  assert.equal(parseDuration("50ms"), 50)
  assert.equal(parseDuration("auto"), null)
  assert.equal(easingShape("cubic-bezier(0.2, 0, 0, 1)"), "strong ease-out")
  assert.match(easingShape("cubic-bezier(.34,1.56,.64,1)"), /overshoots to 1\.\d\d \(back\)/)
  assert.match(easingShape("cubic-bezier(0.42, 0, 1, 1)"), /ease-in/)
  assert.match(easingShape("cubic-bezier(0.77, 0, 0.175, 1)"), /ease-in-out/)
  assert.match(easingShape("linear(0, 0.4 10%, 0.8, 1.04 40%, 1.02, 0.99, 1, 1)"), /^spring .*overshoots to 1\.040/)
  assert.equal(easingShape("ease"), "ease: quick start, soft landing")
})

test("a motion profile pulls out tokens, ranks easings and durations, and keeps staggers, entrances and hovers", () => {
  const stagger = entry({ type: "web-animation", target: "p.word", property: "opacity, filter", durationMs: 403, easing: "cubic-bezier(0.22, 1, 0.36, 1)", count: 40, stagger: { stepMs: 20, spanMs: 780, evenGaps: 39, gaps: 39, gapRangeMs: [19, 21], from: "start times" } })
  const profile = buildMotionProfile(tokens, [
    { phase: "load", entries: [stagger] },
    { phase: "scroll", entries: [entry({ durationMs: 600, easing: "cubic-bezier(0.2, 0, 0, 1)" })] },
    // Entering and leaving run the same transition.
    { phase: "hover", label: "Pricing", entries: [entry({ property: "transform", durationMs: 200, easing: "cubic-bezier(0.2, 0, 0, 1)" }), entry({ property: "transform", durationMs: 200, easing: "cubic-bezier(0.2, 0, 0, 1)", startMs: 400 })] },
  ], { libraries: ["three.js r175"], canvases: [{ context: "webgl2", width: 1120, height: 520, y: 80 }], contexts: { webgl2: 1 }, viewTransitions: false, scrollDriven: false })

  assert.deepEqual(profile.tokens.map((t) => [t.name, t.kind]), [["--duration-hover", "duration"], ["--ease-fast", "easing"], ["--ease-spring", "easing"]], "only motion-named custom properties")
  assert.deepEqual(profile.easings[0], { value: "cubic-bezier(0.2, 0, 0, 1)", shape: "strong ease-out", tokenCandidate: "--ease-fast", elements: 40, ran: 3 })
  assert.deepEqual(profile.durations[0], { ms: 200, tokenCandidate: "--duration-hover", elements: 40, ran: 2 })
  assert.deepEqual(profile.staggers, [{ phase: "load", target: "p.word", property: "opacity, filter", count: 40, durationMs: 403, easing: "cubic-bezier(0.22, 1, 0.36, 1)", stepMs: 20, spanMs: 780, evenGaps: 39, gaps: 39, gapRangeMs: [19, 21], from: "start times" }], "how the stagger was inferred travels with it")
  assert.equal(profile.totals, undefined, "nothing was capped")
  assert.equal(profile.entrance.length, 1)
  assert.deepEqual(profile.hovers, [{ label: "Pricing", target: "a.link", property: "transform", durationMs: 200, delayMs: 0, easing: "cubic-bezier(0.2, 0, 0, 1)" }])
  assert.match(profile.pixelOnly[0]!, /^WebGL 2 1120×520 at y=80/)
  assert.deepEqual(profile.tech.libraries, ["three.js r175"])
})

test("profiles merge across pages: counts add up and repeats are dropped", () => {
  const one = buildMotionProfile(tokens, [{ phase: "hover", label: "Nav", entries: [entry({})] }], null)
  const merged = mergeMotionProfiles([one, one])!
  assert.equal(merged.easings.find((e) => e.value === "cubic-bezier(0.2, 0, 0, 1)")!.elements, 80)
  assert.equal(merged.tokens.length, 3)
  assert.equal(merged.hovers.length, 1)
  assert.equal(mergeMotionProfiles([]), undefined)
})

test("capped lists say how many items they held", () => {
  const many = Array.from({ length: 45 }, (_, i) => entry({ target: `a.l${i}`, durationMs: 100 + i }))
  const profile = buildMotionProfile(tokens, [{ phase: "load", entries: many }], null)
  assert.equal(profile.entrance.length, 30)
  assert.equal(profile.totals?.entrance, 45)
  assert.equal(profile.durations.length, 16)
  assert.ok((profile.totals?.durations ?? 0) > 16)
  assert.equal(mergeMotionProfiles([profile])!.totals?.entrance, 45, "a merged profile keeps what a page found")
})
