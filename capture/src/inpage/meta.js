// Evaluated in the captured page: title, description, favicon, canonical URL and same-site links.
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
  const canonical = document.querySelector('link[rel~="canonical"]')?.getAttribute("href")
  return {
    canonical: canonical ? abs(canonical) : null,
    title: document.title || null,
    description: document.querySelector('meta[name="description"], meta[property="og:description"]')?.getAttribute("content") || null,
    favicon: icon ? abs(icon.getAttribute("href")) : abs("/favicon.ico"),
    links,
  }
}
