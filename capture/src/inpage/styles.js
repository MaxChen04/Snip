// Evaluated in the captured page. Serializes per-element computed styles that
// differ from browser defaults (and from the parent, for inherited props),
// plus pseudo-elements, keyframes, CSS variables and aggregated design tokens.
(opts) => {
  const MAX = (opts && opts.maxElements) || 3000
  const INHERITED = new Set([
    "color", "cursor", "direction", "font-family", "font-feature-settings", "font-kerning", "font-optical-sizing",
    "font-size", "font-stretch", "font-style", "font-variant", "font-variant-ligatures", "font-variant-numeric",
    "font-variation-settings", "font-weight", "letter-spacing", "line-height", "list-style-image",
    "list-style-position", "list-style-type", "quotes", "tab-size", "text-align", "text-align-last",
    "text-indent", "text-rendering", "text-shadow", "text-transform", "text-wrap", "visibility", "white-space",
    "white-space-collapse", "word-break", "word-spacing", "overflow-wrap", "hyphens", "caret-color",
    "-webkit-font-smoothing", "-webkit-text-fill-color", "-webkit-text-stroke-color", "-webkit-text-stroke-width",
    "writing-mode", "pointer-events", "fill", "stroke", "stroke-width", "user-select", "orphans", "widows",
  ])
  const SKIP = /^(inline-size|block-size|min-inline-size|min-block-size|max-inline-size|max-block-size|perspective-origin|transform-origin|-webkit-locale|-webkit-user-modify|-webkit-rtl-ordering|border-(block|inline)-|inset-(block|inline)|margin-(block|inline)|padding-(block|inline)|overflow-(block|inline)|scroll-margin-(block|inline)|scroll-padding-(block|inline)|contain-intrinsic-(block|inline)-size)/
  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "LINK", "META", "HEAD", "NOSCRIPT", "TEMPLATE", "BR", "WBR", "TITLE", "SOURCE", "TRACK"])

  const iframe = document.createElement("iframe")
  iframe.style.cssText = "position:absolute;width:0;height:0;border:0;visibility:hidden"
  document.documentElement.appendChild(iframe)
  const idoc = iframe.contentDocument
  idoc.open()
  idoc.write("<!doctype html><html><head></head><body></body></html>")
  idoc.close()
  const defaults = new Map()
  const defaultsFor = (tag) => {
    if (defaults.has(tag)) return defaults.get(tag)
    const el = idoc.createElement(tag)
    idoc.body.appendChild(el)
    const cs = iframe.contentWindow.getComputedStyle(el)
    const o = {}
    for (let i = 0; i < cs.length; i++) o[cs[i]] = cs.getPropertyValue(cs[i])
    el.remove()
    defaults.set(tag, o)
    return o
  }

  const counts = { colors: {}, fonts: {}, fontSizes: {}, spacing: {}, radii: {}, shadows: {}, transitions: {} }
  const bump = (bucket, v) => {
    if (!v) return
    counts[bucket][v] = (counts[bucket][v] || 0) + 1
  }
  const toHex = (c) => {
    const m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?\s*\)$/.exec(c)
    if (!m) return c
    const a = m[4] === undefined ? 1 : parseFloat(m[4])
    if (a === 0) return null
    const hex = "#" + [m[1], m[2], m[3]].map((n) => (+n).toString(16).padStart(2, "0")).join("")
    return a === 1 ? hex : `${hex}${Math.round(a * 255).toString(16).padStart(2, "0")}`
  }
  const isPx = (v) => /^-?\d+(\.\d+)?px$/.test(v) && parseFloat(v) !== 0

  const selectorFor = (el) => {
    const parts = []
    let cur = el
    for (let depth = 0; cur && cur.nodeType === 1 && depth < 4; depth++) {
      let s = cur.tagName.toLowerCase()
      if (cur.id && /^[A-Za-z][\w-]*$/.test(cur.id)) {
        parts.unshift(`${s}#${cur.id}`)
        break
      }
      const cls = [...cur.classList].filter((c) => /^[A-Za-z_][\w-]*$/.test(c)).slice(0, 3)
      if (cls.length) s += "." + cls.join(".")
      const parent = cur.parentElement
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === cur.tagName)
        if (same.length > 1) s += `:nth-of-type(${same.indexOf(cur) + 1})`
      }
      parts.unshift(s)
      cur = parent
    }
    return parts.join(" > ")
  }

  const ownText = (el) => {
    let t = ""
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.textContent
    t = t.replace(/\s+/g, " ").trim()
    return t ? t.slice(0, 80) : undefined
  }

  const diffStyles = (el, cs, parentCs, tag) => {
    const base = defaultsFor(tag)
    const out = {}
    for (let i = 0; i < cs.length; i++) {
      const p = cs[i]
      if (p.startsWith("--") || SKIP.test(p)) continue
      const v = cs.getPropertyValue(p)
      if (INHERITED.has(p)) {
        if (parentCs ? parentCs.getPropertyValue(p) === v : base[p] === v) continue
      } else if (base[p] === v) continue
      if (p === "width" || p === "height") continue
      out[p] = v
    }
    return out
  }

  const pseudo = (el, which) => {
    const cs = getComputedStyle(el, which)
    const content = cs.getPropertyValue("content")
    if (!content || content === "none" || content === "normal") return undefined
    const base = defaultsFor("span")
    const out = { content }
    for (let i = 0; i < cs.length; i++) {
      const p = cs[i]
      if (p.startsWith("--") || SKIP.test(p) || INHERITED.has(p)) continue
      const v = cs.getPropertyValue(p)
      if (base[p] !== v) out[p] = v
    }
    return out
  }

  const elements = []
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT)
  let el = walker.currentNode
  const csCache = new WeakMap()
  const getCs = (e) => {
    let cs = csCache.get(e)
    if (!cs) {
      cs = getComputedStyle(e)
      csCache.set(e, cs)
    }
    return cs
  }
  while (el && elements.length < MAX) {
    if (!SKIP_TAGS.has(el.tagName) && el !== iframe) {
      const cs = getCs(el)
      if (cs.display !== "none") {
        const r = el.getBoundingClientRect()
        const tag = el.tagName.toLowerCase()
        if (r.width > 0 && r.height > 0) {
          const parentCs = el.parentElement ? getCs(el.parentElement) : null
          const styles = diffStyles(el, cs, parentCs, tag)
          const rec = {
            sel: selectorFor(el),
            tag,
            text: ownText(el),
            rect: { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) },
            styles,
          }
          const before = pseudo(el, "::before")
          const after = pseudo(el, "::after")
          if (before) rec.before = before
          if (after) rec.after = after
          elements.push(rec)

          // Tokens
          for (const p of ["color", "background-color", "border-top-color", "border-bottom-color", "fill", "stroke", "outline-color"]) {
            const v = cs.getPropertyValue(p)
            if (p.startsWith("border") && parseFloat(cs.getPropertyValue(p.replace("color", "width"))) === 0) continue
            if (p === "outline-color" && cs.outlineStyle === "none") continue
            if ((p === "fill" || p === "stroke") && tag !== "svg" && tag !== "path") continue
            if (v && v !== "none") bump("colors", toHex(v))
          }
          if (ownText(el)) {
            bump("fonts", cs.fontFamily)
            bump("fontSizes", cs.fontSize)
          }
          for (const p of ["padding-top", "padding-right", "padding-bottom", "padding-left", "margin-top", "margin-bottom", "row-gap", "column-gap"]) {
            const v = cs.getPropertyValue(p)
            if (isPx(v)) bump("spacing", v.replace(/\.\d+px$/, "px").replace(/^-/, ""))
          }
          const radius = cs.borderTopLeftRadius
          if (radius && radius !== "0px") bump("radii", radius)
          if (cs.boxShadow && cs.boxShadow !== "none") bump("shadows", cs.boxShadow)
          const durs = cs.transitionDuration.split(",").map((s) => s.trim())
          if (durs.some((d) => d !== "0s")) {
            const props = cs.transitionProperty.split(",").map((s) => s.trim())
            const fns = cs.transitionTimingFunction.split(/,(?![^(]*\))/).map((s) => s.trim())
            props.forEach((p, i) => {
              const d = durs[i % durs.length]
              if (d !== "0s") bump("transitions", `${p} ${d} ${fns[i % fns.length]}`)
            })
          }
        }
      }
    }
    el = walker.nextNode()
  }

  // Keyframes and font faces from readable stylesheets.
  const keyframes = []
  const fontFaces = []
  const hoverSelectors = []
  const visit = (rules) => {
    for (const rule of rules) {
      if (rule.type === CSSRule.KEYFRAMES_RULE) keyframes.push({ name: rule.name, css: rule.cssText })
      else if (rule.type === CSSRule.FONT_FACE_RULE) fontFaces.push(rule.cssText)
      else if (rule.type === CSSRule.STYLE_RULE && rule.selectorText.includes(":hover")) hoverSelectors.push(rule.cssText.slice(0, 500))
      if (rule.cssRules) visit(rule.cssRules)
    }
  }
  for (const sheet of [...document.styleSheets, ...(document.adoptedStyleSheets || [])]) {
    try {
      visit(sheet.cssRules)
    } catch {
      /* cross-origin */
    }
  }

  const cssVariables = {}
  const rootCs = getComputedStyle(document.documentElement)
  for (let i = 0; i < rootCs.length; i++) {
    const p = rootCs[i]
    if (p.startsWith("--")) cssVariables[p] = rootCs.getPropertyValue(p).trim()
  }

  iframe.remove()

  const top = (bucket, n) =>
    Object.entries(counts[bucket])
      .filter(([v]) => v && v !== "null")
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([value, count]) => ({ value, count }))

  const tokens = {
    colors: top("colors", 48),
    fonts: top("fonts", 10).map(({ value, count }) => ({ family: value, count })),
    fontSizes: top("fontSizes", 24).sort((a, b) => parseFloat(a.value) - parseFloat(b.value)),
    spacing: top("spacing", 24).sort((a, b) => parseFloat(a.value) - parseFloat(b.value)),
    radii: top("radii", 16),
    shadows: top("shadows", 12),
    transitions: top("transitions", 24),
    keyframes: [...new Set(keyframes.map((k) => k.name))],
    cssVariables,
  }

  return {
    url: location.href,
    viewport: { width: innerWidth, height: innerHeight },
    document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
    elementCount: elements.length,
    truncated: elements.length >= MAX,
    elements,
    keyframes,
    fontFaces,
    hoverRules: hoverSelectors.slice(0, 400),
    cssVariables,
    tokens,
  }
}
