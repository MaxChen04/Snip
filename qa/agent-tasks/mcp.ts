// A minimal MCP client for agents without MCP support of their own: it shows what an MCP client shows the model
// (server instructions, tools with their descriptions and schemas) and calls one tool at a time.
//
//   node --import tsx qa/agent-tasks/mcp.ts <url> list
//   node --import tsx qa/agent-tasks/mcp.ts <url> call <tool> '<json arguments>'
//   node --import tsx qa/agent-tasks/mcp.ts <url> task <n>       marks where task n starts in the server's log
//
// Image content is replaced by a one-line placeholder; everything else is printed as the server sent it.

const [url, command, name, json] = process.argv.slice(2)
if (!url || !command) {
  console.error("usage: mcp.ts <url> list | call <tool> '<json>'")
  process.exit(2)
}

async function rpc(method: string, params: unknown) {
  const res = await fetch(url!, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
  const text = await res.text()
  const line = text.split("\n").find((l) => l.startsWith("data: "))
  const msg = JSON.parse(line ? line.slice(6) : text)
  if (msg.error) throw new Error(msg.error.code + ": " + msg.error.message)
  return msg.result
}

if (command === "task") {
  await fetch(url + "?mark=" + encodeURIComponent(name ?? ""))
  console.log("Starting task " + name)
} else if (command === "list") {
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "agent-tasks", version: "1" } })
  const { tools } = await rpc("tools/list", {})
  console.log(JSON.stringify({ serverInstructions: init.instructions ?? null, tools }, null, 2))
} else if (command === "call") {
  const result = await rpc("tools/call", { name, arguments: json ? JSON.parse(json) : {} })
  for (const c of result.content ?? []) {
    if (c.type === "text") console.log(c.text)
    else if (c.type === "image") console.log("[image " + c.mimeType + ", " + Math.round((c.data.length * 3) / 4) + " bytes]")
    else console.log(JSON.stringify(c))
  }
  if (result.isError) console.log("[isError: true]")
} else {
  console.error("unknown command " + command)
  process.exit(2)
}
