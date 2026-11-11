// Bug 7: locked items move with their frame.
// board-canvas.tsx titleDown() passes every item whose groupId is the frame (locked or not) to beginDrag, and
// board-layout.ts moveOnBoard() moves anything "riding" with a dragged frame. Only direct item drags go through
// unlocked(). Correct behaviour: dragging the frame by its title leaves a locked item where it is, and a locked
// item the frame left behind is no longer in it: membership follows position.
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
  const puts = t.list("PUT", "/api/boards/board1/items").flatMap((r) => r.body.items as { id: string; x: number; y: number; groupId: string | null }[])
  const savedPinned = puts.find((p) => p.id === "pinned")
  assert.deepEqual(
    { moved: [Math.round(after.x - before.x), Math.round(after.y - before.y)], saved: savedPinned && [savedPinned.x, savedPinned.y], group: savedPinned?.groupId },
    { moved: [0, 0], saved: [260, 52], group: null },
    "the locked note moved with the frame (on screen by `moved`, or saved at `saved` instead of its stored 260,52), or it was not saved out of the frame (`group`)",
  )
  assert.equal(puts.findLast((p) => p.id === "free")?.groupId, "g1", "the unlocked note left the frame it moved with")
})

test("an item dropped into a frame does not stretch it back over a locked item it left behind", async () => {
  const items = [
    noteItem("free", "free note", 16, 52, { groupId: "g1" }),
    noteItem("pinned", "locked note", 260, 52, { groupId: "g1", style: { locked: true } }),
    noteItem("other", "other note", 900, 52),
  ]
  const board = boardOf(items, [frame("g1", 0, 0, 476, 228, "Frame")])
  const t = await app.session({ state: { boards: { board1: board } } })
  const { page } = t
  await t.goto("/b/board1")
  const pinned = page.locator('[data-key="note:pinned"]')
  const other = page.locator('[data-key="note:other"]')
  const frameBox = page.locator('[data-frame="g1"]')
  await pinned.waitFor()
  await sleep(300)
  const pinnedBefore = (await pinned.boundingBox())!

  const drag = async (from: { x: number; y: number }, by: { x: number; y: number }) => {
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(from.x + by.x / 2, from.y + by.y / 2, { steps: 5 })
    await page.mouse.move(from.x + by.x, from.y + by.y, { steps: 5 })
    await page.mouse.up()
  }
  // The frame, by its title row, well clear of the locked note; then let that save go out.
  const title = (await page.locator('[data-frame="g1"] > div').first().boundingBox())!
  await drag({ x: title.x + 40, y: title.y + title.height / 2 }, { x: 0, y: 400 })
  await until("frame moved away", async () => (await frameBox.boundingBox())!.y > pinnedBefore.y + pinnedBefore.height)
  await sleep(900)
  const away = (await frameBox.boundingBox())!

  // Another note, into the middle of the frame: it joins, and the frame grows to fit what is in it.
  const note = (await other.boundingBox())!
  await drag({ x: note.x + note.width / 2, y: note.y + note.height / 2 }, { x: away.x + away.width / 2 - (note.x + note.width / 2), y: away.y + away.height / 2 - (note.y + note.height / 2) })
  await sleep(900)

  const puts = t.list("PUT", "/api/boards/board1/items").flatMap((r) => r.body.items as { id: string; groupId: string | null }[])
  assert.equal(puts.findLast((p) => p.id === "other")?.groupId, "g1", "the dropped note did not join the frame")
  assert.equal(puts.findLast((p) => p.id === "pinned")?.groupId, null, "the locked note is a member again")
  const grown = (await frameBox.boundingBox())!
  const pinnedAfter = (await pinned.boundingBox())!
  assert.deepEqual([pinnedAfter.x, pinnedAfter.y], [pinnedBefore.x, pinnedBefore.y], "the locked note moved")
  assert.ok(grown.y >= pinnedAfter.y + pinnedAfter.height, `the frame (top ${grown.y}) stretched back over the locked note (bottom ${pinnedAfter.y + pinnedAfter.height})`)
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
