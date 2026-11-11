// Bug 1: the reference page sticks on an error screen.
// reference-page.tsx load() sets `error` on any failure and never clears it, so one failed poll hides the page for good,
// even though later polls succeed. Correct behaviour: the page comes back (title visible, no error screen).
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { gate, reference, startApp, until, sleep, type App } from "./harness.ts"

let app: App
before(async () => void (app = await startApp()))
after(async () => app?.stop())

test("a failed poll while capturing does not leave a permanent error screen", async () => {
  const state = { references: { ref1: reference({ id: "ref1", title: "Poll Target", status: "capturing", progress: "Capturing 1/3: /" }) } }
  const t = await app.session({ state, clock: true })
  const { page } = t
  const url = /^\/api\/references\/ref1$/
  // React strict mode loads the page twice at boot, so count only the requests made after the page is on screen.
  let armed = false
  let polls = 0
  t.on("GET", url, () => {
    if (!armed) return undefined
    polls++
    if (polls === 1) return { status: 500, json: { error: "Boom: the server fell over" } }
    state.references.ref1 = reference({ id: "ref1", title: "Poll Target", status: "ready", pageCount: 3 })
    return undefined // fall through to the default (the state's current reference)
  })
  await t.goto("/r/ref1")

  // 1. first GET succeeds and the page shows.
  await page.getByRole("heading", { name: "Poll Target" }).waitFor()
  await sleep(300)
  armed = true
  const boot = t.count("GET", url)

  // The poll runs every 4 s while capturing. Jump the fake clock instead of waiting.
  const poll = async (n: number) => {
    await page.clock.fastForward(4500)
    await until(`poll #${n}`, () => t.count("GET", url) >= boot + n)
    await sleep(200) // let the response land and React render
  }

  // 2. the next poll fails once.
  await poll(1)
  // 3. later polls succeed and the reference is ready.
  await poll(2)

  const errorShown = await page.getByText("Boom: the server fell over").isVisible()
  const titleShown = await page.getByRole("heading", { name: "Poll Target" }).isVisible()
  assert.equal(errorShown, false, "the error screen from the single failed poll is still showing after a later poll succeeded")
  assert.equal(titleShown, true, "the page content (title) should be visible again after a successful poll")

  // Once ready, polling stops.
  const before = t.count("GET", url)
  await page.clock.fastForward(30_000)
  await sleep(300)
  await page.clock.fastForward(30_000)
  await sleep(300)
  assert.equal(t.count("GET", url), before, "polling should stop once the reference is ready")
})

test("a reference deleted while capturing shows the error and stops polling", async () => {
  const state = { references: { ref1: reference({ id: "ref1", title: "Poll Target", status: "capturing", progress: "Capturing 1/3: /" }) } }
  const t = await app.session({ state, clock: true })
  const { page } = t
  const url = /^\/api\/references\/ref1$/
  let gone = false
  t.on("GET", url, () => (gone ? { status: 404, json: { error: "not found" } } : undefined))
  await t.goto("/r/ref1")
  await page.getByRole("heading", { name: "Poll Target" }).waitFor()
  await sleep(300)

  gone = true
  const boot = t.count("GET", url)
  await page.clock.fastForward(4500)
  await until("the poll that finds it gone", () => t.count("GET", url) > boot)
  await page.getByText("not found").waitFor()
  assert.equal(await page.getByRole("heading", { name: "Poll Target" }).isVisible(), false, "the deleted reference's page is still showing")

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
  await t.goto("/r/ref1")
  await page.getByRole("button", { name: "Organize" }).click()
  const board = page.getByRole("checkbox", { name: /Moodboard/ })
  await board.click()
  await page.getByText("Boom: could not save to the board").waitFor()
  assert.equal(await board.getAttribute("aria-checked"), "false")
  assert.deepEqual(t.consoleErrors, [])
})

test("Re-capture is offered only for a ready or failed reference", async () => {
  const state = {
    references: {
      busy: reference({ id: "busy", title: "Busy", status: "capturing", progress: "Capturing 1/3: /" }),
      paused: reference({ id: "paused", title: "Paused", status: "paused" }),
      failed: reference({ id: "failed", title: "Failed", status: "failed", error: "nope" }),
    },
  }
  const t = await app.session({ state })
  const { page } = t
  const recapture = page.getByRole("button", { name: "Re-capture" })
  for (const [id, offered] of [["busy", false], ["paused", false], ["failed", true]] as const) {
    await t.goto(`/r/${id}`)
    await page.getByRole("button", { name: "Organize" }).waitFor()
    assert.equal(await recapture.isVisible(), offered, `Re-capture on a ${id} reference`)
  }
})

test("pressing Re-capture twice sends one request, and a refusal is shown", async () => {
  const t = await app.session({ state: { references: { ref1: reference({ id: "ref1", title: "Poll Target" }) } } })
  const { page } = t
  const url = "/api/references/ref1/recapture"
  const hold = gate()
  t.on("POST", url, async () => {
    await hold.opened
    return { status: 409, json: { error: "This capture is still in progress." } }
  })
  await t.goto("/r/ref1")
  const recapture = page.getByRole("button", { name: "Re-capture" })
  await recapture.click()
  await until("first recapture in flight", () => t.count("POST", url) === 1)
  await recapture.click()
  await sleep(300)
  hold.open()
  await page.getByText("This capture is still in progress.").waitFor()
  assert.equal(t.count("POST", url), 1, "the second press sent another recapture")
  assert.deepEqual(t.consoleErrors, [])
})

test("a failed delete is shown and stays on the page", async () => {
  const t = await app.session({ state: { references: { ref1: reference({ id: "ref1", title: "Poll Target" }) } } })
  const { page } = t
  t.on("DELETE", "/api/references/ref1", () => ({ status: 500, json: { error: "Boom: could not delete" } }))
  page.on("dialog", (d) => void d.accept())
  await t.goto("/r/ref1")
  await page.getByRole("button", { name: "More" }).click()
  await page.getByRole("menuitem", { name: "Delete reference" }).click()
  await page.getByText("Boom: could not delete").waitFor()
  assert.equal(await page.getByRole("heading", { name: "Poll Target" }).isVisible(), true)
  assert.deepEqual(t.consoleErrors, [])
})
