import { lookup } from "node:dns/promises"
import { isIP } from "node:net"

// Keeps captures on the public internet. A reference can be queued by an MCP client, and a page's
// HTML is handed back to that client, so without this a prompt-injected agent could have the
// capture machine screenshot its router, a localhost service or a cloud metadata endpoint.
// ALLOW_PRIVATE_URLS=true in capture/.env turns it off, for capturing your own local sites.

export const allowPrivateUrls = () => process.env.ALLOW_PRIVATE_URLS === "true"

export class PrivateAddressError extends Error {
  constructor(host: string) {
    super(`Snip doesn't capture private network addresses (${host}). To capture a local site, set ALLOW_PRIVATE_URLS=true in capture/.env and restart the capture agent.`)
  }
}

function ipv4Private(ip: string) {
  const [a, b] = ip.split(".").map(Number) as [number, number]
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast and reserved
  )
}

/** True for loopback, private, link-local and other non-public addresses. */
export function isPrivateIp(ip: string): boolean {
  const kind = isIP(ip)
  if (kind === 4) return ipv4Private(ip)
  if (kind !== 6) return false
  const v6 = ip.toLowerCase()
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return ipv4Private(mapped[1]!)
  if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(v6)) {
    const [hi, lo] = v6.slice(7).split(":").map((h) => parseInt(h, 16)) as [number, number]
    return ipv4Private(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)
  }
  return v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || /^ff/.test(v6)
}

const bare = (host: string) => host.replace(/^\[|\]$/g, "").toLowerCase()

/** Private by name alone, with no DNS lookup: IP literals, localhost and mDNS names. */
export function isPrivateHostLiteral(hostname: string): boolean {
  const host = bare(hostname)
  if (isIP(host)) return isPrivateIp(host)
  return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || !host.includes(".")
}

const resolved = new Map<string, Promise<boolean>>()

/** True when the host is private by name, or any address it resolves to is private. */
export function isPrivateHost(hostname: string): Promise<boolean> {
  const host = bare(hostname)
  if (isPrivateHostLiteral(host)) return Promise.resolve(true)
  let result = resolved.get(host)
  if (!result) {
    result = lookup(host, { all: true, verbatim: true }).then(
      (addresses) => addresses.some((a) => isPrivateIp(a.address)),
      () => false, // Unresolvable: the browser fails to load it anyway.
    )
    resolved.set(host, result)
    setTimeout(() => resolved.delete(host), 60_000).unref?.()
  }
  return result
}

/** Throws a readable error when a capture's start URL is on a private network. */
export async function assertPublicUrl(url: string) {
  if (allowPrivateUrls()) return
  const { hostname } = new URL(url)
  if (await isPrivateHost(hostname)) throw new PrivateAddressError(hostname)
}

/**
 * Checks where a page ended up after redirects. Crawled links keep the start URL's host, which
 * was checked before the capture began, so a redirect is the remaining way onto a private host.
 */
export async function assertPublicPage(page: { url(): string }) {
  const url = page.url()
  if (url.startsWith("http:") || url.startsWith("https:")) await assertPublicUrl(url)
}
