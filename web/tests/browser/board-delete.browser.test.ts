// Deleting a board asks in the app's own dialog, says there is no undo, and ends with a toast; a toast never lands on the filter dock.
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { boardOf, collection, reference, startApp, websiteItem, type App } from "./harness.ts"

let app: App
before(async () => void (app = await startApp()))
after(async () => app?.stop())

const open = async (opts: Parameters<App["session"]>[0] = {}) => {
  const t = await app.session({ state: { collections: [collection({ name: "Moodboard" })], boards: { board1: boardOf() } }, ...opts })
  await t.goto("/b/board1")
  await t.page.getByRole("button", { name: "Board actions" }).waitFor()
  return t
}
const askToDelete = async (t: Awaited<ReturnType<typeof open>>) => {
  await t.page.getByRole("button", { name: "Board actions" }).click()
  await t.page.getByRole("menuitem", { name: "Delete board" }).click()
  return t.page.getByRole("dialog", { name: "Delete “Moodboard”?" })
}

test("Delete board asks in a dialog that says there is no undo, and Cancel sends nothing", async () => {
  const t = await open()
  let native = 0
  t.page.on("dialog", (d) => void (native++, d.dismiss()))
  const dialog = await askToDelete(t)
  await dialog.getByText("This can't be undone.").waitFor()
  await dialog.getByRole("button", { name: "Cancel" }).click()
  await dialog.waitFor({ state: "detached" })
  assert.equal(t.count("DELETE", "/api/collections/board1"), 0)
  assert.equal(native, 0, "a native confirm was used")
})

test("a deleted board says so with a toast and goes back to All saves", async () => {
  const t = await open()
  const dialog = await askToDelete(t)
  await dialog.getByRole("button", { name: "Delete", exact: true }).click()
  await t.page.getByText("Deleted board “Moodboard”").waitFor()
  await t.page.waitForURL((url) => url.pathname === "/")
  assert.equal(t.count("DELETE", "/api/collections/board1"), 1)
})

test("a toast lands above the filter dock, not on it, on a desktop and on a phone", async () => {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 800 }]) {
    const r = reference({ id: "r1", domain: "one.example", title: "One" })
    const t = await app.session({ state: { boards: { board1: boardOf([websiteItem(r, 0, 0)]) } }, viewport })
    t.on("PATCH", "/api/collections/board1", () => ({ status: 500, json: { error: "Boom: could not rename" } }))
    await t.goto("/b/board1")
    const dock = t.page.getByRole("toolbar", { name: "Filter saves" })
    await dock.waitFor()
    await t.page.getByRole("button", { name: /Rename board/ }).click()
    await t.page.getByRole("textbox", { name: "Board name" }).fill("Another name")
    await t.page.keyboard.press("Enter")
    const toast = t.page.locator("[data-sonner-toast]").filter({ hasText: "Boom: could not rename" })
    await toast.waitFor()
    await t.page.waitForTimeout(600) // the toast settles into its place
    const [toastBox, dockBox] = [await toast.boundingBox(), await dock.boundingBox()]
    assert.ok(toastBox!.y + toastBox!.height <= dockBox!.y, `${viewport.width}px: the toast ends at ${toastBox!.y + toastBox!.height}px, the dock starts at ${dockBox!.y}px`)
  }
})
