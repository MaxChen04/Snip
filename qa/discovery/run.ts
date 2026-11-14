// Agent discovery eval: serves the fixture library over Snip's real MCP handler on localhost, gives each
// task's prompt to an agent harness (Claude Code, Codex, Gemini CLI, or a scripted baseline), logs every
// tool call the agent makes, and scores whether it found the right page and section.
//
//   node --import tsx qa/discovery/run.ts --harness claude [--model <id>] [--tasks id,id] [--repeat 3] [--distractors 60]
//   node --import tsx qa/discovery/run.ts --harness scripted     # no model: checks the pipeline itself
//
// Results go to qa/discovery/results/<harness>-<time>.json (gitignored) with a summary on stdout.
// The harness CLIs must be installed and signed in on this machine; nothing here needs an API key.
// Scoring reads the server's own log of tool calls, so it is the same for every harness.

import { spawn } from "node:child_process"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { mcpApiHandler } from "../../web/worker/mcp"
import { LIBRARY } from "./library"
import { loadLibrary, migratedDatabase, type LoadedLibrary } from "./load"
import { answers, TASKS, type DiscoveryTask } from "./tasks"

type ToolCall = { name: string; args: Record<string, unknown>; bytes: number; isError: boolean }

const { values: opts } = parseArgs({
  options: {
    harness: { type: "string", default: "scripted" },
    model: { type: "string" },
    tasks: { type: "string" },
    repeat: { type: "string", default: "1" },
    port: { type: "string", default: "5399" },
    timeout: { type: "string", default: "240" },
    distractors: { type: "string", default: "0" },
  },
})

const PORT = Number(opts.port)
const MCP_URL = `http://localhost:${PORT}/mcp`

const SUFFIX = `

Use the Snip MCP server (tools named like search_pages, get_page) to look through my saved references. Don't browse the web. When you are done, end your reply with one line:
ANSWER: <page id> [section <index>]
using the page id from Snip (and the section index, if one section is the answer).`

// ---------- Harness adapters: how each CLI is told about the MCP server and given one prompt ----------

interface Harness {
  /** argv for one non-interactive run, and an optional working directory to run it in. */
  command(prompt: string, workdir: string): Promise<{ argv: string[]; env?: Record<string, string> }>
}

const HARNESSES: Record<string, Harness> = {
  // Claude Code: only this server, its tools pre-approved, no other tools.
  claude: {
    async command(prompt, workdir) {
      const config = path.join(workdir, "mcp.json")
      await writeFile(config, JSON.stringify({ mcpServers: { snip: { type: "http", url: MCP_URL } } }))
      return {
        argv: ["claude", "-p", prompt, "--mcp-config", config, "--strict-mcp-config", "--allowedTools", "mcp__snip", "--output-format", "text",
          ...(opts.model ? ["--model", opts.model] : [])],
      }
    },
  },
  // Codex CLI: the server passed as a config override, so ~/.codex/config.toml is untouched.
  codex: {
    async command(prompt) {
      return {
        argv: ["codex", "exec", "--skip-git-repo-check", "-c", `mcp_servers.snip.url="${MCP_URL}"`, ...(opts.model ? ["-m", opts.model] : []), prompt],
      }
    },
  },
  // Gemini CLI: reads servers from .gemini/settings.json in the working directory.
  gemini: {
    async command(prompt, workdir) {
      await mkdir(path.join(workdir, ".gemini"), { recursive: true })
      await writeFile(path.join(workdir, ".gemini", "settings.json"), JSON.stringify({ mcpServers: { snip: { httpUrl: MCP_URL, trust: true } } }))
      return { argv: ["gemini", "-p", prompt, "--allowed-mcp-server-names", "snip", ...(opts.model ? ["-m", opts.model] : [])] }
    },
  },
}

/** No model: searches with the task's own query and answers with the top hit. A floor, and a check that scoring works. */
async function scripted(task: DiscoveryTask): Promise<string> {
  const res = await rpc("tools/call", { name: "search_pages", arguments: { query: task.query, limit: 5 } })
  const top = (res.structuredContent as { items: { id: string; section: { index: number } | null }[] }).items[0]
  if (!top) return "ANSWER: none"
  if (top.section) await rpc("tools/call", { name: "get_page", arguments: { page_id: top.id, section: top.section.index } })
  return `ANSWER: ${top.id}${top.section ? ` section ${top.section.index}` : ""}`
}

// ---------- The MCP server, logging tool calls ----------

let calls: ToolCall[] = []

async function rpc(method: string, params: unknown) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
  const line = (await res.text()).split("\n").find((l) => l.startsWith("data: "))!
  return JSON.parse(line.slice(6)).result as Record<string, unknown>
}

async function serve(env: Env) {
  const ctx = { waitUntil() {}, passThroughOnException() {}, props: { ownerId: "eval" } } as unknown as ExecutionContext
  const body = (req: IncomingMessage) => new Promise<Buffer>((resolve) => {
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c)).on("end", () => resolve(Buffer.concat(chunks)))
  })
  const server = createServer(async (req, res) => {
    const raw = await body(req)
    let call: ToolCall | null = null
    try {
      const msg = raw.length ? JSON.parse(raw.toString()) : null
      if (msg?.method === "tools/call") call = { name: msg.params.name, args: msg.params.arguments ?? {}, bytes: 0, isError: false }
    } catch {}
    const headers = new Headers()
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v)
    const response = await mcpApiHandler.fetch(
      new Request(`http://localhost:${PORT}${req.url}`, { method: req.method, headers, body: raw.length && req.method !== "GET" ? raw : undefined }),
      env,
      ctx,
    )
    const text = await response.text()
    if (call) {
      call.bytes = text.length
      call.isError = /"isError":true/.test(text)
      calls.push(call)
    }
    res.writeHead(response.status, Object.fromEntries(response.headers))
    res.end(text)
  })
  await new Promise<void>((resolve) => server.listen(PORT, "127.0.0.1", resolve))
  return server
}

// ---------- Running and scoring ----------

function run(argv: string[], cwd: string, timeoutS: number) {
  return new Promise<{ output: string; code: number | null; timedOut: boolean }>((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, stdio: ["ignore", "pipe", "pipe"] })
    let output = ""
    child.stdout.on("data", (d) => (output += d))
    child.stderr.on("data", (d) => (output += d))
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutS * 1000)
    child.on("close", (code, signal) => {
      clearTimeout(timer)
      resolve({ output, code, timedOut: signal === "SIGTERM" })
    })
  })
}

interface Result {
  task: string
  kind: DiscoveryTask["kind"]
  /** The answered page is a right one. */
  found: boolean
  /** The agent looked at the expected section (get_page with its index), when the task names one. */
  sawSection: boolean | null
  /** It opened a right page at any point, even if it answered another. */
  openedRight: boolean
  answer: string | null
  toolCalls: number
  searches: number
  bytesRead: number
  errors: number
  seconds: number
  timedOut: boolean
  calls: ToolCall[]
}

function score(task: DiscoveryTask, lib: LoadedLibrary, output: string, log: ToolCall[], seconds: number, timedOut: boolean): Result {
  const byId = new Map([...lib.pages].map(([key, id]) => [id, key]))
  const pageOf = (id: unknown) => {
    const key = typeof id === "string" ? byId.get(id) : undefined
    const site = key && LIBRARY.find((s) => key.startsWith(s.url))
    return site ? { site: site.url, path: key.slice(site.url.length) } : null
  }
  const m = [...output.matchAll(/ANSWER:\s*`?([0-9a-f]{16})`?(?:\s*\[?section\s+(\d+))?/gi)].pop()
  const answered = m ? pageOf(m[1]) : null
  const expected = task.expect.path ? lib.pages.get(task.expect.site + task.expect.path) : undefined
  const expectedIndex = task.expect.section && task.expect.path
    ? LIBRARY.find((s) => s.url === task.expect.site)!.pages.find((p) => p.path === task.expect.path)!.sections!.findIndex((s) => s.label === task.expect.section)
    : null
  const opened = log.filter((c) => c.name === "get_page" || c.name === "get_page_styles").map((c) => pageOf(c.args.page_id))
  return {
    task: task.id,
    kind: task.kind,
    found: !!answered && answers(task, answered.site, answered.path),
    sawSection: expectedIndex == null ? null : log.some((c) => c.name === "get_page" && c.args.page_id === expected && c.args.section === expectedIndex),
    openedRight: opened.some((p) => p && answers(task, p.site, p.path)),
    answer: m ? m[0] : null,
    toolCalls: log.length,
    searches: log.filter((c) => c.name.startsWith("search_")).length,
    bytesRead: log.reduce((a, c) => a + c.bytes, 0),
    errors: log.filter((c) => c.isError).length,
    seconds,
    timedOut,
    calls: log,
  }
}

const { mf, database, files } = await migratedDatabase()
const env = { DB: database, FILES: files, SESSION_SECRET: "eval-secret" } as unknown as Env
const server = await serve(env)
try {
  const lib = await loadLibrary(database, files, Number(opts.distractors))
  const harness = opts.harness!
  if (harness !== "scripted" && !HARNESSES[harness]) throw new Error(`--harness must be one of scripted, ${Object.keys(HARNESSES).join(", ")}`)
  const chosen = opts.tasks ? TASKS.filter((t) => opts.tasks!.split(",").includes(t.id)) : TASKS
  const results: Result[] = []
  for (let r = 0; r < Number(opts.repeat); r++) {
    for (const task of chosen) {
      calls = []
      const started = Date.now()
      let output: string
      let timedOut = false
      if (harness === "scripted") output = await scripted(task)
      else {
        const workdir = await mkdtemp(path.join(tmpdir(), "snip-eval-"))
        const cmd = await HARNESSES[harness]!.command(task.prompt + SUFFIX, workdir)
        const res = await run(cmd.argv, workdir, Number(opts.timeout))
        output = res.output
        timedOut = res.timedOut
      }
      const result = score(task, lib, output, calls, (Date.now() - started) / 1000, timedOut)
      results.push(result)
      console.log(`${result.found ? "✓" : "✗"} ${task.id.padEnd(20)} ${String(result.toolCalls).padStart(2)} calls  ${(result.bytesRead / 1024).toFixed(1).padStart(6)} KB  ${result.answer ?? "(no answer)"}`)
    }
  }
  const n = results.length
  const share = (f: (r: Result) => boolean | null, of = results) => {
    const rel = of.filter((r) => f(r) != null)
    return rel.length ? `${Math.round((rel.filter((r) => f(r)).length / rel.length) * 100)}%` : "n/a"
  }
  const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0
  const summary = {
    harness,
    model: opts.model ?? null,
    librarySites: lib.refs.size,
    runs: n,
    found: share((r) => r.found),
    foundExcludingVisual: share((r) => r.found, results.filter((r) => r.kind !== "visual")),
    sawExpectedSection: share((r) => r.sawSection),
    medianToolCalls: median(results.map((r) => r.toolCalls)),
    medianKB: Math.round(median(results.map((r) => r.bytesRead)) / 1024),
    timeouts: results.filter((r) => r.timedOut).length,
  }
  console.log(summary)
  const dir = new URL("./results/", import.meta.url)
  await mkdir(dir, { recursive: true })
  const file = new URL(`${harness}${opts.model ? `-${opts.model.replace(/[^\w.-]/g, "_")}` : ""}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`, dir)
  await writeFile(file, JSON.stringify({ summary, results }, null, 2))
  console.log(`Wrote ${file.pathname}`)
} finally {
  server.close()
  await mf.dispose()
}
