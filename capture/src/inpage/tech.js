// Evaluated in the captured page. Finds what moves the page beyond CSS and Web Animations: canvas contexts, the
// WebGL shaders compiled, and animation libraries left as globals. Installed as an init script so it sees contexts
// created while the page loads. Contexts made in workers (OffscreenCanvas) are not seen.
//   { op: "install" }  wrap getContext and shaderSource
//   { op: "take" }  return { libraries, contexts, canvases, shaders }
(arg) => {
  const op = arg && arg.op
  if (op === "install") {
    if (window.__snipTech) return null
    const t = (window.__snipTech = { kinds: new WeakMap(), contexts: {}, shaders: new Set() })
    const getContext = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
      const ctx = getContext.call(this, type, ...rest)
      try {
        if (ctx && !t.kinds.has(this)) {
          t.kinds.set(this, type)
          t.contexts[type] = (t.contexts[type] || 0) + 1
        }
      } catch {}
      return ctx
    }
    for (const C of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
      if (!C) continue
      const shaderSource = C.prototype.shaderSource
      C.prototype.shaderSource = function (shader, source) {
        try { if (t.shaders.size < 200) t.shaders.add(String(source)) } catch {}
        return shaderSource.call(this, shader, source)
      }
    }
    return null
  }
  const t = window.__snipTech
  const w = window
  const libraries = []
  const add = (name, ok) => ok && libraries.push(name)
  if (w.gsap) {
    const st = w.ScrollTrigger && w.ScrollTrigger.getAll ? w.ScrollTrigger.getAll().length : 0
    libraries.push(`GSAP ${w.gsap.version || ""}`.trim() + (st ? ` (${st} ScrollTriggers)` : ""))
  }
  add(`three.js r${w.__THREE__}`, w.__THREE__)
  add("Lottie", w.lottie || w.bodymovin || document.querySelector("lottie-player, dotlottie-player, dotlottie-wc"))
  add("Rive", w.rive || document.querySelector("canvas[data-rive], rive-canvas"))
  add("Spline", document.querySelector("spline-viewer"))
  add("Unicorn Studio", w.UnicornStudio || document.querySelector("[data-us-project]"))
  add("PixiJS", w.PIXI || w.__PIXI_APP__)
  add("Lenis smooth scroll", w.Lenis || w.lenis || /\blenis\b/.test(document.documentElement.className))
  add("Locomotive Scroll", w.LocomotiveScroll || document.querySelector("[data-scroll-container]"))
  add("Framer", document.querySelector("[data-framer-name], [data-framer-appear-id], [data-framer-component-type]"))
  add("Motion", w.Motion)
  add("anime.js", w.anime)
  add("Webflow Interactions", w.Webflow && document.querySelector("[data-w-id]"))
  add("Barba.js", w.barba)
  add("Swiper", w.Swiper || document.querySelector(".swiper-initialized"))
  add("Astro view transitions", document.querySelector('meta[name="astro-view-transitions-enabled"]'))
  const canvases = [...document.querySelectorAll("canvas")]
    .map((c) => {
      const r = c.getBoundingClientRect()
      return { context: (t && t.kinds.get(c)) || null, width: Math.round(r.width), height: Math.round(r.height), y: Math.round(r.top + scrollY) }
    })
    .filter((c) => c.width >= 24 && c.height >= 24)
    .slice(0, 20)
  const shaders = t ? [...t.shaders] : []
  return {
    libraries,
    contexts: t ? t.contexts : {},
    canvases,
    // The longest first: short ones are mostly the same textured-quad pass every renderer has.
    shaders: { count: shaders.length, sources: shaders.sort((a, b) => b.length - a.length).slice(0, 6).map((s) => s.slice(0, 2000)) },
  }
}
