// Evaluated in the captured page. Picks a handful of elements likely to have
// hover effects (matching :hover rules or carrying transitions), marks them
// with data-rs-hover and returns their boxes.
(opts) => {
  const max = (opts && opts.max) || 6
  const limitY = (opts && opts.limitY) || innerHeight * 4
  const candidates = new Map()
  const add = (el, score) => {
    if (!(el instanceof Element)) return
    candidates.set(el, (candidates.get(el) || 0) + score)
  }

  // 1. Elements matched by :hover rules in readable stylesheets.
  const visit = (rules) => {
    for (const rule of rules) {
      if (rule.type === CSSRule.STYLE_RULE && rule.selectorText.includes(":hover")) {
        for (const part of rule.selectorText.split(",")) {
          if (!part.includes(":hover")) continue
          const baseSel = part.split(":hover")[0].trim()
          if (!baseSel || /:(not|has|is|where)\($/.test(baseSel)) continue
          try {
            document.querySelectorAll(baseSel).forEach((el) => add(el, 3))
          } catch {
            /* invalid after stripping */
          }
        }
      }
      if (rule.cssRules) visit(rule.cssRules)
    }
  }
  for (const sheet of document.styleSheets) {
    try {
      visit(sheet.cssRules)
    } catch {
      /* cross-origin */
    }
  }

  // 2. Interactive elements with transitions on themselves or children.
  document.querySelectorAll('a, button, [role="button"], [class*="card" i], [class*="btn" i], li').forEach((el) => {
    const hasTransition = (e) => getComputedStyle(e).transitionDuration.split(",").some((d) => d.trim() !== "0s")
    if (hasTransition(el)) add(el, 2)
    else if ([...el.querySelectorAll("*")].slice(0, 15).some(hasTransition)) add(el, 1)
  })

  const seen = new Set()
  const picked = []
  const ranked = [...candidates.entries()].sort((a, b) => b[1] - a[1])
  for (const [el] of ranked) {
    if (picked.length >= max) break
    const r = el.getBoundingClientRect()
    const y = r.top + scrollY
    if (r.width < 24 || r.height < 16 || r.width > 900 || r.height > 640 || y > limitY || y < 0) continue
    const cs = getComputedStyle(el)
    if (cs.visibility === "hidden" || cs.display === "none" || parseFloat(cs.opacity) === 0) continue
    // Skip nested picks and visually identical siblings.
    if (picked.some((p) => p.el.contains(el) || el.contains(p.el))) continue
    const sig = `${el.tagName}.${[...el.classList].sort().join(".")}:${Math.round(r.width / 20)}x${Math.round(r.height / 20)}`
    if (seen.has(sig)) continue
    seen.add(sig)
    const i = picked.length
    el.setAttribute("data-rs-hover", String(i))
    const label =
      (el.getAttribute("aria-label") || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40) || el.tagName.toLowerCase()
    const cls = [...el.classList].slice(0, 2).join(".")
    picked.push({ el, i, label, selector: `${el.tagName.toLowerCase()}${cls ? "." + cls : ""}` })
  }
  return picked.map(({ i, label, selector }) => ({ i, label, selector }))
}
