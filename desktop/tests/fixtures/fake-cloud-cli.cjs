// Stand-in for desktop/provision/cli.cjs while the engine is built in parallel.
// It speaks the same NDJSON contract (proposals/cloud-contracts.md §1) and writes
// the same cloud.json, so the Electron path and the Settings UI can be driven
// end-to-end without Cloudflare. Enable it with SNIP_CLOUD_ENGINE=<this file>.
const fs = require("node:fs")
const path = require("node:path")
const SYNTHETIC = require("./synthetic.cjs")

const argv = process.argv.slice(2)
const command = argv[0] ?? "setup"
const flag = name => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? argv[index + 1] : undefined
}
const dataRoot = flag("data-root") ?? path.resolve(__dirname, "../../..")
const delay = Math.max(0, Number(process.env.SNIP_FAKE_DELAY ?? 40))
const now = () => new Date().toISOString()
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let cancelled = false
process.on("SIGINT", () => {
  cancelled = true
})

const CLOUD_URL = process.env.SNIP_FAKE_URL || "https://snip.max.workers.dev"

const emit = value => {
  process.stdout.write(`${JSON.stringify({ v: 1, ...value })}\n`)
}

// Synthetic test values: all zeros with a small tag, so a fixture id can never be
// mistaken for a real account, database, namespace or library. See synthetic.cjs.
const paths = { dir: path.join(dataRoot, ".snip"), state: path.join(dataRoot, ".snip", "cloud.json") }
function readState() {
  try {
    return JSON.parse(fs.readFileSync(paths.state, "utf8"))
  } catch {
    return { version: 1, mode: "local", library: { id: SYNTHETIC.LIBRARY_ID }, cloud: null, snapshot: null, steps: [], error: null }
  }
}
function writeState(state) {
  fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 })
  const temp = path.join(paths.dir, `.cloud-${process.pid}.tmp`)
  const fd = fs.openSync(temp, "wx", 0o600)
  try {
    fs.writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(temp, paths.state)
}

const SETUP_STEPS = [
  ["preflight", "Check this Mac"],
  ["cloudflare-auth", "Sign in to Cloudflare"],
  ["account", "Choose a Cloudflare account"],
  ["url", "Find your workers.dev address"],
  ["r2", "Check R2 storage"],
  // guard classifies before any mutation (contracts v3.10 §1.5).
  ["guard", "Check this account has no other Snip"],
  ["resources", "Create the database and bucket"],
  ["config", "Write the cloud configuration"],
  ["schema", "Apply the database schema"],
  ["deploy", "Deploy your Snip"],
  ["secrets", "Set the cloud secrets"],
  ["quiesce", "Pause captures"],
  // The local server stops first; export starts its own Worker on the quiescent dir.
  ["release", "Stop the local server"],
  ["export", "Read this Mac's library"],
  ["import", "Copy the library to Cloudflare"],
  ["verify", "Check every reference arrived"],
  ["owner", "Sign this Mac in"],
  ["finish", "Switch Snip to your cloud library"],
]
const PULL_STEPS = [
  ["pull-preflight", "Check this Mac"],
  ["pull-manifest", "Read the cloud library"],
  ["pull-d1", "Download the database"],
  ["pull-stage", "Prepare a local copy"],
  ["pull-files", "Download screenshots"],
  ["pull-verify", "Check every reference arrived"],
  ["pull-swap", "Switch Snip to this Mac"],
  ["pull-finish", "Retry captures"],
]

async function step(id, message, work) {
  emit({ event: "step", command, step: id, status: "started", message })
  await sleep(delay)
  const started = Date.now()
  const result = await work?.()
  if (cancelled) return false
  emit({ event: "step", step: id, status: result?.status ?? "ok", message: result?.message ?? message, data: result?.data, progress: { done: 1, total: 1 }, at: now(), durationMs: Date.now() - started })
  return true
}
async function human(id, action, url, message) {
  emit({ event: "human", step: id, action, url, message })
  await sleep(delay * 5)
  return !cancelled
}
async function progress(id, message, current, total, unit) {
  emit({ event: "progress", step: id, message, current, total, unit })
  await sleep(Math.max(1, delay))
}
const skip = id => emit({ event: "step", command, step: id, status: "skipped", message: "Nothing to copy", at: now() })

function saveStep(state, id, status, detail = "") {
  const existing = state.steps.find(entry => entry.id === id)
  if (existing) Object.assign(existing, { status, at: now(), detail })
  else state.steps.push({ id, status, at: now(), detail })
}

async function setup() {
  const state = readState()
  const empty = !!state.empty
  state.mode = "enabling"
  state.error = null
  state.steps = []
  writeState(state)

  for (const [id, title] of SETUP_STEPS) {
    if (cancelled) break
    if (id === "cloudflare-auth") {
      if (!(await human(id, "open_url", "https://dash.cloudflare.com/oauth2/auth", "Approve Snip in your browser"))) break
      await step(id, title)
      continue
    }
    if (id === "r2") {
      if (!(await human(id, "enable_r2", "https://dash.cloudflare.com/?to=/:account/r2/overview", "Turn on R2 to store screenshots"))) break
      await step(id, title)
      continue
    }
    if (id === "owner") {
      if (!(await human(id, "open_url", "https://snip.max.workers.dev/auth/owner?t=fake", "Finish signing in"))) break
      emit({ event: "session", token: "fake-session-token", url: CLOUD_URL })
      await step(id, title)
      continue
    }
    if (empty && ["quiesce", "release", "export", "import", "verify"].includes(id)) {
      skip(id)
      continue
    }
    if (id === "export" || id === "import") {
      emit({ event: "step", command, step: id, status: "started", message: title, at: now() })
      for (let done = 200; done <= 800; done += 200) {
        if (cancelled) break
        await progress(id, title, done, id === "export" ? 800 : 812, "MB")
      }
      if (cancelled) break
      emit({ event: "step", step: id, status: "ok", message: title, at: now() })
      saveStep(state, id, "done", title)
      writeState(state)
      continue
    }
    if (!(await step(id, title))) break
    saveStep(state, id, "done", title)
    if (id === "secrets" || id === "deploy") {
      state.cloud = {
        url: flag("domain") ? `https://${flag("domain")}` : CLOUD_URL,
        accountId: flag("account") ?? SYNTHETIC.ACCOUNT_ID,
        workerName: "snip",
        d1: { name: "snip", id: SYNTHETIC.DATABASE_ID },
        kv: { name: "OAUTH_KV", id: SYNTHETIC.NAMESPACE_ID },
        bucket: "snip-files",
        ownerId: "max",
        detachedAt: null,
        lastDeployedAt: now(),
        lastVerifiedAt: now(),
      }
    }
    if (id === "verify" && !empty) {
      // The local library was never copied; it stays where it is (contracts §1.11).
      state.snapshot = {
        kind: "live", path: null, keptLocal: true, takenAt: now(), refs: 42, files: 311, bytes: 812000000,
        export: { path: "backups/cloud-export-2026-11-06T10-12-00", takenAt: now(), refs: 42, files: 311, bytes: 812000000 },
      }
      state.transfer = { tables: { refs: 42, pages: 311 }, keys: 311, bytes: 812000000, verifiedAt: now() }
    }
    writeState(state)
  }

  if (cancelled) {
    state.mode = "enabling"
    writeState(state)
    emit({ event: "result", ok: false, code: "CANCELLED", mode: "enabling" })
    process.exitCode = 1
    return
  }
  state.mode = "cloud"
  state.error = null
  state.move = { status: empty ? "empty" : "completed", reason: null, at: now() }
  saveStep(state, "finish", "done", "Switched to cloud")
  writeState(state)
  // The real `finish` writes the capture env the app points SNIP_CAPTURE_ENV_FILE at.
  const capture = path.join(dataRoot, "capture")
  fs.mkdirSync(capture, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(capture, ".env.cloud"), `SNIP_URL=${state.cloud.url}\nCAPTURE_TOKEN=fake-capture-token\n`, { mode: 0o600 })
  emit({ event: "result", ok: true, code: "OK", mode: "cloud", data: { url: state.cloud.url, refs: empty ? 0 : 42, files: empty ? 0 : 311, bytes: empty ? 0 : 812000000 } })
}

async function pull() {
  const state = readState()
  state.mode = "disabling"
  writeState(state)
  for (const [id, title] of PULL_STEPS) {
    if (cancelled) break
    if (id === "pull-files") {
      emit({ event: "step", command, step: id, status: "started", message: title, at: now() })
      for (let done = 100; done <= 311; done += 100) {
        if (cancelled) break
        await progress(id, title, done, 311, "files")
      }
      emit({ event: "step", step: id, status: "ok", message: title, at: now() })
      continue
    }
    if (!(await step(id, title))) break
  }
  if (cancelled) {
    emit({ event: "result", ok: false, code: "CANCELLED", mode: "disabling" })
    process.exitCode = 1
    return
  }
  state.mode = "local"
  state.cloud = null
  state.error = null
  writeState(state)
  emit({ event: "result", ok: true, code: "OK", mode: "local", data: {} })
}

async function detach() {
  const state = readState()
  for (const [id, title] of [["detach-preflight", "Check this Mac"], ["detach-finish", "Switch back to this Mac"]]) {
    if (!(await step(id, title, undefined))) break
  }
  state.mode = "local"
  state.error = null
  if (state.cloud) state.cloud.detachedAt = now()
  writeState(state)
  emit({ event: "result", ok: true, code: "OK", mode: "local", data: {} })
}

async function deleteResources() {
  const state = readState()
  const host = (() => { try { return new URL(state.cloud?.url).host } catch { return null } })()
  if (!host || flag("confirm") !== host) {
    emit({ event: "step", command, step: "delete-preflight", status: "failed", message: "The address doesn't match", at: now() })
    emit({ event: "result", ok: false, code: "FAILED", mode: state.mode })
    process.exitCode = 1
    return
  }
  for (const [id, title] of [["delete-preflight", "Check the cloud copy"], ["delete-execute", "Delete the Worker, database and files"], ["delete-verify", "Confirm it's gone"]]) {
    if (!(await step(id, title, undefined))) break
  }
  state.mode = "local"
  state.cloud = null
  state.transfer = null
  state.error = null
  writeState(state)
  emit({ event: "result", ok: true, code: "OK", mode: "local", data: {} })
}

async function snapshot() {
  const action = ["delete", "delete-export"].includes(argv[1]) ? argv[1] : "restore"
  const state = readState()
  // delete and delete-export carry a basename interlock (contracts v3.13 §1.11).
  const target = action === "delete" ? state.snapshot?.path : action === "delete-export" ? state.snapshot?.export?.path : null
  const expected = target ? path.basename(String(target).replace(/[\\/]+$/, "")) : null
  if (action !== "restore") {
    if (!flag("confirm")) {
      emit({ event: "needs_input", keys: [{ key: "confirm", label: "Confirm the item to delete", secret: false }] })
      emit({ event: "result", ok: false, code: "NEEDS_INPUT", mode: state.mode, data: { needs: "confirm" } })
      process.exitCode = 2
      return
    }
    if (!expected || flag("confirm") !== expected) {
      emit({ event: "result", ok: false, code: "FAILED", mode: state.mode, data: { code: "CONFIRM_MISMATCH", message: "This item changed. Refresh and try again." } })
      process.exitCode = 1
      return
    }
  }
  if (action === "restore" && state.snapshot?.kind !== "backup") {
    emit({ event: "step", command, step: "snapshot-preflight", status: "failed", message: "Your library is still on this Mac. Use Switch back to it.", at: now() })
    emit({ event: "result", ok: false, code: "FAILED", mode: state.mode, data: { code: "KEPT_LOCAL" } })
    process.exitCode = 1
    return
  }
  if (action === "delete" && state.snapshot?.kind !== "backup") {
    emit({ event: "result", ok: false, code: "UNSUPPORTED", mode: state.mode, data: { code: "CANNOT_DELETE_LOCAL" } })
    process.exitCode = 4
    return
  }
  const steps = [
    ["snapshot-preflight", "Check the snapshot"],
    [`snapshot-${action === "delete-export" ? "delete-export" : action}`, action === "restore" ? "Switch back to the previous library" : action === "delete" ? "Delete the previous library" : "Delete the export"],
    ["snapshot-finish", "Finish"],
  ]
  for (const [id, title] of steps) {
    if (!(await step(id, title))) break
  }
  if (action === "delete") state.snapshot = null
  if (action === "delete-export" && state.snapshot) state.snapshot.export = null
  if (action === "restore") state.snapshot = { kind: "backup", path: "backups/replaced-previous", takenAt: now(), refs: 42, files: 311, bytes: 812000000, keptLocal: false, export: null }
  state.mode = "local"
  state.error = null
  writeState(state)
  emit({ event: "result", ok: true, code: "OK", mode: "local", data: {} })
}

async function abort() {
  const state = readState()
  if (state.mode !== "enabling") {
    emit({ event: "result", ok: false, code: "UNSUPPORTED", mode: state.mode })
    process.exitCode = 4
    return
  }
  for (const [id, title] of [["abort-preflight", "Check the unfinished setup"], ["abort-cleanup", "Remove what it created"]]) {
    if (!(await step(id, title, undefined))) break
  }
  state.mode = "local"
  state.cloud = null
  state.snapshot = null
  state.error = null
  state.steps = []
  writeState(state)
  emit({ event: "result", ok: true, code: "OK", mode: "local", data: {} })
}

async function owner() {
  const action = argv[1] === "rotate" ? "rotate" : "link"
  // `--no-handoff` is what the app passes on every invocation; anything else would
  // make the link useless on the device that opens it.
  if (!argv.includes("--no-handoff")) {
    emit({ event: "result", ok: false, code: "FAILED", mode: readState().mode, data: { code: "HANDOFF_REQUIRED" } })
    process.exitCode = 1
    return
  }
  const state = readState()
  if (!state.cloud?.url) {
    emit({ event: "step", command, step: "owner-preflight", status: "failed", message: "This Mac holds no owner secret for its cloud library.", at: now() })
    emit({ event: "result", ok: false, code: "FAILED", mode: state.mode, data: { code: "SECRET_MISSING" } })
    process.exitCode = 1
    return
  }
  if (action === "rotate") {
    if (!(await step("owner-rotate", "Rotating the owner secret"))) return
  }
  if (!(await step("owner-preflight", "Checking the cloud library", () => ({ message: state.cloud.url })))) return
  const minted = { link: `${state.cloud.url.replace(/\/+$/, "")}/auth/owner?t=fake.${"a".repeat(43)}` }
  // The mint's event data nests what the step returned, exactly like the real engine.
  if (!(await step("owner-mint", "Creating a sign-in link", () => ({ message: "Link ready", data: { url: minted.link } })))) return
  emit({ event: "human", step: "owner-open", action: "open_url", url: minted.link, message: "Sign in to your Snip in the browser" })
  // With `--no-handoff` the run is over once the link exists: a device cannot be
  // observed from here, so it reports the link as ready rather than as a sign-in.
  if (!(await step("owner-open", "Link ready", () => ({ message: "Link ready; open it in the browser to sign this device in" })))) return
  emit({ event: "result", ok: true, code: "OK", mode: state.mode, data: { url: minted.link, cloudUrl: state.cloud.url } })
}

async function main() {
  if (command === "status") {
    emit({ event: "result", ok: true, code: "OK", mode: readState().mode, data: readState() })
    return
  }
  if (command === "setup") await setup()
  else if (command === "pull") await pull()
  else if (command === "detach") await detach()
  else if (command === "delete-resources") await deleteResources()
  else if (command === "snapshot") await snapshot()
  else if (command === "abort") await abort()
  else if (command === "owner") await owner()
  else {
    emit({ event: "result", ok: false, code: "UNSUPPORTED", mode: "local" })
    process.exitCode = 4
  }
}

main().catch(error => {
  emit({ event: "log", level: "error", message: error.message })
  emit({ event: "result", ok: false, code: "FAILED", mode: "local" })
  process.exitCode = 1
})
