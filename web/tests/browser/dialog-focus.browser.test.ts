// Keyboard focus around dialogs: Tab never leaves an open dialog, and closing one with Escape returns focus to the
// control that opened it.
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import type { Locator, Page } from "playwright"
import { boardOf, pasteOnPage, reference, savedPage, startApp, type App } from "./harness.ts"

let app: App
before(async () => void (app = await startApp()))
after(async () => app?.stop())

/** A short description of the focused element, to compare before and after. */
const focused = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null
    return el ? `${el.tagName}:${el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 30) ?? ""}` : "none"
  })

/**
 * Press a key `n` times, back to back, and list every element outside the dialog that held focus for any length of
 * time. The dialog's own focus guards (hidden spans) are not counted.
 */
const tabStaysIn = async (page: Page, dialog: Locator, key: "Tab" | "Shift+Tab", n = 30) => {
  await dialog.evaluate((d) => {
    const w = window as unknown as { leaks: string[] }
    w.leaks = []
    document.addEventListener("focusin", (e) => {
      const el = e.target as HTMLElement
      if (!d.contains(el) && !el.hasAttribute("data-base-ui-focus-guard")) w.leaks.push(`${el.tagName}:${el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 30)}`)
    })
  })
  for (let i = 0; i < n; i++) await page.keyboard.press(key)
  return page.evaluate(() => (window as unknown as { leaks: string[] }).leaks)
}

const ref = reference({ pageCount: 1 })
const withRef = async () => {
  const t = await app.session({ state: { references: { ref1: ref }, boards: { board1: boardOf() } } })
  t.on("GET", "/api/references/ref1", () => ({ json: { reference: ref, pages: [savedPage()], animations: [] } }))
  return t
}

/** The dialogs, each with the control that opens it. */
const DIALOGS = [
  {
    name: "Add (card options)",
    start: "/",
    title: "New reference",
    opener: "BUTTON:More options",
    open: (page: Page) => page.getByRole("button", { name: "More options" }).click(),
  },
  {
    name: "Add (board header)",
    start: "/b/board1",
    title: "New reference",
    opener: "BUTTON:Add website",
    open: (page: Page) => page.getByRole("button", { name: "Add website" }).first().click(),
  },
  {
    name: "Connect MCP (top bar)",
    start: "/",
    title: "Connect Snip to your agent",
    opener: "BUTTON:Connect MCP",
    open: (page: Page) => page.getByRole("button", { name: "Connect MCP" }).click(),
  },
  {
    name: "Re-capture",
    start: "/r/ref1",
    title: /Re-capture example.com/,
    opener: "BUTTON:Re-capture",
    open: (page: Page) => page.getByRole("button", { name: "Re-capture" }).click(),
  },
]

for (const d of DIALOGS) {
  test(`${d.name}: Tab and Shift+Tab stay inside, and Escape returns focus to the opener`, async () => {
    const t = await withRef()
    const { page } = t
    await t.goto(d.start)
    await d.open(page)
    const dialog = page.getByRole("dialog", { name: d.title })
    await dialog.waitFor()
    assert.deepEqual(await tabStaysIn(page, dialog, "Tab"), [], "Tab left the dialog")
    assert.deepEqual(await tabStaysIn(page, dialog, "Shift+Tab"), [], "Shift+Tab left the dialog")
    await page.keyboard.press("Escape")
    await dialog.waitFor({ state: "detached" })
    assert.equal(await focused(page), d.opener)
    assert.deepEqual(t.consoleErrors, [])
  })
}

test("Tab stays inside the Add dialog with its crawl options open", async () => {
  const t = await withRef()
  const { page } = t
  await t.goto("/b/board1")
  await page.getByRole("button", { name: "Add website" }).first().click()
  const dialog = page.getByRole("dialog", { name: "New reference" })
  await dialog.getByRole("button", { name: "Capture options" }).click()
  await dialog.getByRole("radio", { name: /Crawl site/ }).click()
  assert.deepEqual(await tabStaysIn(page, dialog, "Tab"), [])
})

test("the Add dialog opens with its URL field focused, every time it opens", async () => {
  const t = await withRef()
  const { page } = t
  await t.goto("/")
  const more = page.getByRole("button", { name: "More options" })
  for (let i = 0; i < 2; i++) {
    await more.click()
    const dialog = page.getByRole("dialog", { name: "New reference" })
    await dialog.waitFor()
    await page.getByRole("textbox", { name: "Website URL" }).waitFor()
    assert.equal(await focused(page), "INPUT:Website URL")
    await page.keyboard.press("Escape")
    await dialog.waitFor({ state: "detached" })
    assert.equal(await focused(page), "BUTTON:More options")
  }
})

test("a link pasted while a control has focus opens the Add dialog, and Escape returns focus to that control", async () => {
  const t = await withRef()
  const { page } = t
  await t.goto("/b/board1")
  const add = page.getByRole("button", { name: "Add website" }).first()
  await add.focus()
  await pasteOnPage(page, "https://linear.app")
  const dialog = page.getByRole("dialog", { name: "New reference" })
  await dialog.waitFor()
  await page.keyboard.press("Escape")
  await dialog.waitFor({ state: "detached" })
  assert.equal(await focused(page), "BUTTON:Add website")
})
