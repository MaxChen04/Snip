// Bug 7: locked items move with their frame.
// board-canvas.tsx titleDown() passes every item whose groupId is the frame (locked or not) to beginDrag, and
// board-layout.ts moveOnBoard() moves anything "riding" with a dragged frame. Only direct item drags go through
// unlocked(). Correct behaviour: dragging the frame by its title leaves a locked item where it is.
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { boardOf, frame, gate, noteItem, sleep, startApp, until, type App } from "./harness.ts"

let app: App
before(async () => void (app = await startApp()))
after(async () => app?.stop())

test("dragging a frame by its title does not move a locked item inside it", async () => {
  const items = [
    noteItem("free", "free note", 16, 52, { groupId: "g1" }),
    noteItem("pinned", "locked note", 260, 52, { groupId: "g1", style: { locked: true } }),
  ]
  const board = boardOf(items, [frame("g1", 0, 0, 476, 228, "Frame")])
  const t = await app.session({ state: { boards: { board1: board } } })
  const { page } = t
  await t.goto("/b/board1")
  const pinned = page.locator('[data-key="note:pinned"]')
  const free = page.locator('[data-key="note:free"]')
  await pinned.waitFor()
  await sleep(300)
  const before = (await pinned.boundingBox())!
  const freeBefore = (await free.boundingBox())!

  // Drag the frame by its title row, 200px right and 120px down.
  const title = (await page.locator('[data-frame="g1"] > div').first().boundingBox())!
  const [x, y] = [title.x + 40, title.y + title.height / 2]
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 100, y + 60, { steps: 5 })
  await page.mouse.move(x + 200, y + 120, { steps: 5 })
  await page.mouse.up()

  // The unlocked sibling rides with the frame (sanity: the drag really happened).
  await until("free note moved with the frame", async () => Math.abs((await free.boundingBox())!.x - (freeBefore.x + 200)) < 2)
  // Let the layout save go out (400 ms debounce).
  await sleep(900)

  const after = (await pinned.boundingBox())!
  const puts = t.list("PUT", "/api/boards/board1/items").flatMap((r) => r.body.items as { id: string; x: number; y: number }[])
  const savedPinned = puts.find((p) => p.id === "pinned")
  assert.deepEqual(
    { moved: [Math.round(after.x - before.x), Math.round(after.y - before.y)], saved: savedPinned ? [savedPinned.x, savedPinned.y] : [260, 52] }, // not saved at all is fine too
    { moved: [0, 0], saved: [260, 52] },
    "the locked note moved with the frame (on screen by `moved` px, and it was saved at `saved` instead of its stored 260,52)",
  )
})

test("a selection with a locked item is not grouped, and pressing G twice makes one frame", async () => {
  const board = boardOf([noteItem("a", "first", 0, 0), noteItem("b", "second", 260, 0), noteItem("pinned", "locked note", 520, 0, { style: { locked: true } })])
  const t = await app.session({ state: { boards: { board1: board } } })
  const { page } = t
  const groups = "/api/boards/board1/groups"
  const created = gate()
  t.on("POST", groups, async (req) => {
    await created.opened
    return { json: { id: "newgroup", name: req.body.name, x: req.body.x, y: req.body.y, w: req.body.w, h: req.body.h } }
  })
  await t.goto("/b/board1")
  await page.locator('[data-key="note:a"]').waitFor()
  await sleep(300)

  // Everything, the locked note included: G does nothing.
  await page.mouse.click(5, 400)
  await page.keyboard.press("Control+a")
  await page.keyboard.press("g")
  await sleep(300)
  assert.equal(t.count("POST", groups), 0, "a locked item was grouped")

  // The two free notes: G twice while the first request is unanswered.
  await page.keyboard.press("Escape")
  await page.locator('[data-key="note:a"]').click()
  await page.locator('[data-key="note:b"]').click({ modifiers: ["Shift"] })
  await page.keyboard.press("g")
  await until("group POST in flight", () => t.count("POST", groups) === 1)
  await page.keyboard.press("g")
  await sleep(300)
  created.open()
  await page.locator('[data-frame="newgroup"]').waitFor()
  await sleep(300)
  assert.equal(t.count("POST", groups), 1, "pressing G twice made two frames")
  assert.deepEqual(t.list("POST", groups)[0]!.body.items.map((i: { id: string }) => i.id).sort(), ["a", "b"])
})
