// The owner-link URL is meant for a person: it is what their browser opens. The
// session token the same run may hand back is a different thing entirely, and this
// module only ever reads the link (contracts §4.2, §3).

const OWNER_PATH = "/auth/owner"

/** Loopback is the one place Snip's own library is served over plain http. */
function isLoopback(hostname) {
  return hostname === "localhost" || hostname === "[::1]" || hostname === "::1" || /^127\./.test(hostname)
}

/**
 * The link, if this event carries one, else null.
 *
 * Only three places can: `owner-mint`'s step data, the `human` open_url event, and
 * the command's result data. Never a `session` event, and never a guessed value.
 */
function ownerLinkFrom(event, cloudUrl) {
  if (!event || typeof event !== "object" || event.event === "session") return null
  let candidate = null
  if (event.event === "step" && event.step === "owner-mint" && event.data && typeof event.data === "object") {
    // A step's `data` is whatever the step returned; the mint returns `{ data: { url } }`.
    const inner = event.data.data && typeof event.data.data === "object" ? event.data.data : event.data
    if (typeof inner.url === "string") candidate = inner.url
  } else if (event.event === "human" && event.action === "open_url" && typeof event.url === "string") candidate = event.url
  else if (event.event === "result" && event.data && typeof event.data.url === "string") candidate = event.data.url
  if (!candidate || candidate.length > 4096) return null
  let url
  try {
    url = new URL(candidate)
  } catch {
    return null
  }
  // A link is only useful against the library it was minted for, and the engine mints
  // exactly one parameter. Anything else is not that link.
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) return null
  if (url.pathname !== OWNER_PATH) return null
  const keys = [...url.searchParams.keys()]
  if (keys.length !== 1 || keys[0] !== "t") return null
  if (!url.searchParams.get("t")) return null
  if (cloudUrl) {
    try {
      if (url.origin !== new URL(cloudUrl).origin) return null
    } catch {
      return null
    }
  }
  return url.href
}

/**
 * The one sentence Settings shows under the link (contracts v3.22 §1.4.2). The run
 * cannot observe the other device, so this describes what the link does, not a state
 * Snip has seen: nothing here may claim this Mac was signed in.
 */
const LINK_NOTE = "Works once and expires in 10 minutes. The browser that opens it is signed in and can add a passkey."

/** The same 10 minutes the engine stamps into the link (contracts §4.2). */
const LINK_TTL_MS = 10 * 60_000

module.exports = { ownerLinkFrom, LINK_NOTE, LINK_TTL_MS, OWNER_PATH }
