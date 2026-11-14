// Stacking order lives on the server: a board draws its items in the order it loaded them, and bringing an item to
// the front (dragging it) saves a z above the rest, so a reload shows the same order.
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { boardOf, noteItem, sleep, startApp, until, type App } from "./harness.ts"

let app: App
before(async () => void (app = await startApp()))
after(async () => app?.stop())

test("a board stacks items as loaded, and a drag to the front is saved as z and survives a reload", async () => {
  // Bottom to top as the server orders them (by z), not by id or position.
  const board = boardOf([noteItem("b", "bottom", 300, 0, { z: 5 }), noteItem("c", "middle", 600, 0, { z: 6 }), noteItem("a", "top", 0, 0, { z: 9 })])
  const t = await app.session({ state: { boards: { board1: board } } })
  const { page } = t
  const items = "/api/boards/board1/items"
  // The mocked server stores z and orders by it, like the real one.
  t.on("PUT", items, ({ body }) => {
    for (const p of body.items) Object.assign(board.items.find((i) => i.id === p.id)!, { x: p.x, y: p.y, z: p.z })
    board.items.sort((x, y) => x.z! - y.z!)
    return { json: { ok: true } }
  })
  const stack = () => page.locator('[data-key^="note:"]').evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.key))
  await t.goto("/b/board1")
  const b = page.locator('[data-key="note:b"]')
  await b.waitFor()
  await sleep(300)
  assert.deepEqual(await stack(), ["note:b", "note:c", "note:a"], "drawn in the order the board loaded")

  const box = (await b.boundingBox())!
  const [px, py] = [box.x + box.width / 2, box.y + box.height / 2]
  await page.mouse.move(px, py)
  await page.mouse.down()
  await page.mouse.move(px + 20, py + 60, { steps: 5 })
  await page.mouse.up()
  assert.deepEqual(await stack(), ["note:c", "note:a", "note:b"], "the dragged item comes to the front")

  await until("the move is saved", () => t.count("PUT", items) === 1)
  const saved = t.list("PUT", items)[0]!.body.items
  assert.deepEqual(saved.map((p: { id: string; z: number }) => [p.id, p.z]), [["b", 10]], "only the raised item is saved, above the highest z")

  await page.evaluate(() => window.dispatchEvent(new Event("rs:reload")))
  await sleep(500)
  assert.deepEqual(await stack(), ["note:c", "note:a", "note:b"])
  await page.reload()
  await b.waitFor()
  await sleep(300)
  assert.deepEqual(await stack(), ["note:c", "note:a", "note:b"], "the order survives a reload")
  assert.equal(t.count("PUT", items), 1, "loading saves nothing")
})
