// v1 signs in with passkeys only. Settings is the window a person uses to set up
// access, so it must never offer GitHub: an install that already has GitHub keeps
// signing in, but nothing here sets it up or advertises it.
//
// The prompt text is shared with the MCP prompts (web/shared/cloud-prompts.ts) and is
// not part of this rule; only the Settings screens are.
const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const settingsDir = path.join(__dirname, "../../web/src/settings")
const screens = ["settings-app.tsx", "dialogs.tsx", "bits.tsx"]
const read = file => fs.readFileSync(path.join(settingsDir, file), "utf8")

test("the Settings screens never offer or advertise GitHub sign-in", () => {
  for (const file of screens) {
    const source = read(file)
    assert.equal(/github/i.test(source), false, `${file} mentions GitHub; v1 is passkeys only`)
    assert.equal(/github/i.test(file), false)
  }
})

test("the Settings screens spell passkeys as the browser sign-in path", () => {
  const app = read("settings-app.tsx")
  assert.match(app, /Other browsers use a passkey/)
  assert.match(app, /passkeys/i)
})

test("the owner is shown only when the Worker reports it", () => {
  const app = read("settings-app.tsx")
  // Reading the owner is what the cloud-status check is for now; a missing or
  // unreachable status must not produce "Signed in as undefined".
  assert.match(app, /Signed in as \$\{cloud\.snapshot\.cloudStatus\.ownerId\}/)
  assert.match(app, /This Mac signed in through an owner link/)
})
