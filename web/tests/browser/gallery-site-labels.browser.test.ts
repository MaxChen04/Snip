import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { image, reference, savedPage, startApp, until, type App } from "./harness.ts"
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

test("stacked sites use clear sides at overview zoom without covering tiles or another label", async () => {
  const sites = ["Forma", "Studio North", "Highland", "Outline"].map((title, i) => reference({
    id: `site${i}`, title, domain: `site${i}.example`, pageCount: 2,
  }))
  const lib = oneSite(sites[0]!, [])
  lib.references = sites
  lib.pages = sites.flatMap((site, i) => [0, 1].map((j) => savedPage({
    id: `page${i}-${j}`, title: `${site.title} ${j + 1}`, path: `/${j + 1}`, referenceId: site.id,
    createdAt: new Date(Date.UTC(2026, 0, 1) - (i * 2 + j) * 60_000).toISOString(),
  })))
  const positions = lib.pages.map((p, i) => ({
    kind: "page" as const, id: p.id, x: i >= 6 ? -632 : -120,
    y: [-510, -344, -122, 44, 266, 432, -122, 44][i]!,
  }))
  const t = await app.session({
    viewport: { width: 1440, height: 900 },
    state: { libraryPositions: { version: 1, positions } },
  })
  t.on("GET", /^\/api\//, mockLibrary(lib))
  await t.page.emulateMedia({ reducedMotion: "reduce" })
  await t.goto("/")
  const canvas = t.page.locator('[aria-roledescription="canvas"]')
  const tiles = canvas.locator("[data-gallery-tile]")
  const labels = canvas.getByRole("button", { name: /^Frame .* cluster$/ })
  await tiles.first().waitFor()
  const zoomOut = t.page.getByRole("button", { name: "Zoom out" })
  for (let i = 0; i < 6; i++) await zoomOut.click()

  for (const zoom of [26, 25]) {
    await t.page.getByRole("button", { name: `Zoom ${zoom}%, reset to 100%` }).waitFor()
    await until("each site has a label in a clear spot", async () => (await labels.count()) === 4)
    assert.equal(await tiles.count(), 8)
    const tileBoxes = await Promise.all((await tiles.all()).map((tile) => tile.boundingBox()))
    const labelBoxes = await Promise.all((await labels.all()).map((label) => label.boundingBox()))
    const overlaps = (a: NonNullable<(typeof labelBoxes)[number]>, b: NonNullable<(typeof tileBoxes)[number]>) =>
      a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
    for (const [i, label] of labelBoxes.entries()) {
      assert.ok(label)
      assert.ok(tileBoxes.every((tile) => tile && !overlaps(label, tile)), `label ${i + 1} covers no tile at ${zoom}%`)
      assert.ok(labelBoxes.slice(i + 1).every((other) => other && !overlaps(label, other)), `label ${i + 1} covers no other label at ${zoom}%`)
    }
    if (zoom === 26) await zoomOut.click()
  }
  assert.deepEqual(t.consoleErrors, [])
  await t.page.context().close()
})

test("an overview label stays hidden when uploaded images block all sides", async () => {
  const r = reference({ title: "Enclosed site", pageCount: 1 })
  const lib = oneSite(r, [savedPage()])
  const surroundings = [
    [-376, -271], [-120, -271], [136, -271],
    [-376, -90], [136, -90],
    [-376, 91], [-120, 91], [136, 91],
  ]
  const images = surroundings.map((_, i) => image({ id: `wall${i}`, title: `Wall ${i}` }))
  const t = await app.session({
    state: {
      libraryPositions: { version: 1, positions: [
        { kind: "page", id: "page1", x: -120, y: -75 },
        ...surroundings.map(([x, y], i) => ({ kind: "image" as const, id: images[i]!.id, x: x!, y: y! })),
      ] },
    },
  })
  t.on("GET", /^\/api\//, mockLibrary(lib))
  t.on("GET", "/api/images", () => ({ json: { items: images, nextCursor: null } }))
  await t.page.emulateMedia({ reducedMotion: "reduce" })
  await t.goto("/")
  const canvas = t.page.locator('[aria-roledescription="canvas"]')
  const tiles = canvas.locator("[data-gallery-tile]")
  await tiles.first().waitFor()
  const zoomOut = t.page.getByRole("button", { name: "Zoom out" })
  for (let i = 0; i < 6; i++) await zoomOut.click()
  await t.page.getByRole("button", { name: "Zoom 26%, reset to 100%" }).waitFor()
  await until("the enclosed page and its obstacles are rendered", async () => (await tiles.count()) === 9)
  assert.equal(await canvas.getByRole("button", { name: "Frame Enclosed site cluster" }).count(), 0)
  assert.deepEqual(t.consoleErrors, [])
  await t.page.context().close()
})
