// The Settings progress list must render the engine's step order. A step out of order
// is a product bug here: `guard` has to classify the account before anything is created.
const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const source = fs.readFileSync(path.join(__dirname, "../../web/src/settings/steps.ts"), "utf8")

function order(command) {
  // Keys are bare where they are identifiers and quoted where they contain spaces.
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = source.match(new RegExp(`(?:^|\\n)\\s*"?${escaped}"?:\\s*\\[([^\\]]+)\\]`, "s"))
  assert.ok(match, `steps.ts has no ${command} order`)
  return [...match[1].matchAll(/"([^"]+)"/g)].map(entry => entry[1])
}

test("setup renders guard before resources (contracts v3.10 §1.5)", () => {
  const steps = order("setup")
  assert.deepEqual(steps, [
    "preflight", "cloudflare-auth", "account", "url", "r2", "guard", "resources", "config",
    "schema", "deploy", "secrets", "quiesce", "release", "export", "import", "verify", "owner", "finish",
  ])
  assert.ok(steps.indexOf("guard") < steps.indexOf("resources"))
  assert.ok(steps.indexOf("guard") < steps.indexOf("schema"))
  // The local server stops before the library is read (§1.8): export owns its own Worker.
  assert.ok(steps.indexOf("release") < steps.indexOf("export"))
  assert.ok(steps.indexOf("quiesce") < steps.indexOf("release"))
})

test("every command's order matches the published step ids", () => {
  assert.deepEqual(order("pull"), ["pull-preflight", "pull-manifest", "pull-d1", "pull-stage", "pull-files", "pull-verify", "pull-swap", "pull-finish"])
  assert.deepEqual(order("detach"), ["detach-preflight", "detach-finish"])
  assert.deepEqual(order("delete-resources"), ["delete-preflight", "delete-execute", "delete-verify"])
  assert.deepEqual(order("snapshot restore"), ["snapshot-preflight", "snapshot-restore", "snapshot-finish"])
  assert.deepEqual(order("snapshot delete"), ["snapshot-preflight", "snapshot-delete", "snapshot-finish"])
})

test("the fake engine runs the same order as the UI", () => {
  const fixture = fs.readFileSync(path.join(__dirname, "fixtures/fake-cloud-cli.cjs"), "utf8")
  const block = fixture.match(/const SETUP_STEPS = \[([\s\S]*?)\n\]/)
  assert.ok(block, "fixture has no SETUP_STEPS")
  const ids = [...block[1].matchAll(/\["([^"]+)"/g)].map(entry => entry[1])
  assert.deepEqual(ids, order("setup"))
})
