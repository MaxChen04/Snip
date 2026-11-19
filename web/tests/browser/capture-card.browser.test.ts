// The capture card at the canvas origin (its status line) and the dock's + popover (its options).
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { STOPPED_EMPTY, WAITING } from "../../shared/capture-errors.ts"
import type { Reference } from "../../shared/types.ts"
import { parseProgress } from "../../src/lib/capture-progress.ts"
import { openAddDialog, boardOf, reference, startApp, until, websiteItem, type App } from "./harness.ts"

let app: App
before(async () => void (app = await startApp()))
after(async () => app?.stop())

test("the + popover and the Add dialog offer the same crawl page caps", async () => {
  const t = await app.session({ state: { boards: { board1: boardOf() } } })
  const { page } = t
  await t.goto("/")
  await page.getByRole("button", { name: "Add a site or images" }).click()
  await page.getByRole("radio", { name: /Whole site/ }).click()
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
const card = (t: Awaited<ReturnType<typeof withRunning>>) => t.page.locator("[data-capture-status]")

test("a suggestion capture has a Hugeicons Cancel control while queued, with one pending request and a neutral stopped state", async () => {
  const t = await app.session()
  const ref = reference({ id: "suggested", domain: "stripe.com", url: "https://stripe.com/", status: "queued", mode: "single", progress: WAITING, pageCount: 0 })
  t.on("POST", "/api/references", () => {
    t.state.references[ref.id] = ref
    return { json: ref }
  })
  const release = Promise.withResolvers<void>()
  t.on("POST", "/api/references/suggested/cancel", async () => {
    await release.promise
    t.state.references[ref.id] = { ...ref, status: "failed", error: STOPPED_EMPTY, progress: null }
    return { json: t.state.references[ref.id] }
  })
  await t.goto("/")
  await t.page.getByRole("button", { name: "stripe.com", exact: true }).click()
  const cancel = card(t).getByRole("button", { name: "Cancel", exact: true })
  await cancel.waitFor()
  assert.equal(t.list("POST", "/api/references")[0]!.body.mode, "single")
  assert.equal(await cancel.locator("svg").count(), 1)
  assert.equal(await card(t).getByRole("button", { name: "Pause" }).count(), 0)
  try {
    await cancel.click()
    await until("cancel pending", () => t.count("POST", "/api/references/suggested/cancel") === 1)
    assert.equal(await cancel.isDisabled(), true)
    assert.equal(await cancel.getAttribute("aria-busy"), "true")
    await cancel.evaluate((el) => { (el as HTMLButtonElement).click(); (el as HTMLButtonElement).click() })
    assert.equal(t.count("POST", "/api/references/suggested/cancel"), 1)
  } finally { release.resolve() }
  await card(t).getByText("You stopped this capture before any pages were saved.").waitFor()
  assert.equal(await t.page.getByRole("alert").count(), 0)
  assert.equal(await card(t).getByRole("progressbar").count(), 0)
  assert.equal(await cancel.count(), 0)
  assert.deepEqual(t.consoleErrors, [])
})

test("a running single capture can retry a failed cancellation without pretending it stopped", async () => {
  const ref = reference({ status: "capturing", mode: "single", progress: "Capturing 1/1: /", pageCount: 0 })
  const t = await withRunning(ref)
  t.on("POST", "/api/references/ref1/cancel", () => ({ status: 503, json: { error: "Temporarily unavailable" } }))
  const cancel = card(t).getByRole("button", { name: "Cancel", exact: true })
  await cancel.click()
  await t.page.getByText("Couldn't cancel: Temporarily unavailable").waitFor()
  await until("cancel enabled again", () => cancel.isEnabled())
  assert.equal(await card(t).getByRole("progressbar").count(), 1)
  t.on("POST", "/api/references/ref1/cancel", () => {
    t.state.references.ref1 = { ...ref, status: "failed", error: STOPPED_EMPTY, progress: null }
    return { json: t.state.references.ref1 }
  })
  await cancel.focus()
  await t.page.keyboard.press("Enter")
  await card(t).getByText("You stopped this capture before any pages were saved.").waitFor()
  assert.equal(t.count("POST", "/api/references/ref1/cancel"), 2)
})

test("crawls offer Cancel beside Pause or Resume and retain completed pages in the website scope", async () => {
  for (const status of ["capturing", "paused"] as const) {
    const ref = reference({ status: "capturing", mode: "crawl", maxPages: 10, pageCount: 2, progress: "Capturing 3/10: /pricing" })
    const t = await withRunning(ref)
    if (status === "paused") {
      t.on("POST", "/api/references/ref1/pause", () => {
        t.state.references.ref1 = { ...ref, status: "paused", progress: "Paused" }
        return { json: t.state.references.ref1 }
      })
      await card(t).getByRole("button", { name: "Pause" }).click()
    }
    await card(t).getByRole("button", { name: status === "paused" ? "Resume" : "Pause" }).waitFor()
    await card(t).getByRole("button", { name: "Cancel", exact: true }).waitFor()
    t.on("POST", "/api/references/ref1/cancel", () => {
      t.state.references.ref1 = { ...ref, status: "ready", progress: null }
      return { json: t.state.references.ref1 }
    })
    await t.goto("/?site=ref1")
    await t.page.getByRole("button", { name: "Cancel", exact: true }).click()
    await t.page.getByText("Stopped with 2 pages", { exact: true }).waitFor()
    assert.equal(await t.page.getByRole("button", { name: "Cancel", exact: true }).count(), 0)
    assert.equal(t.state.references.ref1!.pageCount, 2)
  }
})

test("Cancel stays inside narrow capture cards in light and dark themes", async () => {
  for (const colorScheme of ["light", "dark"] as const) for (const mode of ["single", "crawl"] as const) {
    const t = await withRunning(reference({ domain: "a-very-long-domain.example.com", status: "capturing", mode, maxPages: 10, progress: "Capturing 4/10: /a-very-long-path" }), { viewport: { width: 320, height: 720 } })
    await t.page.emulateMedia({ colorScheme, reducedMotion: "reduce" })
    const cdp = await t.page.context().newCDPSession(t.page)
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true })
    const cancel = card(t).getByRole("button", { name: "Cancel", exact: true })
    await cancel.waitFor()
    const container = (await card(t).boundingBox())!
    const button = (await cancel.boundingBox())!
    const label = (await card(t).locator("p[aria-live]").boundingBox())!
    assert.ok(button.x >= container.x && button.x + button.width <= container.x + container.width + 1)
    assert.ok(button.x + button.width <= 320 && button.y + button.height <= 720)
    assert.ok(button.height >= 44, "touch controls have a 44px target")
    assert.ok(label.y + label.height <= button.y, "the capture label has its own row above the controls")
    assert.deepEqual(t.consoleErrors, [])
  }
})

test("the + popover offers the landing page, the whole site and image upload while a capture runs", async () => {
  const t = await withRunning(reference({ status: "capturing", progress: "Capturing 1/1: /" }))
  await card(t).getByText("Capturing example.com").waitFor()
  await t.page.getByRole("button", { name: "Add a site or images" }).click()
  for (const name of [/Landing page/, /Whole site/]) assert.equal(await t.page.getByRole("radio", { name }).isVisible(), true)
  assert.equal(await t.page.getByRole("button", { name: "Upload images" }).isVisible(), true)
  assert.equal(await t.page.getByRole("button", { name: "More options" }).isVisible(), true)
})

test("a queued capture reads the Worker's progress text on the card and the reference page, agent online or not", async () => {
  for (const agent of ["recent", "stale"] as const) {
    const t = await withRunning(reference({ status: "queued", progress: WAITING }), { agent })
    await card(t).getByText(WAITING).waitFor()
    assert.equal(await card(t).getByText("Waiting to capture").count(), 0, `a client wording of its own while the agent is ${agent}`)
    await t.goto("/?site=ref1")
    await t.page.getByText(WAITING).first().waitFor()
  }
  // Whatever the Worker says is what shows: nothing on the card rewrites it.
  const custom = await withRunning(reference({ status: "queued", progress: "Waiting behind 2 other captures" }))
  await card(custom).getByText("Waiting behind 2 other captures").waitFor()
})

// ---------------------------------------------------------------- the bar

const bar = (t: Awaited<ReturnType<typeof withRunning>>) => card(t).getByRole("progressbar", { name: "Capturing" })

test("a single page shows an indeterminate bar, never a percentage, and holds still for reduced motion", async () => {
  const t = await withRunning(reference({ status: "capturing", mode: "single", progress: "Capturing 1/1: /" }))
  await card(t).getByText("Capturing example.com").waitFor()
  await bar(t).waitFor()
  assert.equal(await bar(t).getAttribute("aria-valuenow"), null, "a single page claims no share done")
  const animation = () => bar(t).locator("[data-slot=progress-sweep]").evaluate((el) => getComputedStyle(el).animationName)
  assert.equal(await animation(), "indeterminate")
  // No filled share of the track anywhere in the card.
  assert.equal(await card(t).locator("[style*='width']").count(), 0)

  await t.page.emulateMedia({ reducedMotion: "reduce" })
  assert.equal(await animation(), "none")
})

test("a crawl keeps its real fraction, and a queued capture shows no bar at all", async () => {
  const crawl = await withRunning(reference({ status: "capturing", mode: "crawl", maxPages: 10, progress: "Capturing 5/10: /pricing" }))
  await card(crawl).getByText("Crawling example.com").waitFor()
  assert.equal(await bar(crawl).getAttribute("aria-valuenow"), "40")
  assert.equal(await bar(crawl).locator("[data-slot=progress-sweep]").count(), 0)
  const fill = card(crawl).locator("[style*='width']")
  assert.equal(await fill.count(), 1)
  assert.match((await fill.getAttribute("style"))!, /width: 40%/)

  const queued = await withRunning(reference({ status: "queued", mode: "single", progress: WAITING }))
  await card(queued).getByText(WAITING).waitFor()
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

// ---------------------------------------------------------------- several captures at once

/** The home page with several captures tracked at once, as the app adopts the running ones when it loads. */
const withCaptures = async (refs: Reference[], opts: { clock?: boolean } = {}) => {
  const t = await app.session({ state: { references: Object.fromEntries(refs.map((r) => [r.id, r])) }, clock: opts.clock })
  t.on("GET", "/api/references", (req) => ({ json: { items: Object.values(t.state.references).filter((r) => r.status === req.query.get("status")), nextCursor: null } }))
  await t.goto("/")
  return t
}
const at = (sec: number) => `2026-01-01T00:00:${String(sec).padStart(2, "0")}.000Z`
const capture = (id: string, o: Partial<Reference> = {}) =>
  reference({ id, domain: `${id}.example`, url: `https://${id}.example/`, status: "capturing", progress: "Capturing 1/1: /", ...o })

test("the card shows the capture that is capturing, not a newer one still queued", async () => {
  const a = capture("aaa", { claimedAt: at(10), createdAt: at(1) })
  const b = capture("bbb", { claimedAt: at(20), createdAt: at(2) })
  const c = capture("ccc", { status: "queued", progress: WAITING, createdAt: at(3) })
  const t = await withCaptures([a, b, c])
  // Of the two being captured, the one that started last.
  await card(t).getByText("Capturing bbb.example").waitFor()
  assert.equal(await card(t).getByText("+2 more").count(), 1)
})

test("with nothing capturing the card shows a queued capture and counts the rest", async () => {
  const a = capture("aaa", { status: "queued", progress: WAITING, createdAt: at(1) })
  const b = capture("bbb", { status: "queued", progress: WAITING, createdAt: at(2) })
  const t = await withCaptures([a, b])
  await card(t).getByText(WAITING).waitFor()
  assert.equal(await card(t).getByText("+1 more").count(), 1)
})

test("a capture that finishes while another is capturing leaves the card, and the count follows", async () => {
  const a = capture("aaa", { claimedAt: at(20), createdAt: at(1) })
  const b = capture("bbb", { claimedAt: at(10), createdAt: at(2) })
  const t = await withCaptures([a, b], { clock: true })
  await card(t).getByText("Capturing aaa.example").waitFor()
  assert.equal(await card(t).getByText("+1 more").count(), 1)

  t.state.references.aaa = { ...a, status: "ready", pageCount: 1, progress: null }
  await t.page.clock.fastForward(5000)
  await card(t).getByText("Capturing bbb.example").waitFor()
  assert.equal(await card(t).getByText("more", { exact: false }).count(), 0, "the finished one no longer counts")
  assert.equal(await card(t).getByText("Saved 1 page").count(), 0)
})

// ---------------------------------------------------------------- pause and resume say what happened

test("pausing a queued crawl says Paused; pausing one that is capturing says it pauses after the page", async () => {
  const queued = reference({ status: "queued", mode: "crawl", maxPages: 10, progress: WAITING })
  const q = await withRunning(queued)
  q.on("POST", "/api/references/ref1/pause", () => ({ json: { ...queued, status: "paused", progress: "Paused" } }))
  await card(q).getByRole("button", { name: "Pause" }).click()
  await q.page.getByText("Paused", { exact: true }).first().waitFor()
  assert.equal(await q.page.getByText("Pausing after this page").count(), 0)

  const running = reference({ status: "capturing", mode: "crawl", maxPages: 10, progress: "Capturing 2/10: /pricing" })
  const c = await withRunning(running)
  c.on("POST", "/api/references/ref1/pause", () => ({ json: { ...running, control: "pause" } }))
  await card(c).getByRole("button", { name: "Pause" }).click()
  await c.page.getByText("Pausing after this page").waitFor()
})

// ---------------------------------------------------------------- the agent's progress text, with or without a total

test("the progress text reads with a total (7/25) and without one (page 1), and only while capturing", () => {
  const at = (progress: string | null, status: Reference["status"] = "capturing") => parseProgress({ status, progress })
  assert.deepEqual(at("Capturing 7/25: /enterprise"), { n: 7, total: 25, path: "/enterprise" })
  assert.deepEqual(at("Capturing page 1: /"), { n: 1, total: null, path: "/" })
  assert.deepEqual(at("Capturing page 12: /docs/getting started"), { n: 12, total: null, path: "/docs/getting started" })
  assert.equal(at("Waiting for the capture agent"), null)
  assert.equal(at("Paused"), null)
  assert.equal(at(null), null)
  assert.equal(at("Capturing 7/25: /enterprise", "queued"), null)
})

test("a crawl with a known total shows N of M pages and a real fraction, and one without shows Page N and an indeterminate bar", async () => {
  const known = await withRunning(reference({ status: "capturing", mode: "crawl", maxPages: 25, progress: "Capturing 5/10: /pricing" }))
  await card(known).getByText("5 of 10 pages").waitFor()
  assert.match((await card(known).locator("[style*='width']").getAttribute("style"))!, /width: 40%/)
  assert.equal(await bar(known).getAttribute("aria-valuenow"), "40")

  const unknown = await withRunning(reference({ status: "capturing", mode: "crawl", maxPages: 25, progress: "Capturing page 1: /" }))
  await card(unknown).getByText("Page 1", { exact: true }).waitFor()
  assert.equal(await card(unknown).getByText(/ of \d+ pages/).count(), 0, "a total that is not known is not shown")
  await bar(unknown).locator("[data-slot=progress-sweep]").waitFor()
  assert.equal(await bar(unknown).getAttribute("aria-valuenow"), null)
  assert.equal(await card(unknown).locator("[style*='width']").count(), 0)
  // Nothing is claimed to be queued behind it either.
  assert.equal(await unknown.page.getByText(/more queued/).count(), 0)
})

test("a crawl's page being captured and the pages queued behind it are one pending tile, and nothing on them spins", async () => {
  const t = await withRunning(reference({ status: "capturing", mode: "crawl", maxPages: 10, progress: "Capturing 4/10: /pricing" }))
  const pending = t.page.locator("[data-slot=skeleton]").filter({ hasText: /^(\/pricing|6 more queued)$/ })
  await t.page.getByText("6 more queued").waitFor()
  assert.equal(await pending.count(), 2)
  const looks = await pending.evaluateAll((els) => els.map((el) => { const s = getComputedStyle(el); return [el.className, s.animationName, s.borderStyle].join("|") }))
  assert.equal(looks[0], looks[1], "the two pending tiles look different")
  assert.match(looks[0]!, /skeleton-breathe/)
  assert.equal(await pending.locator("[data-slot=spinner], svg").count(), 0)

  // The card's own spinner (the Snip button, Starting…) breathes instead of turning under reduced motion.
  await t.page.emulateMedia({ reducedMotion: "reduce" })
  const breathing = await t.page.evaluate(() => {
    const el = document.createElement("div")
    el.className = "spinner"
    document.body.append(el)
    const name = getComputedStyle(el).animationName
    el.remove()
    return name
  })
  assert.equal(breathing, "spinner-breathe")
})

test("in the site, the capture pill shows how far it has got only when the crawl's total is known", async () => {
  const share = async (progress: string) => {
    const r = reference({ id: "ref1", status: "capturing", mode: "crawl", maxPages: 25, progress })
    const t = await app.session({ state: { references: { ref1: r } } })
    await t.goto("/?site=ref1")
    await t.page.getByRole("button", { name: "Pause" }).waitFor()
    return t.page.getByRole("progressbar", { name: "Pages captured" }).getAttribute("aria-valuenow")
  }
  assert.equal(await share("Capturing 5/10: /pricing"), "40")
  assert.equal(await share("Capturing page 1: /"), null, "without a total the bar sweeps")
})
