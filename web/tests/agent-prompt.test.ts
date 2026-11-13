import { test } from "node:test"
import assert from "node:assert/strict"
import { buildAgentPrompt } from "../src/lib/agent-prompt"
import { claudeCodeCommand, codexCommand, codexToml, isLocalOrigin, mcpJsonConfig, mcpUrl, opencodeJson } from "../src/lib/mcp"

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
  assert.equal(claudeCodeCommand(url), `claude mcp add --scope user --transport http snip ${url}`)
  assert.deepEqual(JSON.parse(mcpJsonConfig(url)), { mcpServers: { snip: { url } } })
  assert.equal(codexCommand(url), `codex mcp add snip --url ${url}`)
  assert.equal(codexToml(url), `[mcp_servers.snip]\nurl = "${url}"`)
  assert.deepEqual(JSON.parse(opencodeJson(url)).mcp.snip, { type: "remote", url, enabled: true })
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

test("copied prompt carries the saved note on why the reference was saved", () => {
  const base = { id: "ref1", title: "Linear", domain: "linear.app", url: "https://linear.app" }
  const prompt = buildAgentPrompt({
    reference: { ...base, notes: "Borrow this navigation and spacing.\nIgnore the hero." } as never,
    pages: [],
    animations: [],
    tokens: false,
    mcpUrl: "https://snip.max.workers.dev/mcp",
  })
  assert.ok(prompt.includes("Why I saved this reference"))
  assert.ok(prompt.includes("> Borrow this navigation and spacing.\n> Ignore the hero."))
  // The note sits with the reference details, before the fetch steps.
  assert.ok(prompt.indexOf("> Borrow") < prompt.indexOf("Fetch only the items below"))

  for (const notes of [null, "   "]) {
    const without = buildAgentPrompt({ reference: { ...base, notes } as never, pages: [], animations: [], tokens: false, mcpUrl: "x" })
    assert.ok(!without.includes("Why I saved this reference"))
  }
})

test("copied prompt asks for motion at the scope of the selection", () => {
  const reference = { id: "ref1", title: "Ando", domain: "ando.so", url: "https://ando.so", tokens: { motion: { version: 1 } } } as never
  const base = { reference, pages: [], animations: [], tokens: false, mcpUrl: "https://snip.test/mcp" }
  const onePage = buildAgentPrompt({ ...base, pages: [{ id: "p1", path: "/", title: "Home" }] as never })
  assert.match(onePage, /get_motion_profile with reference_id "ref1" and page_id "p1":/)
  const recording = buildAgentPrompt({ ...base, animations: [{ id: "a1", pageId: "p2", kind: "hover", label: "Nav" }] as never })
  assert.match(recording, /page_id "p2"/, "a picked recording scopes motion to its page")
  assert.match(buildAgentPrompt({ ...base, tokens: true }), /get_motion_profile with reference_id "ref1": .*merged across its pages/, "the whole site only for site-wide tokens")
  assert.ok(!buildAgentPrompt({ ...base, reference: { ...(reference as object), tokens: null } as never, pages: [{ id: "p1", path: "/" }] as never }).includes("get_motion_profile"), "no profile, no call")
})

test("saved direction, selected view, capture revision and scoped motion survive in one prompt", () => {
  const reference = { id: "ref1", title: "Example", domain: "example.test", url: "https://example.test", captureRun: 7,
    notes: "Use the pricing cards.\nKeep our own copy.", options: { colorScheme: "light" }, tokens: { motion: { version: 1 } } } as never
  const pages = [{ id: "p1", path: "/pricing", title: "Pricing", mobileKey: "mobile.jpg", altScheme: { scheme: "dark" },
    sections: [{ kind: "section", label: "Plans" }] }] as never
  const prompt = buildAgentPrompt({ reference, pages, animations: [], tokens: false, mcpUrl: "https://snip.test/mcp",
    views: { p1: { viewport: "desktop", scheme: "dark", sections: [0] } } })
  assert.match(prompt, /> Use the pricing cards\.\n> Keep our own copy\./)
  assert.match(prompt, /Capture run: 7\./)
  assert.match(prompt, /page_id "p1", desktop, dark theme, section 0 "Plans"/)
  assert.match(prompt, /get_motion_profile with reference_id "ref1" and page_id "p1":/)
  const selection = JSON.parse(prompt.split("\n").find((line) => line.startsWith("Selection: "))!.slice("Selection: ".length))
  assert.deepEqual(selection, { reference_id: "ref1", capture_run: 7, pages: [{ page_id: "p1", path: "/pricing", viewport: "desktop", scheme: "dark", sections: [{ index: 0, kind: "section", label: "Plans" }] }] })
  assert.match(prompt, /captureRun other than 7/)
})
