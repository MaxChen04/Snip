// Bug 3: runs started from this window show setup's title and steps.
// begin() never refreshes and ProgressView derives the command from snapshot.running, which
// is null when the window was opened before the run. Real main: after Copy back starts,
// state() WOULD return running:{command:"pull"}; the app just never asks.
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

test("Copy back shows the copy-back title and its 8 steps, not setup's", async () => {
  const { page, close } = await openSettings(browser, server, { mode: "cloud" })
  try {
    await page.getByRole("button", { name: "Turn off cloud…" }).click()
    await page.getByText("Bring the cloud library back to this Mac").click()
    await page.getByRole("button", { name: "Copy back now" }).click()
    await page.waitForFunction(() => (window as any).__sim.run?.command === "pull")

    await sim(page, "step", "pull-preflight", "started")
    await sim(page, "step", "pull-preflight", "ok")
    await sim(page, "step", "pull-manifest", "ok")
    await sim(page, "step", "pull-d1", "started")
    await page.waitForTimeout(1000) // far longer than one state() round trip

    const main = page.locator("main")
    const heading = (await main.getByRole("heading", { level: 1 }).innerText()).trim()
    const counter = (await main.getByText(/^\d+ of \d+$/).innerText()).trim()
    const rows = await main.locator("ol > li").allInnerTexts()
    assert.ok(
      heading === "Bringing your cloud library back" && counter === "2 of 8" && rows.includes("Download the database"),
      `expected the copy-back view; got heading="${heading}", counter="${counter}", steps=${JSON.stringify(rows.slice(0, 4))}…`,
    )
  } finally {
    await close()
  }
})

test("deleting the export shows its own title and steps", async () => {
  const { page, close } = await openSettings(browser, server, { mode: "cloud" })
  try {
    await page.getByRole("button", { name: "Turn off cloud…" }).waitFor()
    // The fake's snapshot has no export row; start the command the row's button starts.
    await page.evaluate(() => void (window as any).snipCloud.snapshot("delete-export", "cloud-export"))
    await sim(page, "step", "snapshot-preflight", "started")
    await sim(page, "step", "snapshot-preflight", "ok")
    await sim(page, "step", "snapshot-delete-export", "started")
    const main = page.locator("main")
    await main.getByText("1 of 3").waitFor()
    assert.equal((await main.getByRole("heading", { level: 1 }).innerText()).trim(), "Deleting the export")
    assert.deepEqual(await main.locator("ol > li").allInnerTexts(), ["Check the snapshot", "Delete the export", "Finish"])
  } finally {
    await close()
  }
})
