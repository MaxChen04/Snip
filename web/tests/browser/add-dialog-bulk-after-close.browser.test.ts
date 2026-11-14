// Closing the Add dialog does not cut a bulk add short: once submitted, every URL is sent, and the final toast
// reports the true counts, failures included. (A newer dialog is still left alone: see add-dialog-stale-submit.)
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { boardOf, closeDialog, gate, pasteOnPage, startApp, until, type App } from "./harness.ts"

let app: App
before(async () => void (app = await startApp()))
after(async () => app?.stop())

const submitThree = async (t: Awaited<ReturnType<App["session"]>>) => {
  const { page } = t
  await t.goto("/b/board1")
  await page.getByRole("button", { name: "Add website" }).first().waitFor()
  await pasteOnPage(page, "https://one.example.com\nhttps://two.example.com\nhttps://three.example.com")
  const dialog = page.getByRole("dialog", { name: "New reference" })
  await dialog.getByText("3 websites", { exact: true }).waitFor()
  await dialog.getByRole("button", { name: "Save 3 websites" }).click()
  await until("first POST in flight", () => t.count("POST", "/api/references") === 1)
}

test("closing the dialog mid bulk add still sends every URL, and the toast says so", async () => {
  const t = await app.session({ state: { boards: { board1: boardOf() } } })
  const { page } = t
  const first = gate()
  let n = 0
  t.on("POST", "/api/references", async () => {
    if (++n === 1) await first.opened
    return undefined
  })
  await submitThree(t)

  await closeDialog(page)
  first.open()

  await until("all three sent", () => t.count("POST", "/api/references") === 3)
  assert.deepEqual(t.list("POST", "/api/references").map((r) => r.body.url), ["https://one.example.com/", "https://two.example.com/", "https://three.example.com/"])
  await page.getByText("Added 3 websites").waitFor()
})

test("a URL that fails after the dialog closed is counted in the final toast", async () => {
  const t = await app.session({ state: { boards: { board1: boardOf() } } })
  const { page } = t
  const first = gate()
  let n = 0
  t.on("POST", "/api/references", async (req) => {
    if (++n === 1) await first.opened
    return req.body.url.includes("two.") ? { status: 500, json: { error: "Boom: could not save" } } : undefined
  })
  await submitThree(t)

  await closeDialog(page)
  first.open()

  await page.getByText("Added 2 websites. 1 couldn't be added: Boom: could not save").waitFor()
  assert.equal(t.count("POST", "/api/references"), 3)
})
