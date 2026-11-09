// Hot reload uses the same isolated library and migrations as packaged Snip Dev.
const fs = require("node:fs/promises")
const path = require("node:path")
const { createRequire } = require("node:module")
const { pathToFileURL } = require("node:url")
const { storageConfig, migrate } = require("./local-server.cjs")

async function main() {
  const [, , root, portText, dataRoot] = process.argv
  const port = Number(portText)
  if (!root || !dataRoot || !path.isAbsolute(root) || !path.isAbsolute(dataRoot) || root === dataRoot || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Expected a runtime root, port and separate test library.")
  const fromRepo = createRequire(path.join(root, "package.json"))
  const { unstable_readConfig } = fromRepo("wrangler")
  const source = unstable_readConfig({ config: path.join(root, "web/wrangler.jsonc") })
  const config = Object.fromEntries(["name", "main", "compatibility_date", "compatibility_flags", "ratelimits", "assets", "d1_databases", "r2_buckets", "kv_namespaces", "vars"].filter(key => source[key] !== undefined).map(key => [key, source[key]]))
  const controller = new AbortController()
  let server, startup, stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    controller.abort()
    await startup?.catch(() => {})
    await server?.close()
    process.exit(0)
  }
  process.on("SIGTERM", () => void stop())
  process.on("disconnect", () => void stop())
  process.on("message", message => { if (message?.type === "snip:stop") void stop() })
  startup = (async () => {
    const migrations = await storageConfig(root, dataRoot, unstable_readConfig, config)
    await migrate(root, dataRoot, controller.signal, migrations)
    if (stopping) return
    // Place the config beside the test library's .dev.vars. Vite must never read
    // the source checkout's everyday credentials or persist into its storage.
    const configPath = path.join(dataRoot, "web/wrangler.dev.json")
    await fs.writeFile(configPath, JSON.stringify(config) + "\n", { mode: 0o600 })
    process.env.SNIP_WRANGLER_CONFIG = configPath
    process.env.SNIP_DESKTOP_DATA_ROOT = dataRoot
    const { createServer } = await import(pathToFileURL(fromRepo.resolve("vite")).href)
    server = await createServer({ root: path.join(root, "web"), server: { host: "localhost", port, strictPort: true } })
    if (stopping) return
    await server.listen()
    if (!stopping) process.send?.({ type: "snip:web-ready", url: `http://localhost:${port}` })
  })()
  await startup
}

main().catch(error => {
  console.error(error.userMessage || error.message)
  process.exit(1)
})
