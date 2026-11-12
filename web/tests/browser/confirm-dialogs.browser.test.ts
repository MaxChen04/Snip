// Deleting an image, removing several items from a board and re-capturing a website ask in the app's own dialog, not a native confirm.
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { boardOf, collection, image, imageItem, noteItem, reference, savedPage, sleep, startApp, type App } from "./harness.ts"

let app: App
before(async () => void (app = await startApp()))
after(async () => app?.stop())

const withImage = async () => {
  const t = await app.session({ state: { collections: [collection()], boards: { board1: boardOf([imageItem(image(), 0, 0)]) } } })
  let native = 0
  t.page.on("dialog", (d) => void (native++, d.dismiss()))
  await t.goto("/b/board1?open=image:img1")
  await t.page.getByRole("dialog", { name: "Picture" }).waitFor()
  return { t, natives: () => native }
}
const askToDeleteImage = async (t: Awaited<ReturnType<typeof withImage>>["t"]) => {
  await t.page.getByRole("button", { name: "More actions" }).click()
  await t.page.getByRole("menuitem", { name: "Delete image" }).click()
  return t.page.getByRole("dialog", { name: "Delete this image?" })
}

test("Delete image asks in a dialog that says there is no undo, and Cancel keeps the image and its inspector", async () => {
  const { t, natives } = await withImage()
  const dialog = await askToDeleteImage(t)
  await dialog.getByText("It comes off every board too. This can't be undone.").waitFor()
  await dialog.getByRole("button", { name: "Cancel" }).click()
  await dialog.waitFor({ state: "detached" })
  await sleep(200)
  assert.equal(t.count("DELETE", "/api/images/img1"), 0)
  assert.equal(await t.page.getByRole("dialog", { name: "Picture" }).isVisible(), true, "the inspector is still open")
  assert.equal(natives(), 0, "a native confirm was used")

  // Escape closes the question, not the inspector behind it.
  await askToDeleteImage(t)
  await t.page.keyboard.press("Escape")
  await dialog.waitFor({ state: "detached" })
  assert.equal(await t.page.getByRole("dialog", { name: "Picture" }).isVisible(), true, "Escape left the inspector open")
  assert.equal(t.count("DELETE", "/api/images/img1"), 0)
  assert.deepEqual(t.consoleErrors, [])
})

test("a deleted image says so with a toast and closes its inspector", async () => {
  const { t, natives } = await withImage()
  const dialog = await askToDeleteImage(t)
  await dialog.getByRole("button", { name: "Delete", exact: true }).click()
  await t.page.getByText("Deleted image").waitFor()
  await t.page.getByRole("dialog", { name: "Picture" }).waitFor({ state: "detached" })
  assert.equal(t.count("DELETE", "/api/images/img1"), 1)
  assert.equal(natives(), 0, "a native confirm was used")
  assert.deepEqual(t.consoleErrors, [])
})

test("a failed image delete is shown and leaves the inspector open", async () => {
  const { t } = await withImage()
  t.on("DELETE", "/api/images/img1", () => ({ status: 500, json: { error: "Boom: could not delete the image" } }))
  const dialog = await askToDeleteImage(t)
  await dialog.getByRole("button", { name: "Delete", exact: true }).click()
  await t.page.getByText("Boom: could not delete the image").waitFor()
  assert.equal(await t.page.getByRole("dialog", { name: "Picture" }).isVisible(), true)
})

test("removing several items asks in a dialog, and Cancel removes nothing", async () => {
  const board = boardOf([noteItem("n1", "first", 0, 0), noteItem("n2", "second", 300, 0)])
  const t = await app.session({ state: { boards: { board1: board } } })
  const { page } = t
  let native = 0
  page.on("dialog", (d) => void (native++, d.dismiss()))
  await t.goto("/b/board1")
  await page.locator('[data-key="note:n1"]').waitFor()
  await sleep(300)
  await page.mouse.click(5, 400)
  await page.keyboard.press("Control+a")
  await page.keyboard.press("Delete")
  const dialog = page.getByRole("dialog", { name: "Remove 2 items from this board?" })
  await dialog.getByText("Notes are deleted for good. This can't be undone.").waitFor()
  await dialog.getByRole("button", { name: "Cancel" }).click()
  await dialog.waitFor({ state: "detached" })
  await sleep(200)
  assert.equal(t.requests.filter((r) => r.method === "DELETE").length, 0)
  assert.equal(await page.locator('[data-key^="note:"]').count(), 2)
  assert.equal(native, 0, "a native confirm was used")

  await page.keyboard.press("Delete")
  await page.getByRole("dialog", { name: "Remove 2 items from this board?" }).getByRole("button", { name: "Remove" }).click()
  await page.locator('[data-key^="note:"]').first().waitFor({ state: "detached" })
  assert.deepEqual(t.list("DELETE", /^\/api\/boards\/board1\/notes\//).map((r) => r.path).sort(), ["/api/boards/board1/notes/n1", "/api/boards/board1/notes/n2"])
  assert.equal(native, 0)
  assert.deepEqual(t.consoleErrors, [])
})

test("Re-capture on a website with pages asks first, and Cancel sends nothing", async () => {
  const t = await app.session({ state: { references: { ref1: reference({ id: "ref1", title: "Example", domain: "example.com" }) } } })
  const { page } = t
  let native = 0
  page.on("dialog", (d) => void (native++, d.dismiss()))
  t.on("GET", "/api/references/ref1", () => ({ json: { reference: t.state.references.ref1, pages: [savedPage({ id: "p1" }), savedPage({ id: "p2", path: "/pricing" })], animations: [] } }))
  await t.goto("/r/ref1")
  await page.getByRole("button", { name: "Re-capture" }).click()
  const dialog = page.getByRole("dialog", { name: "Re-capture example.com?" })
  await dialog.getByText("Its 2 captured pages will be replaced.").waitFor()
  await dialog.getByRole("button", { name: "Cancel" }).click()
  await dialog.waitFor({ state: "detached" })
  assert.equal(t.count("POST", "/api/references/ref1/recapture"), 0)

  await page.getByRole("button", { name: "Re-capture" }).click()
  await page.getByRole("dialog", { name: "Re-capture example.com?" }).getByRole("button", { name: "Re-capture" }).click()
  await page.getByText("Re-capture queued").waitFor()
  assert.equal(t.count("POST", "/api/references/ref1/recapture"), 1)
  assert.equal(native, 0, "a native confirm was used")
  assert.deepEqual(t.consoleErrors, [])
})
