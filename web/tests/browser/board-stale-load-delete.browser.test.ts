// Bug 5: a stale board load overwrites a local delete.
// board-canvas.tsx load() only guards against other loads (`latest`). A poll GET that was sent before a delete and
// answers after it still contains the deleted item, and load() applies it. Correct behaviour: X does not reappear.
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { boardOf, collection, gate, noteItem, reference, sleep, startApp, until, websiteItem, type App } from "./harness.ts"

let app: App
before(async () => void (app = await startApp()))
after(async () => app?.stop())

test("a board GET that was in flight during a delete does not bring the deleted note back", async () => {
  const site = reference({ id: "site1", status: "capturing", progress: "Capturing 1/3: /", collectionIds: ["board1"] })
  const board = boardOf([websiteItem(site, 0, 0), noteItem("n1", "delete me", 400, 0)], [], collection({ referenceCount: 1 }))
  const t = await app.session({ state: { boards: { board1: board } }, clock: true })
  const { page } = t
  const boardUrl = "/api/boards/board1"

  // The 2nd GET (the poll) is held; its body is what the server knew when it was sent: the note still exists.
  // (React strict mode makes the app load the board twice at boot, so arm the hold only after the board is on screen.)
  const release = gate()
  let armed = false
  let held = false
  t.on("GET", boardUrl, async () => {
    if (!armed || held) return undefined
    held = true
    const snapshot = structuredClone(t.state.boards.board1!)
    await release.opened
    return { json: snapshot }
  })
  // The delete succeeds on the server.
  t.on("DELETE", "/api/boards/board1/notes/n1", () => {
    t.state.boards.board1!.items = t.state.boards.board1!.items.filter((i) => i.id !== "n1")
    return { json: { ok: true } }
  })
  await t.goto("/b/board1")
  const note = page.locator('[data-key="note:n1"]')
  await note.waitFor()

  // Poll fires (capturing site) and its response is held.
  armed = true
  await page.clock.fastForward(4500)
  await until("poll GET held", () => held)

  // Select the note and press Delete while the GET is in flight.
  await note.click()
  await page.keyboard.press("Delete")
  await until("DELETE sent", () => t.count("DELETE", "/api/boards/board1/notes/n1") === 1)
  await note.waitFor({ state: "detached" })

  release.open()
  await sleep(600)

  assert.equal(await note.count(), 0, "the deleted note came back when the stale GET response was applied")
})
