// Keyboard focus and the home canvas. Focus brings a tile that is out of view back onto the screen, so Tab can reach it.
//   node --import tsx --test web/tests/browser/canvas-focus.browser.test.ts
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { savedPage, sleep, startApp, until, type App } from "./harness.ts"

let app: App
before(async () => {
  app = await startApp()
})
after(async () => app?.stop())

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
  await t.page.getByRole("button", { name: "Add a site or images" }).waitFor()
  if (n) await t.page.getByRole("button", { name: "Page 0", exact: true }).waitFor()
  await sleep(300)
  return t
}

const within = (b: { x: number; y: number; width: number; height: number }, w: number, h: number) => b.x >= 0 && b.y >= 0 && b.x + b.width <= w && b.y + b.height <= h

test("Tab to a tile that is out of view pans it into view", { timeout: 60_000 }, async () => {
  const t = await home(DESKTOP, 12)
  const { page } = t
  // The leftmost tile fully on the screen: two presses push it past the left edge, but it stays inside the margin the
  // canvas keeps mounted. (Page 11 is left out so Tab has a next page to go to.)
  const fits = (b: { x: number; y: number; width: number; height: number } | null) =>
    !!b && b.x >= 0 && b.x + b.width <= DESKTOP.width && b.y >= 80 && b.y + b.height <= DESKTOP.height - 80
  const boxes = await Promise.all(Array.from({ length: 11 }, (_, i) => page.getByRole("button", { name: `Page ${i}`, exact: true }).boundingBox()))
  const n = boxes.reduce<number>((best, b, i) => (fits(b) && (best < 0 || b!.x < boxes[best]!.x) ? i : best), -1)
  assert.ok(n >= 0, "some tile starts on the screen")
  const tile = page.getByRole("button", { name: `Page ${n}`, exact: true })
  const onScreen = async () => fits(await tile.boundingBox())
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
  assert.equal(next.label, `Page ${n + 1}`)
  assert.ok(within(next, DESKTOP.width, DESKTOP.height), `the next tile is on the screen: ${JSON.stringify(next)}`)
  assert.deepEqual(t.consoleErrors, [])
})
