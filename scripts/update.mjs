#!/usr/bin/env node
// Updates a local Snip checkout to the latest main in one step:
// quit Snip.app gracefully, fast-forward git, install dependencies and the
// capture browser, back up and migrate the local database, rebuild the web
// app (and Snip.app when desktop/ changed), then reopen the app.
//
//   npm run update                 update if main has new commits
//   npm run update -- --full       rerun every step, even when up to date
//   npm run update -- --stash      stash local edits instead of stopping
//   npm run update -- --relaunch   reopen Snip.app afterwards even if it was closed
//
// Untracked files (research/, output/, .env files, your library) are never touched.

import { execFileSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { localConfigPath } from "../web/local-config.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const BRANCH = "main"
const APP_ID = "dev.snip.desktop"
// npm rewrites these on `npm install`; they are safe to reset because the update reinstalls from the committed copy.
export const LOCKFILES = new Set(["package-lock.json", "desktop/package-lock.json"])

// Which steps a set of changed paths requires. `full` forces every step.
export function planSteps(changed, { full = false } = {}) {
  const any = test => full || changed.some(test)
  const deps = file => /(^|\/)package(-lock)?\.json$/.test(file) && !file.startsWith("desktop/")
  return {
    install: any(deps),
    browser: true, // Cheap no-op when the browser is present, and repairs a missed install.
    migrate: true, // Applies only pending migrations, after a backup.
    buildWeb: true, // Snip.app serves web/dist, so it must match the source.
    rebuildApp: any(file => file.startsWith("desktop/") && !file.startsWith("desktop/tests/")),
  }
}

// Splits `git status --porcelain` output into lockfile churn and real local edits.
export function classifyChanges(porcelain) {
  const files = porcelain.split("\n").filter(Boolean).map(line => line.slice(3).replace(/^.* -> /, ""))
  return { lockfiles: files.filter(file => LOCKFILES.has(file)), edits: files.filter(file => !LOCKFILES.has(file)) }
}

/**
 * True when this Mac is using its cloud library. Read from cloud.json only: the
 * engine owns that file, and an unreadable one means "local", so an update never
 * deploys on a guess.
 */
export function cloudMode(dataRoot = ROOT) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(dataRoot, ".snip/cloud.json"), "utf8"))
    return state && state.mode === "cloud" && Boolean(state.cloud && state.cloud.url)
  } catch {
    return false
  }
}

const log = message => console.log(`\x1b[1m›\x1b[0m ${message}`)
const fail = message => { console.error(`\n\x1b[31m✗\x1b[0m ${message}`); process.exit(1) }
const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim()
function run(label, cmd, args, options = {}) {
  log(label)
  const result = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", ...options })
  if (result.status !== 0) {
    fail(`${label} failed. Fix the error above, then run \`npm run update\` again to finish.`)
  }
}
function npmCommand() {
  if (process.env.npm_execpath?.endsWith(".js")) return [process.execPath, [process.env.npm_execpath]]
  const sibling = path.join(path.dirname(process.execPath), "npm")
  return [fs.existsSync(sibling) ? sibling : "npm", []]
}
function npm(label, args, options) {
  const [cmd, prefix] = npmCommand()
  run(label, cmd, [...prefix, ...args], options)
}

const mac = process.platform === "darwin"
const installedApp = () => ["/Applications/Snip.app", path.join(os.homedir(), "Applications/Snip.app")].find(dir => fs.existsSync(dir))
function appRunning() {
  if (!mac) return false
  return spawnSync("pgrep", ["-f", "Snip.app/Contents/MacOS/Snip"], { stdio: "ignore" }).status === 0
}
// A terminal dev server or capture agent keeps writing to the database, so a
// backup or migration taken under it may be inconsistent. Run after Snip.app quits.
const terminalServices = () => spawnSync("pgrep", ["-f", "tsx[^ ]*( --[^ ]+)* src/index\\.ts|capture/src/index\\.ts|node_modules/\\.bin/vite"], { stdio: "ignore" }).status === 0
async function quitApp() {
  log("Quitting Snip.app (active captures finish first)…")
  spawnSync("osascript", ["-e", `tell application id "${APP_ID}" to quit`], { stdio: "ignore" })
  const deadline = Date.now() + 10 * 60 * 1000
  let waited = 0
  while (appRunning()) {
    if (Date.now() > deadline) fail("Snip.app is still running after 10 minutes. Quit it from the menu bar, then run `npm run update` again. Nothing was changed.")
    if (++waited % 15 === 0) log("Still waiting for Snip.app to finish its capture…")
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
}

// Mirrors the app's own pre-migration backup so CLI and app upgrades are equally safe.
function migrate() {
  const wrangler = path.join(ROOT, "node_modules/wrangler/bin/wrangler.js")
  const env = { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" }
  const web = path.join(ROOT, "web")
  const localArgs = ["DB", "--local", "--config", localConfigPath(web), "--persist-to", path.join(web, ".wrangler/state")]
  const list = spawnSync(process.execPath, [wrangler, "d1", "migrations", "list", ...localArgs], { cwd: web, env, encoding: "utf8" })
  if (list.status !== 0) { process.stderr.write(list.stderr || ""); fail("Could not read the local database's migration status. Nothing was migrated.") }
  if (list.stdout.includes("No migrations to apply")) { log("Local database is already up to date"); return }
  const d1 = path.join(web, ".wrangler/state/v3/d1")
  if (fs.existsSync(d1)) {
    const backup = path.join(ROOT, "backups", `d1-${new Date().toISOString().replace(/[:.]/g, "-")}`)
    fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 })
    fs.cpSync(d1, path.join(backup, "d1"), { recursive: true })
    log(`Backed up the local database to ${path.relative(ROOT, backup)}`)
  }
  run("Migrating the local database", process.execPath, [wrangler, "d1", "migrations", "apply", ...localArgs], { cwd: web, env })
}

async function main(argv) {
  const flags = new Set(argv)
  for (const flag of flags) if (!["--full", "--stash", "--relaunch"].includes(flag)) fail(`Unknown option ${flag}. Use --full, --stash or --relaunch.`)

  const branch = git("rev-parse", "--abbrev-ref", "HEAD")
  if (branch !== BRANCH) fail(`You're on branch "${branch}". Switch with \`git switch ${BRANCH}\`, then run the update again.`)

  const { lockfiles, edits } = classifyChanges(execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: ROOT, encoding: "utf8" }))
  if (edits.length && !flags.has("--stash")) {
    fail(`You have local edits that an update could overwrite:\n  ${edits.join("\n  ")}\nCommit them, or run \`npm run update -- --stash\` to set them aside (restore later with \`git stash pop\`).`)
  }

  log(`Checking ${BRANCH} on GitHub…`)
  run("Fetching", "git", ["fetch", "--quiet", "origin", BRANCH])
  const before = git("rev-parse", "HEAD")
  const target = git("rev-parse", `origin/${BRANCH}`)
  const behind = Number(git("rev-list", "--count", `HEAD..origin/${BRANCH}`))
  const ahead = Number(git("rev-list", "--count", `origin/${BRANCH}..HEAD`))
  if (ahead > 0) fail(`Your ${BRANCH} has ${ahead} commit(s) that aren't on GitHub. Push or rebase them first; the update only fast-forwards.`)
  // A failed update leaves this marker so the next run finishes every step.
  const marker = path.join(git("rev-parse", "--absolute-git-dir"), "snip-update-incomplete") // .git is a file in worktrees
  const resume = fs.existsSync(marker)
  if (resume) log("Finishing the previous update that didn't complete")
  if (!behind && !resume && !flags.has("--full")) { log(`Snip is up to date (${before.slice(0, 7)}).`); return }

  const wasRunning = appRunning()
  if (wasRunning) await quitApp()
  if (terminalServices()) {
    fail(`A terminal \`npm run dev\` or \`npm run capture\` is still running and using the database. Stop it (Ctrl-C), then run \`npm run update\` again. Nothing was changed.${wasRunning ? " Snip.app was quit; reopen it if you need it now." : ""}`)
  }

  if (lockfiles.length) { log(`Resetting npm lockfile churn: ${lockfiles.join(", ")}`); git("checkout", "--", ...lockfiles) }
  if (edits.length) { git("stash", "push", "--message", `snip-update ${new Date().toISOString()}`); log("Stashed your local edits. Restore them with `git stash pop`.") }

  if (behind) {
    console.log(git("log", "--oneline", "--no-decorate", `HEAD..${target}`).split("\n").map(line => `    ${line}`).join("\n"))
    run(`Updating to ${target.slice(0, 7)} (${behind} new commit${behind === 1 ? "" : "s"})`, "git", ["merge", "--ff-only", "--quiet", target])
  }
  const changed = behind ? git("diff", "--name-only", before, target).split("\n").filter(Boolean) : []
  const steps = planSteps(changed, { full: flags.has("--full") || resume })
  fs.writeFileSync(marker, `${new Date().toISOString()}\n`)
  if (!fs.existsSync(path.join(ROOT, "node_modules"))) steps.install = true

  if (steps.install) npm("Installing dependencies (npm ci)", ["ci", "--no-audit", "--no-fund"])
  if (steps.browser) run("Installing the capture browser", process.execPath, [path.join(ROOT, "node_modules/playwright/cli.js"), "install", "chromium"], { cwd: path.join(ROOT, "capture") })
  if (steps.migrate) migrate()
  if (steps.buildWeb) npm("Building the web app", ["run", "build", "-w", "web"])
  // Cloud mode: the hosted Worker runs the same bundle, so it must be migrated
  // and redeployed before the new capture protocol starts. Migrations are
  // additive, so an old Worker with the new schema is safe; the reverse is not.
  if (steps.buildWeb && cloudMode()) {
    run("Deploying the cloud Worker", process.execPath, [path.join(ROOT, "desktop/provision/cli.cjs"), "deploy", "--root", ROOT, "--data-root", ROOT, "--json"], { cwd: ROOT })
  }
  const app = mac && installedApp()
  if (app && steps.rebuildApp) {
    npm("Installing Snip.app dependencies", ["ci", "--prefix", "desktop", "--no-audit", "--no-fund"])
    npm("Rebuilding Snip.app", ["run", "build", "--prefix", "desktop"])
  }

  fs.rmSync(marker, { force: true })
  console.log(`\n\x1b[32m✓\x1b[0m Snip is updated to ${git("rev-parse", "--short", "HEAD")}.`)
  if (app && (wasRunning || flags.has("--relaunch"))) {
    log("Reopening Snip.app")
    spawnSync("open", ["-b", APP_ID], { stdio: "inherit" })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main(process.argv.slice(2))
