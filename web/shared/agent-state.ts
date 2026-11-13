// What Snip knows about the capture agent, and the one place that words it. The MCP tools (capture status, wait, add reference, tasks, the
// cloud setup check), the gallery banner and the Mac app all read this, so an agent turned away for its version (a 426, noted by
// `noteRefusedAgent`) is never called offline, or told to start the agent, by any of them. The agent, the tray, the doctor and the
// provisioning engine ship without web/shared and keep their own copies of the refusal (web/tests/capture-protocol-copies.test.ts).

import { CLOUD_OLDER_MESSAGE } from "./capture-protocol"
import type { AgentPresence } from "./types"

/** A recent agent wins (another agent is working, so an old refusal is not the news), then a refusal, then offline, then never. */
export type AgentState =
  | { kind: "online"; activity: "idle" | "busy" | null }
  | { kind: "refused"; outdated: "app" | "cloud"; at: string }
  | { kind: "offline"; lastSeenAt: string }
  | { kind: "never" }

/** Who is reading: an AI client calling an MCP tool, the gallery in a browser tab, or the gallery inside the Mac app. */
export type AgentAudience = "assistant" | "browser" | "desktop"

/** `headline` is what is true; `action` is what to do about it. Commands are in backticks. */
export type AgentAdvice = { headline: string; action: string }

/** What `GET /api/agent` returns; `refused` is absent from a Worker before 1.5.0. */
type Presence = Pick<AgentPresence, "lastSeenAt" | "freshness" | "activity"> & { refused?: AgentPresence["refused"] }

export const agentState = (p: Presence): AgentState =>
  p.freshness === "recent" ? { kind: "online", activity: p.activity }
  : p.refused ? { kind: "refused", outdated: p.refused.outdated, at: p.refused.at }
  : p.lastSeenAt ? { kind: "offline", lastSeenAt: p.lastSeenAt }
  : { kind: "never" }

const ASK = "Ask the user to open the Snip app or start `npm run capture` on their Mac. Stop polling until they do."

/** `now` only dates an offline agent (its age, or its day on the reader's clock); a test can fix it. The banner and the Mac app differ only for an absent agent. */
export function agentAdvice(state: AgentState, audience: AgentAudience, now: number = Date.now()): AgentAdvice {
  const assistant = audience === "assistant"
  switch (state.kind) {
    case "online":
      return state.activity === "busy"
        ? { headline: "A capture agent is online and busy with another job.", action: "It takes the next queued capture when that finishes." }
        : { headline: "A capture agent is online.", action: "It should take queued captures within seconds." }
    case "refused":
      if (assistant)
        return state.outdated === "cloud"
          ? { headline: "A capture agent is running but was turned away because it is newer than the cloud library.", action: "Ask the user to update the cloud library (`npm run update`). Stop polling until they do." }
          : { headline: "A capture agent is running but was turned away because it is older than the cloud library.", action: "Ask the user to update the Snip app, which carries the agent. Stop polling until they do." }
      return state.outdated === "cloud"
        ? { headline: CLOUD_OLDER_MESSAGE, action: "Queued captures wait until then." }
        : { headline: "A capture agent is running an older version.", action: "Update the Snip app. Queued captures wait until then." }
    case "offline":
    case "never": {
      const seen = state.kind === "offline" ? new Date(state.lastSeenAt) : null
      if (assistant)
        return { headline: seen ? `The capture agent was last seen ${Math.max(0, Math.round((now - +seen) / 1000))}s ago and is probably not running.` : "No capture agent has ever contacted Snip.", action: ASK }
      const when = seen && (seen.toDateString() === new Date(now).toDateString() ? seen.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : seen.toLocaleDateString([], { month: "short", day: "numeric" }))
      return {
        headline: when ? `Capture agent offline since ${when}.` : "No capture agent has connected yet.",
        action: `Queued captures wait until it runs. ${audience === "desktop" ? "Use Retry in Snip's menu bar, or restart Snip." : "Start it with `npm run capture`, or open Snip.app."}`,
      }
    }
  }
}
