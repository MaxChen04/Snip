// Evaluated in the captured page: its visible text as blocks with their document y, for search.
// Text in hidden elements, scripts and styles is left out; image alt text and aria-labels count.
({ max }) => {
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "IFRAME", "CANVAS", "VIDEO", "AUDIO"])
  const blocks = []
  const seen = new WeakSet()
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    if (!r.width || !r.height) return null
    const cs = getComputedStyle(el)
    if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) return null
    return r
  }
  const push = (el, text) => {
    const t = text.replace(/\s+/g, " ").trim()
    if (!t) return
    const r = visible(el)
    if (!r) return
    blocks.push({ y: Math.max(0, Math.round(r.top + scrollY)), t: t.slice(0, 400) })
  }
  const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.nodeType === 1 && SKIP.has(n.nodeName.toUpperCase()) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  })
  for (let n = walker.nextNode(); n && blocks.length < max; n = walker.nextNode()) {
    if (n.nodeType === 3) {
      // One block per parent element, so a paragraph broken by <strong> or <a> stays one line.
      const el = n.parentElement
      if (!el || seen.has(el)) continue
      seen.add(el)
      const own = [...el.childNodes].filter((c) => c.nodeType === 3 || (c.nodeType === 1 && !c.children.length && getComputedStyle(c).display.startsWith("inline")))
      push(el, own.map((c) => { if (c.nodeType === 1) seen.add(c); return c.textContent ?? "" }).join(" "))
    } else {
      const el = n
      const label = el.nodeName === "IMG" ? el.getAttribute("alt") : el.getAttribute("aria-label")
      if (label) push(el, label)
    }
  }
  return blocks
}
