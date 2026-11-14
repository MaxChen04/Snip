// Recovery regression for desktop/cloud-state.cjs. Asserts the CORRECT behaviour, so it
// fails today and passes once the bug is fixed.
//
// readCloudState() must keep returning null for an unreadable file (cloud-state.test.cjs
// pins that), and cloudMode(null) is "local". So callers need a different door: this test
// is written against a new export, `cloudModeFor(dataRoot)`, which reads the file itself
// and answers:
//   "local"       there is no cloud.json (a library that never enabled cloud)
//   "unreadable"  cloud.json exists but cannot be trusted (corrupt JSON, oversized, not an
//                 object, not a regular file); callers must not open the local Worker as
//                 if the library were local
//   otherwise     the recorded mode ("cloud", "enabling", ...)
const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const cloudState = require("../cloud-state.cjs")

function library(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snip-cloud-state-recovery-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
function write(root, body) {
  fs.mkdirSync(path.join(root, ".snip"), { recursive: true })
  fs.writeFileSync(path.join(root, ".snip", "cloud.json"), typeof body === "string" ? body : JSON.stringify(body))
}

test("BUG 8: a corrupt cloud.json is distinguishable from a library that never enabled cloud", t => {
  assert.equal(typeof cloudState.cloudModeFor, "function", "cloud-state.cjs must export cloudModeFor(dataRoot) so callers can tell 'no file' from 'file present but unreadable'")
  const { cloudModeFor } = cloudState

  const fresh = library(t)
  assert.equal(cloudModeFor(fresh), "local", "no file is a local library")

  const good = library(t)
  write(good, { mode: "cloud", cloud: { url: "https://snip.max.workers.dev" } })
  assert.equal(cloudModeFor(good), "cloud")

  const truncated = library(t)
  write(truncated, '{"version":1,"mode":"cloud","cloud":{"url":"https://snip.max.work')
  assert.equal(cloudState.readCloudState(truncated), null, "the pinned behaviour of readCloudState is unchanged")
  assert.notEqual(cloudModeFor(truncated), "local", "a truncated cloud.json must not read as a local library")
  assert.equal(cloudModeFor(truncated), "unreadable")

  const oversized = library(t)
  write(oversized, JSON.stringify({ mode: "cloud", padding: "x".repeat(600_000) }))
  assert.equal(cloudModeFor(oversized), "unreadable", "an oversized cloud.json is unreadable, not local")

  const notAnObject = library(t)
  write(notAnObject, "[1, 2, 3]")
  assert.equal(cloudModeFor(notAnObject), "unreadable", "valid JSON that is not a state object is unreadable, not local")

  const directory = library(t)
  fs.mkdirSync(path.join(directory, ".snip", "cloud.json"), { recursive: true })
  assert.equal(cloudModeFor(directory), "unreadable", "a cloud.json that is not a regular file is unreadable, not local")
})
