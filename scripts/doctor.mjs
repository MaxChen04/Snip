#!/usr/bin/env node
// Checks a Snip checkout and prints one line per problem with how to fix it.
//   npm run doctor

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
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

async function checks() {
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

  const captureFile = process.env.SNIP_CAPTURE_ENV_FILE || at("capture/.env")
  const capture = readEnv(captureFile)
  if (!capture) bad(`${path.relative(ROOT, captureFile)} is missing`, "cp capture/.env.example capture/.env, then set SNIP_URL and CAPTURE_TOKEN.")
  else if (placeholder(capture.SNIP_URL) || !capture.CAPTURE_TOKEN) bad("capture/.env: SNIP_URL or CAPTURE_TOKEN is not set", "Use http://localhost:5173 and web/.dev.vars' CAPTURE_TOKEN locally, or your Worker URL and its CAPTURE_TOKEN secret.")
  else {
    if (isLocal(capture.SNIP_URL) && web && capture.CAPTURE_TOKEN !== web.CAPTURE_TOKEN) bad("capture/.env and web/.dev.vars have different CAPTURE_TOKENs", "Copy CAPTURE_TOKEN from web/.dev.vars into capture/.env.")
    else ok(`capture/.env points at ${capture.SNIP_URL}`)

    try {
      const res = await fetch(new URL("/agent/ping", capture.SNIP_URL), {
        headers: { authorization: `Bearer ${capture.CAPTURE_TOKEN}`, "x-snip-capture-protocol": "2" },
        signal: AbortSignal.timeout(5000),
      })
      if (res.ok) ok("The Worker accepts the capture token")
      else if (res.status === 401) bad("The Worker rejected CAPTURE_TOKEN", "Make capture/.env's CAPTURE_TOKEN match the Worker's (web/.dev.vars locally, `wrangler secret put CAPTURE_TOKEN` when deployed).")
      else if (res.status === 404) warn(`The Worker at ${capture.SNIP_URL} is older than this checkout`, "Deploy (npm run deploy) or restart the local app to pick up the latest Worker.")
      else bad(`The Worker answered ${res.status}`, "Check the Worker's logs.")
    } catch {
      if (isLocal(capture.SNIP_URL)) warn(`Nothing is answering at ${capture.SNIP_URL}`, "Start Snip.app or `npm run dev`, then run the doctor again.")
      else bad(`Can't reach ${capture.SNIP_URL}`, "Check the URL, or deploy with `npm run setup:cloudflare`.")
    }
  }

  if (capture?.CHROMIUM_PATH) {
    if (fs.existsSync(capture.CHROMIUM_PATH)) ok("Capture browser (CHROMIUM_PATH)")
    else bad(`CHROMIUM_PATH doesn't exist: ${capture.CHROMIUM_PATH}`, "Fix the path in capture/.env or remove it to use Playwright's Chromium.")
  } else {
    try {
      const { chromium } = createRequire(at("capture/package.json"))("playwright")
      if (fs.existsSync(chromium.executablePath())) ok("Capture browser installed")
      else bad("The capture browser isn't installed", "Run `npx playwright install chromium` (the agent also installs it on first capture).")
    } catch {
      bad("Playwright isn't installed", "Run `npm install`.")
    }
  }

  const deploy = at("web/wrangler.deploy.jsonc")
  if (fs.existsSync(deploy)) {
    const { readValues } = await import(pathToFileURL(at("scripts/cloudflare.mjs")).href)
    const v = readValues(fs.readFileSync(deploy, "utf8"))
    const missing = Object.entries(v).filter(([, value]) => !value).map(([k]) => ({ d1: "database_id", kv: "KV id", login: "ALLOWED_GITHUB_LOGINS", url: "PUBLIC_URL" })[k])
    if (missing.length) bad(`web/wrangler.deploy.jsonc is missing ${missing.join(", ")}`, "Run `npm run setup:cloudflare` again.")
    else ok(`Deploy config for ${v.url} (sign-in: ${v.login})`)
  }

  const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=no", "web/wrangler.jsonc"], { cwd: ROOT, encoding: "utf8" })
  if (status.stdout?.trim()) warn("web/wrangler.jsonc has local edits", "Run `npm run setup:cloudflare` (it copies your values into the gitignored web/wrangler.deploy.jsonc), then `git checkout web/wrangler.jsonc` so `npm run update` works.")

  return results
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const results = await checks()
  for (const r of results) {
    const mark = r.ok === true ? "\x1b[32m✓\x1b[0m" : r.ok === false ? "\x1b[31m✗\x1b[0m" : "\x1b[33m!\x1b[0m"
    console.log(`${mark} ${r.label}${r.fix ? `\n    ${r.fix}` : ""}`)
  }
  const failed = results.filter((r) => r.ok === false).length
  console.log(failed ? `\n${failed} problem${failed === 1 ? "" : "s"} to fix.` : "\nAll good.")
  process.exitCode = failed ? 1 : 0
}
