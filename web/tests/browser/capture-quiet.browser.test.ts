// A capture whose agent has gone quiet (Reference.quietSince): no spinner, no progress, plain words, and Stop,
// on the capture card, the website tile and the reference page. A stop settles it, and the agent coming back clears it.
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { STOPPED_EMPTY } from "../../shared/capture-errors.ts"
import { boardOf, reference, startApp, until, websiteItem, type App } from "./harness.ts"

let app: App
before(async () => void (app = await startApp()))
after(async () => app?.stop())

const QUIET = "The capture agent stopped responding. Snip picks this up again automatically, or you can stop it."
const quietSince = "2026-01-01T00:00:00.000Z"
const quiet = (o: Parameters<typeof reference>[0] = {}) => reference({ status: "capturing", progress: "Capturing 1/1: /", quietSince, ...o })

/** The home page with a running capture, whose Stop the Worker settles straight away as it would for a dead agent. */
const home = async (r: ReturnType<typeof reference>) => {
  const t = await app.session({ state: { references: { [r.id]: r } } })
  t.on("GET", "/api/references", (req) => (req.query.get("status") === "capturing" ? { json: { items: [t.state.references[r.id]], nextCursor: null } } : undefined))
  t.on("POST", `/api/references/${r.id}/stop`, () => {
    t.state.references[r.id] = reference({ ...r, status: "failed", error: STOPPED_EMPTY, progress: null, control: null, quietSince: null })
    return { json: t.state.references[r.id] }
  })
  await t.goto("/")
  return t
}

test("on the card, a quiet single-page capture says so, shows no spinner or bar, and can be stopped", async () => {
  const t = await home(quiet({ mode: "single" }))
  const { page } = t
  const card = page.locator("form")
  await card.getByText(QUIET).waitFor()
  assert.equal(await card.getByText("Capturing example.com").count(), 0)
  assert.equal(await card.getByRole("progressbar").count(), 0)
  assert.equal(await card.locator("[style*='width']").count(), 0)
  assert.equal(await card.locator(".animate-spin").count(), 0, "something still spins")
  assert.equal(await card.getByText("Not responding", { exact: true }).count(), 1, "the pill")
  // Nothing on the canvas below the card spins for it either.
  assert.equal(await page.locator("main .animate-spin, [aria-hidden] .animate-spin").count(), 0)

  await card.getByRole("button", { name: "Stop" }).click()
  await card.getByText("You stopped this capture before any pages were saved.").waitFor()
  assert.equal(t.count("POST", "/api/references/ref1/stop"), 1)
  assert.equal(await card.getByText(QUIET).count(), 0)
})

test("a quiet crawl that was already told to stop still offers Stop, and not Pause", async () => {
  const t = await home(quiet({ mode: "crawl", maxPages: 10, control: "stop", progress: "Capturing 4/10: /pricing" }))
  const card = t.page.locator("form")
  await card.getByText(QUIET).waitFor()
  await card.getByRole("button", { name: "Stop" }).waitFor()
  assert.equal(await card.getByRole("button", { name: "Pause" }).count(), 0)
  assert.equal(await card.getByText("Stopping…").count(), 0)
})

test("on the reference page, a quiet capture says so in words, shows no spinner, and Stop settles it", async () => {
  const r = quiet({ id: "ref1", mode: "single" })
  const t = await app.session({ state: { references: { ref1: r } }, clock: true })
  const { page } = t
  t.on("POST", "/api/references/ref1/stop", () => {
    t.state.references.ref1 = reference({ ...r, status: "failed", error: STOPPED_EMPTY, progress: null, quietSince: null })
    return { json: t.state.references.ref1 }
  })
  await t.goto("/r/ref1")
  await page.getByText(QUIET).waitFor()
  assert.equal(await page.getByRole("status", { name: "Loading" }).count(), 0, "a spinner is showing")
  assert.equal(await page.getByText("Capturing /").count(), 0, "the placeholder tile says it is working")

  await page.getByRole("button", { name: "Stop" }).click()
  await page.getByText("You stopped this capture before any pages were saved.").waitFor()
  assert.equal(await page.getByText(QUIET).count(), 0)
})

test("when the agent comes back the quiet copy goes and the capture reads as running again", async () => {
  const t = await app.session({ state: { references: { ref1: quiet({ id: "ref1", mode: "single" }) } }, clock: true })
  const { page } = t
  const url = /^\/api\/references\/ref1$/
  await t.goto("/r/ref1")
  await page.getByText(QUIET).waitFor()

  t.state.references.ref1 = reference({ id: "ref1", status: "capturing", progress: "Capturing 1/1: /", quietSince: null })
  const polls = t.count("GET", url)
  await page.clock.fastForward(4500)
  await until("the next poll", () => t.count("GET", url) > polls)
  await page.getByText(QUIET).waitFor({ state: "detached" })
  await page.getByText("Capturing /").first().waitFor()
})

test("a website tile on a board says Not responding for a quiet capture", async () => {
  const r = quiet({ id: "q", domain: "quiet.example", title: "Quiet Site", coverKey: null })
  const t = await app.session({ state: { boards: { board1: boardOf([websiteItem(r, 0, 0)]) } } })
  await t.goto("/b/board1")
  assert.match(await t.page.getByRole("button", { name: "Quiet Site" }).innerText(), /Not responding/)
})
