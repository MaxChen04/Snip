// Bug 2: a failed run that does not leave mode "enabling" shows no error.
// ErrorCard only renders inside ProgressView, which is gated on busy/enabling/disabling/choice.
// Real main for a failed Copy back: state() keeps mode "cloud", busy false; main logs an
// error line (a toast) and nothing else.
import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import type { Browser } from "playwright"
import { launch, openSettings, pageTextOutsideToasts, sim, startVite, toastTexts, type Server } from "./harness"

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

test("a failed Copy back leaves an error with its message and a retry affordance on screen", async () => {
  const { page, close } = await openSettings(browser, server, { mode: "cloud" })
  try {
    await page.getByRole("button", { name: "Turn off cloud…" }).click()
    await page.getByText("Bring the cloud library back to this Mac").click()
    await page.getByRole("button", { name: "Copy back now" }).click()
    await page.waitForFunction(() => (window as any).__sim.run?.command === "pull")

    await sim(page, "step", "pull-preflight", "started")
    await sim(page, "step", "pull-preflight", "ok")
    await sim(page, "step", "pull-manifest", "ok")
    await sim(page, "step", "pull-files", "started")
    await sim(page, "step", "pull-files", "failed", { message: "Copy failed" })
    await sim(page, "result", { ok: false, code: "FAILED", mode: "cloud", data: { step: "pull-files", message: "Copy failed" } })
    await sim(page, "exit", { code: 1 })

    // Let the UI settle: its refresh() round trip, and the 400ms second read.
    await page.waitForTimeout(1500)

    const text = await pageTextOutsideToasts(page)
    const toasts = await toastTexts(page)
    const state = await page.evaluate(() => ({ mode: (window as any).__sim.mode, run: (window as any).__sim.run }))
    assert.deepEqual(state, { mode: "cloud", run: null })
    const retry = await page.getByRole("button", { name: /retry/i }).count()
    assert.ok(
      /Copy failed/.test(text) && retry > 0,
      `expected "Copy failed" and a Retry button in the page (not in a toast). ` +
        `message on page=${/Copy failed/.test(text)}, retry buttons=${retry}, toasts=${JSON.stringify(toasts)}`,
    )
  } finally {
    await close()
  }
})

test("a refusal with no failed step shows the engine's own sentence from the result", async () => {
  const { page, close } = await openSettings(browser, server, { mode: "cloud" })
  try {
    await page.getByRole("button", { name: "Turn off cloud…" }).click()
    await page.getByText("Bring the cloud library back to this Mac").click()
    await page.getByRole("button", { name: "Copy back now" }).click()
    await page.waitForFunction(() => (window as any).__sim.run?.command === "pull")
    // cli.cjs passes `message` beside `data`, not inside it.
    await sim(page, "result", { ok: false, code: "LOCKED", mode: null, data: { holder: null }, message: "Another Snip command holds the lock.", retryable: true })
    await sim(page, "exit", { code: 3 })
    await page.waitForTimeout(1500)
    // <main> holds no toasts, so this is the card and not main's log line.
    const main = page.locator("main")
    assert.equal(await main.getByText("Another Snip command holds the lock.").count(), 1)
    assert.equal(await main.getByRole("button", { name: "Retry" }).count(), 1)
  } finally {
    await close()
  }
})
