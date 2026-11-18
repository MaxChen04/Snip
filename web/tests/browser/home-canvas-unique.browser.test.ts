// The home canvas draws each item once: however far it pans, no item shows twice, and the content never leaves the screen.
//   node --import tsx --test web/tests/browser/home-canvas-unique.browser.test.ts
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import type { Page } from "playwright"
import { savedPage, sleep, startApp, until, type App, type Req } from "./harness.ts"

let app: App
before(async () => {
  app = await startApp()
})
after(async () => app?.stop())

const VIEW = { width: 1280, height: 800 }

/** A signed-in home page whose library is `n` captured pages, served in pages of the feed like the real API. */
async function home(n: number) {
  const pages = Array.from({ length: n }, (_, i) => ({
    ...savedPage({ id: `p${i}`, title: `Page ${i}`, path: `/p${i}`, desktopHeight: [900, 1400, 700][i % 3]!, createdAt: new Date(Date.UTC(2026, 0, 1) - i * 60_000).toISOString() }),
    reference: { id: "ref1", title: "Example", domain: "example.com", favicon: null },
  }))
  const t = await app.session({ viewport: VIEW })
  t.on("GET", "/api/pages", ({ query }: Req) => {
    const from = Number(query.get("cursor") ?? 0)
    const limit = Number(query.get("limit") ?? 30)
    return { json: { items: pages.slice(from, from + limit), nextCursor: from + limit < pages.length ? String(from + limit) : null } }
  })
  t.on("GET", "/api/counts", () => ({ json: { websites: 0, pages: n, sections: 0, animations: 0, images: 0 } }))
  await t.goto("/")
  await t.page.getByRole("button", { name: "Page 0", exact: true }).waitFor()
  await sleep(300)
  return t
}

/** The labels of the tiles mounted on the canvas, and how many of them are on the screen. */
const tiles = (page: Page) =>
  page.evaluate<{ labels: string[]; onScreen: number }>(`(() => {
    const els = [...document.querySelectorAll("[aria-roledescription=canvas] button[aria-label^='Page ']")]
    const onScreen = els.filter((el) => {
      const r = el.getBoundingClientRect()
      return r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight
    }).length
    return { labels: els.map((el) => el.getAttribute("aria-label")), onScreen }
  })()`)

/** Wheel-pan the canvas by (dx, dy) screen px in steps, as a trackpad does. */
async function wheelPan(page: Page, dx: number, dy: number, steps: number) {
  await page.evaluate(`(async () => {
    const el = document.querySelector("[aria-roledescription=canvas]")
    for (let i = 0; i < ${steps}; i++) {
      el.dispatchEvent(new WheelEvent("wheel", { deltaX: ${dx / steps}, deltaY: ${dy / steps}, bubbles: true, cancelable: true }))
      await new Promise((r) => requestAnimationFrame(r))
    }
  })()`)
  await sleep(100)
}

for (const n of [3, 40, 400, 1000]) {
  test(`${n} items: panning far in every direction shows each item once, and the content stays on screen`, { timeout: 120_000 }, async () => {
    const t = await home(n)
    const { page } = t
    const seen = new Set<string>()
    const check = async (where: string) => {
      const { labels, onScreen } = await tiles(page)
      assert.equal(new Set(labels).size, labels.length, `${where}: an item is drawn twice`)
      assert.ok(onScreen > 0, `${where}: no tile on the screen`)
      for (const l of labels) seen.add(l)
    }
    await check("at the start")
    // Out to the edge and well past it in each direction, then out at the smallest zoom.
    const far = 60_000
    for (const [dx, dy, name] of [[far, 0, "right"], [-2 * far, 0, "left"], [far, far, "down"], [0, -2 * far, "up"]] as const) {
      for (let i = 0; i < 6; i++) {
        await wheelPan(page, dx / 6, dy / 6, 10)
        await check(`panning ${name}`)
      }
      // Pulled past the edge, the view springs back inside once the wheel stops.
      await sleep(800)
      await check(`after panning ${name}`)
    }
    for (let i = 0; i < 8; i++) await page.getByRole("button", { name: "Zoom out" }).click()
    await sleep(600)
    await check("zoomed out")
    assert.ok(seen.size <= n)
    if (n <= 40) assert.equal(seen.size, n, "every item was reached")

    // The way back: recenter brings the plaza, and the newest item beside it, to the middle.
    await page.getByRole("button", { name: "Recenter" }).click()
    await until("the newest item is back on the screen", async () => {
      const b = await page.getByRole("button", { name: "Page 0", exact: true }).boundingBox()
      return !!b && b.x > 0 && b.x + b.width < VIEW.width && b.y > 0 && b.y + b.height < VIEW.height
    })
    assert.deepEqual(t.consoleErrors, [])
    await page.context().close()
  })
}

test("a saved view outside the content (from before each item was drawn once) lands at its edge", { timeout: 60_000 }, async () => {
  const t = await home(40)
  const { page } = t
  // An entry saved far out (a block copy many periods away), then another place on top of it.
  await page.evaluate(`history.replaceState({ ...history.state, view: { x: 90000, y: -70000, zoom: 1 } }, ""); history.pushState({}, "", "/?filter=pages")`)
  await until("the Pages filter is on", async () => new URL(page.url()).searchParams.get("filter") === "pages")
  await page.goBack()
  await until("Back to All saves", async () => !new URL(page.url()).searchParams.get("filter"))
  await sleep(500)
  const { labels, onScreen } = await tiles(page)
  assert.ok(onScreen > 0, "tiles are on the screen")
  assert.equal(new Set(labels).size, labels.length)
  assert.deepEqual(t.consoleErrors, [])
  await page.context().close()
})
