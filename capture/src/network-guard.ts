import { lookup } from "node:dns/promises"
import { Agent, createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http"
import { connect, isIP, type Socket } from "node:net"

export const allowPrivateUrls = () => process.env.ALLOW_PRIVATE_URLS === "true"

export class PrivateAddressError extends Error {
  constructor(host: string) {
    super(`Snip doesn't capture private network addresses (${host}). To capture a local site, set ALLOW_PRIVATE_URLS=true in capture/.env and restart the capture agent.`)
  }
}

function ipv4Private(ip: string) {
  const [a, b] = ip.split(".").map(Number) as [number, number]
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224
}

const bare = (host: string) => host.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "")

/** Canonicalize IPv6 too, so expanded loopback and IPv4-mapped forms cannot evade the check. */
export function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) return ipv4Private(ip)
  if (isIP(ip) !== 6) return false
  const v6 = bare(new URL(`http://[${ip}]/`).hostname)
  const mapped = v6.match(/^::ffff:([0-9a-f]+):([0-9a-f]+)$/)
  if (mapped) {
    const hi = parseInt(mapped[1]!, 16), lo = parseInt(mapped[2]!, 16)
    return ipv4Private(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)
  }
  // Only global unicast is allowed. Exclude transition ranges that can encode an IPv4 target.
  return !/^[23]/.test(v6) || /^2001:(?:0:|:|db8:)/.test(v6) || /^2002:/.test(v6)
}

export function isPrivateHostLiteral(hostname: string): boolean {
  const host = bare(hostname)
  if (isIP(host)) return isPrivateIp(host)
  return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || !host.includes(".")
}

type Resolver = (host: string) => Promise<{ address: string; family: number }[]>
const resolve: Resolver = host => lookup(host, { all: true, verbatim: true })

/** Resolve once, validate every answer, then connect to the returned IP rather than resolving again. */
export async function publicAddress(hostname: string, resolver: Resolver = resolve): Promise<string> {
  const host = bare(hostname)
  if (isPrivateHostLiteral(host)) throw new PrivateAddressError(host)
  if (isIP(host)) return host
  const addresses = await resolver(host)
  if (!addresses.length) throw new Error(`No addresses found for ${host}`)
  if (addresses.some(a => !isIP(a.address) || isPrivateIp(a.address))) throw new PrivateAddressError(host)
  return (addresses.find(a => a.family === 4) ?? addresses[0]!).address
}

export async function assertPublicUrl(url: string) {
  if (!allowPrivateUrls()) await publicAddress(new URL(url).hostname)
}

/**
 * A per-job egress proxy shared by Chromium and BrowserContext.request (CSS/fonts/sitemaps).
 * CONNECT keeps TLS end-to-end. Every socket uses the exact validated IP, closing DNS-rebinding
 * races as well as redirect/subresource bypasses. No cached permission or direct fallback.
 */
export async function createCaptureNetwork(deps: {
  resolve?: Resolver
  connect?: (address: string, port: number) => Socket
} = {}) {
  const sockets = new Set<Socket>()
  let blocked: PrivateAddressError | undefined
  let closed = false
  const track = (socket: Socket) => {
    sockets.add(socket)
    socket.on("error", () => {})
    socket.on("close", () => sockets.delete(socket))
    socket.setTimeout(120_000, () => socket.destroy())
    if (closed) socket.destroy()
    return socket
  }
  const addressFor = async (host: string) => {
    try { return await publicAddress(host, deps.resolve) }
    catch (error) {
      if (error instanceof PrivateAddressError) blocked ??= error
      throw error
    }
  }
  const dial = (address: string, port: number) => track((deps.connect ?? ((host, p) => connect({ host, port: p })))(address, port))
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "")
      if (url.protocol !== "http:" || url.username || url.password) throw new Error("Invalid proxy URL")
      const address = await addressFor(url.hostname)
      if (closed || req.destroyed) return res.destroy()
      const agent = new Agent({ keepAlive: false })
      agent.createConnection = () => dial(address, Number(url.port) || 80)
      const headers: IncomingHttpHeaders = { ...req.headers, host: url.host, connection: "close" }
      delete headers["proxy-authorization"]
      delete headers["proxy-connection"]
      const upstream = httpRequest({ hostname: address, port: url.port || 80, method: req.method,
        path: url.pathname + url.search, headers, agent }, response => {
        res.writeHead(response.statusCode ?? 502, response.headers)
        response.pipe(res)
      })
      upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end() })
      res.on("close", () => { upstream.destroy(); agent.destroy() })
      req.pipe(upstream)
    } catch (error) {
      res.writeHead(error instanceof PrivateAddressError ? 403 : 502)
      res.end()
    }
  })
  server.on("connection", track)
  // Plain ws:// uses an HTTP upgrade; wss:// travels through CONNECT below.
  server.on("upgrade", async (req, client, head) => {
    try {
      const url = new URL(req.url ?? "")
      if (!["http:", "ws:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid upgrade")
      const address = await addressFor(url.hostname)
      if (closed || client.destroyed) return client.destroy()
      const upstream = dial(address, Number(url.port) || 80)
      upstream.on("error", () => client.destroy())
      client.on("close", () => upstream.destroy())
      upstream.on("close", () => client.destroy())
      upstream.once("connect", () => {
        const headers: IncomingHttpHeaders = { ...req.headers, host: url.host }
        delete headers["proxy-authorization"]
        delete headers["proxy-connection"]
        upstream.write(`${req.method} ${url.pathname + url.search} HTTP/1.1\r\n${Object.entries(headers).map(([key, value]) => `${key}: ${value}`).join("\r\n")}\r\n\r\n`)
        if (head.length) upstream.write(head)
        upstream.pipe(client)
        client.pipe(upstream)
      })
    } catch (error) {
      client.end(`HTTP/1.1 ${error instanceof PrivateAddressError ? "403 Forbidden" : "502 Bad Gateway"}\r\nConnection: close\r\n\r\n`)
    }
  })
  server.on("connect", async (req, client, head) => {
    try {
      const url = new URL(`http://${req.url}`)
      if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Invalid tunnel")
      const address = await addressFor(url.hostname)
      if (closed || client.destroyed) return client.destroy()
      const upstream = dial(address, Number(url.port) || 80)
      upstream.on("error", () => client.destroy())
      client.on("close", () => upstream.destroy())
      upstream.on("close", () => client.destroy())
      upstream.once("connect", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
        if (head.length) upstream.write(head)
        upstream.pipe(client)
        client.pipe(upstream)
      })
    } catch (error) {
      client.end(`HTTP/1.1 ${error instanceof PrivateAddressError ? "403 Forbidden" : "502 Bad Gateway"}\r\nConnection: close\r\n\r\n`)
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  return {
    // Chromium otherwise implicitly bypasses proxies for loopback and link-local addresses.
    proxy: { server: `http://127.0.0.1:${(server.address() as { port: number }).port}`, bypass: "<-loopback>" },
    assertAllowed() { if (blocked) throw blocked },
    async close() {
      closed = true
      for (const socket of sockets) socket.destroy()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}
