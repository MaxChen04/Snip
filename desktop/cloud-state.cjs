// Reads the engine's cloud.json and derives the app-level mode. Electron never
// writes this file: the provisioning engine owns it (see proposals/cloud-contracts.md §2).
const fs = require("node:fs")
const path = require("node:path")

const MODES = new Set(["local", "enabling", "cloud", "disabling"])
const STEP_STATES = new Set(["done", "failed", "skipped", "running", "waiting", "pending"])
const MAX_BYTES = 512 * 1024

function cloudPaths(dataRoot) {
  const snip = path.join(dataRoot, ".snip")
  return {
    dir: snip,
    state: path.join(snip, "cloud.json"),
    lock: path.join(snip, "cloud.lock"),
    secrets: path.join(snip, "cloud-secrets.bin"),
  }
}

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function text(value, limit = 500) {
  return typeof value === "string" && value.length <= limit ? value : null
}

function count(value) {
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : null
}

function normalizeCloud(raw) {
  if (!isObject(raw)) return null
  const url = text(raw.url, 2048)
  if (!url) return null
  return {
    url,
    accountId: text(raw.accountId, 128),
    workerName: text(raw.workerName, 64) ?? "snip",
    d1: isObject(raw.d1) ? head(raw.d1) : null,
    kv: isObject(raw.kv) ? head(raw.kv) : null,
    bucket: text(raw.bucket, 128),
    ownerId: text(raw.ownerId, 128),
    detachedAt: text(raw.detachedAt, 40),
    adoptedAt: text(raw.adoptedAt, 40),
    adoptedFrom: text(raw.adoptedFrom, 40),
    adoptedLibrary: isObject(raw.adoptedLibrary) ? { refs: count(raw.adoptedLibrary.refs), pages: count(raw.adoptedLibrary.pages), collections: count(raw.adoptedLibrary.collections) } : null,
    lastDeployedAt: text(raw.lastDeployedAt, 40),
    lastVerifiedAt: text(raw.lastVerifiedAt, 40),
    workerVersion: text(raw.workerVersion, 40),
    expectedWorkerVersion: text(raw.expectedWorkerVersion, 40),
  }
}

function head(raw) {
  const out = {}
  if (typeof raw.name === "string") out.name = raw.name.slice(0, 128)
  if (typeof raw.id === "string") out.id = raw.id.slice(0, 128)
  return out
}

/**
 * `kind: "live"` means this Mac's library itself: nothing was copied, so there is
 * nothing to restore and detach is the way back. `kind: "backup"` only exists after a
 * `pull` replaced a real local library, and that one can be switched back to.
 * `export` is setup's portable dump: delete-only, never restorable (contracts §1.11).
 */
function normalizeSnapshot(raw) {
  if (!isObject(raw)) return null
  const takenAt = text(raw.takenAt, 40)
  const at = takenAt ? Date.parse(takenAt) : NaN
  const kind = raw.kind === "backup" ? "backup" : raw.kind === "live" ? "live" : raw.keptLocal === true ? "live" : null
  const exported = isObject(raw.export) ? raw.export : null
  return {
    kind,
    path: kind === "backup" ? text(raw.path, 1024) : null,
    takenAt: Number.isFinite(at) ? takenAt : null,
    refs: count(raw.refs),
    files: count(raw.files),
    bytes: count(raw.bytes),
    keptLocal: kind === "live",
    export: exported
      ? { path: text(exported.path, 1024), takenAt: text(exported.takenAt, 40), refs: count(exported.refs), files: count(exported.files), bytes: count(exported.bytes) }
      : null,
  }
}

function normalizeMove(raw) {
  if (!isObject(raw)) return null
  return {
    status: ["completed", "empty", "skipped"].includes(raw.status) ? raw.status : null,
    reason: text(raw.reason, 64),
    at: text(raw.at, 40),
  }
}

function normalizeStep(raw) {
  if (!isObject(raw) || typeof raw.id !== "string" || !raw.id) return null
  return {
    id: raw.id.slice(0, 64),
    status: STEP_STATES.has(raw.status) ? raw.status : "pending",
    at: text(raw.at, 40),
    detail: text(raw.detail, 500),
  }
}

function normalizeError(raw) {
  if (!isObject(raw)) return null
  const message = text(raw.message, 1000)
  if (!message) return null
  return {
    step: text(raw.step, 64),
    code: text(raw.code, 64),
    message,
    hint: text(raw.hint, 1000),
    at: text(raw.at, 40),
  }
}

// Unknown fields survive so a newer engine can add data without this build dropping it.
function normalizeCloudState(raw) {
  if (!isObject(raw)) return null
  const mode = MODES.has(raw.mode) ? raw.mode : "local"
  const steps = Array.isArray(raw.steps) ? raw.steps.map(normalizeStep).filter(Boolean).slice(0, 64) : []
  return {
    ...raw,
    version: Number.isFinite(raw.version) ? raw.version : 1,
    mode,
    library: isObject(raw.library) && typeof raw.library.id === "string" ? { id: raw.library.id.slice(0, 64) } : raw.library ?? null,
    cloud: normalizeCloud(raw.cloud),
    snapshot: normalizeSnapshot(raw.snapshot),
    transfer: isObject(raw.transfer) ? raw.transfer : null,
    move: normalizeMove(raw.move),
    steps,
    error: normalizeError(raw.error),
  }
}

/** The cloud.json for a library, or null when the library has never enabled cloud. */
function readCloudState(dataRoot) {
  const file = cloudPaths(dataRoot).state
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    return null
  }
  if (!stat.isFile() || stat.size > MAX_BYTES) return null
  try {
    return normalizeCloudState(JSON.parse(fs.readFileSync(file, "utf8")))
  } catch {
    return null
  }
}

/** "local" for a fresh library. A stale lock never changes mode. */
function cloudMode(state) {
  return state && MODES.has(state.mode) ? state.mode : "local"
}

// The capture agent keeps one file per destination. Snip rewrites neither mid-capture:
// the engine writes `.env.cloud` during `finish`, and Snip copies `.env` to `.env.local`
// the first time the app enables cloud. `SNIP_CAPTURE_ENV_FILE` picks between them.
function captureEnvFiles(dataRoot, captureRoot) {
  const base = captureRoot ?? path.join(dataRoot, "capture")
  return { default: path.join(base, ".env"), local: path.join(base, ".env.local"), cloud: path.join(base, ".env.cloud") }
}

/**
 * The env file the capture child should load.
 * Cloud mode prefers `.env.cloud`; local mode prefers `.env.local` so a snapshot
 * keeps its original capture settings. Missing files fall back to `.env`.
 */
function selectCaptureEnvFile({ dataRoot, captureRoot, mode, exists = fs.existsSync }) {
  const files = captureEnvFiles(dataRoot, captureRoot)
  const preferred = mode === "cloud" ? files.cloud : files.local
  if (exists(preferred)) return { path: preferred, name: path.basename(preferred), fallback: false }
  return { path: files.default, name: path.basename(files.default), fallback: !exists(files.default) }
}

/** Copy the live capture env to `.env.local` before the cloud file takes over. */
function keepLocalCaptureEnv({ dataRoot, captureRoot, copy = fs.copyFileSync, exists = fs.existsSync }) {
  const files = captureEnvFiles(dataRoot, captureRoot)
  if (exists(files.local) || !exists(files.default)) return false
  copy(files.default, files.local, fs.constants.COPYFILE_EXCL)
  try {
    fs.chmodSync(files.local, 0o600)
  } catch {}
  return true
}

module.exports = {
  cloudPaths,
  normalizeCloudState,
  readCloudState,
  cloudMode,
  captureEnvFiles,
  selectCaptureEnvFile,
  keepLocalCaptureEnv,
}
