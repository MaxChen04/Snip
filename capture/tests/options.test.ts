import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { signedInState } from "../src/capture"

test("saved sign-in needs an existing STORAGE_STATE file", () => {
  assert.throws(() => signedInState({}), /STORAGE_STATE isn't set/)
  assert.throws(() => signedInState({ STORAGE_STATE: "/nope/auth.json" }), /doesn't exist/)
  const file = join(mkdtempSync(join(tmpdir(), "snip-")), "auth.json")
  writeFileSync(file, "{}")
  assert.equal(signedInState({ STORAGE_STATE: file }), file)
})
