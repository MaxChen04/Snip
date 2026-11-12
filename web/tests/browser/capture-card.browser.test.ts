// The capture card at the canvas origin: its options, its status line and the pill beside the field.
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { STOPPED_EMPTY, WAITING } from "../../shared/capture-errors.ts"
import type { Reference } from "../../shared/types.ts"
import { openAddDialog, boardOf, reference, startApp, until, websiteItem, type App } from "./harness.ts"

let app: App
before(async () => void (app = await startApp()))
after(async () => app?.stop())

test("the card and the Add dialog offer the same crawl page caps", async () => {
  const t = await app.session({ state: { boards: { board1: boardOf() } } })
  const { page } = t
  await t.goto("/")
  await page.getByRole("button", { name: "Crawl site" }).click()
  const card = await page.getByRole("group", { name: "Pages to crawl" }).getByRole("button").allInnerTexts()

  await t.goto("/b/board1")
  const dialog = await openAddDialog(page)
  await dialog.getByRole("radio", { name: /Crawl site/ }).click()
  const row = dialog.getByText("Up to", { exact: true }).locator("xpath=..")
  const dlg = (await row.getByRole("button").allInnerTexts()).map((s) => s.trim())

  assert.deepEqual(card, ["10", "25", "50", "100"])
  assert.deepEqual(dlg, card)
})

// ---------------------------------------------------------------- a capture that is already running

/** The home page with one capture running: it is adopted when the app loads, as one started elsewhere would be. */
const withRunning = async (r: Reference, opts: { viewport?: { width: number; height: number }; agent?: "recent" | "stale" } = {}) => {
  const t = await app.session({ state: { references: { [r.id]: r } }, viewport: opts.viewport })
  t.on("GET", "/api/references", (req) => (req.query.get("status") === r.status ? { json: { items: [r], nextCursor: null } } : undefined))
  if (opts.agent) t.on("GET", "/api/agent", () => ({ json: { lastSeenAt: "2026-01-01T00:00:00.000Z", freshness: opts.agent, activity: "idle" } }))
  await t.goto("/")
  return t
}
const card = (t: Awaited<ReturnType<typeof withRunning>>) => t.page.locator("form")

test("the options stay on the card while a capture runs", async () => {
  const t = await withRunning(reference({ status: "capturing", progress: "Capturing 1/1: /" }))
  await card(t).getByText("Capturing", { exact: true }).waitFor()
  assert.equal(await t.page.getByRole("button", { name: "More options" }).isVisible(), true)
  assert.equal(await t.page.getByRole("button", { name: "One page" }).isVisible(), true)
  assert.equal(await t.page.getByRole("button", { name: "Crawl site" }).isVisible(), true)
  assert.equal(await t.page.getByRole("button", { name: "Upload images" }).isVisible(), true)
})

test("the pill names the state: Queued while waiting, Capturing once it runs", async () => {
  const queued = await withRunning(reference({ status: "queued", progress: WAITING }))
  await card(queued).getByText("Waiting to capture example.com").waitFor()
  assert.equal(await card(queued).getByText("Queued", { exact: true }).count(), 1)
  assert.equal(await card(queued).getByText("Capturing", { exact: true }).count(), 0)

  const running = await withRunning(reference({ status: "capturing", progress: "Capturing 1/1: /" }))
  await card(running).getByText("Capturing example.com").waitFor()
  assert.equal(await card(running).getByText("Capturing", { exact: true }).count(), 1)
  assert.equal(await card(running).getByText("Queued", { exact: true }).count(), 0)
})

test("a queued capture with no agent running says it is waiting for the capture agent", async () => {
  const t = await withRunning(reference({ status: "queued", progress: WAITING }), { agent: "stale" })
  await card(t).getByText(WAITING).waitFor()
  assert.equal(await card(t).getByText("Waiting for your Mac").count(), 0)
})

// ---------------------------------------------------------------- the bar

const bar = (t: Awaited<ReturnType<typeof withRunning>>) => card(t).getByRole("progressbar", { name: "Capturing" })

test("a single page shows an indeterminate bar, never a percentage, and holds still for reduced motion", async () => {
  const t = await withRunning(reference({ status: "capturing", mode: "single", progress: "Capturing 1/1: /" }))
  await card(t).getByText("Capturing example.com").waitFor()
  await bar(t).waitFor()
  const animation = () => bar(t).evaluate((el) => getComputedStyle(el).animationName)
  assert.equal(await animation(), "indeterminate")
  // No filled share of the track anywhere in the card.
  assert.equal(await card(t).locator("[style*='width']").count(), 0)

  await t.page.emulateMedia({ reducedMotion: "reduce" })
  assert.equal(await animation(), "none")
})

test("a crawl keeps its real fraction, and a queued capture shows no bar at all", async () => {
  const crawl = await withRunning(reference({ status: "capturing", mode: "crawl", maxPages: 10, progress: "Capturing 5/10: /pricing" }))
  await card(crawl).getByText("Crawling example.com").waitFor()
  assert.equal(await bar(crawl).count(), 0)
  const fill = card(crawl).locator("[style*='width']")
  assert.equal(await fill.count(), 1)
  assert.match((await fill.getAttribute("style"))!, /width: 40%/)

  const queued = await withRunning(reference({ status: "queued", mode: "single", progress: WAITING }))
  await card(queued).getByText("Waiting to capture example.com").waitFor()
  assert.equal(await bar(queued).count(), 0)
  assert.equal(await card(queued).locator("[style*='width']").count(), 0)
})

// ---------------------------------------------------------------- a capture the user stopped

test("a stopped capture is a neutral state with Re-capture, not a red failure", async () => {
  const stopped = reference({ status: "failed", error: STOPPED_EMPTY })
  const t = await app.session({ state: { references: { ref1: stopped } } })
  t.on("GET", "/api/references", (req) => (req.query.get("status") === "queued" ? { json: { items: [{ ...stopped, status: "queued" }], nextCursor: null } } : undefined))
  await t.goto("/")
  await card(t).getByText("You stopped this capture before any pages were saved.").waitFor()
  assert.equal(await t.page.getByRole("alert").count(), 0)
  assert.equal(await t.page.getByText(STOPPED_EMPTY).count(), 0, "the raw error is not shown")
  await card(t).getByRole("button", { name: "Re-capture" }).click()
  await until("re-capture sent", () => t.count("POST", "/api/references/ref1/recapture") === 1)

  // A real failure keeps its alert.
  const failed = reference({ id: "ref2", status: "failed", error: "Timeout 30000ms exceeded" })
  const f = await app.session({ state: { references: { ref2: failed } } })
  f.on("GET", "/api/references", (req) => (req.query.get("status") === "queued" ? { json: { items: [{ ...failed, status: "queued" }], nextCursor: null } } : undefined))
  await f.goto("/")
  await f.page.getByRole("alert").waitFor()
})

test("website tiles say Queued while waiting and Stopped once the user stopped them", async () => {
  const queued = reference({ id: "q", domain: "queued.example", title: "Queued Site", status: "queued", progress: WAITING, coverKey: null })
  const stopped = reference({ id: "s", domain: "stopped.example", title: "Stopped Site", status: "failed", error: STOPPED_EMPTY, coverKey: null })
  const failed = reference({ id: "f", domain: "failed.example", title: "Failed Site", status: "failed", error: "Something odd happened", coverKey: null })
  const board = boardOf([websiteItem(queued, 0, 0), websiteItem(stopped, 300, 0), websiteItem(failed, 600, 0)])
  const t = await app.session({ state: { boards: { board1: board } } })
  await t.goto("/b/board1")
  const tile = (name: string) => t.page.getByRole("button", { name })
  assert.match(await tile("Queued Site").innerText(), /Queued/)
  assert.match(await tile("Stopped Site").innerText(), /Stopped/)
  assert.match(await tile("Failed Site").innerText(), /Capture failed/)
})
