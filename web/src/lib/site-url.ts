/** Accepts "linear.app" or a full URL; returns null until it looks like a real host. */
export function parseSiteUrl(raw: string): URL | null {
  const s = raw.trim()
  if (!s) return null
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`)
    if (!/^https?:$/.test(u.protocol) || !u.hostname.includes(".")) return null
    return u
  } catch {
    return null
  }
}

/** Every distinct website in pasted text (one per line, or separated by spaces or commas). */
export function extractUrls(text: string): URL[] {
  const seen = new Set<string>()
  const out: URL[] = []
  for (const part of text.split(/[\s,]+/)) {
    const u = parseSiteUrl(part)
    if (u && !seen.has(u.href)) {
      seen.add(u.href)
      out.push(u)
    }
  }
  return out
}
