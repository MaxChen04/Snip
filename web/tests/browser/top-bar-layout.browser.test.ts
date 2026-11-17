import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { createRequire } from "node:module"
import { boardOf, collection, startApp, type App } from "./harness.ts"

const require = createRequire(import.meta.url)
const { installWindowChrome } = require("../../../desktop/window-chrome.cjs")
let app: App
before(async () => { app = await startApp() })
after(async () => app?.stop())

// Use the production injected CSS, replacing only the native environment
// variable unavailable in Chromium with the measured desktop safe-area width.
function macCSS() {
  let css = ""
  installWindowChrome({ webContents: {
    on: (_: string, ready: () => void) => ready(),
    insertCSS: (value: string) => { css = value; return Promise.resolve() },
  } }, "darwin")
  return css.replaceAll("env(titlebar-area-x, 0px)", "96px")
}

for (const width of [720, 900, 1280, 1728]) {
  test(`Mac header is centered and separated at ${width}px`, async () => {
    const t = await app.session({ viewport: { width, height: 800 } })
    await t.goto("/")
    const { page } = t
    await page.addStyleTag({ content: macCSS() })
    const field = page.getByRole("textbox", { name: /^Search your saves/ })
    await field.waitFor()
    const box = () => page.locator(".snip-toolbar-search").boundingBox()
    const initial = (await box())!
    assert.ok(Math.abs(initial.x + initial.width / 2 - width / 2) < 1)
    assert.equal(await page.getByRole("button", { name: /switch board/ }).count(), 0, "boards live in the filter dock, not the header")
    assert.equal(await page.getByRole("link", { name: "Snip home" }).isVisible(), false, "the Mac lane holds only the traffic lights")
    const lane = (await page.locator(".snip-toolbar-leading").boundingBox())!
    assert.ok(lane.x + lane.width + 12 <= initial.x, "the leading lane does not reach search")
    assert.equal(await page.locator(".snip-toolbar-leading").evaluate((el) => getComputedStyle(el).paddingLeft), "88px", "the leading lane reserves traffic-light space")
    await field.fill("a long search query")
    assert.deepEqual(await box(), initial, "typing never moves or resizes search")
    await page.getByRole("button", { name: "Clear search" }).click()
    assert.equal(await field.inputValue(), "")
    assert.deepEqual(t.consoleErrors, [])
  })
}

test("small web windows reflow search without losing controls", async () => {
  const t = await app.session({ viewport: { width: 375, height: 740 } })
  await t.goto("/")
  const search = t.page.locator(".snip-toolbar-search")
  await search.waitFor()
  const b = (await search.boundingBox())!
  assert.ok(b.x >= 0 && b.x + b.width <= 375)
  assert.ok(b.y >= 64)
  assert.ok(await t.page.getByRole("link", { name: "Snip home" }).isVisible(), "web keeps its logo")
  await t.page.getByRole("button", { name: "Account", exact: true }).click()
  await t.page.keyboard.press("Escape")
  assert.deepEqual(t.consoleErrors, [])
})

test("web keeps the logo home link clear of centered search", async () => {
  const t = await app.session({ viewport: { width: 1280, height: 800 } })
  await t.goto("/")
  const logo = t.page.getByRole("link", { name: "Snip home" })
  await logo.waitFor()
  const l = (await logo.boundingBox())!
  const s = (await t.page.locator(".snip-toolbar-search").boundingBox())!
  assert.ok(l.x + l.width + 12 <= s.x)
  assert.ok(Math.abs(s.x + s.width / 2 - 640) < 1)
})

test("on a board the dock's boards button names the board and goes back to All saves", async () => {
  const c = collection({ name: "A very long board name ".repeat(5) })
  const t = await app.session({ viewport: { width: 720, height: 480 }, state: {
    collections: [c], boards: { board1: boardOf([], [], c) },
  } })
  await t.goto("/b/board1")
  await t.page.addStyleTag({ content: macCSS() })
  const boards = t.page.getByRole("toolbar", { name: "Filter saves" }).getByRole("button", { name: `Boards, in ${c.name}` })
  await boards.waitFor()
  const s = (await t.page.locator(".snip-toolbar-search").boundingBox())!
  assert.ok(Math.abs(s.x + s.width / 2 - 360) < 1)
  await boards.click()
  await t.page.locator('a[data-nav][href="/"]').click()
  await t.page.waitForURL(app.url + "/")
  assert.equal(new URL(t.page.url()).pathname, "/", "All saves stays reachable from an empty board")
  await t.page.getByRole("toolbar", { name: "Filter saves" }).getByRole("button", { name: "Boards, in All saves" }).waitFor()
})

test("a board that fails to load still offers a way back to All saves", async () => {
  const t = await app.session({ state: { boards: { board1: boardOf() } } })
  t.on("GET", "/api/boards/board1", () => ({ status: 500, json: {} }))
  await t.goto("/b/board1")
  await t.page.getByRole("button", { name: "Try again" }).waitFor()
  await t.page.getByRole("link", { name: "Go to All saves" }).click()
  await t.page.waitForURL(app.url + "/")
})
