// The empty-library welcome ("Start your library") is for a library known to be empty: it waits for the saves themselves,
// not just the counts, so a library that is still loading never tells the user it is empty.
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { gate, startApp, until, type App } from "./harness.ts"
import { library, mockLibrary } from "./site-library.ts"

let app: App
before(async () => void (app = await startApp()))
after(async () => app?.stop())

const FEED = /^\/api\/(references|pages|sections|animations|images)$/

for (const [what, lib] of [
  ["with none", null],
  ["with saves", library()],
] as const) {
  test(`while the saves load the welcome stays hidden; released ${what}, the canvas shows ${lib ? "them" : "the welcome"}`, async () => {
    const t = await app.session()
    const hold = gate()
    t.on("GET", FEED, async (req) => {
      await hold.opened
      return lib ? mockLibrary(lib)(req) : undefined
    })
    if (lib) t.on("GET", "/api/counts", mockLibrary(lib))
    await t.goto("/")
    const { page } = t
    await until("the counts answered", () => t.count("GET", "/api/counts") > 0 && t.count("GET", FEED) > 0)
    await page.getByRole("toolbar", { name: "Filter saves" }).waitFor()
    await page.locator("[data-slot=skeleton]").first().waitFor()
    await page.getByText("100%").waitFor()
    assert.equal(await page.getByText("Start your library").count(), 0, "the welcome showed while the saves were loading")
    assert.equal(await page.getByText("Try one").count(), 0)

    hold.open()
    if (lib) {
      await page.getByRole("button", { name: "Moodboard 1", exact: true }).first().waitFor({ state: "attached" })
      assert.equal(await page.getByText("Start your library").count(), 0)
    } else {
      await page.getByText("Start your library").waitFor()
      await page.getByText("Try one").waitFor()
      assert.equal(await page.locator("[data-slot=skeleton]").count(), 0, "skeletons stayed after the load finished")
    }
  })
}
