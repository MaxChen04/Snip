// Toasts: removing several items and creating a board in the popover say so, and the same news twice replaces its toast.
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { boardOf, noteItem, reference, sleep, startApp, until, type App } from "./harness.ts"

let app: App
before(async () => void (app = await startApp()))
after(async () => app?.stop())

test("removing several items from a board says how many", async () => {
  const board = boardOf([noteItem("n1", "first", 0, 0), noteItem("n2", "second", 300, 0)])
  const t = await app.session({ state: { boards: { board1: board } } })
  const { page } = t
  await t.goto("/b/board1")
  await page.locator('[data-key="note:n1"]').waitFor()
  await sleep(300)
  await page.mouse.click(5, 400)
  await page.keyboard.press("Control+a")
  await page.keyboard.press("Delete")
  await page.getByRole("dialog", { name: "Remove 2 items from this board?" }).getByRole("button", { name: "Remove" }).click()
  await page.getByText("Removed 2 items").waitFor()
})

test("creating a board in the Organize popover says so", async () => {
  const t = await app.session({ state: { references: { ref1: reference({ id: "ref1", status: "ready" }) } } })
  const { page } = t
  await t.goto("/r/ref1")
  await page.getByRole("button", { name: "Organize" }).click()
  const popover = page.getByRole("dialog")
  await popover.getByRole("button", { name: /New board/ }).click()
  await popover.getByRole("textbox", { name: "Board name" }).fill("Fresh board")
  await popover.getByRole("button", { name: "Create", exact: true }).click()
  await page.getByText("Created board “Fresh board”").waitFor()
})

test("asking to add a saved site again replaces its Already saved toast", async () => {
  const saved = reference({ id: "ref1", title: "Example Domain" })
  const t = await app.session({ state: { references: { ref1: saved } } })
  const { page } = t
  t.on("POST", "/api/references", () => ({ status: 409, json: { error: "This URL is already saved", existing: saved } }))
  await t.goto("/")
  const field = page.getByRole("textbox", { name: "Link to capture" })
  for (let i = 1; i <= 3; i++) {
    await field.fill("example.com")
    await field.press("Enter")
    await until("POST sent", () => t.count("POST", "/api/references") === i)
    await page.getByText("Already saved").first().waitFor()
  }
  await sleep(500)
  assert.equal(await page.getByText("Already saved").count(), 1, "the toasts stacked")
})

test("the same confirmation twice is one toast", async () => {
  const t = await app.session()
  const { page } = t
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"])
  await t.goto("/")
  await page.getByRole("button", { name: "Connect MCP" }).click()
  const copy = page.getByRole("dialog").getByRole("button", { name: /^Copy / }).first()
  for (let i = 0; i < 3; i++) {
    await copy.click()
    await page.getByText(/^Copied /).first().waitFor()
  }
  await sleep(500)
  assert.equal(await page.getByText(/^Copied /).count(), 1, "the toasts stacked")
})
