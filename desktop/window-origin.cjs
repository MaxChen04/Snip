// Every IPC shortcut goes through one sender check, but the two windows are different
// trust domains: the gallery carries the desktop bridge on a localhost origin, and
// Settings is a file we ship on a custom scheme. A window is pinned to the origin it
// was created for, so a navigation elsewhere can never inherit either bridge.

function parse(url) {
  try {
    const parsed = new URL(url)
    const host = parsed.host.toLowerCase()
    // Node treats a non-special scheme as opaque origin ("null"); name it ourselves.
    const origin = parsed.protocol === "snip:" ? `snip://${host}` : parsed.origin
    return { protocol: parsed.protocol, host, pathname: parsed.pathname, origin }
  } catch {
    return null
  }
}

const originOf = url => parse(url)?.origin ?? null

/** The routes Snip's own windows own: the gallery, the guide and a reference. */
function isAppRoute(url, appOrigin) {
  const parsed = parse(url)
  if (!parsed || !appOrigin || parsed.origin !== appOrigin) return false
  return parsed.pathname === "/" || parsed.pathname === "/guide" || /^\/r\/[^/]+$/.test(parsed.pathname)
}

/** The local gallery never gains the desktop bridge on any other localhost page. */
const isGallery = isAppRoute

function isSettingsUrl(url) {
  return parse(url)?.origin === "snip://settings"
}

/**
 * A window's pin is `{ role: "local" | "cloud" | "settings", origin }`, recorded when
 * the window is created. Navigation stays inside that origin.
 */
function allowsNavigation(pin, toUrl) {
  const parsed = parse(toUrl)
  return !!pin && !!parsed && parsed.origin === pin.origin
}

/**
 * Trusted renderer for one IPC event. `senderMatches` is
 * `event.sender === window.webContents`, `frameIsMain` is
 * `event.senderFrame === window.webContents.mainFrame`, and `frameUrl` is
 * `event.senderFrame.url`. The cloud window deliberately has no preload, so it can
 * never be a trusted sender.
 */
function trustedSender({ pin, localOrigin, senderMatches, frameIsMain, frameUrl }) {
  if (!pin || !senderMatches || !frameIsMain || typeof frameUrl !== "string") return false
  if (pin.role === "settings") return isSettingsUrl(frameUrl)
  if (pin.role === "local") return pin.origin === localOrigin && isGallery(frameUrl, localOrigin)
  return false
}

module.exports = { parse, originOf, isAppRoute, isGallery, isSettingsUrl, allowsNavigation, trustedSender }
