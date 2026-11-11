// Bug 3: bulk add keeps creating references after the dialog is closed.
// add-reference-dialog.tsx submitBulk() loops over every pasted URL with no check that the dialog is still open.
// Paste three URLs, submit, hold the first POST, close the dialog, release. Correct behaviour: no further
// POST /api/references after the close.
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { boardOf, closeDialog, gate, pasteOnPage, sleep, startApp, until, type App } from "./harness.ts"

let app: App
before(async () => void (app = await startApp()))
after(async () => app?.stop())

test("closing the dialog mid bulk add stops the remaining POSTs", async () => {
  const t = await app.session({ state: { boards: { board1: boardOf() } } })
  const { page } = t
  const first = gate()
  let n = 0
  t.on("POST", "/api/references", async () => {
    if (++n === 1) await first.opened
    return undefined
  })
  await t.goto("/b/board1")
  await page.getByRole("button", { name: "Add website" }).first().waitFor()

  await pasteOnPage(page, "https://one.example.com\nhttps://two.example.com\nhttps://three.example.com")
  const dialog = page.getByRole("dialog", { name: "New reference" })
  await dialog.getByText("3 websites", { exact: true }).waitFor()
  await dialog.getByRole("button", { name: "Save 3 websites" }).click()
  await until("first POST in flight", () => t.count("POST", "/api/references") === 1)

  await closeDialog(page)
  const atClose = t.count("POST", "/api/references")
  first.open()
  await sleep(800)

  assert.equal(t.count("POST", "/api/references"), atClose, `after the dialog was closed the loop sent ${t.count("POST", "/api/references") - atClose} more POST /api/references (urls: ${t.list("POST", "/api/references").map((r) => r.body.url).join(", ")})`)
})
