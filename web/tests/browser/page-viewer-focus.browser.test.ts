// The page viewer is a modal: Tab never leaves it, Escape closes it and returns focus to the tile that opened it, and the
// website's page behind it is hidden from the keyboard and from screen readers while it is open.
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import type { Page } from "playwright"
import { reference, savedPage, startApp, type App } from "./harness.ts"

let app: App
before(async () => void (app = await startApp()))
after(async () => app?.stop())

/** A short description of the focused element, to compare before and after. */
const focused = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null
    return el ? `${el.tagName}:${el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 30) ?? ""}` : "none"
  })

/** A page with a sidebar that has sections and an HTML snapshot, so the viewer has plenty of controls to Tab through. */
const viewerPage = savedPage({
  id: "a",
  path: "/",
  title: "Home",
  snapshotKey: "pages/a/snapshot.html",
  sections: [
    { kind: "header", label: "Top bar", y: 0, height: 80, key: "pages/a/s0.jpg" },
    { kind: "hero", label: "Big claim", y: 80, height: 500, key: "pages/a/s1.jpg" },
    { kind: "footer", label: "Links", y: 580, height: 200, key: "pages/a/s2.jpg" },
  ],
})

const website = async () => {
  const r = reference({ id: "ref1", pageCount: 2 })
  const t = await app.session({ state: { references: { ref1: r } } })
  t.on("GET", /^\/api\/references\/ref1$/, () => ({ json: { reference: r, pages: [viewerPage, savedPage({ id: "b", path: "/pricing", title: "Pricing" })], animations: [] } }))
  await t.goto("/r/ref1")
  return t
}

/** Open the viewer from its tile with the keyboard, the way a keyboard user does. */
const open = async (t: Awaited<ReturnType<typeof website>>) => {
  const { page } = t
  const opener = page.getByRole("button", { name: "Home" })
  await opener.focus()
  const before = await focused(page)
  await page.keyboard.press("Enter")
  const viewer = page.getByRole("dialog")
  await viewer.waitFor()
  await viewer.getByRole("button", { name: "Close" }).waitFor()
  return { viewer, opener: before }
}

/** The viewer's tab stops: what Tab can reach inside it. */
const FOCUSABLE = "a[href], button, input, select, textarea, [tabindex]"

test("Tab and Shift+Tab never leave the page viewer, and Escape returns focus to the tile that opened it", async () => {
  const t = await website()
  const { page } = t
  const { viewer, opener } = await open(t)
  assert.match(opener, /^BUTTON:Home/)

  // Note every focus change: what lands outside the viewer (its own focus guards are not counted), and which of its stops are visited.
  const stops = await viewer.evaluate((d, sel) => {
    const items = [...d.querySelectorAll<HTMLElement>(sel)].filter((el) => el.tabIndex >= 0 && !el.matches(":disabled") && el.checkVisibility({ visibilityProperty: true }))
    const w = window as unknown as { stops: HTMLElement[]; leaks: string[]; visited: Set<number> }
    w.stops = items
    w.leaks = []
    w.visited = new Set()
    document.addEventListener("focusin", (e) => {
      const el = e.target as HTMLElement
      if (d.contains(el)) {
        if (items.includes(el)) w.visited.add(items.indexOf(el))
      } else if (!el.hasAttribute("data-base-ui-focus-guard")) w.leaks.push(`${el.tagName}:${el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 30)}`)
    })
    return items.length
  }, FOCUSABLE)
  assert.ok(stops >= 6, `the viewer should have several stops, found ${stops}`)

  const tabbed = async (key: "Tab" | "Shift+Tab") => {
    for (let i = 0; i < stops * 2 + 3; i++) await page.keyboard.press(key)
    return page.evaluate(() => {
      const w = window as unknown as { leaks: string[]; visited: Set<number> }
      const out = { leaks: w.leaks, visited: w.visited.size }
      w.leaks = []
      w.visited = new Set()
      return out
    })
  }
  const forward = await tabbed("Tab")
  assert.deepEqual(forward.leaks, [], "Tab left the viewer")
  assert.equal(forward.visited, stops, "Tab reached every stop in the viewer, then came round")
  const backward = await tabbed("Shift+Tab")
  assert.deepEqual(backward.leaks, [], "Shift+Tab left the viewer")
  assert.equal(backward.visited, stops, "Shift+Tab reached every stop in the viewer, then came round")

  await page.keyboard.press("Escape")
  await viewer.waitFor({ state: "detached" })
  assert.equal(await focused(page), opener)
  assert.equal(new URL(page.url()).searchParams.get("page"), null)
  assert.deepEqual(t.consoleErrors, [])
})

test("the website's page behind the viewer is hidden from screen readers and does not scroll while it is open, and is back when it closes", async () => {
  const t = await website()
  const { page } = t
  const { viewer, opener } = await open(t)
  const scrollLock = () => page.evaluate(() => getComputedStyle(document.body).overflow)
  assert.equal(await scrollLock(), "hidden")
  // Assistive technology sees the viewer and nothing of the website behind it.
  assert.equal(await page.getByRole("button", { name: "Select", exact: true }).count(), 0, "the page behind is still in the accessibility tree")
  assert.equal(await page.getByRole("tab", { name: "Pages" }).count(), 0)
  const exposed = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]')!
    return [...document.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, [tabindex]")]
      .filter((el) => !dialog.contains(el) && !el.hasAttribute("data-base-ui-focus-guard") && el.tabIndex >= 0 && !el.closest("[inert], [aria-hidden='true']"))
      .map((el) => `${el.tagName}:${el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 30)}`)
  })
  assert.deepEqual(exposed, [], "controls behind the viewer are not hidden")
  // The viewer is named for the page it shows.
  await page.getByRole("dialog", { name: "Home" }).waitFor()

  await viewer.getByRole("button", { name: "Close" }).click()
  await viewer.waitFor({ state: "detached" })
  await page.getByRole("button", { name: "Select", exact: true }).waitFor()
  assert.notEqual(await scrollLock(), "hidden")
  assert.equal(await focused(page), opener)
})

test("the viewer's own keys still work inside the trap: arrows resize the sidebar, Escape in the Save popover closes only the popover", async () => {
  const t = await website()
  const { page } = t
  const { viewer } = await open(t)

  const handle = viewer.getByRole("separator", { name: "Resize sidebar" })
  await handle.focus()
  const width = async () => Number(await handle.getAttribute("aria-valuenow"))
  const before = await width()
  await page.keyboard.press("ArrowLeft")
  assert.equal(await width(), before + 16)
  await page.keyboard.press("ArrowRight")
  assert.equal(await width(), before)

  const save = viewer.getByRole("button", { name: "Save" })
  await save.click()
  await page.getByText("This page stays in its website too.").waitFor()
  await page.keyboard.press("Escape")
  await page.getByText("This page stays in its website too.").waitFor({ state: "detached" })
  assert.equal(await viewer.count(), 1, "Escape in the popover closed the viewer too")
  assert.equal(await focused(page), "BUTTON:Save")

  await page.keyboard.press("Escape")
  await viewer.waitFor({ state: "detached" })
})
