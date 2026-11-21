# Agent task evals

Can an agent that has never seen Snip get real work done through its MCP server? `qa/discovery` measures finding the right page; these tasks cover the rest of a session: comparing pages, turning tokens into a theme, capturing a URL, pulling one section's markup and organizing pages on a board.

`serve.ts` serves the discovery fixture library over Snip's real MCP handler with no sign-in, adds design tokens to Plainleaf and an HTML snapshot to Orbitly's home page, and runs a simulated capture agent that finishes any queued capture after `--capture-seconds` (default 20). Everything is in memory and synthetic. Each tool call is appended to the `--log` file as JSON: tool, arguments, bytes on the wire, `visibleChars` (the text the model reads) and whether it was an error.

```bash
node --import tsx qa/agent-tasks/serve.ts --port 5401 --log /tmp/snip-agent.jsonl
```

Point any MCP client at `http://127.0.0.1:5401/mcp`. For an agent without MCP support, `mcp.ts` stands in for the client: `list` prints the server instructions and tools as a client would show them, `call <tool> '<json>'` calls one, and `task <n>` writes a marker to the log so calls can be split per task.

```bash
node --import tsx qa/agent-tasks/mcp.ts http://127.0.0.1:5401/mcp list
node --import tsx qa/agent-tasks/mcp.ts http://127.0.0.1:5401/mcp call search_pages '{"query":"pricing"}'
```

## Tasks

Given in order, as messages in one session:

1. "Find the pricing pages I've saved and compare their layouts."
2. "Pull the color and type tokens from the Plainleaf site I saved into a Tailwind theme."
3. "Save https://ferncastle.test to Snip and tell me when the capture is done."
4. "Find a section like a testimonial grid in my saved sites and give me its HTML markup."
5. "Put these three pages on a board called 'Pricing inspiration': https://plainleaf.test/pricing, https://tallyho.test/pricing and https://quillbase.test/pricing."

Score each from the log (calls, errors, characters read) and from the agent's own account of where it had to guess. The agent must not read the repository: the point is what the tool list and results alone teach it.
