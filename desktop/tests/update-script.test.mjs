import test from "node:test"
import assert from "node:assert/strict"
import { planSteps, classifyChanges } from "../../scripts/update.mjs"

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
