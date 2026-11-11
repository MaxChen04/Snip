// The typed-name gate compares against the cloud library's host. With no host on record
// an empty field used to "match", arming the destructive button with nothing typed.
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

test("with no cloud library on record the delete button stays disabled", async () => {
  const { page, close } = await openSettings(browser, server, { mode: "local", search: "?dialog=delete", awaitFirstPaint: false })
  try {
    const confirm = page.getByRole("dialog").getByRole("button", { name: "Delete cloud resources" })
    await confirm.waitFor()
    assert.equal(await confirm.isDisabled(), true)
  } finally {
    await close()
  }
})

test("typing the library's host arms the delete button", async () => {
  const { page, close } = await openSettings(browser, server, { mode: "cloud", search: "?dialog=delete", awaitFirstPaint: false })
  try {
    const dialog = page.getByRole("dialog")
    const confirm = dialog.getByRole("button", { name: "Delete cloud resources" })
    await confirm.waitFor()
    assert.equal(await confirm.isDisabled(), true)
    await dialog.getByRole("textbox").fill("snip.example.workers.dev")
    assert.equal(await confirm.isDisabled(), false)
  } finally {
    await close()
  }
})
