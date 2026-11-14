// Packaged users must be able to update an old Worker from the bundled Settings
// window, even when that Worker cannot serve the gallery or sign the app in.
import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import type { Browser } from "playwright"
import { calls, launch, openSettings, sim, startVite, type Server } from "./harness"

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

test("cloud update is explicit, works without a cloud response, and shows the deploy steps", async () => {
  // The bridge's snapshot has cloudStatus:null: neither a cloud response nor a
  // signed-in cloud page is needed to reach this native action.
  const { page, pageErrors, close } = await openSettings(browser, server, { mode: "cloud" })
  try {
    const update = page.getByRole("button", { name: "Update cloud library", exact: true })
    await update.waitFor()
    assert.equal(await update.isEnabled(), true)
    assert.deepEqual(await calls(page, "update"), [])
    assert.equal(await page.evaluate(() => (window as any).__sim.run), null)

    await update.click()
    await page.getByRole("heading", { name: "Updating your cloud library", exact: true }).waitFor()
    assert.deepEqual((await calls(page, "update")).map(({ method, args }) => ({ method, args })), [{ method: "update", args: [] }])
    assert.equal(await page.evaluate(() => (window as any).__sim.run.command), "deploy")
    assert.deepEqual(await calls(page, "enable"), [])
    assert.equal(await update.count(), 0)

    await sim(page, "step", "deploy-quiesce", "started")
    await sim(page, "step", "deploy-quiesce", "ok")
    await sim(page, "step", "deploy-preflight", "ok")
    await sim(page, "step", "deploy-layout", "started")
    await page.getByText("2 of 6", { exact: true }).waitFor()
    assert.deepEqual(await page.locator("main ol > li").allInnerTexts(), [
      "Finish the current capture", "Check this Mac", "Prepare this app’s cloud update",
      "Update the database", "Update the cloud library", "Verify the cloud update",
    ])

    await sim(page, "result", { ok: true, code: "OK", mode: "cloud" })
    await sim(page, "exit")
    await update.waitFor()
    assert.deepEqual(pageErrors, [])
  } finally {
    await close()
  }
})

test("a failed update offers Retry and repeats deploy rather than starting a new cloud setup", async () => {
  const { page, pageErrors, close } = await openSettings(browser, server, { mode: "cloud" })
  try {
    await page.getByRole("button", { name: "Update cloud library", exact: true }).click()
    await sim(page, "step", "deploy-verify", "failed", { message: "The cloud update could not be verified.", data: { code: "DEPLOY_VERIFY_FAILED" } })
    await sim(page, "result", { ok: false, code: "DEPLOY_VERIFY_FAILED", mode: "cloud", retryable: true })
    await sim(page, "exit", { code: 1 })
    await page.getByRole("button", { name: "Retry", exact: true }).click()
    await page.getByRole("heading", { name: "Updating your cloud library", exact: true }).waitFor()
    assert.equal(await page.evaluate(() => (window as any).__sim.run.command), "deploy")
    assert.equal((await calls(page, "retryStep")).length, 1)
    assert.deepEqual(await calls(page, "enable"), [])
    assert.deepEqual(pageErrors, [])
  } finally {
    await close()
  }
})

test("Cancel uses the existing stop action and an update can be started again", async () => {
  const { page, pageErrors, close } = await openSettings(browser, server, { mode: "cloud" })
  try {
    const update = page.getByRole("button", { name: "Update cloud library", exact: true })
    await update.click()
    await page.getByRole("button", { name: "Cancel", exact: true }).click()
    await update.waitFor()
    assert.equal((await calls(page, "cancel")).length, 1)
    assert.equal(await page.evaluate(() => (window as any).__sim.run), null)
    await update.click()
    await page.getByRole("heading", { name: "Updating your cloud library", exact: true }).waitFor()
    assert.equal((await calls(page, "update")).length, 2)
    assert.deepEqual(pageErrors, [])
  } finally {
    await close()
  }
})

test("a local-only library has no cloud-update action", async () => {
  const { page, close } = await openSettings(browser, server, { mode: "local" })
  try {
    assert.equal(await page.getByRole("button", { name: "Update cloud library", exact: true }).count(), 0)
    assert.deepEqual(await calls(page, "update"), [])
  } finally {
    await close()
  }
})
