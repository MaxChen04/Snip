import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { planSteps, classifyChanges, cloudMode, checkoutOf, usesCheckout } from "../../scripts/update.mjs"

test("only a dev server or capture agent in this checkout holds the update up", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "snip-update-services-")))
  try {
    const root = path.join(dir, "snip")
    const worktree = path.join(root, ".claude/worktrees/canvas")
    const other = path.join(dir, "elsewhere/snip")
    for (const d of [path.join(root, "web"), path.join(root, "capture"), path.join(worktree, "web"), path.join(other, "web"), path.join(dir, "Snip Dev.app/library/capture")]) fs.mkdirSync(d, { recursive: true })
    fs.mkdirSync(path.join(root, ".git"))
    fs.writeFileSync(path.join(worktree, ".git"), "gitdir: elsewhere\n") // a worktree's .git is a file
    fs.mkdirSync(path.join(other, ".git"))

    assert.equal(checkoutOf(path.join(root, "web")), root)
    assert.equal(usesCheckout(path.join(root, "web"), root), true, "npm run dev")
    assert.equal(usesCheckout(path.join(root, "capture"), root), true, "npm run capture")
    assert.equal(usesCheckout(root, root), true)
    assert.equal(usesCheckout(path.join(worktree, "web"), root), false, "a worktree inside the checkout has its own database")
    assert.equal(usesCheckout(path.join(other, "web"), root), false, "another checkout")
    assert.equal(usesCheckout(path.join(dir, "Snip Dev.app/library/capture"), root), false, "Snip Dev's own engine")
    assert.equal(usesCheckout(undefined, root), true, "a folder that can't be read counts as ours")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("only resets npm lockfile churn; other edits block the update", () => {
  const result = classifyChanges(" M package-lock.json\n M desktop/package-lock.json\n M web/src/App.tsx\nR  a.ts -> capture/b.ts\n")
  assert.deepEqual(result.lockfiles, ["package-lock.json", "desktop/package-lock.json"])
  assert.deepEqual(result.edits, ["web/src/App.tsx", "capture/b.ts"])
})

test("reinstalls for dependency changes and rebuilds Snip.app only for desktop changes", () => {
  assert.equal(planSteps(["web/src/App.tsx"]).install, false)
  assert.equal(planSteps(["capture/package.json"]).install, true)
  assert.equal(planSteps(["package-lock.json"]).install, true)
  assert.equal(planSteps(["desktop/package-lock.json"]).install, false)
  assert.equal(planSteps(["desktop/main.cjs"]).rebuildApp, true)
  assert.equal(planSteps(["desktop/tests/x.test.cjs"]).rebuildApp, false)
  const always = planSteps([])
  assert.deepEqual([always.browser, always.migrate, always.buildWeb], [true, true, true])
  assert.deepEqual(planSteps([], { full: true }), { install: true, browser: true, migrate: true, buildWeb: true, rebuildApp: true })
})

test("the cloud deploy runs only for a cloud install, and never on an unreadable journal", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "snip-update-cloud-"))
  try {
    assert.equal(cloudMode(root), false, "no journal means local")
    fs.mkdirSync(path.join(root, ".snip"), { recursive: true })
    const file = path.join(root, ".snip/cloud.json")
    fs.writeFileSync(file, JSON.stringify({ version: 1, mode: "local", cloud: { url: "https://snip.x.workers.dev" } }))
    assert.equal(cloudMode(root), false)
    fs.writeFileSync(file, JSON.stringify({ version: 1, mode: "enabling", cloud: { url: "https://snip.x.workers.dev" } }))
    assert.equal(cloudMode(root), false, "an interrupted setup is not a deploy target")
    fs.writeFileSync(file, JSON.stringify({ version: 1, mode: "cloud", cloud: { url: "https://snip.x.workers.dev" } }))
    assert.equal(cloudMode(root), true)
    fs.writeFileSync(file, "{not json")
    assert.equal(cloudMode(root), false, "an unreadable journal is never guessed at")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
