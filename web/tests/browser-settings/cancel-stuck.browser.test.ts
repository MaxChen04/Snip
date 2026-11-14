// Bug 1: Cancel during a long step leaves the window busy forever.
// Real main: the engine is killed after a cancel and NO `result` event is sent; main only
// logs "Stopped. Nothing on Cloudflare was changed." and state() then reports busy:false
// with mode "enabling". Main never pushes state, so the UI has to notice by itself.
import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import type { Browser } from "playwright"
import { launch, openSettings, sim, startVite, type Server } from "./harness"

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

test("after a cancelled run the window offers Resume or Undo, not a dead Cancel button", async () => {
  const { page, close } = await openSettings(browser, server, { mode: "local", cancelKillMs: 600 })
  try {
    await page.getByRole("button", { name: "Enable cloud" }).click()
    await page.getByRole("button", { name: "Continue to Cloudflare" }).click()
    await page.waitForFunction(() => (window as any).__sim.run !== null)

    await sim(page, "step", "preflight", "started")
    await sim(page, "step", "preflight", "ok")
    await sim(page, "step", "cloudflare-auth", "started", { message: "Waiting for Cloudflare" })

    const cancel = page.locator("main").getByRole("button", { name: "Cancel", exact: true })
    await cancel.click()
    // The fake main kills the engine 600ms later: log only, no result event.
    await page.waitForFunction(() => (window as any).__sim.run === null)
    // Give the UI a couple of seconds after that log (main never pushes state).
    const resume = page.locator("main").getByRole("button", { name: /^(Resume|Retry)$/ })
    const undo = page.locator("main").getByRole("button", { name: /Undo setup/ })
    await resume.or(undo).first().waitFor({ timeout: 3000 }).catch(() => {})

    const visible = await cancel.isVisible()
    const offered = (await resume.count()) + (await undo.count())
    const state = await page.evaluate(() => ({ run: (window as any).__sim.run, mode: (window as any).__sim.mode }))
    assert.deepEqual(state, { run: null, mode: "enabling" }, "precondition: main has no run and mode is enabling")
    assert.equal(offered > 0 && !visible, true, `expected Resume/Undo and no Cancel button; cancelVisible=${visible}, resume/undo buttons=${offered}`)
  } finally {
    await close()
  }
})
