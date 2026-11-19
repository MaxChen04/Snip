import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import type { Page } from "playwright"
import { reference, savedPage, startApp, until, type App } from "./harness.ts"
import { mockLibrary, oneSite } from "./site-library.ts"

let app: App
before(async () => { app = await startApp() })
after(async () => app?.stop())

async function home() {
  const ref = reference({ pageCount: 3 })
  const lib = oneSite(ref, [
    savedPage({ id: "a", title: "Alpha sample", path: "/a", createdAt: "2026-01-03T00:00:00Z" }),
    savedPage({ id: "b", title: "Beta sample", path: "/b", createdAt: "2026-01-02T00:00:00Z" }),
    savedPage({ id: "c", title: "Gamma sample", path: "/c", createdAt: "2026-01-01T00:00:00Z" }),
  ])
  const t = await app.session({ viewport: { width: 1440, height: 900 } })
  t.on("GET", /^\/api\//, mockLibrary(lib))
  await t.page.emulateMedia({ reducedMotion: "reduce" })
  await t.goto("/")
  await until("three positions were seeded", () => t.state.libraryPositions.positions.length === 3)
  return t
}

const tile = (page: Page, id: string) => page.locator(`[data-gallery-tile="page:${id}"]`)
const at = (page: Page, id: string) => tile(page, id).evaluate((node) => {
  const { left, top } = (node as HTMLElement).style
  return [Number.parseFloat(left), Number.parseFloat(top)]
})
const moveRequests = (t: Awaited<ReturnType<typeof home>>) => t.requests.filter((r) => r.method === "PUT" && r.path === "/api/library-positions")

test("one group move persists, Escape cancels the next drag, and undo and redo work across compact views", async () => {
  const t = await home()
  const { page } = t
  const before = await Promise.all([at(page, "a"), at(page, "b")])
  await tile(page, "a").click()
  await tile(page, "b").press("Shift+Space")
  assert.equal(await tile(page, "a").getAttribute("aria-pressed"), "true")
  assert.equal(await tile(page, "b").getAttribute("aria-pressed"), "true")

  const a = (await tile(page, "a").boundingBox())!
  await page.mouse.move(a.x + a.width / 2, a.y + 3)
  await page.mouse.down()
  await page.mouse.move(a.x + a.width / 2 + 48, a.y + 3, { steps: 6 })
  await until("the actual tile lifts before the drop", () => tile(page, "a").getAttribute("data-moving"))
  await page.mouse.up()
  await until("a single group write", () => moveRequests(t).length === 1)
  assert.deepEqual(moveRequests(t)[0]!.body.positions.map((p: { id: string }) => p.id).sort(), ["a", "b"])
  const moved = await Promise.all([at(page, "a"), at(page, "b")])
  assert.notDeepEqual(moved, before)
  assert.equal(moved[0]![0]! - before[0]![0]!, moved[1]![0]! - before[1]![0]!)

  const next = (await tile(page, "a").boundingBox())!
  await page.mouse.move(next.x + next.width / 2, next.y + 3)
  await page.mouse.down()
  await page.mouse.move(next.x + next.width / 2 + 65, next.y + 3, { steps: 4 })
  await page.keyboard.press("Escape")
  await page.mouse.up()
  assert.equal(moveRequests(t).length, 1)

  await page.getByRole("button", { name: /^Pages\b/ }).click()
  await until("the compact layout differs from free placement", async () => {
    const compact = await at(page, "a")
    return compact[0] !== moved[0]![0] || compact[1] !== moved[0]![1]
  })
  await page.getByRole("toolbar", { name: "Filter saves" }).getByRole("button", { name: /^All(?:,|$)/ }).click()
  await until("All saves restores the move", async () => JSON.stringify(await at(page, "a")) === JSON.stringify(moved[0]))
  await page.keyboard.press("Control+z")
  await until("undo persists as one group write", () => moveRequests(t).length === 2)
  assert.deepEqual(await at(page, "a"), before[0])
  await page.keyboard.press("Control+Shift+z")
  await until("redo persists as one group write", () => moveRequests(t).length === 3)
  assert.deepEqual(await at(page, "a"), moved[0])
  await page.reload()
  assert.deepEqual(await at(page, "a"), moved[0])
  assert.deepEqual(await at(page, "b"), moved[1])
  assert.deepEqual(t.consoleErrors, [])
  await page.context().close()
})

test("a stale move yields to the other window's layout, and compact pages do not use saved positions", async () => {
  const t = await home()
  const { page } = t
  const saved = t.state.libraryPositions.positions.find((p) => p.id === "a")!
  const other = { ...saved, x: saved.x + 75 }
  t.on("PUT", "/api/library-positions", () => {
    const previous = t.state.libraryPositions
    t.state.libraryPositions = { version: previous.version + 1, positions: previous.positions.map((p) => p.id === "a" ? other : p) }
    return { status: 409, json: { error: "The library layout changed" } }
  })
  await tile(page, "a").click()
  await page.keyboard.press("Alt+ArrowRight")
  await page.getByText("The layout changed in another window.", { exact: false }).waitFor()
  await until("the other window's position is displayed", async () => (await at(page, "a"))[0] === other.x)
  await page.keyboard.press("Control+z")
  assert.equal(moveRequests(t).length, 1)

  const calls = () => t.requests.filter(({ path }) => path.startsWith("/api/library-positions")).length
  const known = calls()
  await t.goto("/?filter=pages")
  await tile(page, "a").waitFor()
  assert.notEqual((await at(page, "a"))[0], other.x)
  assert.equal(calls(), known)
  assert.deepEqual(t.consoleErrors, [])
  await page.context().close()
})
