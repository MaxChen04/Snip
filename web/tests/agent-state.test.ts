import { test } from "node:test"
import assert from "node:assert/strict"
import { agentAdvice, agentState, type AgentAudience, type AgentState } from "../shared/agent-state"
import { CLOUD_OLDER_MESSAGE } from "../shared/capture-protocol"
import type { AgentPresence } from "../shared/types"

// One reading of the capture agent's presence, and the words every surface says about it. The Worker's MCP tools, the gallery banner and
// the desktop app all go through here, so an agent turned away for its version is never reported as offline by any of them.

const NOW = Date.parse("2026-03-10T15:00:00.000Z")
const seconds = (n: number) => new Date(NOW - n * 1000).toISOString()
const refusedAt = seconds(5)

const never: AgentPresence = { lastSeenAt: null, freshness: "never", activity: null, refused: null }
const offline: AgentPresence = { lastSeenAt: seconds(300), freshness: "stale", activity: "idle", refused: null }
const idle: AgentPresence = { lastSeenAt: seconds(10), freshness: "recent", activity: "idle", refused: null }
const busy: AgentPresence = { lastSeenAt: seconds(10), freshness: "recent", activity: "busy", refused: null }
const refused = (outdated: "app" | "cloud", rest: Partial<AgentPresence> = {}): AgentPresence => ({
  ...never,
  refused: { at: refusedAt, protocol: outdated === "app" ? 3 : 5, outdated },
  ...rest,
})

test("the state of the agent: a recent agent wins, then a refusal, then offline, then never", () => {
  const cases: [string, Parameters<typeof agentState>[0], AgentState][] = [
    ["nothing has ever contacted Snip", never, { kind: "never" }],
    ["seen before, not lately", offline, { kind: "offline", lastSeenAt: offline.lastSeenAt! }],
    ["checking in, idle", idle, { kind: "online", activity: "idle" }],
    ["checking in, busy", busy, { kind: "online", activity: "busy" }],
    ["turned away for being older than the Worker", refused("app"), { kind: "refused", outdated: "app", at: refusedAt }],
    ["turned away for being newer than the Worker", refused("cloud"), { kind: "refused", outdated: "cloud", at: refusedAt }],
    ["refused, and an older contact too: the refusal is the news", refused("app", { lastSeenAt: seconds(300), freshness: "stale", activity: "idle" }), { kind: "refused", outdated: "app", at: refusedAt }],
    ["refused, but another agent is checking in: it is online, something is working", refused("app", { lastSeenAt: seconds(10), freshness: "recent", activity: "busy" }), { kind: "online", activity: "busy" }],
    ["a Worker before 1.5.0 sends no refusal field", { lastSeenAt: null, freshness: "never", activity: null }, { kind: "never" }],
    ["a recent agent with no activity recorded", { lastSeenAt: seconds(10), freshness: "recent", activity: null }, { kind: "online", activity: null }],
  ]
  for (const [label, presence, expected] of cases) assert.deepEqual(agentState(presence), expected, label)
})

const today = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })

test("what each audience is told, for every state", () => {
  const advice = (presence: Parameters<typeof agentState>[0], audience: AgentAudience) => agentAdvice(agentState(presence), audience, NOW)
  const start = "Ask the user to open the Snip app or start `npm run capture` on their Mac. Stop polling until they do."
  const queued = "Queued captures wait until it runs."

  // An AI client: what is true, and what to do, with `Stop polling` wherever only the user can move it.
  assert.deepEqual(advice(never, "assistant"), { headline: "No capture agent has ever contacted Snip.", action: start })
  assert.deepEqual(advice(offline, "assistant"), { headline: "The capture agent was last seen 300s ago and is probably not running.", action: start })
  assert.deepEqual(advice(idle, "assistant"), { headline: "A capture agent is online.", action: "It should take queued captures within seconds." })
  assert.deepEqual(advice(busy, "assistant"), { headline: "A capture agent is online and busy with another job.", action: "It takes the next queued capture when that finishes." })
  assert.deepEqual(advice(refused("app"), "assistant"), {
    headline: "A capture agent is running but was turned away because it is older than the cloud library.",
    action: "Ask the user to update the Snip app, which carries the agent. Stop polling until they do.",
  })
  assert.deepEqual(advice(refused("cloud"), "assistant"), {
    headline: "A capture agent is running but was turned away because it is newer than the cloud library.",
    action: "Ask the user to update the cloud library (`npm run update`). Stop polling until they do.",
  })

  // The gallery in a browser tab: the words the banner has always shown.
  assert.deepEqual(advice(never, "browser"), { headline: "No capture agent has connected yet.", action: `${queued} Start it with \`npm run capture\`, or open Snip.app.` })
  assert.deepEqual(advice(offline, "browser"), { headline: `Capture agent offline since ${today(offline.lastSeenAt!)}.`, action: `${queued} Start it with \`npm run capture\`, or open Snip.app.` })
  assert.deepEqual(advice(refused("app"), "browser"), { headline: "A capture agent is running an older version.", action: "Update the Snip app. Queued captures wait until then." })
  assert.deepEqual(advice(refused("cloud"), "browser"), { headline: CLOUD_OLDER_MESSAGE, action: "Queued captures wait until then." })

  // The same gallery inside the Mac app, where there is no terminal to start anything in.
  assert.deepEqual(advice(never, "desktop"), { headline: "No capture agent has connected yet.", action: `${queued} Use Retry in Snip's menu bar, or restart Snip.` })
  assert.deepEqual(advice(offline, "desktop"), { headline: `Capture agent offline since ${today(offline.lastSeenAt!)}.`, action: `${queued} Use Retry in Snip's menu bar, or restart Snip.` })
  assert.deepEqual(advice(refused("app"), "desktop"), advice(refused("app"), "browser"), "an old app is fixed the same way in both")
  assert.deepEqual(advice(refused("cloud"), "desktop"), advice(refused("cloud"), "browser"))

  // Nothing about an agent that is checking in depends on who asks.
  for (const audience of ["browser", "desktop"] as const) for (const p of [idle, busy]) assert.deepEqual(advice(p, audience), advice(p, "assistant"))
})

test("offline is dated by the day: a time today, a date before", () => {
  const sameDay = new Date(NOW - 3 * 3600 * 1000).toISOString()
  const earlier = new Date(NOW - 5 * 86_400_000).toISOString()
  assert.equal(agentAdvice({ kind: "offline", lastSeenAt: sameDay }, "browser", NOW).headline, `Capture agent offline since ${today(sameDay)}.`)
  assert.equal(
    agentAdvice({ kind: "offline", lastSeenAt: earlier }, "browser", NOW).headline,
    `Capture agent offline since ${new Date(earlier).toLocaleDateString([], { month: "short", day: "numeric" })}.`,
  )
})

test("no advice has an em dash or an en dash, and backticks pair up", () => {
  const states: AgentState[] = [{ kind: "never" }, { kind: "offline", lastSeenAt: seconds(90) }, { kind: "online", activity: "idle" }, { kind: "online", activity: "busy" }, { kind: "refused", outdated: "app", at: refusedAt }, { kind: "refused", outdated: "cloud", at: refusedAt }]
  for (const state of states) {
    for (const audience of ["assistant", "browser", "desktop"] as const) {
      const { headline, action } = agentAdvice(state, audience, NOW)
      assert.doesNotMatch(`${headline} ${action}`, /[\u2013\u2014]/, `${state.kind} ${audience}`)
      assert.equal(`${headline}${action}`.split("`").length % 2, 1, `${state.kind} ${audience}: backticks pair up`)
    }
  }
})
