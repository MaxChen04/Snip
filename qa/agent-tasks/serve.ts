// Agent task eval server: the discovery fixture library (qa/discovery) plus design tokens, an HTML snapshot and a
// simulated capture agent, served over Snip's real MCP handler with no sign-in. Every tool call is appended to a
// JSONL log, so an agent's calls, errors and bytes read can be scored afterwards whatever harness drove it.
//
//   node --import tsx qa/agent-tasks/serve.ts --port 5401 --log /tmp/snip-agent-5401.jsonl
//
// Everything is in memory and synthetic: no real library, account or network is touched.

import { appendFile, writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage } from "node:http"
import { parseArgs } from "node:util"
import * as db from "../../web/worker/db"
import { mcpApiHandler } from "../../web/worker/mcp"
import type { DesignTokens } from "../../web/shared/types"
import { loadLibrary, migratedDatabase } from "../discovery/load"
import { pageUpload } from "../discovery/library"

const { values: opts } = parseArgs({
  options: {
    port: { type: "string", default: "5401" },
    log: { type: "string", default: "/tmp/snip-agent-tasks.jsonl" },
    "capture-seconds": { type: "string", default: "20" },
  },
})
const PORT = Number(opts.port)
const LOG = opts.log!

const TOKENS: DesignTokens = {
  colors: [
    { value: "#0f172a", count: 412 }, { value: "#ffffff", count: 388 }, { value: "#16a34a", count: 96 },
    { value: "#64748b", count: 140 }, { value: "#f1f5f9", count: 77 }, { value: "#dcfce7", count: 31 }, { value: "#e2e8f0", count: 58 },
  ],
  fonts: [{ family: "\"Inter Tight\", system-ui, sans-serif", count: 520 }, { family: "\"Source Serif 4\", Georgia, serif", count: 44 }, { family: "\"JetBrains Mono\", monospace", count: 12 }],
  fontSizes: [{ value: "16px", count: 300 }, { value: "14px", count: 190 }, { value: "20px", count: 40 }, { value: "36px", count: 12 }, { value: "56px", count: 4 }, { value: "12px", count: 61 }],
  spacing: [{ value: "8px", count: 210 }, { value: "16px", count: 188 }, { value: "24px", count: 120 }, { value: "48px", count: 30 }],
  radii: [{ value: "12px", count: 80 }, { value: "999px", count: 41 }, { value: "6px", count: 22 }],
  shadows: [{ value: "0 1px 2px rgba(15,23,42,.08), 0 8px 24px rgba(15,23,42,.06)", count: 18 }],
  transitions: [{ value: "all 0.2s cubic-bezier(0.2, 0, 0, 1)", count: 33 }],
  keyframes: ["fade-up"],
  cssVariables: { "--brand": "#16a34a", "--ink": "#0f172a", "--surface": "#f1f5f9", "--radius-card": "12px", "--font-sans": "\"Inter Tight\", system-ui, sans-serif" },
}

const FILLER = "<!-- " + "filler ".repeat(2500) + "-->"
const TESTIMONIALS_HTML = [
  '<!doctype html><html><head><title>Orbitly</title><style>.quotes{display:grid;grid-template-columns:repeat(3,1fr);gap:24px}.quote{border-radius:16px;padding:24px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.1)}</style></head><body>',
  '<header class="nav"><a href="/">Orbitly</a><nav><a href="/product">Product</a><a href="/teams">Teams</a><a href="/pricing">Pricing</a></nav></header>',
  '<section class="hero"><h1>Scheduling that respects your calendar</h1><p>Share one link. Never double-book.</p><a class="btn" href="/signup">Get started</a></section>',
  FILLER,
  '<section class="testimonials" id="loved"><h2>Loved by teams</h2><div class="quotes">',
  '<figure class="quote"><blockquote>Orbitly saved our sales team hours every week.</blockquote><figcaption><img src="/a/dana.jpg" alt=""><b>Dana</b> Head of Sales</figcaption></figure>',
  '<figure class="quote"><blockquote>Finally, a booking page our customers like.</blockquote><figcaption><img src="/a/priya.jpg" alt=""><b>Priya</b> Founder</figcaption></figure>',
  '<figure class="quote"><blockquote>We replaced three tools with one link.</blockquote><figcaption><img src="/a/tom.jpg" alt=""><b>Tom</b> Ops Lead</figcaption></figure>',
  '</div></section>',
  FILLER,
  '<footer>Orbitly</footer></body></html>',
].join("\n")

const { mf, database, files } = await migratedDatabase()
const env = { DB: database, FILES: files, SESSION_SECRET: "eval-secret" } as unknown as Env
const lib = await loadLibrary(database, files)

// Tokens for Plainleaf (site and pages), and an HTML snapshot for Orbitly's home page.
const plainleaf = lib.refs.get("https://plainleaf.test")!
await database.prepare("UPDATE refs SET tokens_json = ? WHERE id = ?").bind(JSON.stringify(TOKENS), plainleaf).run()
await database.prepare("UPDATE pages SET tokens_json = ? WHERE reference_id = ?").bind(JSON.stringify(TOKENS), plainleaf).run()
const orbitlyHome = lib.pages.get("https://orbitly.test/")!
const snapshotKey = "refs/" + lib.refs.get("https://orbitly.test") + "/eval/snapshot.html"
await files.put(snapshotKey, TESTIMONIALS_HTML, { httpMetadata: { contentType: "text/html" } })
await database.prepare("UPDATE pages SET snapshot_key = ? WHERE id = ?").bind(snapshotKey, orbitlyHome).run()

// A capture agent that finishes each queued capture after a delay, the way Snip.app's would.
const captureMs = Number(opts["capture-seconds"]) * 1000
const PIXEL = await files.get((await db.getPage(database, orbitlyHome))!.desktopThumbKey!).then((o) => o!.arrayBuffer())
setInterval(async () => {
  try {
    await db.touchPresence(database, "idle", null)
    const job = await db.claimJob(database)
    if (!job) return
    await db.touchPresence(database, "busy", job.id)
    setTimeout(async () => {
      const u = new URL(job.url)
      const name = u.hostname.split(".")[0]!.replace(/^\w/, (c) => c.toUpperCase())
      const upload = pageUpload(job.id, job.attempt, { path: u.pathname, title: name, sections: [
        { kind: "header", label: name, text: name + "\nHome About Contact" },
        { kind: "hero", label: "Welcome to " + name, text: "Welcome to " + name },
        { kind: "footer", label: "Footer", text: name + " Ltd." },
      ] }, 0, u.origin)
      for (const key of [upload.desktopKey, upload.desktopThumbKey, ...(upload.sections ?? []).map((s) => s.key)]) if (key) await files.put(key, PIXEL, { httpMetadata: { contentType: "image/jpeg" } })
      await db.addPage(database, job.id, job.lease, upload)
      await db.completeJob(database, job.id, job.lease, { title: name, description: null, favicon: null, coverKey: null, tokens: null })
      await db.touchPresence(database, "idle", null)
    }, captureMs)
  } catch (e) {
    console.error("capture agent:", e)
  }
}, 2000)

const ctx = { waitUntil() {}, passThroughOnException() {}, props: { ownerId: "eval" } } as unknown as ExecutionContext
const body = (req: IncomingMessage) => new Promise<Buffer>((resolve) => {
  const chunks: Buffer[] = []
  req.on("data", (c: Buffer) => chunks.push(c)).on("end", () => resolve(Buffer.concat(chunks)))
})
await writeFile(LOG, "")
/** What the model reads from a tools/call: the text blocks (one is the JSON result) and a placeholder per image. */
function visibleChars(text: string) {
  const line = text.split("\n").find((l) => l.startsWith("data: "))
  try {
    const result = JSON.parse(line ? line.slice(6) : text).result as { content?: { type: string; text?: string }[] } | undefined
    return (result?.content ?? []).reduce((n, c) => n + (c.type === "text" ? c.text!.length : 40), 0)
  } catch {
    return text.length
  }
}

const server = createServer(async (req, res) => {
  const mark = new URL(req.url ?? "/", "http://x").searchParams.get("mark")
  if (mark) {
    await appendFile(LOG, JSON.stringify({ at: new Date().toISOString(), mark }) + "\n")
    res.writeHead(204).end()
    return
  }
  const raw = await body(req)
  let msg: { method?: string; params?: { name?: string; arguments?: unknown } } | null = null
  try {
    msg = raw.length ? JSON.parse(raw.toString()) : null
  } catch {}
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v)
  const response = await mcpApiHandler.fetch(
    new Request("http://localhost:" + PORT + req.url, { method: req.method, headers, body: raw.length && req.method !== "GET" ? raw : undefined }),
    env,
    ctx,
  )
  const text = await response.text()
  if (msg?.method)
    await appendFile(LOG, JSON.stringify({ at: new Date().toISOString(), method: msg.method, name: msg.params?.name, args: msg.params?.arguments, bytes: text.length, visibleChars: visibleChars(text), isError: /"isError":true/.test(text) }) + "\n")
  res.writeHead(response.status, Object.fromEntries(response.headers))
  res.end(text)
})
server.listen(PORT, "127.0.0.1", () => console.log("Snip agent-task server on http://127.0.0.1:" + PORT + "/mcp, log " + LOG))
const stop = async () => {
  server.close()
  await mf.dispose()
  process.exit(0)
}
process.on("SIGTERM", stop)
process.on("SIGINT", stop)
