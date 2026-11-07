import assert from "node:assert/strict"
import { test } from "node:test"
import { mcpApiHandler } from "../worker/mcp"

const pages = Array.from({ length: 25 }, (_, i) => ({
  id: `page${i}`, reference_id: "ref1", url: `https://example.com/${i}`, path: `/${i}`,
  title: `Page ${i}`, ord: i, created_at: "2026-01-01T00:00:00Z",
}))
const reference = {
  id: "ref1", url: "https://example.com", domain: "example.com", title: "Example", description: "Saved reference",
  mode: "crawl", max_pages: 25, status: "ready", page_count: 25, animation_count: 0,
  tokens_json: JSON.stringify({ colors: [{ value: "red", count: 1 }] }),
  created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
}
const env = {
  DB: {
    prepare(sql: string) {
      return {
        bind(...args: string[]) {
          return {
            async first() {
              if (sql.includes("FROM refs")) return args[0] === "ref1" ? reference : null
              if (sql.includes("FROM pages")) return pages.find((p) => p.id === args[0]) ?? null
              return null
            },
            async all() { return { results: sql.includes("FROM pages") ? pages : [] } },
          }
        },
      }
    },
  },
} as unknown as Env

async function rpc(method: string, params: unknown) {
  const request = new Request("http://localhost/mcp", {
    method: "POST",
    headers: { host: "localhost", "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
  const response = await mcpApiHandler.fetch(request, env, { waitUntil() {}, props: { ownerId: "max" } } as unknown as ExecutionContext)
  assert.equal(response.status, 200)
  const body = await response.text()
  const data = body.split("\n").find((line) => line.startsWith("data: "))
  assert.ok(data, body)
  return JSON.parse(data.slice(6)).result
}

test("MCP preserves legacy full reads while explicit overview remains bounded", async () => {
  const tools = (await rpc("tools/list", {})).tools
  const referenceTool = tools.find((tool: { name: string }) => tool.name === "get_reference")
  assert.ok(referenceTool.inputSchema.properties.part.enum.includes("full"))
  const get = async (args: object) => (await rpc("tools/call", { name: "get_reference", arguments: args })).structuredContent
  const implicit = await get({ id: "ref1" })
  const explicit = await get({ id: "ref1", part: "full" })
  assert.deepEqual(implicit, explicit)
  assert.equal(implicit.pages.length, 25)
  assert.deepEqual(implicit.tokens, JSON.parse(reference.tokens_json))
  const overview = await get({ id: "ref1", part: "overview" })
  assert.equal(overview.pages.length, 20)
  assert.equal(overview.omitted.pages, 5)
})

test("MCP accepts the legacy include_styles argument and returns its migration guidance", async () => {
  const result = await rpc("tools/call", { name: "get_page", arguments: { page_id: "page0", image: "none", include_styles: true } })
  assert.equal(result.structuredContent.styles, "Use get_page_styles(page_id) for valid, filterable computed styles.")
})
