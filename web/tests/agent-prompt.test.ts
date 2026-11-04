import { test } from "node:test"
import assert from "node:assert/strict"
import { buildAgentPrompt } from "../src/lib/agent-prompt"
import { claudeCodeCommand, isLocalOrigin, mcpJsonConfig, mcpUrl } from "../src/lib/mcp"

test("mcpUrl appends /mcp to the origin", () => {
  assert.equal(mcpUrl("http://localhost:5173"), "http://localhost:5173/mcp")
  assert.equal(mcpUrl("https://snip.max.workers.dev/"), "https://snip.max.workers.dev/mcp")
})

test("isLocalOrigin spots the local app", () => {
  assert.equal(isLocalOrigin("http://localhost:5173"), true)
  assert.equal(isLocalOrigin("http://127.0.0.1:8787"), true)
  assert.equal(isLocalOrigin("https://snip.max.workers.dev"), false)
})

test("client snippets embed the exact URL", () => {
  const url = "https://snip.max.workers.dev/mcp"
  assert.equal(claudeCodeCommand(url), `claude mcp add --transport http snip ${url}`)
  assert.deepEqual(JSON.parse(mcpJsonConfig(url)), { mcpServers: { snip: { url } } })
})

test("copied prompt names the exact Snip MCP URL", () => {
  const prompt = buildAgentPrompt({
    reference: { id: "ref1", title: "Linear", domain: "linear.app", url: "https://linear.app" } as never,
    pages: [],
    animations: [],
    tokens: false,
    mcpUrl: "https://snip.max.workers.dev/mcp",
  })
  assert.match(prompt, /^Use the Snip MCP server/)
  assert.ok(prompt.includes("Make sure to use the Snip MCP: https://snip.max.workers.dev/mcp"))
})
