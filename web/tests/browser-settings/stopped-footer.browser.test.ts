// An unfinished setup may already have created a Worker, a database or a bucket. With
// nothing but mode "enabling" to go on, the window cannot say Cloudflare is untouched.
import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import type { Browser } from "playwright"
import { launch, openSettings, pageTextOutsideToasts, startVite, type Server } from "./harness"

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

test("an interrupted setup does not claim that nothing on Cloudflare was changed", async () => {
  const { page, close } = await openSettings(browser, server, { mode: "enabling" })
  try {
    await page.locator("main").getByRole("button", { name: "Resume" }).waitFor()
    const text = await pageTextOutsideToasts(page)
    assert.ok(!/Nothing on Cloudflare was changed/.test(text), `the footer claims more than the window knows:\n${text}`)
  } finally {
    await close()
  }
})
