// A board's name is at most 120 characters wherever it is typed, and a long one is cut with an ellipsis on a phone
// rather than wrapped over several lines.
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { boardOf, collection, openAddDialog, reference, startApp, type App } from "./harness.ts"

let app: App
before(async () => void (app = await startApp()))
after(async () => app?.stop())

const LONG = "QA board with a really long name that keeps going ".repeat(3).trim().slice(0, 120)

test("every place that names a board stops at 120 characters", async () => {
  const t = await app.session({ state: { boards: { board1: boardOf() } } })
  const { page } = t
  await t.goto("/b/board1")

  // The boards list in the top bar.
  await page.getByRole("button", { name: /switch board/ }).click()
  await page.getByRole("button", { name: "New board" }).click()
  const inList = page.getByRole("textbox", { name: "Board name" })
  await inList.fill("x".repeat(130))
  assert.equal((await inList.inputValue()).length, 120)
  await page.keyboard.press("Escape")
  await page.keyboard.press("Escape")

  // The picker inside the Add dialog.
  const dialog = await openAddDialog(page)
  await dialog.getByRole("button", { name: /New board/ }).click()
  const inPicker = dialog.getByRole("textbox", { name: "Board name" })
  await inPicker.fill("x".repeat(130))
  assert.equal((await inPicker.inputValue()).length, 120)
})

test("on a phone a long board name stays on one line in the board's pill and in a website's breadcrumb", async () => {
  const board = collection({ id: "board1", name: LONG })
  const r = reference({ id: "ref1", title: "Example Domain", collectionIds: ["board1"] })
  const t = await app.session({ state: { collections: [board], boards: { board1: boardOf([], [], board) }, references: { ref1: r } }, viewport: { width: 390, height: 800 } })
  const { page } = t

  await t.goto("/b/board1")
  const name = page.getByRole("button", { name: /Rename board/ })
  await name.waitFor()
  const pill = (await name.evaluateHandle((el) => el.parentElement!)).asElement()!
  assert.ok((await pill.boundingBox())!.height <= 44, "the pill grew past one line")
  assert.equal(await name.evaluate((el) => el.scrollWidth > el.clientWidth && getComputedStyle(el).textOverflow), "ellipsis")

  await t.goto("/r/ref1")
  const crumb = page.getByRole("link", { name: "All saves" }).locator("xpath=..")
  await crumb.waitFor()
  assert.ok((await crumb.boundingBox())!.height <= 20, `the breadcrumb is ${(await crumb.boundingBox())!.height}px tall`)
  assert.equal(await crumb.evaluate((el) => getComputedStyle(el).textOverflow), "ellipsis")
  const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }))
  assert.ok(widths.scroll <= widths.client, `the page is ${widths.scroll}px wide in a ${widths.client}px window`)
})
