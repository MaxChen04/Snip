// The website view is a scope of the gallery canvas (/?site=<id>): entering it from a tile's chip, the inspector's site
// link or search, filtering and searching inside it, its capture controls and details, the old /r/:id links, and leaving by
// every route back to exactly where the user was.
import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import { boardOf, gate, noteItem, reference, savedPage, startApp, sleep, until, websiteItem, type App } from "./harness.ts"
import { crawlStep, library, mockLibrary, oneSite } from "./site-library.ts"

let app: App
before(async () => {
  app = await startApp()
})
after(async () => {
  await app?.stop()
})

async function open(start = "/", opts: { width?: number } = {}) {
  const lib = library()
  const t = await app.session({ viewport: { width: opts.width ?? 1280, height: 800 } })
  t.on("GET", /^\/api\//, mockLibrary(lib))
  t.on("POST", /^\/api\/references\/[^/]+\/(pause|resume|stop)$/, mockLibrary(lib))
  await t.goto(start)
  await t.page.getByRole("toolbar", { name: "Filter saves" }).waitFor()
  return { ...t, lib }
}

const search = (u: string) => Object.fromEntries(new URL(u).searchParams)
/** Where the canvas world sits: its transform, which the position restore must bring back exactly. */
const worldTransform = (page: import("playwright").Page) => page.evaluate(() => (document.querySelector("[data-far], [style*='translate3d']") as HTMLElement | null)?.style.transform ?? "")

async function openTile(page: import("playwright").Page, name: string) {
  await page.getByRole("button", { name, exact: true }).first().focus()
  await page.keyboard.press("Enter")
  await page.getByRole("dialog", { name }).waitFor()
}

test("the seed journey takes two actions: the inspector's site link enters the scope, Back returns to the open page", async () => {
  const t = await open("/?filter=pages")
  const { page } = t
  // Move the canvas, so the restore has something to prove.
  await page.locator("[aria-label^='All saves. Drag']").focus()
  for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowRight")
  await sleep(500)
  await openTile(page, "Judgment Labs · pricing")
  const before = page.url()
  const position = await worldTransform(page)

  // Action 1: the site link.
  await page.getByRole("dialog").getByRole("link", { name: /judgmentlabs\.ai/ }).click()
  await until("scoped", () => search(page.url()).site === "judgment")
  await page.getByRole("button", { name: "Leave judgmentlabs.ai" }).waitFor()
  await page.getByRole("textbox", { name: /Search in judgmentlabs\.ai/ }).waitFor()
  const dock = page.getByRole("toolbar", { name: "Filter saves" })
  assert.deepEqual(
    await dock.getByRole("button").evaluateAll((bs) => bs.map((b) => b.getAttribute("aria-label")).filter((l) => l && !/Add|Boards/.test(l))),
    ["All, 27", "Pages, 15", "Sections, 12", "Animations, 3", "Tokens"],
    "the dock filters within the site, with its counts",
  )
  assert.equal(await dock.getByRole("button", { name: "Pages, 15" }).getAttribute("aria-pressed"), "true")
  await page.getByRole("button", { name: "Site details: Judgment Labs" }).waitFor()
  assert.equal(await page.getByRole("button", { name: "Back to Pages" }).isVisible(), true, "Back names where it goes")

  // Action 2: Back.
  await page.getByRole("button", { name: "Back to Pages" }).click()
  await page.getByRole("dialog", { name: "Judgment Labs · pricing" }).waitFor()
  assert.equal(page.url(), before, "same filter and open item")
  assert.equal(await worldTransform(page), position, "same canvas position")
  assert.deepEqual(t.consoleErrors, [])
})

test("each way out lands where the scope was entered from: the chip's ×, browser Back and Escape", async () => {
  const t = await open("/?filter=sections&q=pricing")
  const { page } = t
  const start = page.url()
  const enter = async () => {
    await page.getByRole("button", { name: "Pricing table · linear.app", exact: true }).first().focus()
    await page.getByRole("link", { name: "Show everything from linear.app" }).click()
    await until("scoped", () => search(page.url()).site === "linear")
    await page.getByRole("button", { name: "Back to Search: pricing" }).waitFor()
  }
  for (const leave of [
    () => page.getByRole("button", { name: "Leave linear.app" }).click(),
    () => page.goBack(),
    () => page.keyboard.press("Escape"),
  ]) {
    await enter()
    // The scope starts on its own search: the library's query stays behind.
    assert.equal(await page.getByRole("textbox", { name: /Search in linear\.app/ }).inputValue(), "")
    await page.locator("body").click({ position: { x: 5, y: 400 } })
    await leave()
    await until("left", () => page.url() === start)
    assert.equal(await page.getByRole("textbox", { name: /Search your saves/ }).inputValue(), "pricing", "the search comes back")
    assert.equal(await page.getByRole("toolbar", { name: "Filter saves" }).getByRole("button", { name: /^Sections/ }).getAttribute("aria-pressed"), "true")
  }
})

test("search's \"Your sites\" enter a site's scope", async () => {
  const { page } = await open("/")
  await page.getByRole("textbox", { name: /Search your saves/ }).focus()
  await page.getByRole("button", { name: "linear.app", exact: true }).click()
  await until("scoped", () => search(page.url()).site === "linear")
  await page.getByRole("button", { name: "Back to All saves" }).waitFor()
})

test("a tile's site chip enters the scope, and inside it the chip names the page instead", async () => {
  const { page } = await open("/?filter=pages")
  const tile = page.getByRole("button", { name: "Stripe · pricing", exact: true }).first()
  await tile.focus()
  const chip = page.getByRole("link", { name: "Show everything from stripe.com" })
  await chip.waitFor()
  await chip.click()
  await until("scoped", () => search(page.url()).site === "stripe")
  await page.getByRole("button", { name: "Stripe · pricing", exact: true }).first().focus()
  await sleep(200)
  assert.equal(await page.getByRole("link", { name: /Show everything from/ }).count(), 0)
})

test("inside a site, the dock and search ask for that site's material only", async () => {
  const t = await open("/?site=judgment")
  const { page } = t
  await page.getByRole("toolbar", { name: "Filter saves" }).getByRole("button", { name: /^Sections/ }).click()
  await until("sections", () => search(page.url()).filter === "sections")
  await until("site sections", () => t.list("GET", "/api/sections").length)
  await page.getByRole("textbox", { name: /Search in judgmentlabs\.ai/ }).fill("zzz")
  await page.getByText("Nothing in judgmentlabs.ai matches “zzz”").waitFor()
  const urls = await page.evaluate(() => performance.getEntriesByType("resource").map((e) => e.name).filter((n) => /\/api\/(sections|counts)\?/.test(n)))
  assert.ok(urls.every((u) => new URL(u).searchParams.get("reference") === "judgment"), "scoped requests carry ?reference=")
  assert.ok(urls.some((u) => new URL(u).searchParams.get("q") === "zzz"), "the search goes with them")
  // "Search all saves" takes the query out of the site, and Back returns into it.
  await page.getByRole("button", { name: "Search all saves" }).click()
  await until("library search", () => !search(page.url()).site && search(page.url()).q === "zzz")
  await page.goBack()
  await until("back in the site", () => search(page.url()).site === "judgment" && search(page.url()).q === "zzz")
})

test("a capture in progress shows under search with Pause and Stop, and pending pages hold their place", async () => {
  const t = await open("/?site=hone")
  const { page } = t
  await page.getByText("Capturing 4/6: /customers").waitFor()
  assert.equal(await page.getByRole("progressbar", { name: "Pages captured" }).getAttribute("aria-valuenow"), "50")
  await page.getByRole("button", { name: "Pause" }).click()
  await page.getByText("Paused after 3 of 6 pages").waitFor()
  await page.getByRole("button", { name: "Resume" }).waitFor()
  await page.getByRole("button", { name: "Stop" }).click()
  await until("stopped", async () => (await page.getByRole("button", { name: "Stop" }).count()) === 0)
  assert.equal(t.count("POST", "/api/references/hone/pause"), 1)
  assert.equal(t.count("POST", "/api/references/hone/stop"), 1)
})

test("site details hold the note, Visit, Organize and More, and deleting the site leaves its scope", async () => {
  const t = await open("/?filter=websites")
  const { page } = t
  await openTile(page, "Ando")
  await page.getByRole("dialog").getByRole("link", { name: /ando\.so/ }).click()
  await until("scoped", () => search(page.url()).site === "ando")
  await page.getByRole("button", { name: "Site details: Ando" }).click()
  const note = page.getByRole("textbox", { name: "Note" })
  await note.fill("Warm serif type")
  await note.blur()
  await until("note saved", () => t.list("PATCH", "/api/references/ando").length)
  assert.deepEqual(t.list("PATCH", "/api/references/ando")[0]!.body, { notes: "Warm serif type" })
  assert.equal(await page.getByRole("link", { name: "Visit" }).getAttribute("href"), "https://ando.so/")
  await page.getByRole("button", { name: "Organize" }).waitFor()
  await page.getByRole("button", { name: "More" }).click()
  await page.getByRole("menuitem", { name: "Export as .zip" }).waitFor()
  await page.getByRole("menuitem", { name: "Re-capture" }).waitFor()
  await page.getByRole("menuitem", { name: "Delete reference" }).click()
  await page.getByRole("dialog", { name: "Delete ando.so?" }).getByRole("button", { name: "Delete" }).click()
  await until("left after delete", () => search(page.url()).filter === "websites" && !search(page.url()).site)
  assert.equal(t.count("DELETE", "/api/references/ando"), 1)
})

test("old /r/:id links land in the scope: its tab becomes the filter and its page opens", async () => {
  const { page } = await open("/r/judgment")
  await until("scoped", () => search(page.url()).site === "judgment")
  assert.equal(new URL(page.url()).pathname, "/")
  await page.goto(app.url + "/r/judgment?tab=tokens")
  await page.getByRole("region", { name: "Design tokens of judgmentlabs.ai" }).waitFor()
  await page.goto(app.url + "/r/judgment?page=judgment-p2")
  await page.getByRole("dialog", { name: "Judgment Labs · blog" }).waitFor()
  // Opened by a link, the scope's Back goes to All saves.
  await page.keyboard.press("Escape")
  await page.getByRole("button", { name: "Back to All saves" }).click()
  await until("home", () => page.url() === app.url + "/")
})

test("a site that no longer exists says so and offers a way back", async () => {
  const { page } = await open("/?site=gone")
  await page.getByText("This website doesn't exist").waitFor()
  await page.getByRole("button", { name: "Back to All saves" }).first().click()
  await until("home", () => page.url() === app.url + "/")
})

test("selecting inside a site picks pages for a prompt, and Escape ends the selection before leaving", async () => {
  const { page } = await open("/?site=judgment")
  await page.getByRole("button", { name: "Select", exact: true }).click()
  await page.getByRole("button", { name: "Judgment Labs · pricing", exact: true }).first().focus()
  await page.keyboard.press("Enter")
  assert.equal(await page.getByRole("button", { name: "Judgment Labs · pricing", exact: true }).first().getAttribute("aria-pressed"), "true")
  assert.equal(await page.getByRole("dialog").count(), 0, "picking doesn't open the inspector")
  await page.getByText("1 page", { exact: true }).waitFor()
  await page.getByRole("button", { name: "Copy prompt" }).waitFor()
  await page.locator("body").click({ position: { x: 5, y: 400 } })
  await page.keyboard.press("Escape")
  await until("selection ended", async () => (await page.getByRole("button", { name: "Copy prompt" }).count()) === 0)
  assert.equal(search(page.url()).site, "judgment", "still in the site")
  await page.keyboard.press("Escape")
  await until("left", () => !search(page.url()).site)
})

test("in Grid view, a tile's site link enters the scope (there is no canvas to remember a position from)", async () => {
  const lib = library()
  const t = await app.session({ viewport: { width: 1280, height: 800 } })
  t.on("GET", /^\/api\//, mockLibrary(lib))
  await t.page.addInitScript(() => localStorage.setItem("rs.view", "grid"))
  await t.goto("/?filter=pages")
  const { page } = t
  await openTile(page, "Linear · pricing")
  await page.getByRole("dialog").getByRole("link", { name: /^linear\.app/ }).click()
  await until("the scope opens", () => search(page.url()).site === "linear")
  await page.getByRole("button", { name: "Site details: Linear" }).waitFor()
  assert.deepEqual(t.consoleErrors, [])
})

test("a late answer for the site just left does not replace the site entered after it", async () => {
  const t = await open("/")
  const { page } = t
  const hold = gate()
  t.on("GET", /^\/api\/references\/judgment$/, async () => {
    await hold.opened
    return undefined
  })
  const enter = async (domain: string) => {
    await page.getByRole("textbox", { name: /Search your saves/ }).focus()
    await page.getByRole("button", { name: domain, exact: true }).click()
  }
  await enter("judgmentlabs.ai")
  await until("in Judgment's scope", () => search(page.url()).site === "judgment")
  await page.getByRole("button", { name: "Back to All saves" }).click()
  await until("left", () => !search(page.url()).site)
  await enter("linear.app")
  await page.getByRole("button", { name: "Site details: Linear" }).waitFor()

  hold.open()
  await until("Judgment's answer arrives", () => t.count("GET", /^\/api\/references\/judgment$/) > 0)
  await sleep(500)
  assert.equal(await page.getByRole("button", { name: "Site details: Linear" }).isVisible(), true, "Linear's details were replaced")
  assert.equal(await page.getByRole("button", { name: /^Site details: Judgment/ }).count(), 0)
})

test("a search typed in a site and not yet written stays in that site when the user leaves at once", async () => {
  const { page } = await open("/?site=linear")
  await page.getByRole("textbox", { name: /Search in linear\.app/ }).fill("pricing")
  await page.getByRole("button", { name: "Leave linear.app" }).click()
  await until("left", () => !search(page.url()).site)
  await sleep(600)
  assert.equal(search(page.url()).q, undefined, "the site's draft was written into All saves")
  assert.equal(await page.getByRole("textbox", { name: /Search your saves/ }).inputValue(), "")
})

test("Back from a site entered on a board returns to the board's pan, zoom and search", async () => {
  const r = reference({ id: "ref1", title: "Example", domain: "example.com", pageCount: 2 })
  const t = await app.session({ state: { references: { ref1: r }, boards: { board1: boardOf([websiteItem(r, 0, 0), noteItem("n1", "far", 2400, 1600)]) } }, viewport: { width: 1280, height: 800 } })
  const { page } = t
  await t.goto("/b/board1")
  const board = page.locator("[aria-label*='Drag or use the arrow keys']")
  await board.waitFor()
  await board.focus()
  for (const key of ["ArrowRight", "ArrowRight", "ArrowDown", "Minus"]) await page.keyboard.press(key)
  await sleep(400)
  const before = await worldTransform(page)
  await page.getByRole("textbox", { name: /^Search/ }).fill("example")
  await until("the search is in the board's URL", () => search(page.url()).q === "example")

  // On a board a click selects the item and Enter opens it.
  await page.locator("[data-key]", { has: page.getByRole("button", { name: "Example", exact: true }) }).click()
  await page.keyboard.press("Enter")
  await page.getByRole("dialog").getByRole("link", { name: /^example\.com/ }).click()
  await until("in the site", () => search(page.url()).site === "ref1")
  await page.getByRole("button", { name: "Back to Moodboard" }).click()
  await until("on the board", () => new URL(page.url()).pathname === "/b/board1")
  await page.getByRole("dialog").waitFor()
  await page.keyboard.press("Escape")
  await sleep(500)
  assert.equal(await worldTransform(page), before)
  assert.equal(await page.getByRole("textbox", { name: /^Search/ }).inputValue(), "example")
})

test("a site that fails to load says so with Try again, and an old Tokens link to a deleted site says it is gone", async () => {
  const t = await open("/?filter=pages")
  const { page } = t
  let failing = true
  t.on("GET", /^\/api\/references\/linear$/, () => (failing ? { status: 500, json: { error: "Boom" } } : undefined))
  await page.getByRole("textbox", { name: /Search your saves/ }).focus()
  await page.getByRole("button", { name: "linear.app", exact: true }).click()
  await page.getByText("Couldn't load this website").waitFor()
  failing = false
  await page.getByRole("button", { name: "Try again" }).click()
  await page.getByRole("button", { name: "Site details: Linear" }).waitFor()

  await t.goto("/r/gone?tab=tokens")
  await page.getByText("This website doesn't exist").waitFor()
  assert.equal(await page.getByText("Loading…").count(), 0)
  await page.getByRole("alert").getByRole("button", { name: "Back to All saves" }).click()
  await until("back in All saves", () => !search(page.url()).site)
})

test("the capture pill's progress is a status region, so each new page is announced as it is captured", async () => {
  const t = await open("/?site=hone")
  const { page } = t
  const status = page.getByRole("status").filter({ hasText: /^Capturing \d+\/6: / })
  assert.equal(await status.innerText(), "Capturing 4/6: /customers")
  crawlStep(t.lib, "next")
  await until("the next page is announced", async () => (await status.innerText()) === "Capturing 5/6: /about", 10_000)
})

test("a Re-capture and a note save started on one site and finishing on another leave the second site alone", async () => {
  const t = await open("/")
  const { page } = t
  const hold = gate()
  const held = async () => {
    await hold.opened
    return { json: { ok: true } }
  }
  t.on("POST", "/api/references/judgment/recapture", held)
  t.on("PATCH", "/api/references/judgment", held)
  const enter = async (domain: string) => {
    await page.getByRole("textbox", { name: /Search your saves/ }).focus()
    await page.getByRole("button", { name: domain, exact: true }).click()
  }
  await enter("judgmentlabs.ai")
  await page.getByRole("button", { name: "Site details: Judgment Labs" }).click()
  await page.getByRole("textbox", { name: "Note" }).fill("Borrow the pricing table")
  await page.getByRole("button", { name: "More" }).click()
  await page.getByRole("menuitem", { name: "Re-capture" }).click()
  await page.getByRole("dialog", { name: "Re-capture judgmentlabs.ai?" }).getByRole("button", { name: "Re-capture" }).click()
  await until("both requests in flight", () => t.count("POST", "/api/references/judgment/recapture") === 1 && t.count("PATCH", "/api/references/judgment") === 1)

  await page.getByRole("button", { name: "Back to All saves" }).click()
  await until("left", () => !search(page.url()).site)
  await enter("linear.app")
  await page.getByRole("button", { name: "Site details: Linear" }).waitFor()
  hold.open()
  await sleep(800)
  assert.equal(await page.getByRole("button", { name: "Site details: Linear" }).isVisible(), true, "Linear's details were replaced")
  await page.getByRole("button", { name: "Site details: Linear" }).click()
  assert.equal(await page.getByRole("textbox", { name: "Note" }).inputValue(), "", "Judgment's note landed on Linear")
})

test("an old link to a site's tab and page opens that page, even on Animations or Tokens; a page that's gone closes", async () => {
  const t = await open("/")
  const { page } = t
  for (const tab of ["animations", "tokens"]) {
    await t.goto(`/r/judgment?tab=${tab}&page=judgment-p4`)
    await page.getByRole("dialog", { name: "Judgment Labs · docs" }).waitFor()
    assert.deepEqual(search(page.url()), { site: "judgment", filter: tab, open: "page:judgment-p4" })
  }
  await t.goto("/?site=judgment&filter=animations&open=page:gone")
  await page.getByRole("button", { name: "Site details: Judgment Labs" }).waitFor()
  await until("the missing page closes", () => search(page.url()).open === undefined)
  assert.equal(await page.getByRole("dialog").count(), 0)
})

test("a site's note saved in the inspector shows in Site details, and the other way round", async () => {
  const t = await open("/?site=judgment")
  const { page } = t
  t.on("PATCH", "/api/references/judgment", (req) => {
    t.lib.references.find((r) => r.id === "judgment")!.notes = req.body.notes
    return { json: { ok: true } }
  })
  const inspectorNote = () => page.getByRole("dialog").getByPlaceholder("What to borrow from it")
  // A save is done once the site has reloaded after it.
  const saved = async (n: number) => {
    const gets = t.count("GET", "/api/references/judgment")
    await until(`note save #${n}`, () => t.count("PATCH", "/api/references/judgment") === n && t.count("GET", "/api/references/judgment") > gets)
  }

  // The inspector's copy of the site is loaded first, then the note changes in Site details.
  await openTile(page, "Judgment Labs · pricing")
  await inspectorNote().waitFor()
  await page.keyboard.press("Escape")
  await page.getByRole("button", { name: "Site details: Judgment Labs" }).click()
  await page.getByRole("textbox", { name: "Note" }).fill("Borrow the pricing table")
  await page.keyboard.press("Tab")
  await saved(1)
  await page.keyboard.press("Escape")
  await openTile(page, "Judgment Labs · pricing")
  await until("the inspector shows it", async () => (await inspectorNote().inputValue()) === "Borrow the pricing table")

  await inspectorNote().fill("Borrow the footer")
  await page.getByRole("dialog").getByRole("heading").first().click()
  await saved(2)
  await page.keyboard.press("Escape")
  await page.getByRole("button", { name: "Site details: Judgment Labs" }).click()
  await until("Site details shows it", async () => (await page.getByRole("textbox", { name: "Note" }).inputValue()) === "Borrow the footer")
})

test("while a site loads, screen readers hear that it is loading", async () => {
  const lib = library()
  const t = await app.session({ viewport: { width: 1280, height: 800 } })
  t.on("GET", /^\/api\//, mockLibrary(lib))
  const hold = gate()
  t.on("GET", /^\/api\/references\/linear$/, async () => {
    await hold.opened
    return undefined
  })
  await t.goto("/?site=linear")
  await t.page.getByRole("status", { name: "Loading" }).waitFor()
  hold.open()
  await t.page.getByRole("button", { name: "Site details: Linear" }).waitFor()
})

test("a site with more saves than the canvas holds says it shows only the newest", async () => {
  const r = reference({ id: "big", title: "Big", domain: "big.example", pageCount: 1000 })
  const pages = Array.from({ length: 400 }, (_, i) => savedPage({ id: `b${i}`, path: `/p${i}`, title: `Page ${i}` }))
  const t = await app.session({ viewport: { width: 1440, height: 900 } })
  t.on("GET", /^\/api\//, mockLibrary(oneSite(r, pages)))
  t.on("GET", "/api/counts", () => ({ json: { websites: 1, pages: 1000, sections: 0, animations: 0, images: 0 } }))
  await t.goto("/?site=big")
  await t.page.getByText("Showing the newest 400 of 1000. Search to find older saves.").waitFor()
})
