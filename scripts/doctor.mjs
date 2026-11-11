#!/usr/bin/env node
// Checks a Snip checkout and prints one line per problem with how to fix it.
//   npm run doctor
//   npm run doctor -- --check              also probe the cloud library, like `status --check`
//   npm run doctor -- --data-root <path>   read cloud.json from another install
//
// Cloud checks are offline by default, exactly like `status`: `<dataRoot>/.snip/cloud.json`
// is the only source, and only an install that is in cloud mode (or halfway into it) is
// reported on, so a local-only library never sees a cloud warning.

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const require = createRequire(import.meta.url)
// One shape definition for cloud.json: the engine that writes it also reads it.
const readCloudState = require(path.join(ROOT, "desktop/provision/state.cjs")).readState
// The app's own choice of capture env file, so the doctor checks the file the agent loads.
const { cloudModeFor, selectCaptureEnvFile } = require(path.join(ROOT, "desktop/cloud-state.cjs"))
const at = (...p) => path.join(ROOT, ...p)

/** KEY=value lines, ignoring comments. */
export function parseEnv(text) {
  const out = {}
  for (const line of String(text).split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (m) out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2")
  }
  return out
}

const readEnv = (file) => (fs.existsSync(file) ? parseEnv(fs.readFileSync(file, "utf8")) : null)
const isLocal = (url) => { try { return ["localhost", "127.0.0.1"].includes(new URL(url).hostname) } catch { return false } }
const placeholder = (v) => !v || /your-|YOUR-|REPLACE_WITH|generate-with/.test(v)

/** The cloud command line every fix points at, so users copy one real command. */
const CLOUD_COMMAND = "npm run setup:cloudflare --"

/** A canonical http(s) origin, or null when the value cannot be one. */
export function cloudOrigin(value) {
  if (!value) return null
  let url
  try { url = new URL(value) } catch { return null }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) return null
  return url.origin
}

/**
 * Cloud-mode checks. Offline by default: cloud.json is the only source, and the
 * network is touched only with `check`, matching `status --check`. Nothing is
 * returned for a library that is not using cloud, so a local install reads clean.
 */
export async function cloudChecks({ dataRoot, check = false, fetchImpl = fetch, exists = fs.existsSync } = {}) {
  const results = []
  const file = path.join(dataRoot, ".snip", "cloud.json")
  const add = (ok, label, fix) => results.push({ ok, area: "cloud", label, ...(fix ? { fix } : {}) })

  let state
  try {
    state = readCloudState(dataRoot)
  } catch (error) {
    // A damaged journal blocks knowing the mode, so it is reported either way.
    add(false, `The cloud setup record is unreadable: ${error.message}`, error.hint || `Inspect ${file}.`)
    return results
  }
  if (state.mode !== "cloud" && state.mode !== "enabling") return results

  const record = state.cloud || {}
  const snapshot = state.snapshot || null

  if (state.mode === "enabling") {
    const failed = (state.steps || []).filter((step) => step && step.status === "failed").pop() || null
    const error = state.error || null
    const where = error?.step || failed?.id || null
    const why = error?.message || failed?.detail || null
    add(null, `Cloud setup did not finish${where ? ` (stopped at ${where})` : ""}${why ? `: ${why}` : ""}`,
      `Resume it with \`${CLOUD_COMMAND} setup --resume\`. To stay local instead, run \`${CLOUD_COMMAND} abort\`.`)
  } else {
    const origin = cloudOrigin(record.url)
    if (!origin) {
      add(false, `Cloud mode is recorded without a usable Worker URL${record.url ? `: ${record.url}` : ""}`,
        `Run \`${CLOUD_COMMAND} setup --resume\` if setup never finished, otherwise \`${CLOUD_COMMAND} deploy\`.`)
    } else {
      add(true, `Cloud library: ${origin}${record.workerVersion ? ` (Worker ${record.workerVersion})` : ""}`)
      if (record.detachedAt) {
        add(null, `cloud.json records a detach at ${record.detachedAt}, but the mode is cloud`,
          `Run \`${CLOUD_COMMAND} status\`. If you meant to stop using the cloud library, run \`${CLOUD_COMMAND} detach\`.`)
      }
      if (!record.workerVersion) {
        add(null, "No deployed Worker version is recorded for this install",
          `Run \`${CLOUD_COMMAND} deploy\` once so this Mac knows what it deployed.`)
      }
      if (!exists(path.join(dataRoot, ".snip", "cloud-secrets.json"))) {
        add(null, "This Mac holds no owner sign-in secret",
          `Run \`${CLOUD_COMMAND} owner rotate\` to set a new one and mint a fresh sign-in link.`)
      }

      if (check) {
        // The one network call, and only when asked for: the same probe
        // `status --check` makes. A Worker answers 401/404 at its origin and is
        // still healthy, so anything below 500 counts as reachable.
        try {
          const response = await fetchImpl(origin, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(8000) })
          if (response.status < 500) add(true, `The cloud library answers (HTTP ${response.status})`)
          else add(false, `The cloud library answered HTTP ${response.status}`,
            `Check it in the Cloudflare dashboard, then run \`${CLOUD_COMMAND} status --check\`.`)
        } catch {
          add(false, `Can't reach the cloud library at ${origin}`,
            `Check this Mac's connection and open the URL in a browser, then run \`${CLOUD_COMMAND} status --check\`.`)
        }
      }
    }
  }

  // Recorded local artifacts, checked by path only: a record pointing at a
  // directory that is gone makes Settings offer something that cannot work.
  const backup = snapshot && snapshot.kind === "backup" && snapshot.path ? snapshot.path : null
  if (backup && !exists(path.join(dataRoot, backup))) {
    add(false, `The previous library is missing: ${backup}`,
      `Nothing can be restored from it. Remove the stale record with \`${CLOUD_COMMAND} snapshot delete --confirm ${path.basename(backup)}\`.`)
  }
  const exported = snapshot && snapshot.export && snapshot.export.path ? snapshot.export.path : null
  if (exported && !exists(path.join(dataRoot, exported))) {
    add(false, `Setup's backup files are missing: ${exported}`,
      `Remove the stale record with \`${CLOUD_COMMAND} snapshot delete-export --confirm ${path.basename(exported)}\`.`)
  }

  return results
}

export async function checks(options = {}) {
  const root = options.root ?? ROOT
  const at = (...p) => path.join(root, ...p)
  const fetchImpl = options.fetchImpl ?? fetch
  const results = []
  const ok = (label) => results.push({ ok: true, label })
  const bad = (label, fix) => results.push({ ok: false, label, fix })
  const warn = (label, fix) => results.push({ ok: null, label, fix })

  const [major, minor] = process.versions.node.split(".").map(Number)
  if (major > 22 || (major === 22 && minor >= 18)) ok(`Node ${process.versions.node}`)
  else bad(`Node ${process.versions.node} is too old`, "Install Node 22.18 or newer (or 24).")

  if (fs.existsSync(at("node_modules/wrangler")) && fs.existsSync(at("node_modules/playwright"))) ok("Dependencies installed")
  else bad("Dependencies are missing", "Run `npm install` in the repository root.")

  const web = readEnv(at("web/.dev.vars"))
  if (!web) bad("web/.dev.vars is missing", "cp web/.dev.vars.example web/.dev.vars, then fill in SESSION_SECRET and CAPTURE_TOKEN (openssl rand -hex 32).")
  else {
    for (const key of ["SESSION_SECRET", "CAPTURE_TOKEN"]) {
      if (placeholder(web[key])) bad(`web/.dev.vars: ${key} is not set`, `Set it to a random value: openssl rand -hex 32`)
    }
    if (!web.DEV_LOGIN) warn("web/.dev.vars: DEV_LOGIN is not set", "Local development needs DEV_LOGIN to skip GitHub sign-in on localhost.")
    else if (!placeholder(web.SESSION_SECRET) && !placeholder(web.CAPTURE_TOKEN)) ok("web/.dev.vars")
  }

  const dataRoot = options.dataRoot ?? root
  const captureFile = options.captureEnvFile || process.env.SNIP_CAPTURE_ENV_FILE || selectCaptureEnvFile({ dataRoot, mode: cloudModeFor(dataRoot) }).path
  const captureName = path.relative(root, captureFile)
  const capture = readEnv(captureFile)
  if (!capture) bad(`${captureName} is missing`, "cp capture/.env.example capture/.env, then set SNIP_URL and CAPTURE_TOKEN.")
  else if (placeholder(capture.SNIP_URL) || !capture.CAPTURE_TOKEN) bad(`${captureName}: SNIP_URL or CAPTURE_TOKEN is not set`, "Use http://localhost:5173 and web/.dev.vars' CAPTURE_TOKEN locally, or your Worker URL and its CAPTURE_TOKEN secret.")
  else {
    if (isLocal(capture.SNIP_URL) && web && capture.CAPTURE_TOKEN !== web.CAPTURE_TOKEN) bad(`${captureName} and web/.dev.vars have different CAPTURE_TOKENs`, `Copy CAPTURE_TOKEN from web/.dev.vars into ${captureName}.`)
    else ok(`${captureName} points at ${capture.SNIP_URL}`)

    try {
      const res = await fetchImpl(new URL("/agent/ping", capture.SNIP_URL), {
        headers: { authorization: `Bearer ${capture.CAPTURE_TOKEN}`, "x-snip-capture-protocol": "4" },
        signal: AbortSignal.timeout(5000),
      })
      if (res.ok) ok("The Worker accepts the capture token")
      else if (res.status === 401) bad("The Worker rejected CAPTURE_TOKEN", `Make ${captureName}'s CAPTURE_TOKEN match the Worker's (web/.dev.vars locally, \`wrangler secret put CAPTURE_TOKEN\` when deployed).`)
      else if (res.status === 426) bad("Capture agent and Worker versions do not match", "Update and restart every capture agent, and deploy the matching Worker (capture protocol 4).")
      else if (res.status === 404) warn(`The Worker at ${capture.SNIP_URL} is older than this checkout`, "Deploy (npm run deploy) or restart the local app to pick up the latest Worker.")
      else bad(`The Worker answered ${res.status}`, "Check the Worker's logs.")
    } catch {
      if (isLocal(capture.SNIP_URL)) warn(`Nothing is answering at ${capture.SNIP_URL}`, "Start Snip.app or `npm run dev`, then run the doctor again.")
      else bad(`Can't reach ${capture.SNIP_URL}`, `Check the URL, or deploy with \`${CLOUD_COMMAND} deploy\`.`)
    }
  }

  if (capture?.CHROMIUM_PATH) {
    if (fs.existsSync(capture.CHROMIUM_PATH)) ok("Capture browser (CHROMIUM_PATH)")
    else bad(`CHROMIUM_PATH doesn't exist: ${capture.CHROMIUM_PATH}`, `Fix the path in ${captureName} or remove it to use Playwright's Chromium.`)
  } else {
    try {
      const { chromium } = createRequire(at("capture/package.json"))("playwright")
      if (fs.existsSync(chromium.executablePath())) ok("Capture browser installed")
      else bad("The capture browser isn't installed", "Run `npx playwright install chromium` (the agent also installs it on first capture).")
    } catch {
      bad("Playwright isn't installed", "Run `npm install`.")
    }
  }

  // Cloud is reported only for an install that is actually using it, read from
  // cloud.json alone. `--check` adds the one probe `status --check` makes.
  results.push(...await cloudChecks({ dataRoot, check: Boolean(options.check), fetchImpl }))

  const status = options.gitStatus
    ? { stdout: options.gitStatus() }
    : spawnSync("git", ["status", "--porcelain", "--untracked-files=no", "web/wrangler.jsonc"], { cwd: root, encoding: "utf8" })
  if (status.stdout?.trim()) {
    warn("web/wrangler.jsonc has local edits", "`npm run update` stops on edits to tracked files. Start Snip once so it records this library's storage in .snip/storage-identities.json (or copy your own values into gitignored web/wrangler.local.jsonc), then `git checkout web/wrangler.jsonc`.")
  }

  return results
}

/** `--check` and `--data-root <path>`; everything else is ignored. */
export function parseFlags(argv) {
  const flags = { check: false, dataRoot: null, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--check") flags.check = true
    else if (arg === "--help" || arg === "-h") flags.help = true
    else if (arg === "--data-root") flags.dataRoot = argv[++i] ?? null
    else if (arg.startsWith("--data-root=")) flags.dataRoot = arg.slice("--data-root=".length)
  }
  return flags
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const flags = parseFlags(process.argv.slice(2))
  if (flags.help) {
    console.log("Usage: npm run doctor -- [--check] [--data-root <path>]\n\n  --check              also ask the cloud library whether it answers\n  --data-root <path>   read .snip/cloud.json from another install")
  } else {
    const results = await checks({ check: flags.check, dataRoot: flags.dataRoot ?? undefined })
    for (const r of results) {
      const mark = r.ok === true ? "\x1b[32m✓\x1b[0m" : r.ok === false ? "\x1b[31m✗\x1b[0m" : "\x1b[33m!\x1b[0m"
      console.log(`${mark} ${r.label}${r.fix ? `\n    ${r.fix}` : ""}`)
    }
    const failed = results.filter((r) => r.ok === false).length
    console.log(failed ? `\n${failed} problem${failed === 1 ? "" : "s"} to fix.` : "\nAll good.")
    process.exitCode = failed ? 1 : 0
  }
}
