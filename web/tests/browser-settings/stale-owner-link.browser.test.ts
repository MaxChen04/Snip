// Bug 5: "Create a new link" shows the previous link as ready.
// Real main never clears its stored ownerLink when a new owner-link run starts, so the
// first state() poll after the click still returns link A. The sheet then says "Link ready"
// with A while the second mint is still running, and a failed second mint changes nothing.
import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import type { Browser, Page } from "playwright"
import { calls, launch, openSettings, sim, startVite, type Server } from "./harness"

const LINK_A = "https://snip.example.workers.dev/sign-in?t=AAAAAAAAAAAAAAAA"

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

/** Mint link A through the sheet, then click "Create a new link" and leave the second mint running. */
async function secondMintInFlight(page: Page) {
  await page.getByRole("button", { name: "Create link…" }).click()
  await page.waitForFunction(() => (window as any).__sim.run?.command === "owner link")
  await sim(page, "mintLink", LINK_A)
  // main cancels the owner-link run once it has the URL: exit without a log.
  await sim(page, "exit", { cancelled: true, code: null })
  const dialog = page.getByRole("dialog")
  await dialog.getByText(LINK_A).waitFor()
  await dialog.getByText("Link ready").waitFor()

  await dialog.getByRole("button", { name: "Create a new link" }).click()
  await page.waitForFunction(() => (window as any).__sim.run?.command === "owner link")
  return dialog
}

test("while a new link is being minted the sheet does not show the old link as ready", async () => {
  const { page, close } = await openSettings(browser, server, { mode: "cloud" })
  try {
    const dialog = await secondMintInFlight(page)
    await page.waitForTimeout(1500) // the run is still in flight (state().running is non-null)
    const inFlight = await page.evaluate(() => (window as any).__sim.run?.command)
    assert.equal(inFlight, "owner link", "precondition: second mint still running")
    const text = await dialog.innerText()
    assert.ok(!text.includes("Link ready") && !text.includes("AAAAAAAA"), `stale link A is shown as ready while the second mint runs. Sheet says:\n${text}`)
  } finally {
    await close()
  }
})

test("when the second mint fails the sheet shows the failure, not the old link", async () => {
  const { page, close } = await openSettings(browser, server, { mode: "cloud" })
  try {
    const dialog = await secondMintInFlight(page)
    await page.waitForTimeout(1500)
    await sim(page, "exit", { code: 1 }) // no link, no result: main logs "Snip couldn’t create a sign-in link."
    await page.waitForTimeout(1000)
    const text = await dialog.innerText()
    assert.ok(/couldn.t create/i.test(text) && !text.includes("AAAAAAAA"), `expected the failure in the sheet and no stale link. Sheet says:\n${text}`)
  } finally {
    await close()
  }
})

test("closing the sheet mid-mint and reopening it joins the mint in flight", async () => {
  const { page, close } = await openSettings(browser, server, { mode: "cloud" })
  try {
    await page.getByRole("button", { name: "Create link…" }).click()
    await page.waitForFunction(() => (window as any).__sim.run?.command === "owner link")
    await page.keyboard.press("Escape")
    await page.getByRole("dialog").waitFor({ state: "detached" })
    await page.getByRole("button", { name: "Create link…" }).click()
    const dialog = page.getByRole("dialog")
    await dialog.getByText("Creating a sign-in link…").waitFor()
    await page.waitForTimeout(500)
    assert.equal((await calls(page, "ownerLink")).length, 1, "the reopened sheet must not start a second mint")
    assert.ok(!/busy/.test(await dialog.innerText()), "main's refusal of a second run must not reach the sheet")

    await sim(page, "mintLink", LINK_A)
    await sim(page, "exit", { cancelled: true, code: null })
    await dialog.getByText(LINK_A).waitFor()
    await dialog.getByText("Link ready").waitFor()
  } finally {
    await close()
  }
})
