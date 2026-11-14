// Bug 8: a drag made while a group is being created un-groups the item.
// board-canvas.tsx: dragging an item while POST /groups is pending queues a placement with the old groupId (null).
// makeGroup() then sets the new groupId on the node in state, but the queued placement is not touched, so the 400 ms
// flush PUTs groupId:null and the server drops the item out of the group it was just put in.
// Correct behaviour: the PUT that saves the item's placement carries the new group's id.
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { boardOf, gate, noteItem, sleep, startApp, until, type App } from "./harness.ts"

let app: App
before(async () => void (app = await startApp()))
after(async () => app?.stop())

test("moving an item while its group is being created keeps it in the new group", async () => {
  const board = boardOf([noteItem("a", "first", 0, 0), noteItem("b", "second", 260, 0)])
  const t = await app.session({ state: { boards: { board1: board } } })
  const { page } = t
  const created = gate()
  t.on("POST", "/api/boards/board1/groups", async (req) => {
    await created.opened
    return { json: { id: "newgroup", name: req.body.name, x: req.body.x, y: req.body.y, w: req.body.w, h: req.body.h } }
  })
  await t.goto("/b/board1")
  const a = page.locator('[data-key="note:a"]')
  await a.waitFor()
  await sleep(300)

  // Select both notes and group them (G); the group POST is held.
  await page.mouse.click(5, 400) // focus the page body, off any item
  await page.keyboard.press("Control+a")
  await page.keyboard.press("g")
  await until("group POST in flight", () => t.count("POST", "/api/boards/board1/groups") === 1)

  // Drag note A a little while the POST is pending, then let the POST finish straight away.
  await page.keyboard.press("Escape") // so the drag moves only A
  const box = (await a.boundingBox())!
  const [px, py] = [box.x + box.width / 2, box.y + box.height / 2]
  await page.mouse.move(px, py)
  await page.mouse.down()
  await page.mouse.move(px + 15, py + 10, { steps: 4 })
  await page.mouse.move(px + 30, py + 20, { steps: 4 })
  await page.mouse.up()
  created.open()

  await page.locator('[data-frame="newgroup"]').waitFor() // the group exists on the canvas now

  // Wait for the debounced save (400 ms) to go out.
  await until("PUT /items with note A", () => t.list("PUT", "/api/boards/board1/items").some((r) => r.body.items.some((i: any) => i.id === "a")), 4000)
  const put = t.list("PUT", "/api/boards/board1/items").flatMap((r) => r.body.items as { id: string; groupId: string | null; x: number; y: number }[]).filter((i) => i.id === "a").at(-1)!
  assert.equal(put.groupId, "newgroup", `the saved placement of A has groupId ${JSON.stringify(put.groupId)}, so the server would take A out of the group that was just created`)
})

test("a move is not saved while the group is still being created, so it cannot land with the old group", async () => {
  const board = boardOf([noteItem("a", "first", 0, 0), noteItem("b", "second", 260, 0)])
  const t = await app.session({ state: { boards: { board1: board } } })
  const { page } = t
  const created = gate()
  t.on("POST", "/api/boards/board1/groups", async (req) => {
    await created.opened
    return { json: { id: "newgroup", name: req.body.name, x: req.body.x, y: req.body.y, w: req.body.w, h: req.body.h } }
  })
  await t.goto("/b/board1")
  const a = page.locator('[data-key="note:a"]')
  await a.waitFor()
  await sleep(300)
  await page.mouse.click(5, 400)
  await page.keyboard.press("Control+a")
  await page.keyboard.press("g")
  await until("group POST in flight", () => t.count("POST", "/api/boards/board1/groups") === 1)

  await a.focus()
  await page.keyboard.press("ArrowRight")
  await sleep(900) // well past the 400 ms debounce, the POST still unanswered
  const puts = () => t.list("PUT", "/api/boards/board1/items").flatMap((r) => r.body.items as { id: string; groupId: string | null }[]).filter((i) => i.id === "a")
  assert.deepEqual(puts(), [], "A was saved before the server answered the group POST")

  created.open()
  await until("A saved", () => puts().length > 0, 4000)
  assert.deepEqual(puts().map((i) => i.groupId), ["newgroup"])
})
