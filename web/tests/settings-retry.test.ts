// The engine reports `retryable` on every failure (contracts v3.23 §1.3), so the button
// Settings offers has to follow it rather than guessing from the code.
import { test } from "node:test"
import assert from "node:assert/strict"
import { errorAction } from "../src/settings/retry"

test("a transient Cloudflare failure offers Retry", () => {
  // The engine retried inside the step and gave up: the same command can still work.
  assert.equal(errorAction({ code: "CLOUDFLARE_TEMPORARY", retryable: true }), "retry")
})

test("a failure that says retryable: true offers Retry", () => {
  for (const code of ["NOT_AN_ACCOUNT", "LOCAL_SERVER_RUNNING", "TRANSFER_TOKEN_MISSING", "NEEDS_INPUT"]) {
    assert.equal(errorAction({ code, retryable: true }), "retry", code)
  }
})

test("a failure that says retryable: false offers nothing", () => {
  // Repeating cannot help, so a Retry button would be a lie.
  for (const code of ["NOT_A_LIBRARY", "NO_NODE", "NO_BUILD", "FOREIGN_SNIP", "IMPORT_FAILED", "CLOUDFLARE_TEMPORARY"]) {
    assert.equal(errorAction({ code, retryable: false }), "none", code)
  }
})

test("a stale record re-reads instead, whatever retryable says", () => {
  assert.equal(errorAction({ code: "CONFIRM_MISSING", retryable: true }), "refresh")
  assert.equal(errorAction({ code: "CONFIRM_MISMATCH", retryable: false }), "refresh")
})

test("a failure with no retryable field still offers Retry", () => {
  // An older engine omits it; hiding the only action would strand the person.
  assert.equal(errorAction({ code: "FAILED" }), "retry")
  assert.equal(errorAction({ code: null }), "retry")
})
