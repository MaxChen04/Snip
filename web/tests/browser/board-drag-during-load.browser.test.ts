// Bug 6: a drag made while a board load is in flight snaps back.
// board-canvas.tsx load() applies whatever the server sent, even though a local move (commit) happened after the GET
// was sent. Correct behaviour: the dragged item stays at the dragged position on screen.
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { boardOf, gate, noteItem, sleep, startApp, until, type App } from "./harness.ts"

let app: App
before(async () => void (app = await startApp()))
after(async () => app?.stop())

test("an item dragged while a load is in flight stays where it was dropped", async () => {
  const board = boardOf([noteItem("x", "drag me", 0, 0), noteItem("y", "other", 400, 0)])
  const t = await app.session({ state: { boards: { board1: board } } })
  const { page } = t
  const release = gate()
  let armed = false
  let held = false
  t.on("GET", "/api/boards/board1", async () => {
    if (!armed || held) return undefined
    held = true
    const snapshot = structuredClone(t.state.boards.board1!) // X at its old position
    await release.opened
    return { json: snapshot }
  })
  await t.goto("/b/board1")
  const x = page.locator('[data-key="note:x"]')
  await x.waitFor()
  await sleep(300)
  const start = (await x.boundingBox())!

  // A reload starts (what a capture, an upload or the inspector triggers) and its response is held.
  armed = true
  await page.evaluate(() => window.dispatchEvent(new Event("rs:reload")))
  await until("board GET held", () => held)

  // Drag X by 200px to the right while the GET is pending.
  const [px, py] = [start.x + start.width / 2, start.y + start.height / 2]
  await page.mouse.move(px, py)
  await page.mouse.down()
  await page.mouse.move(px + 100, py, { steps: 5 })
  await page.mouse.move(px + 200, py, { steps: 5 })
  await page.mouse.up()
  await sleep(100)
  const dropped = (await x.boundingBox())!
  assert.ok(Math.abs(dropped.x - (start.x + 200)) < 2, `precondition: the drag should have moved X by 200px (moved ${dropped.x - start.x})`)

  release.open()
  await sleep(700)

  const end = (await x.boundingBox())!
  assert.ok(Math.abs(end.x - dropped.x) < 2, `X snapped back after the held GET was applied: it was at x=${Math.round(dropped.x)}, now at x=${Math.round(end.x)} (started at ${Math.round(start.x)})`)
})
