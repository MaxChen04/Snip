// How the home canvas moves: zoom and a released pan settle on the spring, a pull past the content's edge springs back
// inside, and reduced motion skips the animation. Only where the view ends up is asserted, never a frame on the way.
//   node --import tsx --test web/tests/browser/canvas-spring.browser.test.ts
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import type { Page } from "playwright"
import { savedPage, sleep, startApp, until, type App } from "./harness.ts"

let app: App
before(async () => {
  app = await startApp()
})
after(async () => app?.stop())

const VIEW = { width: 1280, height: 800 }

async function home(n: number, reducedMotion: "reduce" | "no-preference" = "no-preference") {
  const pages = Array.from({ length: n }, (_, i) => ({
    ...savedPage({ id: `p${i}`, title: `Page ${i}`, path: `/p${i}`, createdAt: new Date(Date.UTC(2026, 0, 1) - i * 60_000).toISOString() }),
    reference: { id: "ref1", title: "Example", domain: "example.com", favicon: null },
  }))
  const t = await app.session({ viewport: VIEW })
  await t.page.emulateMedia({ reducedMotion })
  t.on("GET", "/api/pages", () => ({ json: { items: pages, nextCursor: null } }))
  t.on("GET", "/api/counts", () => ({ json: { websites: 0, pages: n, sections: 0, animations: 0, images: 0 } }))
  await t.goto("/")
  await t.page.getByRole("button", { name: "Page 0", exact: true }).waitFor()
  await sleep(700)
  return t
}

/** The world's translation and zoom, as written to its transform (read back as float32, so zooms match to 1e-4). */
const view = (page: Page) =>
  page.evaluate<{ x: number; y: number; k: number }>(`(() => {
    const m = new DOMMatrix(document.querySelector("[aria-roledescription=canvas] > div").style.transform)
    return { x: m.e, y: m.f, k: m.a }
  })()`)

/** Wait until the view stops changing (the same for half a second, so a slow frame on a busy machine isn't rest), and return where it stopped. */
async function rest(page: Page) {
  let last = await view(page)
  let still = 0
  for (let i = 0; i < 80; i++) {
    await sleep(125)
    const now = await view(page)
    still = Math.abs(now.x - last.x) < 0.01 && Math.abs(now.y - last.y) < 0.01 && Math.abs(now.k - last.k) < 1e-6 ? still + 1 : 0
    if (still === 4) return now
    last = now
  }
  throw new Error("the view never came to rest")
}

const onScreen = (page: Page) =>
  page.evaluate<number>(`[...document.querySelectorAll("[aria-roledescription=canvas] button[aria-label^='Page ']")].filter((el) => {
    const r = el.getBoundingClientRect()
    return r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight
  }).length`)

test("the zoom buttons end at the zoom asked for, clicks in a row compound, and the keyboard zooms at once", { timeout: 60_000 }, async () => {
  const t = await home(40)
  const { page } = t
  const zoomIn = page.getByRole("button", { name: "Zoom in" })
  await zoomIn.click()
  assert.ok(Math.abs((await rest(page)).k - 1.25) < 1e-4)
  await zoomIn.click()
  await zoomIn.click()
  const three = await rest(page)
  assert.ok(Math.abs(three.k - 1.25 ** 3) < 1e-4, `${three.k}`)
  await page.getByRole("button", { name: /^Zoom \d+%, reset/ }).click()
  assert.ok(Math.abs((await rest(page)).k - 1) < 1e-4)
  // The keyboard's zoom is instant: the next frame is the final one.
  await page.getByRole("region", { name: /^All saves/ }).focus()
  await page.keyboard.press("-")
  await page.evaluate(`new Promise((r) => requestAnimationFrame(r))`)
  const key = await view(page)
  assert.ok(Math.abs(key.k - 0.8) < 1e-4, `${key.k}`)
  await sleep(300)
  assert.deepEqual(await view(page), key, "and nothing moves after it")
  assert.deepEqual(t.consoleErrors, [])
  await page.context().close()
})

test("a drag released past the content's edge springs back inside, and a quick one glides on", { timeout: 60_000 }, async () => {
  const t = await home(40)
  const { page } = t
  await page.getByRole("button", { name: "Hand", exact: true }).click()
  // Far to the right of the content, in one drag: the edge resists, then lets go.
  await page.mouse.move(1100, 400)
  await page.mouse.down()
  for (let i = 1; i <= 40; i++) {
    await page.mouse.move(1100 - i * 60, 400)
    await sleep(8)
  }
  await sleep(120)
  await page.mouse.up()
  await rest(page)
  assert.ok((await onScreen(page)) > 0, "tiles are on the screen after the spring back")

  // Back at the middle, a quick flick: the view keeps going after the pointer stops.
  await page.getByRole("button", { name: "Recenter" }).click()
  const start = await rest(page)
  await page.mouse.move(840, 400)
  await page.mouse.down()
  for (let i = 1; i <= 6; i++) {
    await page.mouse.move(840 + i * 20, 400)
    await sleep(8)
  }
  await page.mouse.up()
  const end = await rest(page)
  assert.ok(end.x - start.x > 140, `the view glided on: it moved ${Math.round(end.x - start.x)} px for a 120 px drag`)
  assert.deepEqual(t.consoleErrors, [])
  await page.context().close()
})

test("with reduced motion, zoom is immediate and a pull past the edge stops at it", { timeout: 60_000 }, async () => {
  const t = await home(40, "reduce")
  const { page } = t
  await page.getByRole("button", { name: "Zoom in" }).click()
  // The next frame is the final one.
  await page.evaluate(`new Promise((r) => requestAnimationFrame(r))`)
  assert.ok(Math.abs((await view(page)).k - 1.25) < 1e-4)

  await page.getByRole("button", { name: "Hand", exact: true }).click()
  await page.mouse.move(1100, 400)
  await page.mouse.down()
  for (let i = 1; i <= 40; i++) await page.mouse.move(1100 - i * 60, 400)
  const held = await view(page)
  await page.mouse.up()
  const after = await view(page)
  assert.deepEqual(after, held, "nothing moves after the release")
  assert.ok((await onScreen(page)) > 0)
  assert.deepEqual(t.consoleErrors, [])
  await page.context().close()
})

test("Back restores the saved pan and zoom exactly", { timeout: 60_000 }, async () => {
  const t = await home(40)
  const { page } = t
  await page.getByRole("button", { name: "Zoom in" }).click()
  await page.getByRole("region", { name: /^All saves/ }).focus()
  await page.keyboard.press("Shift+ArrowLeft")
  const left = await rest(page)
  await sleep(400) // the entry saves its position after a pause
  await page.evaluate(`history.pushState({}, "", "/?filter=pages")`)
  await until("the Pages filter is on", async () => new URL(page.url()).searchParams.get("filter") === "pages")
  await rest(page)
  await page.goBack()
  await until("Back to All saves", async () => !new URL(page.url()).searchParams.get("filter"))
  const back = await rest(page)
  assert.ok(Math.abs(back.x - left.x) < 0.5 && Math.abs(back.y - left.y) < 0.5 && Math.abs(back.k - left.k) < 1e-4, `${JSON.stringify(back)} is not ${JSON.stringify(left)}`)
  assert.deepEqual(t.consoleErrors, [])
  await page.context().close()
})
