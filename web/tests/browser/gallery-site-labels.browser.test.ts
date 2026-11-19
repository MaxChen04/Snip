import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { reference, savedPage, startApp, until, type App } from "./harness.ts"
import { mockLibrary, oneSite } from "./site-library.ts"

let app: App
before(async () => { app = await startApp() })
after(async () => app?.stop())

test("zoomed-out site labels frame the main cluster, and F frames a selection or recenters", async () => {
  const r = reference({ domain: "atlas.example", title: "Atlas Studio", pageCount: 3 })
  const t = await app.session({
    viewport: { width: 1440, height: 900 },
    state: {
      libraryPositions: { version: 1, positions: [
        { kind: "page", id: "one", x: -232, y: -80 },
        { kind: "page", id: "two", x: 24, y: -80 },
        { kind: "page", id: "outlier", x: 1350, y: -180 },
      ] },
    },
  })
  const lib = oneSite(r, [
    savedPage({ id: "one", title: "Atlas main", path: "/", createdAt: "2026-01-03T00:00:00Z" }),
    savedPage({ id: "two", title: "Atlas catalogue", path: "/catalogue", createdAt: "2026-01-02T00:00:00Z" }),
    savedPage({ id: "outlier", title: "Atlas scratch", path: "/scratch", createdAt: "2026-01-01T00:00:00Z" }),
  ])
  t.on("GET", /^\/api\//, mockLibrary(lib))
  await t.page.emulateMedia({ reducedMotion: "reduce" })
  await t.goto("/")
  const { page } = t
  const canvas = page.locator('[aria-roledescription="canvas"]')
  const tile = (id: string) => canvas.locator(`[data-gallery-tile="page:${id}"]`)
  const label = canvas.getByRole("button", { name: "Frame Atlas Studio cluster" })
  const view = () => canvas.locator(":scope > div").first().evaluate((el) => {
    const { a, e, f } = new DOMMatrix(getComputedStyle(el).transform)
    return { zoom: a, x: e, y: f }
  })
  await tile("one").waitFor()
  const initial = await view()
  assert.equal(initial.zoom, 1)
  assert.equal(await label.count(), 0)
  const zoomOut = page.getByRole("button", { name: "Zoom out" })
  for (let i = 0; i < 5; i++) await zoomOut.click()
  assert.ok((await view()).zoom >= 0.3)
  assert.equal(await label.count(), 0)
  await zoomOut.click()
  await label.waitFor()
  assert.ok((await view()).zoom < 0.3)
  assert.equal(await label.count(), 1, "a scattered site has a single label")
  assert.equal(await label.locator("svg, img, [aria-hidden=true]").count() > 0, true, "the label has a site icon")
  await label.click()
  await until("the cluster fills the view", async () => (await view()).zoom > 1)
  await label.waitFor({ state: "detached" })
  for (const id of ["one", "two"]) {
    const box = (await tile(id).boundingBox())!
    assert.ok(box.x > 0 && box.x + box.width < 1440, `${id} is inside the framed region`)
  }
  assert.equal(await tile("outlier").count(), 0)

  await canvas.press("f")
  assert.deepEqual(await view(), initial)
  await tile("two").press("Shift+Space")
  assert.equal(await tile("two").getAttribute("aria-pressed"), "true")
  await tile("two").press("f")
  const fit = await view()
  assert.ok(fit.zoom > 1)
  const box = (await tile("two").boundingBox())!
  assert.ok(Math.abs(box.x + box.width / 2 - 720) < 1)
  assert.ok(Math.abs(box.y + box.height / 2 - 450) < 1)
  assert.deepEqual(t.consoleErrors, [])
  await page.context().close()
})
