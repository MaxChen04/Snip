// Keyboard focus and the home canvas. Focus brings a tile that is out of view back onto the screen, so Tab can reach it,
// but it must never move the canvas for a control that is already in view: on a phone the capture card is almost as wide
// as the screen, and its field used to push the whole card 42 px off the right edge the moment it was tapped.
//   node --import tsx --test web/tests/browser/canvas-focus.browser.test.ts
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import type { Page } from "playwright"
import { savedPage, sleep, startApp, until, type App } from "./harness.ts"

let app: App
before(async () => {
  app = await startApp()
})
after(async () => app?.stop())

const PHONE = { width: 390, height: 844 }
const DESKTOP = { width: 1280, height: 800 }

/** A signed-in home page with `n` captured pages (an empty library shows the first-run card, with its text a phone cannot hold). */
async function home(viewport: { width: number; height: number }, n = 0) {
  const pages = Array.from({ length: n }, (_, i) => ({
    ...savedPage({ id: `p${i}`, title: `Page ${i}`, path: `/p${i}`, createdAt: new Date(Date.UTC(2026, 0, 1) - i * 60_000).toISOString() }),
    reference: { id: "ref1", title: "Example", domain: "example.com", favicon: null },
  }))
  const t = await app.session({ viewport })
  t.on("GET", "/api/pages", () => ({ json: { items: pages, nextCursor: null } }))
  t.on("GET", "/api/counts", () => ({ json: { websites: 0, pages: n, sections: 0, animations: 0, images: 0 } }))
  await t.goto("/")
  await t.page.getByLabel("Link to capture").waitFor()
  if (n) await t.page.getByRole("button", { name: "Page 0", exact: true }).waitFor()
  await sleep(300)
  return t
}

/** The capture card: the logo above its form. */
const card = (page: Page) => page.locator("[data-no-pan]").filter({ has: page.getByLabel("Link to capture") })
const within = (b: { x: number; y: number; width: number; height: number }, w: number, h: number) => b.x >= 0 && b.y >= 0 && b.x + b.width <= w && b.y + b.height <= h

test("on a phone, focusing the capture card's controls leaves the card where it is", { timeout: 60_000 }, async () => {
  const t = await home(PHONE, 12)
  const { page } = t
  const before = (await card(page).boundingBox())!
  assert.ok(within(before, PHONE.width, PHONE.height), `the card starts on the screen: ${JSON.stringify(before)}`)
  const focused = () =>
    page.evaluate<{ label: string | null; inCard: boolean; x: number; right: number }>(`(() => {
      const el = document.activeElement
      const r = el.getBoundingClientRect()
      return { label: el.getAttribute("aria-label"), inCard: !!el.closest("form"), x: r.x, right: r.right }
    })()`)

  // Tab from the canvas goes to the card first: the field, then the buttons beside it. Keyboard focus is what counts as
  // focus-visible for a button, and for a tapped field too.
  await page.getByRole("region", { name: /^All saves/ }).focus()
  await page.keyboard.press("Tab")
  assert.equal((await focused()).label, "Link to capture")
  await page.keyboard.type("example.com")
  for (let stop = 0; stop < 5; stop++) {
    // The canvas glides when it pans, so give a stray pan time to show.
    await sleep(500)
    const f = await focused()
    assert.ok(f.inCard, `stop ${stop} is in the card: ${f.label}`)
    assert.ok(f.x >= 0 && f.right <= PHONE.width, `${f.label} is on the screen: ${f.x} to ${f.right}`)
    const after = (await card(page).boundingBox())!
    assert.ok(Math.abs(after.x - before.x) < 0.5 && Math.abs(after.y - before.y) < 0.5, `the card moved when ${f.label} got focus: ${JSON.stringify(before)} then ${JSON.stringify(after)}`)
    // The stop after the card's last button is a tile, which may rightly pan the card away.
    if (stop < 4) await page.keyboard.press("Tab")
  }
  // The focused Upload images label can overlap the field. Click in that overlap, rather than relying on the
  // default center point: different system fonts put the tooltip just to either side of the field's center.
  const field = page.getByLabel("Link to capture")
  const tooltip = page.locator('[data-slot="tooltip-content"][data-open]').filter({ hasText: "Upload images" })
  await tooltip.waitFor()
  const fieldBox = (await field.boundingBox())!
  const tipBox = (await tooltip.boundingBox())!
  const left = Math.max(fieldBox.x, tipBox.x)
  const right = Math.min(fieldBox.x + fieldBox.width, tipBox.x + tipBox.width)
  const top = Math.max(fieldBox.y, tipBox.y)
  const bottom = Math.min(fieldBox.y + fieldBox.height, tipBox.y + tipBox.height)
  const point = right > left && bottom > top
    ? { x: (left + right) / 2, y: (top + bottom) / 2 }
    : { x: fieldBox.x + fieldBox.width / 2, y: fieldBox.y + fieldBox.height / 2 }
  assert.equal(await field.evaluate((el, p) => document.elementFromPoint(p.x, p.y) === el, point), true, "a control label must not intercept the URL input")
  await field.click({ position: { x: point.x - fieldBox.x, y: point.y - fieldBox.y } })
  assert.equal((await focused()).label, "Link to capture")
  await sleep(500)
  assert.ok(Math.abs((await card(page).boundingBox())!.x - before.x) < 0.5, "the card did not move for a click either")
  assert.deepEqual(t.consoleErrors, [])
})

test("Tab to a tile that is out of view pans it into view", { timeout: 60_000 }, async () => {
  const t = await home(DESKTOP, 12)
  const { page } = t
  // Page 4 is in the next column out, a few hundred px left of the card: past the screen's edge after two presses, but
  // still inside the margin the canvas keeps mounted.
  const tile = page.getByRole("button", { name: "Page 4", exact: true })
  const onScreen = async () => {
    const b = (await tile.boundingBox())!
    return b.x >= 0 && b.x + b.width <= DESKTOP.width && b.y >= 80 && b.y + b.height <= DESKTOP.height - 80
  }
  assert.equal(await onScreen(), true, "the tile starts on the screen")

  // Pan with the keyboard (320 px a press): it is also the last input used, which is what makes a script's focus() count
  // as focus-visible.
  await page.getByRole("region", { name: /^All saves/ }).focus()
  for (let i = 0; i < 2; i++) await page.keyboard.press("Shift+ArrowRight")
  await sleep(300)
  assert.equal(await onScreen(), false, "the tile is out of view after panning away")

  await tile.focus()
  await until("the canvas pans the focused tile into view", onScreen)
  // And Tab on to the next stop keeps the focused tile on the screen.
  await page.keyboard.press("Tab")
  await sleep(500)
  const next = (await page.evaluate(`(() => { const r = document.activeElement.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, label: document.activeElement.getAttribute("aria-label") } })()`)) as { x: number; y: number; width: number; height: number; label: string }
  assert.equal(next.label, "Page 5")
  assert.ok(within(next, DESKTOP.width, DESKTOP.height), `the next tile is on the screen: ${JSON.stringify(next)}`)
  assert.deepEqual(t.consoleErrors, [])
})

test("focusing the capture field brings the card back when it was panned out of view", { timeout: 60_000 }, async () => {
  const t = await home(DESKTOP, 12)
  const { page } = t
  const field = page.getByLabel("Link to capture")
  await page.getByRole("region", { name: /^All saves/ }).focus()
  for (let i = 0; i < 3; i++) await page.keyboard.press("Shift+ArrowRight")
  await sleep(300)
  const away = (await field.boundingBox())!
  assert.ok(away.x + away.width < 0, `the field is out of view: ${JSON.stringify(away)}`)

  await field.focus()
  await until("the card comes back", async () => {
    const b = await field.boundingBox()
    return !!b && within(b, DESKTOP.width, DESKTOP.height)
  })
  assert.deepEqual(t.consoleErrors, [])
})
