// Capture benchmark: runs the real capture pipeline (captureJob) against a local fixture site, or a
// live site with --url, using an in-memory API. Samples CPU and memory of this process plus every
// Chromium process it starts.
//
//   npm run bench -w capture                                # fixture crawl, 4 pages
//   npm run bench -w capture -- --url https://example.com --pages 3
//   npm run bench -w capture -- --assert cpu=65,rss=900     # exit 1 over budget (avg CPU %, p95 RSS MB)
//   npm run bench -w capture -- --out /tmp/run.json         # save metrics + output summary
//   npm run bench -w capture -- --save /tmp/files           # save every uploaded file
//   npm run bench -w capture -- --args "--some-chromium-flag"  # try extra Chromium flags
//
// CPU is "% of one core" (like ps/top). Memory is summed RSS of the process tree (shared pages are
// counted once per process, the same way Activity Monitor rows add up).
import { execFile } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import http from "node:http"
import { dirname, join } from "node:path"
import { chromium } from "playwright"
import type { Job, PageUpload } from "../../web/shared/types"
import type { SnipApi } from "../src/api"
import { CHROMIUM_ARGS } from "../src/browser"

const flag = (name: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : undefined
}
const liveUrl = flag("url")
const pageCount = Number(flag("pages") ?? 4)
const saveDir = flag("save") // write every uploaded file here, to compare outputs between versions
const extraArgs = flag("args")?.split(" ").filter(Boolean) ?? [] // extra Chromium flags to try
const budget = Object.fromEntries((flag("assert") ?? "").split(",").filter(Boolean).map((kv) => kv.split("=")).map(([k, v]) => [k, Number(v)]))

// ---------------------------------------------------------------- fixture site
// A static marketing-style site: sticky nav, gradient hero, marquee animation, scroll-reveal
// sections with lazy images, hover transitions and a cookie banner. Deterministic and offline.
const FIXTURE: Record<string, number> = { "/": 14, "/pricing": 8, "/about": 8, "/blog": 10 } // sections per page
const WORDS = "design system motion layout grid token colour type spacing radius shadow surface interface component pattern product brand story launch build ship team customer".split(" ")
const words = (seed: number, n: number) => Array.from({ length: n }, (_, i) => WORDS[(seed * 7 + i * 13) % WORDS.length]).join(" ")
const CSS = `*{box-sizing:border-box}body{margin:0;font:16px/1.6 -apple-system,system-ui,sans-serif;color:#18181b;background:#fafaf9}
nav{position:sticky;top:0;display:flex;gap:28px;align-items:center;padding:16px 48px;background:#fffc;backdrop-filter:blur(8px);border-bottom:1px solid #eee;z-index:10}
nav a{color:#3f3f46;text-decoration:none;transition:color .2s}nav a:hover{color:#6d28d9}
.btn{display:inline-block;padding:12px 22px;border-radius:10px;background:#6d28d9;color:#fff;text-decoration:none;transition:background-color .25s,transform .25s,box-shadow .25s}
.btn:hover{background:#5b21b6;transform:translateY(-2px);box-shadow:0 8px 24px #6d28d955}
.btn.ghost{background:transparent;color:#6d28d9;border:1px solid #6d28d9}.btn.ghost:hover{background:#f5f3ff}
.hero{padding:120px 48px;background:linear-gradient(135deg,#ede9fe,#fce7f3 50%,#e0f2fe);text-align:center}
.hero h1{font-size:72px;line-height:1.05;margin:0 0 24px;background:linear-gradient(90deg,#6d28d9,#db2777);-webkit-background-clip:text;color:transparent}
.marquee{overflow:hidden;white-space:nowrap;border-block:1px solid #eee;padding:18px 0;font-size:20px;color:#71717a}
.marquee div{display:inline-block;animation:slide 30s linear infinite}@keyframes slide{to{transform:translateX(-50%)}}
section{padding:72px 48px;max-width:1200px;margin:0 auto}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:24px}
.card{padding:24px;border-radius:16px;background:#fff;box-shadow:0 1px 3px #0001;transition:transform .3s,box-shadow .3s}
.card:hover{transform:translateY(-4px);box-shadow:0 12px 32px #0002}.card img{width:100%;height:auto;border-radius:10px;display:block}
.reveal{opacity:0;transform:translateY(32px);transition:opacity .6s,transform .6s}.reveal.in{opacity:1;transform:none}
.cookie{position:fixed;left:24px;right:24px;bottom:24px;padding:20px;background:#18181b;color:#fff;border-radius:12px;display:flex;justify-content:space-between;align-items:center;z-index:20}
footer{padding:48px;background:#18181b;color:#a1a1aa}footer a{color:#e4e4e7;margin-right:16px}`

const svg = (seed: number) => {
  const hue = (seed * 47) % 360
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400" viewBox="0 0 600 400"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 80% 70%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360} 80% 55%)"/></linearGradient></defs><rect width="600" height="400" fill="url(#g)"/>${Array.from({ length: 6 }, (_, i) => `<circle cx="${(seed * 31 + i * 97) % 600}" cy="${(seed * 17 + i * 71) % 400}" r="${30 + ((seed + i) % 5) * 18}" fill="#fff" fill-opacity="0.${2 + (i % 5)}"/>`).join("")}</svg>`
}

function fixturePage(path: string, sections: number) {
  const name = path === "/" ? "Home" : path.slice(1)
  const nav = Object.keys(FIXTURE).map((p) => `<a href="${p}">${p === "/" ? "Home" : p.slice(1)}</a>`).join("")
  const body = Array.from({ length: sections }, (_, s) => {
    const cards = Array.from({ length: 3 }, (_, c) => {
      const seed = s * 3 + c + name.length * 11
      return `<div class="card"><img src="/img/${seed}.svg" width="600" height="400" loading="lazy" alt=""><h3>${words(seed, 3)}</h3><p>${words(seed + 1, 22)}</p>${s === 0 && c === 0 ? `<a class="btn ghost" href="#">Explore ${name} ${words(seed, 1)}</a>` : ""}</div>`
    }).join("")
    return `<section class="reveal"><h2>${words(s + name.length, 4)}</h2><p>${words(s, 40)}</p><div class="grid">${cards}</div></section>`
  }).join("")
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture ${name}</title><meta name="description" content="Benchmark fixture ${name}"><link rel="stylesheet" href="/site.css"></head><body>
<nav><strong>Fixture</strong>${nav}<a class="btn" href="#">Start ${name} trial</a></nav>
<header class="hero"><h1>${words(name.length, 5)}</h1><p>${words(name.length + 3, 18)}</p><a class="btn" href="#">Get ${name} now</a> <a class="btn ghost" href="#">Talk to ${name} sales</a></header>
<div class="marquee"><div>${words(1, 40)} · ${words(1, 40)} · </div></div>${body}
<footer>${nav}<p>© Fixture</p></footer>
<div class="cookie" id="cookie-consent">We use cookies to improve your experience. <button onclick="this.parentNode.remove()">Accept all</button></div>
<script>const io=new IntersectionObserver(es=>es.forEach(e=>e.isIntersecting&&e.target.classList.add('in')),{threshold:.1});document.querySelectorAll('.reveal').forEach(el=>io.observe(el))</script>
</body></html>`
}

async function startFixture() {
  const server = http.createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname
    const send = (type: string, body: string) => { res.writeHead(200, { "content-type": type, "cache-control": "max-age=3600" }); res.end(body) }
    if (path in FIXTURE) return send("text/html; charset=utf-8", fixturePage(path, FIXTURE[path]!))
    if (path === "/site.css") return send("text/css", CSS)
    if (path === "/sitemap.xml") return send("application/xml", `<urlset>${Object.keys(FIXTURE).map((p) => `<url><loc>${base}${p}</loc></url>`).join("")}</urlset>`)
    const img = path.match(/^\/img\/(\d+)\.svg$/)
    if (img) return send("image/svg+xml", svg(Number(img[1])))
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return { base, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }) }
}

// ---------------------------------------------------------------- process sampler
type Proc = { pid: number; ppid: number; rss: number; cpu: number; kind: string; label: string }
const KINDS = ["node", "browser", "gpu", "renderer", "utility", "other"] as const
const kindOf = (pid: number, command: string) =>
  pid === process.pid ? "node"
    : /--type=gpu-process/.test(command) ? "gpu"
      : /--type=renderer/.test(command) ? "renderer"
        : /--type=/.test(command) ? "utility"
          : /chrom|headless/i.test(command) ? "browser" : "other"

/** This process and its descendants. */
function processTree(): Promise<Map<number, Proc>> {
  return new Promise((resolve, reject) => {
    let self = 0
    const child = execFile("ps", ["-A", "-ww", "-o", "pid=,ppid=,rss=,time=,command="], { maxBuffer: 64 << 20 }, (error, out) => {
      if (error) return reject(error)
      const children = new Map<number, Proc[]>()
      for (const line of out.split("\n")) {
        const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d:.]+)\s+(.*)$/)
        if (!m || Number(m[1]) === self) continue
        const p = { pid: Number(m[1]), ppid: Number(m[2]), rss: Number(m[3]) / 1024, cpu: m[4]!.split(":").reduce((s, part) => s * 60 + Number(part), 0), kind: kindOf(Number(m[1]), m[5]!), label: m[5]!.match(/--(?:utility-sub-)?type=\S+/g)?.join(" ") ?? m[5]!.split("/").pop()!.slice(0, 40) }
        children.set(p.ppid, [...(children.get(p.ppid) ?? []), p])
      }
      const tree = new Map<number, Proc>()
      const walk = (pid: number) => { for (const p of children.get(pid) ?? []) if (!tree.has(p.pid)) { tree.set(p.pid, p); walk(p.pid) } }
      walk(process.pid)
      resolve(tree)
    })
    self = child.pid ?? 0
  })
}

class Sampler {
  /** Every process seen during the run: CPU at first sight (0 if it started during the run) and last seen. */
  private seen = new Map<number, { base: number; last: number; kind: string }>()
  private nodeStart = process.cpuUsage()
  private t0 = performance.now()
  private timer: ReturnType<typeof setInterval> | undefined
  private busy: Promise<void> | undefined
  rss: number[] = []
  peakByKind: Record<string, number> = {}
  /** The processes alive at the run's total-RSS peak. */
  atPeak: { pid: number; label: string; rss: number }[] = []
  private peakTotal = 0
  /** Node's own memory at its RSS peak, to tell V8 heap from Buffers. */
  nodeAtPeak: Record<string, number> = {}
  timeline: { t: number; cpu: number; rss: number; cum: Record<string, number> }[] = []
  private lastCpu = 0
  private lastT = 0

  async start(intervalMs = 200) {
    for (const p of (await processTree()).values()) this.seen.set(p.pid, { base: p.cpu, last: p.cpu, kind: p.kind })
    this.nodeStart = process.cpuUsage()
    this.t0 = performance.now()
    this.timer = setInterval(() => { this.busy ??= this.sample().finally(() => { this.busy = undefined }) }, intervalMs)
  }

  /** CPU-seconds used since start, by process kind. A process that exits loses at most its last interval. */
  cpuByKind() {
    const node = process.cpuUsage(this.nodeStart)
    const cpu: Record<string, number> = { node: (node.user + node.system) / 1e6 }
    for (const s of this.seen.values()) if (s.kind !== "node") cpu[s.kind] = (cpu[s.kind] ?? 0) + Math.max(0, s.last - s.base)
    return cpu
  }

  private async sample() {
    const tree = await processTree()
    const rss: Record<string, number> = {}
    for (const p of tree.values()) {
      const s = this.seen.get(p.pid)
      if (s) s.last = Math.max(s.last, p.cpu) // an exited, unreaped process (zombie) reports 0
      else this.seen.set(p.pid, { base: 0, last: p.cpu, kind: p.kind })
      rss[p.kind] = (rss[p.kind] ?? 0) + p.rss
    }
    const mem = process.memoryUsage()
    rss.node = mem.rss / 1048576
    if (rss.node >= (this.peakByKind.node ?? 0)) this.nodeAtPeak = Object.fromEntries(Object.entries(mem).map(([k, v]) => [k, Math.round(v / 1048576)]))
    const total = Object.values(rss).reduce((a, b) => a + b, 0)
    if (total > this.peakTotal) this.atPeak = [{ pid: process.pid, label: "node", rss: rss.node }, ...[...tree.values()].map((p) => ({ pid: p.pid, label: p.label, rss: p.rss }))].sort((a, b) => b.rss - a.rss)
    this.peakTotal = Math.max(this.peakTotal, total)
    this.rss.push(total)
    for (const [k, v] of Object.entries(rss)) this.peakByKind[k] = Math.max(this.peakByKind[k] ?? 0, v)
    const t = (performance.now() - this.t0) / 1000
    const cum = this.cpuByKind()
    const cpuTotal = Object.values(cum).reduce((a, b) => a + b, 0)
    this.timeline.push({ t: +t.toFixed(2), cpu: Math.round(((cpuTotal - this.lastCpu) / Math.max(0.05, t - this.lastT)) * 100), rss: Math.round(total), cum })
    this.lastCpu = cpuTotal
    this.lastT = t
  }

  async stop() {
    clearInterval(this.timer)
    await this.busy
    await this.sample()
    const wall = (performance.now() - this.t0) / 1000
    const byKind = this.cpuByKind()
    const cpuTotal = Object.values(byKind).reduce((a, b) => a + b, 0)
    const sorted = [...this.rss].sort((a, b) => a - b)
    return {
      wall, cpuTotal, byKind,
      avgCpu: (cpuTotal / wall) * 100,
      rssAvg: this.rss.reduce((a, b) => a + b, 0) / this.rss.length,
      rssP95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
      rssPeak: sorted.at(-1) ?? 0,
    }
  }
}

// ---------------------------------------------------------------- run
if (!liveUrl) process.env.ALLOW_PRIVATE_URLS = "true" // the fixture is on localhost
const fixture = liveUrl ? null : await startFixture()
const url = liveUrl ?? `${fixture!.base}/`
const { captureJob } = await import("../src/capture")

const pages: PageUpload[] = []
const uploads = new Map<string, { bytes: number; type: string }>()
const sampler = new Sampler()
const api = {
  progress: async () => {},
  heartbeat: async () => {},
  upload: async (key: string, body: Buffer | string, type: string) => {
    uploads.set(key, { bytes: Buffer.byteLength(body), type })
    if (saveDir) {
      mkdirSync(dirname(join(saveDir, key)), { recursive: true })
      writeFileSync(join(saveDir, key), body)
    }
    return key
  },
  addPage: async (_id: string, page: PageUpload) => { pages.push(page) },
  complete: async () => {},
  control: async () => null,
  pause: async () => true,
  fail: async () => {},
} as unknown as SnipApi
const job: Job = { id: "bench", url, mode: "crawl", maxPages: pageCount, attempt: "a1", lease: "l1", resume: null, options: null, recordingFormats: ["gif", "webm"] }

const browser = await chromium.launch({ headless: true, args: [...CHROMIUM_ARGS, ...extraArgs], executablePath: process.env.CHROMIUM_PATH || undefined })
await sampler.start()
let failure: unknown
try {
  await captureJob(browser, api, job)
} catch (error) {
  failure = error
}
const m = await sampler.stop()
await browser.close()
await fixture?.close()

// ---------------------------------------------------------------- report
const mb = (n: number) => `${Math.round(n)}MB`
const bytesOf = (re: RegExp) => [...uploads].filter(([k]) => re.test(k)).reduce((s, [, v]) => s + v.bytes, 0)
const animations = pages.flatMap((p) => p.animations)
const output = pages.map((p) => ({
  path: p.path, desktop: `${p.desktopWidth}x${p.desktopHeight}`, mobile: `${p.mobileWidth}x${p.mobileHeight}`,
  animations: p.animations.map((a) => `${a.kind}:${a.meta?.frameCount ?? "?"}f:${a.width}x${a.height}:${Math.round((uploads.get(a.gifKey)?.bytes ?? 0) / 1024)}KB:${a.meta?.frames.length ?? 0}stills`),
}))
const result = {
  url, startedAt: Date.now() - Math.round(m.wall * 1000), pages: pages.length, failed: failure ? String((failure as Error).message ?? failure) : null,
  wallS: +m.wall.toFixed(1), cpuS: +m.cpuTotal.toFixed(1), avgCpuPct: Math.round(m.avgCpu), cpuSPerPage: +(m.cpuTotal / Math.max(1, pages.length)).toFixed(2),
  rssAvgMB: Math.round(m.rssAvg), rssP95MB: Math.round(m.rssP95), rssPeakMB: Math.round(m.rssPeak),
  cpuSByKind: Object.fromEntries(KINDS.filter((k) => m.byKind[k] != null).map((k) => [k, +m.byKind[k]!.toFixed(1)])),
  rssPeakByKindMB: Object.fromEntries(KINDS.filter((k) => sampler.peakByKind[k] != null).map((k) => [k, Math.round(sampler.peakByKind[k]!)])),
  uploads: { files: uploads.size, totalKB: Math.round([...uploads.values()].reduce((s, v) => s + v.bytes, 0) / 1024), recordingKB: Math.round(bytesOf(/\.(gif|webm)$/) / 1024), gifKB: Math.round(bytesOf(/\.gif$/) / 1024), webmKB: Math.round(bytesOf(/\.webm$/) / 1024), stillsKB: Math.round(bytesOf(/-(f\d+|sheet)\.jpg$/) / 1024) },
  scrollFrames: animations.filter((a) => a.kind === "scroll").reduce((s, a) => s + (a.meta?.frameCount ?? 0), 0),
  hoverRecordings: animations.filter((a) => a.kind === "hover").length,
  output,
  timeline: sampler.timeline,
}

console.log(`\n${url} · ${pages.length} page(s)${failure ? ` · FAILED: ${result.failed}` : ""}`)
console.log(`wall ${result.wallS}s · cpu ${result.cpuS}s (${result.avgCpuPct}% avg, ${result.cpuSPerPage}s/page) · rss avg ${mb(m.rssAvg)} p95 ${mb(m.rssP95)} peak ${mb(m.rssPeak)}`)
console.log(`cpu s by process: ${Object.entries(result.cpuSByKind).map(([k, v]) => `${k} ${v}`).join(" · ")}`)
console.log(`peak rss by process: ${Object.entries(result.rssPeakByKindMB).map(([k, v]) => `${k} ${v}MB`).join(" · ")}`)
console.log(`at the total peak (MB): ${sampler.atPeak.filter((p) => p.rss > 5).map((p) => `${p.label} ${Math.round(p.rss)}`).join(" · ")}`)
console.log(`node at its peak (MB): ${Object.entries(sampler.nodeAtPeak).map(([k, v]) => `${k} ${v}`).join(" · ")}`)
console.log(`output: ${result.scrollFrames} scroll frames, ${result.hoverRecordings} hover recordings, ${result.uploads.files} files, ${result.uploads.totalKB}KB (recordings ${result.uploads.recordingKB}KB: webm ${result.uploads.webmKB}KB gif ${result.uploads.gifKB}KB, stills ${result.uploads.stillsKB}KB)`)
for (const o of output) console.log(`  ${o.path} desktop ${o.desktop} mobile ${o.mobile} ${o.animations.join(" ")}`)
const out = flag("out")
if (out) writeFileSync(out, JSON.stringify(result, null, 2))

const over = [
  budget.cpu != null && m.avgCpu > budget.cpu ? `avg CPU ${Math.round(m.avgCpu)}% > ${budget.cpu}%` : null,
  budget.rss != null && m.rssP95 > budget.rss ? `p95 RSS ${mb(m.rssP95)} > ${budget.rss}MB` : null, // a single-sample peak is too noisy to gate on
].filter(Boolean)
if (over.length) console.log(`OVER BUDGET: ${over.join(", ")}`)
process.exit(failure || over.length ? 1 : 0)
