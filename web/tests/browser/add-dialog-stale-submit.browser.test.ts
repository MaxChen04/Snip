// Bug 2: a stale submit closes a newer Add dialog.
// Submit URL A with the POST held, close the dialog, open it again and type URL B, then let A's response arrive.
// add-flow.tsx's onAdded does setAdding(null), which closes whichever dialog is open now. Correct behaviour: the
// second dialog stays open with B still in its field.
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { boardOf, closeDialog, gate, openAddDialog, pasteOnPage, sleep, startApp, until, type App } from "./harness.ts"

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

test("a submit that finishes while its dialog is open closes it and reloads the library", async () => {
  const t = await app.session({ state: { boards: { board1: boardOf() } } })
  const { page } = t
  await t.goto("/b/board1")
  const dialog = await openAddDialog(page)
  await page.evaluate(() => window.addEventListener("rs:reload", () => ((window as any).reloads = ((window as any).reloads ?? 0) + 1)))
  await dialog.getByRole("textbox", { name: "Website URL" }).fill("https://aaa.example.com")
  await dialog.getByRole("button", { name: /Save reference/ }).click()
  await dialog.waitFor({ state: "detached" })
  assert.equal(t.count("POST", "/api/references"), 1)
  assert.equal(await page.evaluate(() => (window as any).reloads), 1)
})

test("a sentence pasted on the page puts just its link in the field", async () => {
  const t = await app.session({ state: { boards: { board1: boardOf() } } })
  const { page } = t
  await t.goto("/b/board1")
  await page.getByRole("button", { name: "Add website" }).first().waitFor()

  await pasteOnPage(page, "check this out https://aside.com/ cool")
  const dialog = page.getByRole("dialog", { name: "New reference" })
  const field = dialog.getByRole("textbox", { name: "Website URL" })
  assert.equal(await field.inputValue(), "https://aside.com/")
  assert.equal(await dialog.getByText("Enter a full domain like linear.app").count(), 0)

  await dialog.getByRole("button", { name: /Save reference/ }).click()
  await dialog.waitFor({ state: "detached" })
  assert.deepEqual(t.list("POST", "/api/references").map((r) => r.body.url), ["https://aside.com/"])
})

test("a sentence with several links in it adds each of them, and text with no link opens nothing", async () => {
  const t = await app.session({ state: { boards: { board1: boardOf() } } })
  const { page } = t
  await t.goto("/b/board1")
  await page.getByRole("button", { name: "Add website" }).first().waitFor()

  await pasteOnPage(page, "compare stripe.com and https://linear.app/pricing please")
  const dialog = page.getByRole("dialog", { name: "New reference" })
  await dialog.getByText("2 websites", { exact: true }).waitFor()
  await closeDialog(page)

  await pasteOnPage(page, "no link here, just words")
  assert.equal(await page.getByRole("dialog").count(), 0, "text without a link opens nothing")
})
