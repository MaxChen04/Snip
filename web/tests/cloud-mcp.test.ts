import assert from "node:assert/strict"
import { test } from "node:test"
import { mcpApiHandler, PULL_CLOUD_PROMPT, SETUP_CLOUD_PROMPT } from "../worker/mcp"

// The cloud setup surface is local-origin only: the Worker can describe provisioning but cannot
// perform it, and from a cloud origin "set up cloud" would be a dead end.

const recent = new Date(Date.now() - 12_000).toISOString()

const env = {
  DB: {
    prepare(sql: string) {
      const row = sql.includes("FROM owners")
        ? { id: "max", label: "Max" }
        : sql.includes("FROM worker_presence")
          ? { id: "capture", last_seen_at: recent, activity: "idle", job_id: null }
          : null
      return {
        first: async () => row,
        bind: () => ({ first: async () => row, all: async () => ({ results: [] }) }),
        all: async () => ({ results: [] }),
      }
    },
  },
} as unknown as Env

const ctx = { waitUntil() {}, props: { ownerId: "max" } } as unknown as ExecutionContext

async function rpcRaw(origin: string, method: string, params: unknown) {
  const { hostname, port } = new URL(origin)
  const request = new Request(`${origin}/mcp`, {
    method: "POST",
    // The MCP handler validates the Host header, which a bare Request does not populate.
    headers: { host: port ? `${hostname}:${port}` : hostname, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
  const response = await mcpApiHandler.fetch(request, env, ctx)
  assert.equal(response.status, 200)
  const body = await response.text()
  const data = body.split("\n").find((line) => line.startsWith("data: "))
  assert.ok(data, body)
  return JSON.parse(data.slice(6)) as { result?: Record<string, unknown>; error?: { code: number; message: string } }
}

async function rpc(origin: string, method: string, params: unknown) {
  const message = await rpcRaw(origin, method, params)
  assert.ok(message.result, `expected a result, got ${JSON.stringify(message.error)}`)
  return message.result!
}

test("a local origin registers the setup prompts and the read-only status tool", async () => {
  const origin = "http://localhost:5173"
  const prompts = (await rpc(origin, "prompts/list", {})).prompts as { name: string; description: string }[]
  assert.deepEqual(prompts.map((p) => p.name).sort(), ["pull_cloud", "setup_cloud"])

  const tools = (await rpc(origin, "tools/list", {})).tools as { name: string; annotations?: Record<string, unknown> }[]
  const status = tools.find((t) => t.name === "get_cloud_setup_status")
  assert.ok(status, "the status tool is registered")
  assert.equal(status.annotations?.readOnlyHint, true)
  assert.equal(status.annotations?.destructiveHint, false)
  assert.equal(status.annotations?.openWorldHint, false)

  const setup = (await rpc(origin, "prompts/get", { name: "setup_cloud", arguments: {} })).messages[0]
  assert.equal(setup.role, "user")
  assert.equal(setup.content.text, SETUP_CLOUD_PROMPT)
  // The runbook's required beats.
  for (const phrase of ["setup --check --json", "wait for approval", "Never ask for a secret in chat", "npm run doctor"]) {
    assert.ok(SETUP_CLOUD_PROMPT.toLowerCase().includes(phrase.toLowerCase()), phrase)
  }
  const pull = (await rpc(origin, "prompts/get", { name: "pull_cloud", arguments: {} })).messages[0]
  assert.equal(pull.content.text, PULL_CLOUD_PROMPT)
  assert.match(PULL_CLOUD_PROMPT, /setup:cloudflare -- pull --json/)
})

test("the status tool reports what the Worker can see and says what it cannot", async () => {
  const origin = "http://localhost:5173"
  const result = await rpc(origin, "tools/call", { name: "get_cloud_setup_status", arguments: {} })
  const data = result.structuredContent as {
    mode: string
    origin: string
    deployedUrl: string | null
    checks: { id: string; ok: boolean; detail?: string }[]
    next: { run: string; cwd: string | null; humanActions: string[] }
    note: string
  }
  assert.equal(data.mode, "local")
  assert.equal(data.origin, origin)
  assert.equal(data.deployedUrl, null)
  assert.deepEqual(data.checks.map((c) => c.id), ["origin-local", "owner-configured", "capture-agent"])
  assert.ok(data.checks.every((c) => c.ok))
  assert.match(data.checks[2]!.detail!, /^seen \d+s ago$/)
  assert.equal(data.next.run, "npm run setup:cloudflare -- setup --check --json")
  assert.equal(data.next.cwd, null, "the Worker cannot know the repo path")
  assert.ok(data.next.humanActions.length > 0)
  assert.match(data.note, /cannot inspect your Mac/)

  const pull = (await rpc(origin, "tools/call", { name: "get_cloud_setup_status", arguments: { command: "pull" } })).structuredContent as { next: { run: string; humanActions: string[] } }
  assert.equal(pull.next.run, "npm run setup:cloudflare -- pull --json")
  assert.deepEqual(pull.next.humanActions, [])
})

test("a cloud origin exposes neither the prompts nor the tool", async () => {
  const origin = "https://snip.max.workers.dev"
  // No prompts are registered there, so even the capability is absent.
  const prompts = await rpcRaw(origin, "prompts/list", {})
  assert.equal(prompts.result?.prompts ?? undefined, undefined, JSON.stringify(prompts.result))
  assert.ok(prompts.error, "prompts/list is not a capability on a cloud origin")
  const tools = (await rpc(origin, "tools/list", {})).tools as { name: string }[]
  assert.equal(tools.some((t) => t.name === "get_cloud_setup_status"), false)
  // The library tools are still there.
  assert.ok(tools.some((t) => t.name === "search_references"))
  const called = await rpcRaw(origin, "tools/call", { name: "get_cloud_setup_status", arguments: {} })
  assert.ok(called.error, "the tool does not exist on a cloud origin")
})

test("the Worker reports one version everywhere the engine compares it", async () => {
  const { WORKER_VERSION, MCP_SERVER_VERSION } = await import("../worker/version")
  assert.equal(MCP_SERVER_VERSION, WORKER_VERSION)
  assert.match(WORKER_VERSION, /^\d+\.\d+\.\d+$/)

  const initialize = await rpcRaw("http://localhost:5173", "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } })
  const serverInfo = initialize.result?.serverInfo as { name: string; version: string } | undefined
  assert.equal(serverInfo?.version, WORKER_VERSION, "the MCP handshake advertises the same version")
})

test("a token whose grant has no owner cannot read the library", async () => {
  const request = new Request("http://localhost/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  })
  const response = await mcpApiHandler.fetch(request, env, { waitUntil() {}, props: {} } as unknown as ExecutionContext)
  assert.equal(response.status, 401)
  const legacy = await mcpApiHandler.fetch(request, env, { waitUntil() {} } as unknown as ExecutionContext)
  assert.equal(legacy.status, 401, "a grant minted before ownership existed is not accepted")
})
