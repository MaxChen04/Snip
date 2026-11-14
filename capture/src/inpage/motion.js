// Evaluated in the captured page. Logs the CSS transitions, CSS animations and Web Animations the browser runs,
// with their real timing, easing and from/to values, so motion can be read as numbers rather than estimated from
// frames. Script-driven motion that writes styles every frame (GSAP, scroll libraries) doesn't create animations
// and is not seen here. The capture installs it before the page's own scripts run, so entrance animations played
// while the page loads are logged too.
//   { op: "install" }  start logging; anything already running counts as seen
//   { op: "take" }  return what started since the last take, and restart the clock for startMs
//   { op: "tech" }  what draws the page's motion: animation libraries, canvases and their context, view transitions
(arg) => {
  const op = arg && arg.op
  let m = window.__snipMotion
  if (!m) {
    if (op !== "install") return []
    const seen = new WeakSet()
    const log = []
    const LIMIT = 5000
    const sel = (el) => {
      if (!el || el.nodeType !== 1) return null
      let s = el.tagName.toLowerCase()
      if (el.id && !/\d{3,}/.test(el.id)) return `${s}#${el.id}`
      const cls = Array.from(el.classList).filter((c) => c.length < 30 && !/\d{3,}|[:[\]]/.test(c)).slice(0, 2)
      if (cls.length) s += "." + cls.join(".")
      const p = el.parentElement
      return p && p !== document.body && p.tagName ? `${p.tagName.toLowerCase()} > ${s}` : s
    }
    const round = (v) => (typeof v === "number" && isFinite(v) ? Math.round(v) : v)
    // Only the animation and when it started are kept here: reading keyframes forces a style recalculation, which
    // on a large page stalls it for milliseconds per animation. They are read once, in take.
    const record = (a) => {
      if (!a || seen.has(a)) return
      seen.add(a)
      if (log.length < LIMIT) log.push({ a, startMs: Math.round(performance.now() - m.t0), scrollY: Math.round(scrollY) })
    }
    const describe = ({ a, startMs, scrollY }) => {
      const e = a.effect
      if (!e || !e.getKeyframes) return null
      const t = e.getTiming()
      const name = a.constructor && a.constructor.name
      const raw = e.getKeyframes()
      const keyframes = raw.slice(0, 8).map((k) => {
        const o = {}
        for (const [p, v] of Object.entries(k)) {
          if (v == null || p === "computedOffset" || p === "composite" || (p === "easing" && v === "linear")) continue
          o[p] = typeof v === "number" ? Math.round(v * 1000) / 1000 : String(v).slice(0, 200)
        }
        return o
      })
      return {
        type: name === "CSSTransition" ? "transition" : name === "CSSAnimation" ? "animation" : "web-animation",
        target: sel(e.target) + (e.pseudoElement || ""),
        // Web Animations don't name a property: list what their keyframes animate.
        property: a.transitionProperty || a.animationName || [...new Set(keyframes.flatMap((k) => Object.keys(k)).filter((p) => p !== "offset" && p !== "easing"))].join(", ") || null,
        durationMs: round(typeof t.duration === "number" ? t.duration : 0),
        delayMs: round(t.delay),
        // A CSS animation's timing function lives on its keyframes; the effect itself runs linear. Keep the raw
        // easing: sampled linear() springs can exceed the keyframe preview's string limit and must remain valid CSS.
        easing: name === "CSSAnimation" && t.easing === "linear" && raw[0] && raw[0].easing ? raw[0].easing : t.easing,
        iterations: t.iterations === Infinity ? "infinite" : t.iterations,
        keyframes,
        // When it was started, before its delay. Transitions and element.animate() are logged as they are created; a
        // CSS animation announces itself only once its delay is over, so its own start time is used instead.
        startMs: name === "CSSAnimation" && typeof a.startTime === "number" && isFinite(a.startTime) ? Math.max(0, Math.round(a.startTime - m.t0)) : startMs,
        scrollY,
      }
    }
    // Transitions and CSS animations announce themselves; element.animate() (Motion, Framer Motion) is wrapped.
    // Short effects can finish before anyone polls, so record each one as it starts.
    const onStart = (ev) => ev.target && ev.target.getAnimations && ev.target.getAnimations().forEach(record)
    document.addEventListener("transitionrun", onStart, true)
    document.addEventListener("animationstart", onStart, true)
    const animate = Element.prototype.animate
    if (animate) Element.prototype.animate = function (...args) {
      const a = animate.apply(this, args)
      try { record(a) } catch {}
      return a
    }
    // Canvases are drawn by script, so their motion is only pixels: note which kind of context each one asked for.
    const contexts = new WeakMap()
    const created = {}
    const getContext = HTMLCanvasElement.prototype.getContext
    if (getContext) HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
      const ctx = getContext.call(this, type, ...rest)
      try {
        const kind = /^(experimental-)?webgl$/.test(type) ? "webgl" : type === "webgl2" ? "webgl2" : type === "webgpu" ? "webgpu" : type === "2d" ? "2d" : type === "bitmaprenderer" ? "bitmap" : null
        if (ctx && kind && !contexts.has(this)) {
          contexts.set(this, kind)
          created[kind] = (created[kind] || 0) + 1
        }
      } catch {}
      return ctx
    }
    m = window.__snipMotion = { t0: performance.now(), log, record, describe, contexts, created }
    document.getAnimations().forEach((a) => seen.add(a))
    return []
  }
  if (op === "install") return []
  if (op === "tech") return tech(m)
  document.getAnimations().forEach(m.record)
  // The same effect on many elements (each letter of a heading, every card in a grid) is one entry with a count.
  // Elements that start one after another at an even step (a stagger, set by delays or by starting them in turn) are
  // one entry with the step; otherwise effects that differ only in delay stay apart.
  const groups = new Map()
  for (const raw of m.log.splice(0)) {
    const e = m.describe(raw)
    if (!e) continue
    const { startMs, scrollY, delayMs, ...rest } = e
    const key = JSON.stringify(rest)
    const el = raw.a.effect && raw.a.effect.target
    const g = groups.get(key)
    if (g) g.push({ e, el })
    else groups.set(key, [{ e, el }])
  }
  const out = []
  for (const members of groups.values()) {
    const list = members.map((x) => x.e)
    // A stagger plays across different elements: one element animated again and again (a pulse) is not one.
    const distinct = new Set(members.map((x) => x.el)).size === members.length
    const stagger = list.length >= 3 && distinct && staggerOf(list)
    if (stagger) {
      const first = list.reduce((a, b) => (b.startMs + b.delayMs < a.startMs + a.delayMs ? b : a))
      out.push({ ...first, count: list.length, stagger })
      continue
    }
    const byDelay = new Map()
    for (const e of list) {
      const g = byDelay.get(e.delayMs)
      if (g) g.count = (g.count || 1) + 1
      else byDelay.set(e.delayMs, e)
    }
    out.push(...byDelay.values())
  }
  m.t0 = performance.now()
  return out.sort((a, b) => a.startMs - b.startMs).slice(0, 100)

  /**
   * Whether the elements started one after another at an even step: an inference, so it says how it was made. The
   * step is the median gap between start times (start + delay); `evenGaps` of `gaps` fall within max(4 ms, 25%) of
   * it, and at least 60% must. `from` is "delays" when the elements' own delays set the step (read exactly), or
   * "start times" when script started them in turn (timers can fire late, so gaps wander).
   */
  function staggerOf(list) {
    const delays = new Set(list.map((e) => e.delayMs))
    // Without different delays, starts spread by scrolling (reveals as each card scrolls in) are not a stagger.
    if (delays.size === 1 && new Set(list.map((e) => e.scrollY)).size > 1) return null
    const starts = list.map((e) => e.startMs + e.delayMs).sort((a, b) => a - b)
    const gaps = starts.slice(1).map((t, i) => t - starts[i])
    const sorted = [...gaps].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]
    if (median < 5 || median > 1000) return null
    const even = gaps.filter((g) => Math.abs(g - median) <= Math.max(4, median * 0.25)).length
    if (even < gaps.length * 0.6) return null
    const stepMs = Math.round(median)
    return {
      stepMs,
      spanMs: Math.round(starts[starts.length - 1] - starts[0]),
      evenGaps: even,
      gaps: gaps.length,
      gapRangeMs: [Math.round(sorted[0]), Math.round(sorted[sorted.length - 1])],
      from: delays.size > 1 ? "delays" : "start times",
    }
  }

  function tech(m) {
    const w = window
    const libraries = []
    const add = (name, version) => libraries.push(version ? `${name} ${version}` : name)
    try {
      if (w.gsap) add("GSAP", w.gsap.version)
      if (w.ScrollTrigger) add("GSAP ScrollTrigger")
      if (w.__THREE__) add("three.js", "r" + w.__THREE__)
      if (w.lottie || w.bodymovin || document.querySelector("lottie-player, dotlottie-player, dotlottie-wc, [data-animation-type='lottie']")) add("Lottie")
      if (w.rive || document.querySelector("canvas[data-rive], rive-canvas")) add("Rive")
      if (customElements.get("spline-viewer") || document.querySelector("spline-viewer")) add("Spline")
      if (w.UnicornStudio || document.querySelector("[data-us-project]")) add("Unicorn Studio")
      if (w.lenis || w.Lenis || document.documentElement.classList.contains("lenis")) add("Lenis smooth scroll")
      if (w.LocomotiveScroll || document.documentElement.classList.contains("has-scroll-smooth")) add("Locomotive Scroll")
      if (w.Motion) add("Motion")
      if (document.querySelector("[data-framer-name], [data-framer-component-type]")) add("Framer")
      if (w.Webflow) add("Webflow interactions")
      if (w.Swiper || document.querySelector(".swiper")) add("Swiper")
      if (w.barba) add("Barba page transitions")
    } catch {}
    const astro = !!document.querySelector("meta[name='astro-view-transitions-enabled']")
    let viewTransitions = astro
    let scrollDriven = false
    const visit = (rules, depth) => {
      for (const r of rules) {
        const t = r.cssText || ""
        // Shorthands serialize as longhands with their defaults (animation-timeline: auto), which drive nothing.
        if (!scrollDriven && /animation-timeline:\s*(?!auto\b|initial\b)[\w(-]|(view|scroll)-timeline(-name)?:\s*(?!none\b|initial\b)[\w-]/.test(t)) scrollDriven = true
        if (!viewTransitions && (r.constructor.name === "CSSViewTransitionRule" || /::view-transition|view-transition-name/.test(t))) viewTransitions = true
        if (r.cssRules && depth < 4) visit(r.cssRules, depth + 1)
      }
    }
    for (const sheet of [...document.styleSheets, ...(document.adoptedStyleSheets || [])]) {
      try { visit(sheet.cssRules, 0) } catch { /* cross-origin */ }
    }
    if (astro) add("Astro view transitions")
    const canvases = []
    for (const c of document.querySelectorAll("canvas")) {
      const r = c.getBoundingClientRect()
      if (r.width * r.height < 4000) continue
      const context = m.contexts.get(c) || null
      canvases.push({ context, width: Math.round(r.width), height: Math.round(r.height), y: Math.round(r.top + scrollY) })
      if (canvases.length >= 12) break
    }
    return { libraries, canvases, contexts: { ...m.created }, viewTransitions, scrollDriven }
  }
}
