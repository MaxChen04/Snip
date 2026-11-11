// Before the first state() reply the window knows nothing about this Mac, so it must not
// offer anything: least of all "Enable cloud" on a Mac that is already on its cloud library.
import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import type { Browser } from "playwright"
import { launch, openSettings, startVite, type Server } from "./harness"

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

test("nothing actionable is shown until the first snapshot has loaded", async () => {
  const { page, close } = await openSettings(browser, server, { mode: "cloud", stateDelayMs: 1500, awaitFirstPaint: false })
  try {
    await page.getByText("Settings", { exact: true }).waitFor() // the app has rendered
    const main = page.locator("main")
    assert.deepEqual(
      { buttons: await main.getByRole("button").count(), headings: await main.getByRole("heading").count() },
      { buttons: 0, headings: 0 },
      "main must be empty while state() is still pending",
    )
    await page.getByRole("button", { name: "Turn off cloud…" }).waitFor()
    assert.equal(await page.getByRole("button", { name: "Enable cloud" }).count(), 0)
  } finally {
    await close()
  }
})
