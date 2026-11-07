// Maps `snip://settings/...` to files inside the built Settings bundle. The scheme
// is registered as standard+secure so ES modules, CSS and fonts load exactly as they
// do over HTTP, from disk, with no local Worker running.
const fs = require("node:fs")
const path = require("node:path")

const SETTINGS_ORIGIN = "snip://settings"
const SETTINGS_ENTRY = "index.html"

// Settings is the privileged, offline window: it loads nothing from the network, ever.
// Every asset, including the Inter face, is shipped in the bundle. There is no
// connect-src to grant, no form to submit and no frame to embed. Keeping the policy
// here lets a test assert it never grows a remote host.
const SETTINGS_CSP = Object.freeze({
  defaultSrc: "'none'",
  scriptSrc: "'self'",
  styleSrc: "'self' 'unsafe-inline'",
  fontSrc: "'self'",
  imgSrc: "'self' data:",
  baseUri: "'none'",
  formAction: "'none'",
  frameAncestors: "'none'",
})

function settingsCsp(directives = SETTINGS_CSP) {
  return Object.entries(directives)
    .map(([key, value]) => `${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)} ${value}`)
    .join("; ")
}

function inside(root, target) {
  const relative = path.relative(root, target)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

/** Absolute file path for a settings URL, or null when it would leave the bundle. */
function resolveSettingsAsset(root, requestUrl) {
  let parsed
  try {
    parsed = new URL(requestUrl)
  } catch {
    return null
  }
  if (parsed.protocol !== "snip:" || parsed.host !== "settings") return null
  let pathname
  try {
    pathname = decodeURIComponent(parsed.pathname)
  } catch {
    return null
  }
  if (pathname.includes("\0")) return null
  if (pathname === "/" || pathname === "") pathname = `/${SETTINGS_ENTRY}`
  const target = path.resolve(root, `.${pathname}`)
  if (!inside(path.resolve(root), target)) return null
  try {
    if (!fs.statSync(target).isFile()) return null
  } catch {
    return null
  }
  return target
}

function contentType(file) {
  switch (path.extname(file).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8"
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8"
    case ".css":
      return "text/css; charset=utf-8"
    case ".json":
      return "application/json; charset=utf-8"
    case ".svg":
      return "image/svg+xml"
    case ".png":
      return "image/png"
    case ".jpg":
    case ".jpeg":
      return "image/jpeg"
    case ".webp":
      return "image/webp"
    case ".woff2":
      return "font/woff2"
    case ".woff":
      return "font/woff"
    case ".ico":
      return "image/x-icon"
    default:
      return "application/octet-stream"
  }
}

const settingsUrl = (query = "") => `${SETTINGS_ORIGIN}/${SETTINGS_ENTRY}${query}`

module.exports = { SETTINGS_ORIGIN, SETTINGS_ENTRY, SETTINGS_CSP, settingsCsp, resolveSettingsAsset, contentType, settingsUrl, inside }
