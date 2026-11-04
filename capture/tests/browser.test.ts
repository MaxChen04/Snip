import { test } from "node:test"
import assert from "node:assert/strict"
import { isMissingBrowser, launchWithRepair } from "../src/browser"

const missing = new Error("browserType.launch: Executable doesn't exist at /Users/x/Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell")

test("a missing browser is installed once, then launch is retried", async () => {
  let launches = 0, installs = 0, notified = 0
  const browser = await launchWithRepair({
    launch: async () => { if (launches++ === 0) throw missing; return "browser" },
    install: async () => { installs++ },
    canInstall: true,
    onInstall: () => { notified++ },
  })
  assert.equal(browser, "browser")
  assert.deepEqual([launches, installs, notified], [2, 1, 1])
})

test("other launch errors, and bundled browsers, are not repaired", async () => {
  let installs = 0
  const install = async () => { installs++ }
  await assert.rejects(launchWithRepair({ launch: async () => { throw new Error("spawn EACCES") }, install, canInstall: true }), /EACCES/)
  await assert.rejects(launchWithRepair({ launch: async () => { throw missing }, install, canInstall: false }), /Executable doesn't exist/)
  assert.equal(installs, 0)
  assert.ok(isMissingBrowser(missing))
})

test("a browser that still fails after installing reports the real error", async () => {
  await assert.rejects(launchWithRepair({ launch: async () => { throw missing }, install: async () => {}, canInstall: true }), /Executable doesn't exist/)
  await assert.rejects(launchWithRepair({ launch: async () => { throw missing }, install: async () => { throw new Error("Browser install failed (exit 1)") }, canInstall: true }), /install failed/)
})
