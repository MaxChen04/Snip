import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import type { Page } from "playwright"
import { savedPage, sleep, startApp, until, type App } from "./harness.ts"

let app: App
before(async () => { app = await startApp() })
after(async () => { await app?.stop() })

const selector = "[aria-roledescription=canvas]"
const camera = (page: Page) => page.evaluate(
  (canvas) => {
    const world = document.querySelector<HTMLElement>(canvas + " > div")!
    const matrix = new DOMMatrix(world.style.transform)
    return { x: matrix.e, y: matrix.f, k: matrix.a }
  },
  selector,
)
const frame = (page: Page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => done())))
const wheel = (page: Page, x: number, y: number, ctrl = false, clientX = 700, clientY = 240) => page.locator(selector).dispatchEvent(
  "wheel", { deltaX: x, deltaY: y, deltaMode: 0, ctrlKey: ctrl, clientX, clientY, bubbles: true, cancelable: true },
)
const tile = (page: Page) => page.getByRole("button", { name: "Gesture sample", exact: true })
const lift = (page: Page) => tile(page).getAttribute("data-moving")
const showEvidence = async (page: Page, filename: string) => {
  if (process.env.SNIP_GESTURE_RENDERS) await page.screenshot({ path: process.env.SNIP_GESTURE_RENDERS + "/" + filename })
}

async function gallery(compact = false) {
  const t = await app.session({
    state: { libraryPositions: { version: 0, positions: [{ kind: "page", id: "page1", x: 95, y: -180 }] } },
  })
  await t.page.emulateMedia({ reducedMotion: "reduce" })
  const item = savedPage({ title: "Gesture sample" })
  t.on("GET", "/api/pages", () => ({ json: { items: [{ ...item, reference: { id: "ref1", title: "Example", domain: "example.com", favicon: null } }], nextCursor: null } }))
  t.on("GET", "/api/counts", () => ({ json: { websites: 0, pages: 1, sections: 0, animations: 0, images: 0 } }))
  await t.goto(compact ? "/?filter=pages" : "/")
  await tile(t.page).waitFor()
  if (!compact) await until("free placement ready", () => t.page.getByRole("button", { name: "Arrow", exact: true }).getAttribute("title").then(title => title?.includes("drag")))
  await frame(t.page)
  return t
}

test("Arrow selects and inspects, Space temporarily pans, and Escape rolls an active pan back", { timeout: 30_000 }, async () => {
  const t = await gallery()
  const { page } = t
  const target = tile(page)
  await target.click()
  assert.equal(await target.getAttribute("aria-pressed"), "true")
  assert.equal(await target.evaluate((button) => button === document.activeElement && !button.matches(":focus-visible")), true)
  assert.equal(new URL(page.url()).searchParams.has("open"), false)
  const before = await camera(page)
  const box = (await target.boundingBox())!
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.keyboard.down("Space")
  assert.equal(await page.locator(selector).getAttribute("data-gallery-cursor"), "grab")
  await page.mouse.down()
  await page.keyboard.up("Space")
  await page.mouse.move(x + 36, y + 12)
  await frame(page)
  assert.notDeepEqual(await camera(page), before)
  await page.keyboard.press("Escape")
  assert.deepEqual(await camera(page), before)
  await page.mouse.up()
  assert.equal(await target.getAttribute("aria-pressed"), "true")
  await target.dblclick()
  await until("double click opens the inspector", () => new URL(page.url()).searchParams.has("open"))
  assert.deepEqual(t.consoleErrors, [])
  await page.context().close()
})

test("touch tap selects, then a second finger cancels a primed tile and drains after pinch", { timeout: 30_000 }, async () => {
  const t = await gallery()
  const { page } = t
  const target = tile(page)
  const box = (await target.boundingBox())!
  const first = { x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 }
  const second = { x: first.x + 110, y: first.y, id: 2 }
  const cdp = await page.context().newCDPSession(page)
  const touch = (type: "touchStart" | "touchEnd" | "touchMove", ...touchPoints: Array<typeof first>) =>
    cdp.send("Input.dispatchTouchEvent", { type, touchPoints })
  await touch("touchStart", first)
  await touch("touchEnd")
  assert.equal(await target.getAttribute("aria-pressed"), "true")
  await touch("touchStart", first)
  await until("long press primes the tile", () => lift(page))
  await touch("touchStart", first, second)
  assert.equal(await lift(page), null)
  const start = await camera(page)
  await touch("touchMove", first, { ...second, x: second.x + 60 })
  await frame(page)
  const pinched = await camera(page)
  assert.ok(pinched.k > start.k)
  await touch("touchEnd", first)
  const settled = await camera(page)
  await touch("touchMove", { ...first, x: first.x + 80 })
  await touch("touchEnd")
  await frame(page)
  assert.deepEqual(await camera(page), settled)
  assert.equal(await target.getAttribute("aria-pressed"), "true")
  assert.deepEqual(t.consoleErrors, [])
  await page.context().close()
})

for (const compact of [false, true]) {
  test(`a touch-only double tap opens the inspector in ${compact ? "compact Pages" : "All saves"}`, async () => {
    const t = await gallery(compact)
    const { page } = t
    const target = tile(page)
    const box = (await target.boundingBox())!
    const finger = { x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 }
    const cdp = await page.context().newCDPSession(page)
    for (let i = 0; i < 2; i++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [finger] })
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
      if (i === 0) {
        assert.equal(await target.getAttribute("aria-pressed"), "true")
        assert.equal(new URL(page.url()).searchParams.has("open"), false)
      }
    }
    await until("the inspector opens without a keyboard", () => new URL(page.url()).searchParams.has("open"))
    assert.deepEqual(t.consoleErrors, [])
    await page.context().close()
  })
}

test("wheel locks to pan or Ctrl pinch; either moves the camera while an edge carries a tile", { timeout: 30_000 }, async () => {
  const t = await gallery()
  const { page } = t
  const target = tile(page)
  const box = (await target.boundingBox())!
  const x = box.x + 3
  const y = box.y + box.height / 2
  await showEvidence(page, "gallery-carry-before.png")
  await page.mouse.move(x, y)
  assert.equal(await page.locator(selector).getAttribute("data-gallery-cursor"), "grab")
  await page.mouse.down()
  await page.mouse.move(x + 6, y)
  await until("tile lifts", () => lift(page))
  const down = await camera(page)
  await wheel(page, 18, -14)
  await wheel(page, 0, -60, true)
  await frame(page)
  const panned = await camera(page)
  assert.equal(panned.k, down.k)
  assert.equal(panned.x, down.x - 18)
  assert.equal(panned.y, down.y + 14)
  const carried = (await target.boundingBox())!
  assert.ok(Math.abs(carried.x - box.x - 6) < 1, `the grabbed point stays under the stationary pointer during pan: ${carried.x - box.x}px delta`)
  await sleep(180)
  await wheel(page, 0, -30, true, x + 6, y)
  await frame(page)
  const zoomed = await camera(page)
  assert.ok(zoomed.k > panned.k)
  assert.ok(Math.abs((await target.boundingBox())!.x + (x - box.x) * zoomed.k / down.k - (x + 6)) < 1, "pinch also preserves the grabbed point")
  await showEvidence(page, "gallery-carry.png")
  await page.mouse.move(1270, y)
  const edgeStart = (await camera(page)).x
  await until("edge auto-pans while pointer is stationary", async () => (await camera(page)).x < edgeStart - 20)
  const atEdge = (await target.boundingBox())!
  assert.ok(Math.abs(atEdge.x + (x - box.x) * zoomed.k / down.k - 1270) < 1)
  await page.keyboard.press("Escape")
  await page.mouse.up()
  assert.deepEqual(await camera(page), down)
  assert.equal(await lift(page), null)
  assert.equal(t.requests.filter((r) => r.method === "PUT" && r.path === "/api/library-positions").length, 0)
  assert.deepEqual(t.consoleErrors, [])
  await page.context().close()
})

test("a continuous pinch reverses immediately at the gallery's zoom limit", async () => {
  const t = await gallery()
  const { page } = t
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await page.locator(selector).evaluate((el) => {
    for (const deltaY of [...Array(20).fill(80), -40]) {
      el.dispatchEvent(new WheelEvent("wheel", { ctrlKey: true, deltaY, clientX: 640, clientY: 400, cancelable: true }))
    }
  })
  await frame(page)
  const { k } = await camera(page)
  assert.ok(k > 0.29 && k < 0.32, `reverse pinch increased zoom right away (got ${k})`)
  assert.deepEqual(t.consoleErrors, [])
  await page.context().close()
})

test("compact Arrow selects with a marquee but its tile edges cannot lift or move", { timeout: 30_000 }, async () => {
  const t = await gallery(true)
  const { page } = t
  const target = tile(page)
  const box = (await target.boundingBox())!
  const y = box.y + box.height / 2
  await page.mouse.move(box.x + 3, y)
  assert.equal(await page.locator(selector).getAttribute("data-gallery-cursor"), "arrow")
  await page.mouse.down()
  await page.mouse.move(box.x + 20, y)
  assert.equal(await lift(page), null)
  await page.mouse.up()
  assert.equal(await target.getAttribute("aria-pressed"), "false")
  await page.mouse.move(box.x + box.width + 14, y)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width - 14, y + 22)
  assert.equal(await page.locator(selector + " > [aria-hidden]:not([hidden])").count(), 1)
  await showEvidence(page, "gallery-compact-marquee.png")
  await page.mouse.up()
  assert.equal(await target.getAttribute("aria-pressed"), "true")
  assert.deepEqual(t.consoleErrors, [])
  await page.context().close()
})
