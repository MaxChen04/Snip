// The capture card at the canvas origin: its options, its status line and the pill beside the field.
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { openAddDialog, boardOf, reference, startApp, type App } from "./harness.ts"

let app: App
before(async () => void (app = await startApp()))
after(async () => app?.stop())

test("the card and the Add dialog offer the same crawl page caps", async () => {
  const t = await app.session({ state: { boards: { board1: boardOf() } } })
  const { page } = t
  await t.goto("/")
  await page.getByRole("button", { name: "Crawl site" }).click()
  const card = await page.getByRole("group", { name: "Pages to crawl" }).getByRole("button").allInnerTexts()

  await t.goto("/b/board1")
  const dialog = await openAddDialog(page)
  await dialog.getByRole("radio", { name: /Crawl site/ }).click()
  const row = dialog.getByText("Up to", { exact: true }).locator("xpath=..")
  const dlg = (await row.getByRole("button").allInnerTexts()).map((s) => s.trim())

  assert.deepEqual(card, ["10", "25", "50", "100"])
  assert.deepEqual(dlg, card)
})
