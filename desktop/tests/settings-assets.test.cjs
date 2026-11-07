// The snip:// handler serves exactly the files in the built Settings bundle, nothing
// above it and nothing outside it.
const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { resolveSettingsAsset, contentType, settingsUrl, inside } = require("../settings-assets.cjs")

function bundle(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "snip-settings-assets-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, "assets"))
  fs.writeFileSync(path.join(root, "index.html"), "<!doctype html>")
  fs.writeFileSync(path.join(root, "assets", "settings.js"), "export {}")
  return root
}

test("the settings entry is index.html at the root", t => {
  const root = bundle(t)
  assert.equal(resolveSettingsAsset(root, "snip://settings/"), path.join(root, "index.html"))
  assert.equal(resolveSettingsAsset(root, "snip://settings/index.html"), path.join(root, "index.html"))
  assert.equal(settingsUrl(), "snip://settings/index.html")
  assert.equal(settingsUrl("?a=1"), "snip://settings/index.html?a=1")
})

test("assets resolve inside the bundle and anything else does not", t => {
  const root = bundle(t)
  assert.equal(resolveSettingsAsset(root, "snip://settings/assets/settings.js"), path.join(root, "assets", "settings.js"))
  assert.equal(resolveSettingsAsset(root, "snip://settings/missing.js"), null)
  assert.equal(resolveSettingsAsset(root, "snip://settings/%2e%2e/secret"), null)
  assert.equal(resolveSettingsAsset(root, "snip://settings/../package.json"), null)
  assert.equal(resolveSettingsAsset(root, "snip://other/index.html"), null)
  assert.equal(resolveSettingsAsset(root, "https://settings/index.html"), null)
  assert.equal(resolveSettingsAsset(root, "snip://settings/assets"), null)
  assert.equal(inside(root, path.join(root, "..")), false)
})

test("content types cover what a Vite bundle emits", () => {
  assert.match(contentType("index.html"), /^text\/html/)
  assert.match(contentType("settings.js"), /^text\/javascript/)
  assert.match(contentType("settings.css"), /^text\/css/)
  assert.equal(contentType("logo.png"), "image/png")
  assert.equal(contentType("inter.woff2"), "font/woff2")
  assert.equal(contentType("blob.bin"), "application/octet-stream")
})
