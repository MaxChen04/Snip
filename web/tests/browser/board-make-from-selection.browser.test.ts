// "Make board" copies the selection to a new board. Notes there are created by POST, so each one has to be sent
// with its z, or the copy loses its place in the stack: it would land on top, in the order the requests happen to finish.
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { boardOf, image, imageItem, noteItem, sleep, startApp, until, type App } from "./harness.ts"

let app: App
before(async () => void (app = await startApp()))
after(async () => app?.stop())

test("making a board from a selection sends each note's z", async () => {
  const board = boardOf([
    noteItem("low", "low", 0, 0, { z: 3 }),
    imageItem(image(), 300, 0, { z: 4 }),
    noteItem("high", "high", 600, 0, { z: 9 }),
  ])
  const t = await app.session({ state: { boards: { board1: board } } })
  const { page } = t
  await t.goto("/b/board1")
  await page.locator('[data-key="note:low"]').waitFor()
  await sleep(300)
  await page.mouse.click(5, 400)
  await page.keyboard.press("Control+a")
  await page.getByRole("button", { name: "Make board" }).click()

  const notes = "/api/boards/newboard/notes"
  await until("both notes are created", () => t.count("POST", notes) === 2)
  const sent = t.list("POST", notes).map((r) => [r.body.text, r.body.z])
  assert.deepEqual(sent.sort(), [["high", 9], ["low", 3]])
})
