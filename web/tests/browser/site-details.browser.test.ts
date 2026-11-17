// A website's scope on the canvas keeps working through errors: a failed poll, a site deleted while capturing, a failed
// board toggle, Re-capture and Delete from the site's details, and captures that failed or were stopped.
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import type { Page } from "playwright"
import { STOPPED_EMPTY, WAITING } from "../../shared/capture-errors.ts"
import { gate, reference, startApp, until, sleep, type App } from "./harness.ts"

let app: App
before(async () => void (app = await startApp()))
after(async () => app?.stop())

/** The site pill at the bottom left, named for the site. */
const pill = (page: Page, name = "Poll Target") => page.getByRole("button", { name: `Site details: ${name}` })
async function details(page: Page) {
  await pill(page).click()
  return page.getByRole("dialog").filter({ has: page.getByRole("textbox", { name: "Note" }) })
}
async function more(page: Page) {
  await (await details(page)).getByRole("button", { name: "More" }).click()
  return page.getByRole("menu")
}

test("a failed poll while capturing keeps the site on screen, and polling stops once it is ready", async () => {
  const state = { references: { ref1: reference({ id: "ref1", title: "Poll Target", status: "capturing", progress: "Capturing 1/3: /" }) } }
  const t = await app.session({ state, clock: true })
  const { page } = t
  const url = /^\/api\/references\/ref1$/
  let armed = false
  let polls = 0
  t.on("GET", url, () => {
    if (!armed) return undefined
    polls++
    if (polls === 1) return { status: 500, json: { error: "Boom: the server fell over" } }
    state.references.ref1 = reference({ id: "ref1", title: "Poll Target", status: "ready", pageCount: 3 })
    return undefined
  })
  await t.goto("/?site=ref1")
  await pill(page).waitFor()
  await sleep(300)
  armed = true
  const boot = t.count("GET", url)
  const poll = async (n: number) => {
    await page.clock.fastForward(4500)
    await until(`poll #${n}`, () => t.count("GET", url) >= boot + n)
    await sleep(200)
  }
  await poll(1)
  assert.equal(await pill(page).isVisible(), true, "the failed poll hid the site")
  await poll(2)
  assert.equal(await page.getByText("Boom: the server fell over").isVisible(), false)
  await page.getByRole("button", { name: "Pause" }).waitFor({ state: "detached" })

  const before = t.count("GET", url)
  await page.clock.fastForward(30_000)
  await sleep(300)
  await page.clock.fastForward(30_000)
  await sleep(300)
  assert.equal(t.count("GET", url), before, "polling should stop once the reference is ready")
})

test("a site deleted while capturing says so and stops polling", async () => {
  const state = { references: { ref1: reference({ id: "ref1", title: "Poll Target", status: "capturing", progress: "Capturing 1/3: /" }) } }
  const t = await app.session({ state, clock: true })
  const { page } = t
  const url = /^\/api\/references\/ref1$/
  let gone = false
  t.on("GET", url, () => (gone ? { status: 404, json: { error: "not found" } } : undefined))
  await t.goto("/?site=ref1")
  await pill(page).waitFor()
  await sleep(300)

  gone = true
  const boot = t.count("GET", url)
  await page.clock.fastForward(4500)
  await until("the poll that finds it gone", () => t.count("GET", url) > boot)
  await page.getByText("This website doesn't exist").waitFor()
  assert.equal(await pill(page).count(), 0, "the deleted site's pill is still showing")

  const before = t.count("GET", url)
  await page.clock.fastForward(30_000)
  await sleep(300)
  await page.clock.fastForward(30_000)
  await sleep(300)
  assert.equal(t.count("GET", url), before, "polling should stop once the reference is gone")
})

test("a failed board toggle is reported and leaves the board unchecked", async () => {
  const t = await app.session({ state: { references: { ref1: reference({ id: "ref1", title: "Poll Target" }) } } })
  const { page } = t
  t.on("PUT", "/api/references/ref1/collections/board1", () => ({ status: 500, json: { error: "Boom: could not save to the board" } }))
  await t.goto("/?site=ref1")
  await (await details(page)).getByRole("button", { name: "Organize" }).click()
  const board = page.getByRole("checkbox", { name: /Moodboard/ })
  await board.click()
  await page.getByText("Boom: could not save to the board").waitFor()
  assert.equal(await board.getAttribute("aria-checked"), "false")
  assert.deepEqual(t.consoleErrors, [])
})

test("Re-capture is offered only for a ready or failed reference", async () => {
  const state = {
    references: {
      busy: reference({ id: "busy", title: "Poll Target", status: "capturing", progress: "Capturing 1/3: /" }),
      paused: reference({ id: "paused", title: "Poll Target", status: "paused" }),
      failed: reference({ id: "failed", title: "Poll Target", status: "failed", error: "nope" }),
    },
  }
  const t = await app.session({ state })
  const { page } = t
  for (const [id, offered] of [["busy", false], ["paused", false], ["failed", true]] as const) {
    await t.goto(`/?site=${id}`)
    const menu = await more(page)
    await menu.getByRole("menuitem", { name: "Export as .zip" }).waitFor()
    assert.equal(await menu.getByRole("menuitem", { name: "Re-capture" }).count(), offered ? 1 : 0, `Re-capture on a ${id} reference`)
  }
})

test("Re-capture can't be sent twice while one is in flight, and a refusal is shown", async () => {
  const t = await app.session({ state: { references: { ref1: reference({ id: "ref1", title: "Poll Target" }) } } })
  const { page } = t
  const url = "/api/references/ref1/recapture"
  const hold = gate()
  t.on("POST", url, async () => {
    await hold.opened
    return { status: 409, json: { error: "This capture is still in progress." } }
  })
  await t.goto("/?site=ref1")
  await (await more(page)).getByRole("menuitem", { name: "Re-capture" }).click()
  await until("first recapture in flight", () => t.count("POST", url) === 1)
  await page.getByRole("button", { name: "More" }).click()
  assert.equal(await page.getByRole("menuitem", { name: "Re-capture" }).getAttribute("aria-disabled"), "true")
  await page.keyboard.press("Escape")
  hold.open()
  await page.getByText("This capture is still in progress.").waitFor()
  assert.equal(t.count("POST", url), 1, "a second recapture was sent")
  assert.deepEqual(t.consoleErrors, [])
})

test("a failed delete is shown and stays in the site", async () => {
  const t = await app.session({ state: { references: { ref1: reference({ id: "ref1", title: "Poll Target" }) } } })
  const { page } = t
  t.on("DELETE", "/api/references/ref1", () => ({ status: 500, json: { error: "Boom: could not delete" } }))
  await t.goto("/?site=ref1")
  await (await more(page)).getByRole("menuitem", { name: "Delete reference" }).click()
  await page.getByRole("dialog", { name: "Delete example.com?" }).getByRole("button", { name: "Delete" }).click()
  await page.getByText("Boom: could not delete").waitFor()
  assert.equal(new URL(page.url()).searchParams.get("site"), "ref1")
  await page.keyboard.press("Escape")
  await page.getByRole("dialog", { name: "Delete example.com?" }).waitFor({ state: "detached" })
  await pill(page).waitFor()
  assert.deepEqual(t.consoleErrors, [])
})

test("Delete reference asks in the app's own dialog, says there is no undo, and Cancel sends nothing", async () => {
  const t = await app.session({ state: { references: { ref1: reference({ id: "ref1", title: "Poll Target" }) } } })
  const { page } = t
  let native = 0
  page.on("dialog", (d) => void (native++, d.dismiss()))
  await t.goto("/?site=ref1")
  await (await more(page)).getByRole("menuitem", { name: "Delete reference" }).click()
  const dialog = page.getByRole("dialog", { name: "Delete example.com?" })
  await dialog.getByText("This can't be undone.").waitFor()
  await dialog.getByRole("button", { name: "Cancel" }).click()
  await dialog.waitFor({ state: "detached" })
  assert.equal(t.count("DELETE", "/api/references/ref1"), 0)
  assert.equal(native, 0, "a native confirm was used")
})

test("a deleted site says so with a toast and leaves its scope; its old address then offers a way back", async () => {
  const state = { references: { ref1: reference({ id: "ref1", title: "Poll Target" }) } }
  const t = await app.session({ state })
  const { page } = t
  t.on("DELETE", "/api/references/ref1", () => {
    delete state.references.ref1
    return { json: { ok: true } }
  })
  t.on("GET", /^\/api\/references\/ref1$/, () => (state.references.ref1 ? undefined : { status: 404, json: { error: "not found" } }))
  await t.goto("/r/ref1")
  await (await more(page)).getByRole("menuitem", { name: "Delete reference" }).click()
  await page.getByRole("dialog", { name: "Delete example.com?" }).getByRole("button", { name: "Delete" }).click()
  await page.getByText("Deleted example.com").waitFor()
  await page.waitForURL((url) => url.pathname === "/" && !url.searchParams.get("site"))

  await t.goto("/r/ref1")
  await page.getByText("This website doesn't exist").waitFor()
  await page.getByRole("button", { name: "Back to All saves" }).last().click()
  await page.waitForURL((url) => url.pathname === "/" && !url.searchParams.get("site"))
})

test("a capture the user stopped is a neutral state with Re-capture and Delete, not a red failure", async () => {
  const state = { references: { ref1: reference({ id: "ref1", title: "Poll Target", status: "failed", error: STOPPED_EMPTY }), ref2: reference({ id: "ref2", title: "Broken", status: "failed", error: "Something odd happened" }) } }
  const t = await app.session({ state })
  const { page } = t
  await t.goto("/?site=ref1")
  await page.getByText("You stopped this capture before any pages were saved.").waitFor()
  assert.equal(await page.getByText(STOPPED_EMPTY).count(), 0, "the raw error is not shown")
  assert.equal(await page.getByText("Capture failed.").count(), 0)
  await page.getByRole("button", { name: "Re-capture" }).first().waitFor()
  await page.getByRole("button", { name: "Delete", exact: true }).click()
  await page.getByRole("dialog", { name: "Delete example.com?" }).waitFor()
  await page.keyboard.press("Escape")

  await t.goto("/?site=ref2")
  await page.getByText("Capture failed.").waitFor()
  await page.getByText("Something odd happened").waitFor()
  await page.getByRole("button", { name: "Retry" }).waitFor()
})

test("a queued capture says it is waiting for the capture agent", async () => {
  const t = await app.session({ state: { references: { ref1: reference({ id: "ref1", title: "Poll Target", status: "queued", progress: WAITING }) } } })
  await t.goto("/?site=ref1")
  await t.page.getByText(WAITING).first().waitFor()
  assert.equal(await t.page.getByText("Waiting for your Mac").count(), 0)
})
