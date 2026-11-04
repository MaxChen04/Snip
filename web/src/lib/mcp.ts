/**
 * The MCP endpoint for the Snip instance this page is served from. The Worker serves /mcp on
 * every origin it runs on, so this is http://localhost:5173/mcp inside the local Snip.app and
 * https://snip.<subdomain>.workers.dev/mcp on a deployed site.
 */
export function mcpUrl(origin: string = location.origin): string {
  return `${origin.replace(/\/$/, "")}/mcp`
}

/** True when the page is the local Snip.app or dev server, which only agents on this machine can reach. */
export function isLocalOrigin(origin: string = location.origin): boolean {
  try {
    const { hostname } = new URL(origin)
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname.endsWith(".localhost")
  } catch {
    return false
  }
}

export const claudeCodeCommand = (url: string) => `claude mcp add --transport http snip ${url}`
export const mcpJsonConfig = (url: string) => JSON.stringify({ mcpServers: { snip: { url } } }, null, 2)

/** Codex CLI, IDE extension and ChatGPT desktop app share ~/.codex/config.toml. */
export const codexCommand = (url: string) => `codex mcp add snip --url ${url}`
export const codexToml = (url: string) => `[mcp_servers.snip]\nurl = ${JSON.stringify(url)}`

/** OpenCode wants an "mcp" block (not "mcpServers") and type "remote". */
export const opencodeJson = (url: string) =>
  JSON.stringify({ $schema: "https://opencode.ai/config.json", mcp: { snip: { type: "remote", url, enabled: true } } }, null, 2)
