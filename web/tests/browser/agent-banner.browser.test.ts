// The banner over the gallery when captures wait and no agent is checking in: offline, or turned away for its version.
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { WAITING } from "../../shared/capture-errors.ts"
import { reference, startApp, type App } from "./harness.ts"

let app: App
before(async () => void (app = await startApp()))
after(async () => app?.stop())

type Agent = { lastSeenAt: string | null; freshness: "recent" | "stale" | "never"; activity: "idle" | "busy" | null; refused?: { at: string; protocol: number | null; outdated: "app" | "cloud" } | null }

/** The home page with one capture waiting, and the agent status as given. */
const withWaiting = async (agent: Agent, { desktop = false } = {}) => {
  const queued = reference({ status: "queued", progress: WAITING })
  const t = await app.session({ state: { references: { [queued.id]: queued } } })
  t.on("GET", "/api/references", (req) => (req.query.get("status") === "queued" ? { json: { items: [queued], nextCursor: null } } : undefined))
  t.on("GET", "/api/agent", () => ({ json: agent }))
  if (desktop) await t.page.addInitScript(() => { (window as unknown as { snipDesktop: object }).snipDesktop = { initialState: {}, remember() {}, checkQueue() {} } })
  await t.goto("/")
  return t
}
const banner = (t: Awaited<ReturnType<typeof withWaiting>>) => t.page.getByRole("status").filter({ hasText: /capture|cloud library/i })
const refusedAt = new Date().toISOString()

test("an agent turned away for being older is not called offline, and the fix named is the Snip app", async () => {
  for (const desktop of [false, true]) {
    const t = await withWaiting({ lastSeenAt: null, freshness: "never", activity: null, refused: { at: refusedAt, protocol: 3, outdated: "app" } }, { desktop })
    const text = await banner(t).innerText()
    assert.match(text, /A capture agent is running an older version\. Update the Snip app\./)
    assert.doesNotMatch(text, /offline|has connected|menu bar|restart Snip|npm run capture/i, `desktop ${desktop}`)
  }
})

test("an agent turned away for being newer than the cloud library sends the user to update the cloud library", async () => {
  const t = await withWaiting({ lastSeenAt: null, freshness: "never", activity: null, refused: { at: refusedAt, protocol: 5, outdated: "cloud" } })
  const text = await banner(t).innerText()
  assert.match(text, /Your cloud library is older than this Snip\. Update cloud \(npm run update\)\./)
  assert.doesNotMatch(text, /offline|menu bar|restart Snip/i)
})

test("the refusal replaces the offline wording even when the agent was seen before it", async () => {
  const t = await withWaiting({ lastSeenAt: "2026-01-01T10:00:00.000Z", freshness: "stale", activity: "idle", refused: { at: refusedAt, protocol: 3, outdated: "app" } })
  const text = await banner(t).innerText()
  assert.match(text, /A capture agent is running an older version/)
  assert.doesNotMatch(text, /offline since/)
})

test("without a refusal the banner is the same as before: offline since, or never connected", async () => {
  const gone = await withWaiting({ lastSeenAt: "2026-01-01T10:00:00.000Z", freshness: "stale", activity: "idle", refused: null })
  assert.match(await banner(gone).innerText(), /Capture agent offline since .*Queued captures wait until it runs/s)
  // A Worker that predates the field sends none.
  const never = await withWaiting({ lastSeenAt: null, freshness: "never", activity: null })
  assert.match(await banner(never).innerText(), /No capture agent has connected yet/)
})

test("an agent that is checking in leaves no banner, whatever else was refused", async () => {
  const t = await withWaiting({ lastSeenAt: refusedAt, freshness: "recent", activity: "idle", refused: { at: refusedAt, protocol: 3, outdated: "app" } })
  await t.page.getByText(WAITING).first().waitFor()
  assert.equal(await banner(t).count(), 0)
})
