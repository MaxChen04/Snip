// Bug 4: board picker double-create.
// collection-picker.tsx create() has no in-flight guard and the Create button stays enabled while the POST is pending,
// so pressing it twice creates two boards. Correct behaviour: exactly one POST /api/collections.
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { boardOf, gate, openAddDialog, reference, sleep, startApp, until, type App } from "./harness.ts"

let app: App
before(async () => void (app = await startApp()))
after(async () => app?.stop())

test("pressing Create twice while the POST is pending creates one board", async () => {
  // The picker lives in the reference page's Organize popover (inside the Add dialog it sits in a nested <form>, where
  // Create does not reach the handler at all: see the report).
  const t = await app.session({ state: { references: { ref1: reference({ id: "ref1", status: "ready" }) } } })
  const { page } = t
  const hold = gate()
  t.on("POST", "/api/collections", async () => {
    await hold.opened
    return undefined
  })
  await t.goto("/r/ref1")
  await page.getByRole("button", { name: "Organize" }).click()
  const popover = page.getByRole("dialog")
  await popover.getByRole("button", { name: /New board/ }).click()
  await popover.getByRole("textbox", { name: "Board name" }).fill("Fresh board")
  const create = popover.getByRole("button", { name: "Create", exact: true })
  await create.click()
  await until("first POST /api/collections in flight", () => t.count("POST", "/api/collections") >= 1)
  // Second press while the first is still pending (the button is still there and enabled).
  await create.click({ timeout: 2000 }).catch(() => {})
  await sleep(300)
  hold.open()
  await sleep(500)

  assert.equal(t.count("POST", "/api/collections"), 1, "the Create button sent more than one POST /api/collections")
})

test("creating a board inside the Add dialog selects it and keeps the page and the dialog", async () => {
  const t = await app.session({ state: { boards: { board1: boardOf() } } })
  const { page } = t
  await t.goto("/b/board1")
  const dialog = await openAddDialog(page)
  await dialog.getByRole("textbox", { name: "Website URL" }).fill("https://aaa.example.com")
  await page.evaluate(() => ((window as any).sameDocument = true))
  // The list reload after the create fails: the board was still created.
  let created = false
  t.on("POST", "/api/collections", () => void (created = true))
  t.on("GET", "/api/collections", () => (created ? { status: 500, json: { error: "Boom: list failed" } } : undefined))

  await dialog.getByRole("button", { name: /New board/ }).click()
  await dialog.getByRole("textbox", { name: "Board name" }).fill("Fresh board")
  await dialog.getByRole("button", { name: "Create", exact: true }).click()
  await until("POST /api/collections", () => t.count("POST", "/api/collections") === 1)
  await dialog.getByRole("button", { name: /New board/ }).waitFor()

  assert.equal(await page.evaluate(() => (window as any).sameDocument), true, "the page was reloaded")
  assert.equal(new URL(page.url()).pathname + new URL(page.url()).search, "/b/board1")
  assert.equal(await page.getByText("Boom: list failed").isVisible(), false, "a failed list reload was reported as a failed create")
  assert.equal(t.count("POST", "/api/references"), 0, "creating a board submitted the Add dialog")

  // Enter in the board name creates the board too, without submitting the Add dialog around it.
  await dialog.getByRole("button", { name: /New board/ }).click()
  await dialog.getByRole("textbox", { name: "Board name" }).fill("Second board")
  await dialog.getByRole("textbox", { name: "Board name" }).press("Enter")
  await until("second POST /api/collections", () => t.count("POST", "/api/collections") === 2)
  await sleep(300)
  assert.equal(t.count("POST", "/api/references"), 0, "Enter in the board name submitted the Add dialog")

  await dialog.getByRole("button", { name: /Save reference/ }).click()
  await until("POST /api/references", () => t.count("POST", "/api/references") === 1)
  assert.deepEqual(t.list("POST", "/api/references")[0]!.body.collectionIds, ["board1", "newboard"])
})
