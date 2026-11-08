// The owner link hands the app a session over the loopback. This turns that one event
// into the cookie Chromium needs, and refuses anything that isn't a plain token for
// this Mac's https cloud origin. The token never leaves main.
const SESSION_COOKIE = "rs_session"
const MAX_TOKEN = 4096
const THIRTY_DAYS = 30 * 24 * 60 * 60

function isHttpsOrigin(url) {
  try {
    return new URL(url).protocol === "https:"
  } catch {
    return false
  }
}

/** `null` means "do not sign in"; never throw, never log the token. */
function sessionCookie(event, fallbackUrl, now = Date.now()) {
  const token = event?.token
  if (typeof token !== "string" || !token || token.length > MAX_TOKEN || /\s/.test(token)) return null
  const candidate = typeof event?.url === "string" && event.url ? event.url : fallbackUrl
  if (!isHttpsOrigin(candidate)) return null
  const origin = new URL(candidate).origin
  return {
    url: origin,
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    expirationDate: Math.floor(now / 1000) + THIRTY_DAYS,
  }
}

/** Shell-opening is separate from trusting the engine: only web pages open externally. */
function externalUrl(value) {
  try {
    const url = new URL(value)
    return ["https:", "http:"].includes(url.protocol) ? url.href : null
  } catch {
    return null
  }
}

module.exports = { SESSION_COOKIE, sessionCookie, externalUrl, isHttpsOrigin }
