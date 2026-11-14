// The one rule for a web address the user adds. The Worker enforces it when a reference is created (db.normalizeUrl), and the app
// imports the same function to judge what is typed or pasted, so the two can never disagree about what is accepted or why not.
// Only the URL global, so it runs in the Worker, the browser and Node alike.

/** The longest web address accepted, as typed (after trimming). Browsers and servers give up on much less than this. */
export const MAX_SITE_URL_LENGTH = 2048

export type SiteUrlCheck = { url: URL } | { error: string }

/**
 * Checks a web address and returns it normalised, or a sentence the user can read.
 *
 * Input with no scheme at all gets https://. It must then be http or https, no longer than MAX_SITE_URL_LENGTH, carry no username,
 * password or whitespace, and name a host: one with a dot, `localhost` or an IP literal. The fragment is dropped.
 * Loopback and private addresses pass: the capture agent's own egress guard decides those.
 */
export function checkSiteUrl(input: string): SiteUrlCheck {
  const raw = input.trim()
  if (!raw) return { error: "Enter a web address" }
  if (raw.length > MAX_SITE_URL_LENGTH) return { error: "That web address is too long." }
  if (/\s/.test(raw)) return { error: "A web address cannot contain spaces" }
  // "localhost:3000" and "example.com:8080" start with a host and a port, not a scheme.
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[^/?#]*:\d+(?:[/?#]|$)/.test(raw)
  let url: URL
  try {
    url = new URL(hasScheme ? raw : `https://${raw}`)
  } catch {
    return { error: "That is not a valid web address" }
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { error: "Only http and https addresses can be captured" }
  if (url.username || url.password) return { error: "A web address cannot contain a username or password" }
  // An IPv4 literal always has dots once parsed, and an IPv6 one is in brackets.
  if (!url.hostname.includes(".") && url.hostname !== "localhost" && !url.hostname.startsWith("[")) return { error: "A web address needs a host name, like example.com" }
  url.hash = ""
  return { url }
}
