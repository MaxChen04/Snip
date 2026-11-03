// Evaluated in the captured page: title, description, favicon and same-site links.
() => {
  const abs = (h) => {
    try {
      return new URL(h, location.href).href
    } catch {
      return null
    }
  }
  const icon =
    document.querySelector('link[rel~="icon"][sizes="32x32"], link[rel~="icon"][type="image/png"], link[rel~="icon"], link[rel="apple-touch-icon"]')
  const links = [...document.querySelectorAll("a[href]")]
    .map((a) => ({ href: abs(a.getAttribute("href")), nav: !!a.closest("nav, header, footer") }))
    .filter((l) => l.href)
  return {
    title: document.title || null,
    description: document.querySelector('meta[name="description"], meta[property="og:description"]')?.getAttribute("content") || null,
    favicon: icon ? abs(icon.getAttribute("href")) : abs("/favicon.ico"),
    links,
  }
}
