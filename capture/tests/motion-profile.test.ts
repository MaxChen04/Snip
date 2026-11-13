import { test } from "node:test"
import assert from "node:assert/strict"
import type { MotionEntry } from "../../web/shared/types"
import { easingShape, motionFileKind, motionProfile } from "../src/motion-profile"

const entry = (o: Partial<MotionEntry>): MotionEntry => ({
  type: "web-animation", target: "span", property: "opacity", durationMs: 400, delayMs: 0, easing: "ease", iterations: 1,
  keyframes: [{ offset: 0, opacity: 0 }, { offset: 1, opacity: 1 }], startMs: 0, scrollY: 0, ...o,
})

test("easings are told apart by shape, and overshooting curves report how far they go", () => {
  assert.equal(easingShape("cubic-bezier(0.23, 1, 0.32, 1)").shape, "ease-out")
  assert.equal(easingShape("cubic-bezier(0.4, 0, 0.2, 1)").shape, "ease-in-out")
  assert.equal(easingShape("cubic-bezier(0.4, 0, 1, 1)").shape, "ease-in")
  assert.equal(easingShape("ease-out").shape, "ease-out")
  assert.equal(easingShape("linear").shape, "linear")
  assert.deepEqual(easingShape("cubic-bezier(0.34, 1.56, 0.64, 1)"), { shape: "spring", overshoot: 0.098 })
  assert.deepEqual(easingShape("linear(0, 0.13, 0.51 51%, 1.042 79%, 1.015 92%, 1)"), { shape: "spring", overshoot: 0.042 })
  assert.equal(easingShape("var(--x)").shape, "unknown")
})

test("unevenly spaced delays are not reported as a stagger", () => {
  const profile = (delays: number[]) => motionProfile({ load: delays.map((delayMs) => entry({ delayMs })), scroll: [], hovers: [], files: [], cssVariables: {}, keyframes: [], motionRules: { scrollDriven: [], viewTransitions: false } })
  assert.deepEqual(profile([0, 100, 10000]).staggers, [])
  assert.equal(profile([0, 100, 201, 300]).staggers[0]?.stepMs, 100, "a millisecond of rounding still counts as even")
})

test("a profile finds staggers, motion tokens and pixel-only canvases", () => {
  const p = motionProfile({
    load: [0, 20, 40, 60].map((delayMs) => entry({ delayMs, easing: "cubic-bezier(0.22, 1, 0.36, 1)" })),
    scroll: [entry({ type: "animation", property: "spin", easing: "linear", iterations: "infinite", durationMs: 1000 })],
    hovers: [{ label: "Pricing", motion: [entry({ type: "transition", property: "color", durationMs: 150 })] }, { label: "Blog", motion: [] }],
    tech: { libraries: ["three.js r175"], contexts: { webgl2: 1 }, canvases: [{ context: "webgl2", width: 1120, height: 520, y: 308 }], shaders: { count: 2, sources: ["void main(){}"] } },
    files: [{ kind: "rive", url: "https://x.test/a.riv" }],
    cssVariables: { "--duration-press": "50ms", "--ease-spring": "linear(0, 1.04, 1)", "--tw-ease": "ease", "--color-bg": "#fff" },
    keyframes: ["spin"],
    motionRules: { scrollDriven: [], viewTransitions: false },
  })
  assert.deepEqual(p.staggers, [{ property: "opacity", stepMs: 20, items: 4, durationMs: 400, easing: "cubic-bezier(0.22, 1, 0.36, 1)", phase: "load" }])
  assert.deepEqual(p.tokens, { "--duration-press": "50ms", "--ease-spring": "linear(0, 1.04, 1)" })
  assert.equal(p.easings[0]!.easing, "cubic-bezier(0.22, 1, 0.36, 1)")
  assert.ok(!p.easings.some((e) => e.easing === "linear"), "looping effects stay out of the easing mix")
  assert.deepEqual(p.tech.effects, { transitions: 1, animations: 1, webAnimations: 4 })
  assert.deepEqual(p.hovers, [{ label: "Pricing", motion: [{ type: "transition", property: "color", durationMs: 150, delayMs: 0, easing: "ease" }] }])
  assert.match(p.pixelOnly[0]!, /1 WebGL\/WebGPU canvas \(1120x520 at y=308\)/)
  assert.ok(p.observations.some((o) => o.startsWith("Staggered load opacity: 4 items, 20 ms apart")))
})

test("motion files are recognised by URL and content type", () => {
  assert.equal(motionFileKind("https://x.test/brand/loader.riv?v=2", ""), "rive")
  assert.equal(motionFileKind("https://x.test/a.glb", "model/gltf-binary"), "3d-model")
  assert.equal(motionFileKind("https://x.test/lottie/hero.json", "application/json"), "lottie")
  assert.equal(motionFileKind("https://x.test/clip", "video/mp4"), "video")
  assert.equal(motionFileKind("https://x.test/data.json", "application/json"), null)
})
