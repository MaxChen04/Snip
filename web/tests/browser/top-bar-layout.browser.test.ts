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
    const board = (await page.getByRole("button", { name: "All saves, switch board" }).boundingBox())!
    assert.ok(board.x >= 112, "native controls and navigation have breathing room")
    assert.ok(board.x + board.width + 12 <= initial.x, "navigation does not overlap search")
    await field.fill("a long search query")
    assert.deepEqual(await box(), initial, "typing never moves or resizes search")
    await page.getByRole("button", { name: "Clear search" }).click()
    assert.equal(await field.inputValue(), "")
    await page.getByRole("button", { name: "All saves, switch board" }).click()
    await page.keyboard.press("Escape")
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
  await t.page.getByRole("button", { name: "Account", exact: true }).click()
  await t.page.keyboard.press("Escape")
  assert.deepEqual(t.consoleErrors, [])
})

test("long board names truncate at the native minimum without moving search", async () => {
  const c = collection({ name: "A very long board name ".repeat(5) })
  const t = await app.session({ viewport: { width: 720, height: 480 }, state: {
    collections: [c], boards: { board1: boardOf([], [], c) },
  } })
  await t.goto("/b/board1")
  await t.page.addStyleTag({ content: macCSS() })
  const trigger = t.page.getByRole("button", { name: /switch board/ })
  await trigger.waitFor()
  const b = (await trigger.boundingBox())!
  const s = (await t.page.locator(".snip-toolbar-search").boundingBox())!
  assert.ok(b.x + b.width + 12 <= s.x)
  assert.ok(Math.abs(s.x + s.width / 2 - 360) < 1)
  await trigger.click()
  await t.page.locator('a[data-nav][href="/"]').click()
  await t.page.waitForURL(app.url + "/")
  assert.equal(new URL(t.page.url()).pathname, "/", "home remains reachable without the redundant logo")
})
