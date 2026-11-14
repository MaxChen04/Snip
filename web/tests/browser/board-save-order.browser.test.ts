// Overlapping layout saves must not land out of order: while one PUT /items is unanswered, the next waits for it.
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { boardOf, gate, noteItem, sleep, startApp, until, type App } from "./harness.ts"

let app: App
before(async () => void (app = await startApp()))
after(async () => app?.stop())

test("a second layout save is not sent until the first has been answered", async () => {
  const t = await app.session({ state: { boards: { board1: boardOf([noteItem("a", "move me", 0, 0)]) } } })
  const { page } = t
  const items = "/api/boards/board1/items"
  const release = gate()
  let held = false
  t.on("PUT", items, async () => {
    if (held) return undefined
    held = true
    await release.opened
    return { json: { ok: true } }
  })
  await t.goto("/b/board1")
  const a = page.locator('[data-key="note:a"]')
  await a.waitFor()
  await sleep(300)

  await a.focus()
  await page.keyboard.press("ArrowRight") // 8px
  await until("first save held", () => held)
  await page.keyboard.press("ArrowRight")
  await sleep(900) // well past the 400 ms debounce
  assert.equal(t.count("PUT", items), 1, "the second save went out while the first was still unanswered")

  release.open()
  await until("second save sent", () => t.count("PUT", items) === 2)
  assert.deepEqual(t.list("PUT", items).map((r) => r.body.items[0].x), [8, 16])
})
