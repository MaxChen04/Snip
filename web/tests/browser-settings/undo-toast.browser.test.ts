// Bug 6: Undo shows a success toast before the abort run finishes.
// settings-app.tsx undoSetup() toasts "Setup undone" as soon as abort() returns {started:true}.
// Real main: abort starts a run; here it then fails (failed step, result ok:false).
import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import type { Browser } from "playwright"
import { calls, launch, openSettings, sim, startVite, toastTexts, watch, watched, type Server } from "./harness"

let server: Server
let browser: Browser
before(async () => {
  server = await startVite()
  browser = await launch()
})
after(async () => {
  await browser?.close()
  await server?.stop()
})

test("a failed Undo never says the setup was undone", async () => {
  const { page, close } = await openSettings(browser, server, { mode: "enabling" })
  try {
    await watch(page, "undone", `/Setup undone/.test(document.body.innerText || "")`)
    await page.locator("main").getByRole("button", { name: "Undo setup" }).click()
    await page.getByRole("dialog").getByRole("button", { name: "Undo setup" }).click()
    await page.waitForFunction(() => (window as any).__sim.run?.command === "abort")
    assert.equal((await calls(page, "abort")).length, 1)

    await page.waitForTimeout(800) // the abort run is still working
    const whileRunning = await watched(page, "undone")

    await sim(page, "step", "abort-cleanup", "started")
    await sim(page, "step", "abort-cleanup", "failed", { message: "Couldn’t remove the Worker" })
    await sim(page, "result", { ok: false, code: "FAILED", mode: "enabling", data: { step: "abort-cleanup", message: "Couldn’t remove the Worker" } })
    await sim(page, "exit", { code: 1 })
    await page.waitForTimeout(1000)

    const everSaid = await watched(page, "undone")
    assert.ok(!everSaid, `"Setup undone…" was shown (while the run was still going: ${whileRunning}) although the abort run failed. toasts now: ${JSON.stringify(await toastTexts(page))}`)
  } finally {
    await close()
  }
})

test("Undo runs as a command of its own and ends on the local panels", async () => {
  const { page, close } = await openSettings(browser, server, { mode: "enabling" })
  try {
    const main = page.locator("main")
    await main.getByRole("button", { name: "Undo setup" }).click()
    await page.getByRole("dialog").getByRole("button", { name: "Undo setup" }).click()
    await page.waitForFunction(() => (window as any).__sim.run?.command === "abort")
    await sim(page, "step", "abort-preflight", "started")
    await sim(page, "step", "abort-preflight", "ok")
    await sim(page, "step", "abort-cleanup", "started")
    await main.getByText("1 of 2").waitFor()
    assert.equal((await main.getByRole("heading", { level: 1 }).innerText()).trim(), "Undoing setup")
    assert.deepEqual(await main.locator("ol > li").allInnerTexts(), ["Check this Mac", "Remove what setup created"])
    assert.equal(await main.getByRole("button", { name: "Cancel", exact: true }).count(), 1)

    await sim(page, "step", "abort-cleanup", "ok")
    await sim(page, "result", { ok: true, code: "OK", mode: "local" })
    await sim(page, "exit", { code: 0 })
    await page.getByRole("button", { name: "Enable cloud" }).waitFor()
  } finally {
    await close()
  }
})
