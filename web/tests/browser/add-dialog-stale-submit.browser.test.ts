// Bug 2: a stale submit closes a newer Add dialog.
// Submit URL A with the POST held, close the dialog, open it again and type URL B, then let A's response arrive.
// add-flow.tsx's onAdded does setAdding(null), which closes whichever dialog is open now. Correct behaviour: the
// second dialog stays open with B still in its field.
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { boardOf, closeDialog, gate, openAddDialog, sleep, startApp, until, type App } from "./harness.ts"

let app: App
before(async () => void (app = await startApp()))
after(async () => app?.stop())

test("a late response for a closed Add dialog leaves the newly opened one alone", async () => {
  const t = await app.session({ state: { boards: { board1: boardOf() } } })
  const { page } = t
  const releaseA = gate()
  t.on("POST", "/api/references", async (req) => {
    if (!req.body.url.includes("aaa.example")) return undefined
    await releaseA.opened
    return undefined // then the default answer: a created reference
  })
  await t.goto("/b/board1")
  await page.getByRole("button", { name: "Add website" }).first().waitFor()

  // Dialog 1: submit A, response held.
  const first = await openAddDialog(page)
  await first.getByRole("textbox", { name: "Website URL" }).fill("https://aaa.example.com")
  await first.getByRole("button", { name: /Save reference/ }).click()
  await until("POST for A in flight", () => t.count("POST", "/api/references") === 1)

  // Close it while A is still pending, then open a fresh one and type B.
  await closeDialog(page)
  const second = await openAddDialog(page)
  const field = second.getByRole("textbox", { name: "Website URL" })
  await field.fill("https://bbb.example.com")

  assert.equal(await field.inputValue(), "https://bbb.example.com") // precondition: the second dialog is open and filled

  // A's response arrives now.
  releaseA.open()
  await sleep(600)

  const stillOpen = await page.getByRole("dialog", { name: "New reference" }).isVisible()
  assert.equal(stillOpen, true, "A's late response closed the newer Add dialog")
  assert.equal(await field.inputValue(), "https://bbb.example.com", "B should still be in the field")
})
