// The delete guards are a stale-record interlock, not a typed secret. A missing or
// path-shaped confirm must stop the run before anything is spawned.
const { test } = require("node:test")
const assert = require("node:assert/strict")
const { snapshotFlags, basename } = require("../cloud-confirm.cjs")

test("restore needs no confirm", () => {
  assert.deepEqual(snapshotFlags("restore"), { ok: true, flags: {} })
  assert.deepEqual(snapshotFlags("restore", undefined), { ok: true, flags: {} })
})

test("delete and delete-export require the rendered basename", () => {
  assert.deepEqual(snapshotFlags("delete", "replaced-2026-11-06T10-12-00"), { ok: true, flags: { confirm: "replaced-2026-11-06T10-12-00" } })
  assert.deepEqual(snapshotFlags("delete-export", "cloud-export-2026-11-06T10-12-00"), { ok: true, flags: { confirm: "cloud-export-2026-11-06T10-12-00" } })
})

test("a missing confirm spawns nothing", () => {
  for (const action of ["delete", "delete-export"]) {
    for (const confirm of [undefined, null, "", "   "]) {
      assert.deepEqual(snapshotFlags(action, confirm), { error: "confirm required", code: "CONFIRM_MISSING" })
    }
  }
})

test("a path is not a basename, so the engine's interlock would fail early", () => {
  for (const confirm of ["backups/replaced-x", "backups/", "/tmp/state", "..", "."]) {
    const reply = snapshotFlags("delete", confirm)
    assert.equal(reply.ok, undefined, confirm)
    assert.equal(reply.code, "CONFIRM_MISMATCH")
  }
})

test("unknown actions are refused", () => {
  assert.deepEqual(snapshotFlags("wipe", "x"), { error: "Unknown snapshot action.", code: "UNSUPPORTED" })
  assert.deepEqual(snapshotFlags(undefined, "x"), { error: "Unknown snapshot action.", code: "UNSUPPORTED" })
})

test("basename handles trailing slashes and both separators", () => {
  assert.equal(basename("backups/cloud-export-1/"), "cloud-export-1")
  assert.equal(basename("C:\\snip\\replaced-2"), "replaced-2")
  assert.equal(basename(""), "")
  assert.equal(basename(null), "")
})
