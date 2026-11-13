// The capture protocol: the number an agent sends in `x-snip-capture-protocol` and the Worker requires, and what each side says
// when the other is on another one. The Worker (web/worker/app.ts) reads this module. The capture agent, the doctor
// (scripts/doctor.mjs) and the provisioning engine (desktop/provision) ship without web/shared, so each keeps a copy;
// web/tests/capture-protocol-copies.test.ts keeps every copy equal to this one.

/** Bump it when the agent and the Worker can no longer work with one that has the old number. Worker 1.4.0 and earlier: 3. */
export const CAPTURE_PROTOCOL = 4
export const CAPTURE_PROTOCOL_HEADER = "x-snip-capture-protocol"

/** The agent is on a lower protocol than the Worker: the Snip app, which carries the agent, is the older half. */
export const AGENT_OLDER_MESSAGE = "This capture agent is older than your cloud library. Update the Snip app."
/** The Worker is on a lower protocol than the agent. The wording of the sign-in handoff's refusal (docs/deploy.md, "Update the Worker together with the app"). */
export const CLOUD_OLDER_MESSAGE = "Your cloud library is older than this Snip. Update cloud (npm run update)."
/** A refusal that does not say which: both updates fix it, the app first. */
export const MISMATCH_MESSAGE = "This capture agent and your cloud library are on different versions. Update the Snip app, then update cloud (npm run update)."

/**
 * What the Worker says to an agent that sent `sent` as its protocol. Only a number above the Worker's own means the agent is
 * newer; a missing or unreadable one is an agent too old to have sent it.
 */
export const refusalMessage = (sent: string | undefined) => (/^\d+$/.test(sent ?? "") && Number(sent) > CAPTURE_PROTOCOL ? CLOUD_OLDER_MESSAGE : AGENT_OLDER_MESSAGE)
