import { test } from "node:test"
import assert from "node:assert/strict"
import { diagnoseCaptureError } from "../shared/capture-errors"

test("known capture errors get a plain-language diagnosis", () => {
  assert.match(diagnoseCaptureError("browserType.launch: Executable doesn't exist at /Users/x/chrome-headless-shell")!.fix, /installs the browser/)
  assert.match(diagnoseCaptureError("page.goto: net::ERR_NAME_NOT_RESOLVED at https://nope.example")!.summary, /address/)
  assert.match(diagnoseCaptureError("page.goto: Timeout 45000ms exceeded.")!.summary, /in time/)
  assert.match(diagnoseCaptureError("Target page, context or browser has been closed")!.fix, /fresh browser/)
  assert.match(diagnoseCaptureError("Browser install failed: Error: Download failed")!.fix, /connection/)
  assert.equal(diagnoseCaptureError("Something new"), null)
  assert.equal(diagnoseCaptureError(null), null)
})
