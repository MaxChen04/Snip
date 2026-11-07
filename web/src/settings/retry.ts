// What the error card offers, kept out of the component so it can be tested on its own.
// The engine reports `retryable` on every failure (contracts §1.3): `true` means the same
// command works once the person changes something outside Snip, `false` means repeating
// it cannot help.
import type { CloudError } from "./types"

export type ErrorAction = "refresh" | "retry" | "none"

export function errorAction(error: Pick<CloudError, "code" | "retryable">): ErrorAction {
  // A stale record is fixed by reading it again, never by repeating the same request.
  if (error.code === "CONFIRM_MISSING" || error.code === "CONFIRM_MISMATCH") return "refresh"
  // Only an explicit "no" removes the button. A failure that arrives without the field
  // comes from an older engine, and offering Retry is the honest default there.
  return error.retryable === false ? "none" : "retry"
}
