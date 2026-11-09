// Evaluated in the captured page, scrolled to the top: splits it into its visual sections (header, hero, content
// blocks, footer) from the DOM. Returns document coordinates in CSS px that tile the page top to bottom, or []
// when the page doesn't break into at least two sections.
(opts) => {
  const { maxPx = 16000, max = 24, min = 160 } = opts || {}
  const docH = Math.min(maxPx, Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0))
  const vh = innerHeight
  const box = (el) => {
    const r = el.getBoundingClientRect()
    return { top: r.top + scrollY, bottom: r.bottom + scrollY, h: r.height, w: r.width }
  }
  const visible = (el) => {
    const cs = getComputedStyle(el)
    return cs.display !== "none" && cs.visibility !== "hidden" && cs.position !== "fixed" && cs.position !== "absolute"
  }
  // Full-width-ish, visible children in flow. A display: contents wrapper has no box; its children stand in for it.
  const children = (el) => Array.from(el.children).flatMap((c) => (getComputedStyle(c).display === "contents" ? children(c) : [c]))
  const blocks = (el) => children(el).filter((c) => {
    if (!visible(c)) return false
    const b = box(c)
    return b.h >= 8 && b.w >= innerWidth * 0.5
  })

  // Skip wrapper divs (#__next, #root, <main> holding everything) down to the element whose children are the sections.
  let root = document.body
  for (let depth = 0; root && depth < 12; depth++) {
    const kids = blocks(root)
    if (kids.length !== 1 || box(kids[0]).h < box(root).h * 0.85) break
    root = kids[0]
  }
  if (!root) return []

  // A very tall child that is itself a stack of blocks (a <main> between header and footer) is opened up,
  // through any single-child wrappers inside it.
  const expand = (els, depth) => els.flatMap((el) => {
    if (depth >= 6 || box(el).h <= vh * 2.2) return [el]
    let kids = blocks(el)
    while (kids.length === 1 && box(kids[0]).h >= box(el).h * 0.85) kids = blocks(kids[0])
    return kids.length >= 2 ? expand(kids, depth + 1) : [el]
  })
  let items = expand(blocks(root), 0)
    .map((el) => ({ el, ...box(el) }))
    .sort((a, b) => a.top - b.top)
  // Drop anything overlapping the one before it (side-by-side or layered blocks).
  items = items.filter((it, i, all) => i === 0 || it.top >= all[i - 1].bottom - 4)
  if (items.length < 2) return []

  // Tile the page: each section runs to the next one's top, the first from 0, the last to the end.
  const cuts = items.map((it, i) => ({
    el: it.el,
    top: i === 0 ? 0 : Math.round(it.top),
    bottom: i === items.length - 1 ? docH : Math.round(items[i + 1].top),
  })).filter((s) => s.top < docH)
  if (cuts.length) cuts[cuts.length - 1].bottom = docH

  // A short header bar or footer is a section of its own; it never folds into a neighbour or takes one in.
  const isHeader = (el) => /^(header|nav)$/i.test(el.tagName) || /^(banner|navigation)$/.test(el.getAttribute("role") || "") || !!el.querySelector(":scope > nav, :scope > header")
  const isFooter = (el) => /^footer$/i.test(el.tagName) || el.getAttribute("role") === "contentinfo"
  const fixed = (i) => (i === 0 && isHeader(cuts[i].el)) || (i === cuts.length - 1 && isFooter(cuts[i].el))
  const size = (i) => (fixed(i) ? Infinity : cuts[i].bottom - cuts[i].top)
  // Fold slivers into a neighbour, then the smallest sections until at most `max` remain.
  const merge = (i) => {
    const j = i === 0 ? 1 : i === cuts.length - 1 ? i - 1 : size(i - 1) <= size(i + 1) ? i - 1 : i + 1
    const [a, b] = i < j ? [i, j] : [j, i]
    // The taller of the two names the merged section.
    const keep = cuts[a].bottom - cuts[a].top >= cuts[b].bottom - cuts[b].top ? cuts[a].el : cuts[b].el
    cuts.splice(a, 2, { el: keep, top: cuts[a].top, bottom: cuts[b].bottom })
  }
  // A short band that is only a heading and some text introduces the block below it: join them, named by the heading.
  const headingOf = (el) => (el.matches("h1, h2, h3") ? el : el.querySelector("h1, h2, h3"))
  const headingBand = (i) => {
    const el = cuts[i].el
    return size(i) < 360 && !!headingOf(el) && !el.querySelector("img, svg, video, canvas, picture, iframe, input")
  }
  for (let i = 0; i < cuts.length - 1; ) {
    if (headingBand(i) && !fixed(i + 1)) cuts.splice(i, 2, { el: cuts[i].el, top: cuts[i].top, bottom: cuts[i + 1].bottom })
    else i++
  }
  for (let i = 0; i < cuts.length && cuts.length > 1; ) {
    if (size(i) < min) merge(i)
    else i++
  }
  while (cuts.length > max) {
    let smallest = 0
    cuts.forEach((s, i) => { if (size(i) < size(smallest)) smallest = i })
    merge(smallest)
  }
  if (cuts.length < 2) return []

  const clean = (s) => (s || "").replace(/\s+/g, " ").trim().slice(0, 60)
  // What the section shows (its text and media sources), so the same section can be recognised on another page.
  // Independent of animation state: a marquee's text and images are the same whatever its position.
  const fingerprint = (el) => {
    const media = Array.from(el.querySelectorAll("img, video, source, image"), (m) => m.currentSrc || m.src || m.getAttribute("href") || "").slice(0, 30)
    const text = `${(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 3000)}|${media.join(",")}|${el.querySelectorAll("svg, canvas").length}`
    let h = 5381
    for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0
    return (h >>> 0).toString(36)
  }
  const kindOf = (el, i) => {
    if (i === 0 && isHeader(el)) return "header"
    if (i === cuts.length - 1 && (isFooter(el) || el.querySelector("footer"))) return "footer"
    return "section"
  }
  let heroSeen = false
  return cuts.map((s, i) => {
    let kind = kindOf(s.el, i)
    if (kind === "section" && !heroSeen && s.top < vh) kind = "hero"
    if (kind !== "header") heroSeen = true
    const heading = headingOf(s.el)
    // Ids name sections only when they read like a name ("pricing", "customers"), not a generated or layout id.
    const id = /^[a-z][a-z-_ ]{2,23}$/i.test(s.el.id) && s.el.id.split(/[-_ ]+/).length <= 3 ? s.el.id.replace(/[-_]+/g, " ") : ""
    // innerText follows rendered lines, so text in nested spans keeps its spaces. Headings animated line by line
    // often carry a second copy of their text; keep one.
    let headingText = heading ? (heading.innerText || heading.textContent || "").replace(/\s+/g, " ").trim() : ""
    const half = headingText.slice(0, Math.floor(headingText.length / 2)).trim()
    if (half && headingText === `${half} ${half}`) headingText = half
    const named = clean(s.el.getAttribute("aria-label")) || (kind === "header" || kind === "footer" ? "" : clean(headingText)) || clean(id)
    const label = named || { header: "Header", hero: "Hero", footer: "Footer", section: `Section ${i + 1}` }[kind]
    return { kind, label, y: s.top, height: s.bottom - s.top, fp: fingerprint(s.el) }
  })
}
