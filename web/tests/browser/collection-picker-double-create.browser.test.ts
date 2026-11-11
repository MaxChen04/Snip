// Bug 4: board picker double-create.
// collection-picker.tsx create() has no in-flight guard and the Create button stays enabled while the POST is pending,
// so pressing it twice creates two boards. Correct behaviour: exactly one POST /api/collections.
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { gate, reference, sleep, startApp, until, type App } from "./harness.ts"

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
