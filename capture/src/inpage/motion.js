// Evaluated in the captured page. Logs the CSS transitions, CSS animations and Web Animations the browser runs,
// with their real timing, easing and from/to values, so motion can be read as numbers rather than estimated from
// frames. Script-driven motion that writes styles every frame (GSAP, scroll libraries) doesn't create animations
// and is not seen here.
//   { op: "install" }  start logging; anything already running counts as seen
//   { op: "take" }  return what started since the last take, and restart the clock for startMs
(arg) => {
  const op = arg && arg.op
  let m = window.__snipMotion
  if (!m) {
    if (op !== "install") return []
    const seen = new WeakSet()
    const log = []
    const LIMIT = 1000
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
    const record = (a) => {
      if (!a || seen.has(a)) return
      seen.add(a)
      const e = a.effect
      if (!e || !e.getKeyframes || log.length >= LIMIT) return
      const t = e.getTiming()
      const name = a.constructor && a.constructor.name
      const keyframes = e.getKeyframes().slice(0, 8).map((k) => {
        const o = {}
        for (const [p, v] of Object.entries(k)) {
          if (v == null || p === "computedOffset" || p === "composite" || (p === "easing" && v === "linear")) continue
          o[p] = typeof v === "number" ? Math.round(v * 1000) / 1000 : String(v).slice(0, 200)
        }
        return o
      })
      log.push({
        type: name === "CSSTransition" ? "transition" : name === "CSSAnimation" ? "animation" : "web-animation",
        target: sel(e.target) + (e.pseudoElement || ""),
        // Web Animations don't name a property: list what their keyframes animate.
        property: a.transitionProperty || a.animationName || [...new Set(keyframes.flatMap((k) => Object.keys(k)).filter((p) => p !== "offset" && p !== "easing"))].join(", ") || null,
        durationMs: round(typeof t.duration === "number" ? t.duration : 0),
        delayMs: round(t.delay),
        easing: t.easing,
        iterations: t.iterations === Infinity ? "infinite" : t.iterations,
        keyframes,
        startMs: Math.round(performance.now() - m.t0),
        scrollY: Math.round(scrollY),
      })
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
    m = window.__snipMotion = { t0: performance.now(), log, record }
    document.getAnimations().forEach((a) => seen.add(a))
    return []
  }
  if (op === "install") return []
  document.getAnimations().forEach(m.record)
  // The same effect on many elements (each letter of a heading, every card in a grid) is one entry with a count.
  const groups = new Map()
  for (const e of m.log.splice(0)) {
    const { startMs, scrollY, ...rest } = e
    const key = JSON.stringify(rest)
    const g = groups.get(key)
    if (g) g.count = (g.count || 1) + 1
    else groups.set(key, e)
  }
  m.t0 = performance.now()
  return [...groups.values()].slice(0, 100)
}
