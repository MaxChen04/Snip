// The mode lives in cloud.json, which the engine writes. These tests pin the readings
// the app depends on: a missing file means local, a broken one is unreadable and never
// a crash, and the capture env choice follows the mode.
const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const {
  cloudPaths,
  normalizeCloudState,
  readCloudState,
  cloudMode,
  usesCloud,
  modePlan,
  modeServices,
  cloudModeFor,
  captureEnvFiles,
  selectCaptureEnvFile,
  keepLocalCaptureEnv,
  formatBytes,
  describeSnapshot,
} = require("../cloud-state.cjs")

function library(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snip-cloud-state-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
function write(root, body) {
  fs.mkdirSync(path.join(root, ".snip"), { recursive: true })
  fs.writeFileSync(path.join(root, ".snip", "cloud.json"), typeof body === "string" ? body : JSON.stringify(body))
}

test("a missing cloud.json is a local library", t => {
  const root = library(t)
  assert.equal(readCloudState(root), null)
  assert.equal(cloudMode(null), "local")
  assert.equal(usesCloud(null), false)
})

test("modes other than the four known values fall back to local", () => {
  assert.equal(cloudMode(normalizeCloudState({ mode: "cloud" })), "cloud")
  assert.equal(cloudMode(normalizeCloudState({ mode: "enabling" })), "enabling")
  assert.equal(cloudMode(normalizeCloudState({ mode: "self-destruct" })), "local")
  assert.equal(cloudMode(normalizeCloudState({})), "local")
  assert.equal(normalizeCloudState("nope"), null)
})

test("cloud mode needs a usable cloud url", () => {
  const state = normalizeCloudState({ mode: "cloud", cloud: { url: "https://snip.max.workers.dev" } })
  assert.equal(usesCloud(state), true)
  assert.equal(usesCloud(normalizeCloudState({ mode: "cloud", cloud: null })), false)
  assert.equal(usesCloud(normalizeCloudState({ mode: "enabling", cloud: { url: "https://snip.max.workers.dev" } })), false)
})

test("unknown fields and step order survive normalization", () => {
  const raw = {
    version: 1,
    mode: "cloud",
    futureThing: { keep: true },
    cloud: { url: "https://snip.max.workers.dev", accountId: "abc", newField: 1 },
    steps: [{ id: "deploy", status: "done", at: "2026-11-06T10:12:00Z" }, { id: "import", status: "made-up" }, { nope: true }],
    error: null,
  }
  const state = normalizeCloudState(raw)
  assert.deepEqual(state.futureThing, { keep: true })
  assert.equal(state.cloud.url, "https://snip.max.workers.dev")
  assert.equal(state.steps.length, 2)
  assert.equal(state.steps[1].status, "pending")
})

test("readCloudState rejects corrupt and oversized files instead of throwing", t => {
  const root = library(t)
  write(root, "{not json")
  assert.equal(readCloudState(root), null)
  write(root, { mode: "cloud", cloud: { url: "https://snip.max.workers.dev" } })
  assert.equal(cloudMode(readCloudState(root)), "cloud")
  write(root, JSON.stringify({ mode: "local", padding: "x".repeat(600_000) }))
  assert.equal(readCloudState(root), null)
})

test("the capture agent follows the mode through SNIP_CAPTURE_ENV_FILE", t => {
  const root = library(t)
  fs.mkdirSync(path.join(root, "capture"))
  const files = captureEnvFiles(root)
  assert.equal(path.basename(files.default), ".env")
  assert.equal(path.basename(files.local), ".env.local")
  assert.equal(path.basename(files.cloud), ".env.cloud")

  // Nothing but .env exists yet: both modes use it.
  assert.equal(selectCaptureEnvFile({ dataRoot: root, mode: "local" }).name, ".env")
  assert.equal(selectCaptureEnvFile({ dataRoot: root, mode: "cloud" }).name, ".env")

  fs.writeFileSync(files.local, "SNIP_URL=http://localhost:5173\n")
  fs.writeFileSync(files.cloud, "SNIP_URL=https://snip.max.workers.dev\n")
  assert.equal(selectCaptureEnvFile({ dataRoot: root, mode: "local" }).name, ".env.local")
  assert.equal(selectCaptureEnvFile({ dataRoot: root, mode: "cloud" }).name, ".env.cloud")
  assert.equal(selectCaptureEnvFile({ dataRoot: root, mode: "enabling" }).name, ".env.local")
})

test("keepLocalCaptureEnv copies .env once and never overwrites", t => {
  const root = library(t)
  const capture = path.join(root, "capture")
  fs.mkdirSync(capture)
  fs.writeFileSync(path.join(capture, ".env"), "SNIP_URL=http://localhost:5173\nCAPTURE_TOKEN=local\n", { mode: 0o644 })

  assert.equal(keepLocalCaptureEnv({ dataRoot: root }), true)
  const local = path.join(capture, ".env.local")
  assert.equal(fs.readFileSync(local, "utf8"), "SNIP_URL=http://localhost:5173\nCAPTURE_TOKEN=local\n")
  assert.equal(fs.statSync(local).mode & 0o777, 0o600)

  fs.writeFileSync(local, "edited\n")
  assert.equal(keepLocalCaptureEnv({ dataRoot: root }), false)
  assert.equal(fs.readFileSync(local, "utf8"), "edited\n")
})

test("keepLocalCaptureEnv does nothing without a live .env", t => {
  const root = library(t)
  assert.equal(keepLocalCaptureEnv({ dataRoot: root }), false)
})

test("snapshot and size copy use the engine's numbers", () => {
  assert.equal(formatBytes(812_000_000), "812 MB")
  assert.equal(formatBytes(999), "999 B")
  assert.equal(formatBytes(1_500_000_000_000), "1.5 TB")
  assert.equal(formatBytes(null), null)
  // A local-time value: the label shows this Mac's clock, not UTC.
  assert.equal(
    describeSnapshot({ takenAt: "2026-11-06T10:12:00", bytes: 812_000_000 }, "en-GB"),
    "Snapshot from 6 Nov, 10:12 — 812 MB",
  )
  assert.equal(describeSnapshot(null), null)
})

test("a live snapshot is this Mac's library, a backup is a real second copy", () => {
  // kind is explicit; path is only meaningful for a backup (contracts §1.11).
  const live = normalizeCloudState({ mode: "cloud", cloud: { url: "https://snip.max.workers.dev" }, snapshot: { kind: "live", path: "backups/cloud-move-x", refs: 42 } }).snapshot
  assert.equal(live.kind, "live")
  assert.equal(live.path, null)
  assert.equal(live.keptLocal, true)

  const backup = normalizeCloudState({ mode: "cloud", snapshot: { kind: "backup", path: "backups/replaced-2026-11-06T10-12-00", refs: 42 } }).snapshot
  assert.equal(backup.kind, "backup")
  assert.equal(backup.path, "backups/replaced-2026-11-06T10-12-00")
  assert.equal(backup.keptLocal, false)

  // An older engine that only set keptLocal is read as live, never as a backup.
  const legacy = normalizeCloudState({ snapshot: { path: null, keptLocal: true } }).snapshot
  assert.equal(legacy.kind, "live")
  // Unknown shapes cannot be restored or deleted from the UI.
  assert.equal(normalizeCloudState({ snapshot: { refs: 3 } }).snapshot.kind, null)
})

test("the setup export is normalizeable and stays delete-only", () => {
  const state = normalizeCloudState({
    mode: "cloud",
    snapshot: { kind: "live", path: null, refs: 42, export: { path: "backups/cloud-export-2026-11-06T10-12-00", takenAt: "2026-11-06T10:12:00Z", refs: 42, files: 311, bytes: 812000000 } },
  })
  assert.equal(state.snapshot.export.refs, 42)
  assert.equal(state.snapshot.export.bytes, 812000000)
  assert.equal(state.snapshot.path, null)
})

test("cloud paths stay inside .snip", t => {
  const root = library(t)
  const paths = cloudPaths(root)
  assert.equal(paths.state, path.join(root, ".snip", "cloud.json"))
  assert.equal(paths.lock, path.join(root, ".snip", "cloud.lock"))
})

test("a finished run is followed by whatever the recorded mode needs, whatever the result", () => {
  // A failed or cancelled local run: the engine stopped captures or the Worker, and both come back.
  assert.deepEqual(modePlan({ mode: "local", applied: "local", webRunning: false }), { kind: "local", stopCapture: false, stopWeb: false, recreateWindow: false, start: ["web", "capture"] })
  assert.deepEqual(modePlan({ mode: "enabling", applied: "local", webRunning: true }), { kind: "local", stopCapture: false, stopWeb: false, recreateWindow: false, start: ["web", "capture"] })
  // The mode moved, even under a failed result: capture changes destination and the window its origin.
  assert.deepEqual(modePlan({ mode: "cloud", applied: "local", webRunning: true }), { kind: "cloud", stopCapture: true, stopWeb: true, recreateWindow: true, start: ["capture"] })
  assert.deepEqual(modePlan({ mode: "local", applied: "cloud", webRunning: false }), { kind: "local", stopCapture: true, stopWeb: false, recreateWindow: true, start: ["web", "capture"] })
  // The local Worker never runs beside a cloud library.
  assert.deepEqual(modePlan({ mode: "cloud", applied: "cloud", webRunning: true }), { kind: "cloud", stopCapture: false, stopWeb: true, recreateWindow: false, start: ["capture"] })
})

test("an unreadable or unsupported record starts nothing and is never a local library", t => {
  assert.deepEqual(modeServices("unreadable"), [])
  assert.deepEqual(modeServices("cloud"), ["capture"])
  assert.deepEqual(modeServices("enabling"), ["web", "capture"])
  assert.deepEqual(modePlan({ mode: "unreadable", applied: "local", webRunning: true }), { kind: "unreadable", stopCapture: true, stopWeb: true, recreateWindow: true, start: [] })
  // The engine refuses any record version but 1 (provision/state.cjs); so does the app.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "snip-cloud-version-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, ".snip"))
  fs.writeFileSync(path.join(root, ".snip", "cloud.json"), JSON.stringify({ version: 2, mode: "local" }))
  assert.equal(cloudModeFor(root), "unreadable")
  fs.writeFileSync(path.join(root, ".snip", "cloud.json"), JSON.stringify({ version: 1, mode: "enabling" }))
  assert.equal(cloudModeFor(root), "enabling")
})

test("only the modes the engine writes are modes", () => {
  // Nothing ever wrote "disabling"; a record that claims it is read like any unknown mode.
  assert.equal(normalizeCloudState({ mode: "disabling" }).mode, "local")
})
