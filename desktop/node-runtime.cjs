const fs = require("node:fs/promises")
const path = require("node:path")
const { execFile } = require("node:child_process")
const { promisify } = require("node:util")

const execFileAsync = promisify(execFile)
const PROBE = "JSON.stringify({platform:process.platform,arch:process.arch,version:process.versions.node})"

async function validNode(executable, env) {
  try {
    const { stdout } = await execFileAsync(executable, ["-p", PROBE], { env, timeout: 2000, maxBuffer: 16384 })
    const { platform, arch, version } = JSON.parse(stdout.trim())
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
    if (!match || platform !== "darwin" || arch !== "arm64") return false
    const major = Number(match[1]), minor = Number(match[2])
    return (major === 22 && minor >= 18) || (major === 24 && minor >= 11) || major >= 25
  } catch { return false }
}

async function saveCache(cacheFile, executable) {
  if (!cacheFile) return
  const temporary = `${cacheFile}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    await fs.mkdir(path.dirname(cacheFile), { recursive: true })
    await fs.writeFile(temporary, JSON.stringify({ executable }), { mode: 0o600 })
    await fs.rename(temporary, cacheFile)
  } catch { await fs.rm(temporary, { force: true }).catch(() => {}) }
}

async function resolveNode({ cacheFile, env = process.env } = {}) {
  let cached
  try { cached = JSON.parse(await fs.readFile(cacheFile, "utf8")).executable } catch {}
  if (typeof cached === "string" && path.isAbsolute(cached) && await validNode(cached, env)) return { executable: cached, env: { ...env } }
  const seen = new Set()
  async function find(searchPath, selectedEnv) {
    for (const dir of (searchPath || "").split(path.delimiter).slice(0, 128)) {
      if (!dir || !path.isAbsolute(dir)) continue
      const executable = path.join(dir, "node")
      if (seen.has(executable)) continue
      seen.add(executable)
      if (await validNode(executable, selectedEnv)) {
        await saveCache(cacheFile, executable)
        return { executable, env: selectedEnv }
      }
    }
  }
  const current = await find(env.PATH, { ...env })
  if (current) return current
  try {
    const shell = env.SHELL && path.isAbsolute(env.SHELL) ? env.SHELL : "/bin/zsh"
    const { stdout } = await execFileAsync(shell, ["-ilc", "printf '\\n__SNIP_PATH__%s\\n' \"$PATH\""], { env, timeout: 8000, maxBuffer: 1024 * 1024 })
    const marker = stdout.lastIndexOf("\n__SNIP_PATH__")
    if (marker !== -1) {
      const loginPath = stdout.slice(marker + "\n__SNIP_PATH__".length).split("\n")[0]
      const found = await find(loginPath, { ...env, PATH: loginPath })
      if (found) return found
    }
  } catch {}
  throw new Error("Snip requires native Apple Silicon Node.js 22.18+ or 24.11+.")
}

module.exports = { resolveNode }
