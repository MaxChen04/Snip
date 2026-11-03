// Evaluated in the captured page. Builds a self-contained HTML document:
// scripts removed, CSSOM-injected rules (CSS-in-JS) materialized, linked
// stylesheets replaced by placeholders that Node fills with fetched CSS.
() => {
  const SHEET_TOKEN = "__RS_SHEET_"
  const sheets = []
  const doc = document
  const clone = doc.documentElement.cloneNode(true)

  // Materialize <style> rules (styled-components/emotion insert via CSSOM).
  const origStyles = [...doc.querySelectorAll("style")]
  const cloneStyles = [...clone.querySelectorAll("style")]
  origStyles.forEach((s, i) => {
    const c = cloneStyles[i]
    if (!c || !s.sheet) return
    try {
      const text = [...s.sheet.cssRules].map((r) => r.cssText).join("\n")
      if (text.length > (s.textContent || "").trim().length) c.textContent = text
    } catch {
      /* ignore */
    }
  })

  // Linked stylesheets -> placeholders.
  const origLinks = [...doc.querySelectorAll('link[rel~="stylesheet"]')]
  const cloneLinks = [...clone.querySelectorAll('link[rel~="stylesheet"]')]
  origLinks.forEach((l, i) => {
    const c = cloneLinks[i]
    if (!c) return
    if (l.disabled || !l.href) {
      c.remove()
      return
    }
    let inline = null
    try {
      if (l.sheet) inline = [...l.sheet.cssRules].map((r) => r.cssText).join("\n")
    } catch {
      /* cross-origin: Node fetches it */
    }
    const idx = sheets.length
    sheets.push({ href: l.href, media: l.media || "", inline })
    const style = doc.createElement("style")
    style.setAttribute("data-rs-href", l.href)
    if (l.media) style.setAttribute("media", l.media)
    style.textContent = `${SHEET_TOKEN}${idx}__`
    c.replaceWith(style)
  })

  // Constructed stylesheets.
  for (const sheet of doc.adoptedStyleSheets || []) {
    try {
      const style = doc.createElement("style")
      style.setAttribute("data-rs-adopted", "")
      style.textContent = [...sheet.cssRules].map((r) => r.cssText).join("\n")
      clone.querySelector("head")?.appendChild(style)
    } catch {
      /* ignore */
    }
  }

  // Images: freeze the resolved source, disable lazy loading.
  const origImgs = [...doc.images]
  const cloneImgs = [...clone.querySelectorAll("img")]
  origImgs.forEach((img, i) => {
    const c = cloneImgs[i]
    if (!c) return
    const src = img.currentSrc || img.src
    if (src) c.setAttribute("src", src)
    c.removeAttribute("loading")
    c.removeAttribute("srcset")
    c.removeAttribute("sizes")
  })
  clone.querySelectorAll("picture source").forEach((s) => s.remove())

  // Canvas -> image.
  const origCanvas = [...doc.querySelectorAll("canvas")]
  const cloneCanvas = [...clone.querySelectorAll("canvas")]
  origCanvas.forEach((cv, i) => {
    const c = cloneCanvas[i]
    if (!c) return
    try {
      const img = doc.createElement("img")
      img.src = cv.toDataURL("image/png")
      img.className = cv.className
      img.setAttribute("style", cv.getAttribute("style") || "")
      img.width = cv.width
      img.height = cv.height
      c.replaceWith(img)
    } catch {
      /* tainted */
    }
  })

  // Form state.
  const origInputs = [...doc.querySelectorAll("input, textarea, select")]
  const cloneInputs = [...clone.querySelectorAll("input, textarea, select")]
  origInputs.forEach((inp, i) => {
    const c = cloneInputs[i]
    if (!c) return
    if (inp.type === "checkbox" || inp.type === "radio") {
      if (inp.checked) c.setAttribute("checked", "")
    } else if (inp.tagName === "TEXTAREA") c.textContent = inp.value
    else if (inp.tagName !== "SELECT" && inp.type !== "password") c.setAttribute("value", inp.value)
  })

  // Strip active content.
  clone.querySelectorAll('script, noscript, link[rel="preload"], link[rel="modulepreload"], link[rel="prefetch"], link[rel="manifest"], meta[http-equiv]').forEach((n) => n.remove())
  clone.querySelectorAll("*").forEach((n) => {
    for (const a of [...n.attributes]) {
      if (/^on/i.test(a.name)) n.removeAttribute(a.name)
      else if (/^(href|src|action|formaction)$/i.test(a.name) && /^\s*javascript:/i.test(a.value)) n.removeAttribute(a.name)
    }
  })

  // Base URL + capture metadata.
  const head = clone.querySelector("head") || clone.insertBefore(doc.createElement("head"), clone.firstChild)
  head.querySelectorAll("base").forEach((b) => b.remove())
  const base = doc.createElement("base")
  base.href = location.href
  base.target = "_blank"
  head.insertBefore(base, head.firstChild)
  const meta = doc.createElement("meta")
  meta.name = "snip-captured"
  meta.content = `${location.href} @ ${new Date().toISOString()}`
  head.insertBefore(meta, base.nextSibling)
  // Avoid smooth-scroll jumps when browsing the static snapshot.
  const reveal = doc.createElement("style")
  reveal.setAttribute("data-rs", "")
  reveal.textContent = "html{scroll-behavior:auto!important}"
  head.appendChild(reveal)

  const dt = doc.doctype ? `<!DOCTYPE ${doc.doctype.name}>` : "<!DOCTYPE html>"
  return { html: `${dt}\n${clone.outerHTML}`, sheets, token: SHEET_TOKEN }
}
