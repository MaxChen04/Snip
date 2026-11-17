// The dock is the way to every board, so it never waits on data it doesn't need: a stalled count or board request still
// leaves the user a way to another board.
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { boardOf, collection, gate, startApp, until, type App } from "./harness.ts"

let app: App
before(async () => void (app = await startApp()))
after(async () => app?.stop())

const boards = () => {
  const one = collection({ id: "board1", name: "Moodboard" })
  const two = collection({ id: "board2", name: "Second" })
  return { collections: [one, two], boards: { board1: boardOf([], [], one), board2: boardOf([], [], two) } }
}

for (const [where, start, held] of [
  ["All saves while its counts are pending", "/", "/api/counts"],
  ["a board while it is still loading", "/b/board1", "/api/boards/board1"],
] as const) {
  test(`on ${where}, the dock still opens another board`, async () => {
    const t = await app.session({ state: boards() })
    const hold = gate()
    t.on("GET", held, async () => {
      await hold.opened
      return undefined
    })
    await t.goto(start)
    const { page } = t
    await page.getByRole("button", { name: /^Boards, in / }).click()
    await page.getByRole("link", { name: /^Second/ }).click()
    await until("on the other board", () => new URL(page.url()).pathname === "/b/board2")
    assert.equal(t.count("GET", held) > 0, true)
    hold.open()
  })
}
