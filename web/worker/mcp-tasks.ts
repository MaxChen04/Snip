import type { CaptureStatus, Reference } from "../shared/types"
import { STOPPED_EMPTY } from "../shared/capture-errors"

// MCP Tasks extension (io.modelcontextprotocol/tasks, 2026-07-28). A capture is
// already a durable job in D1, so the task id is the reference id and tasks/get
// reads the capture's current state; nothing extra is stored.
//
// Spec rules this module encodes:
// - A task is returned only to a client that declared the extension on that request.
// - "failed" is reserved for JSON-RPC errors; a capture that failed is a completed
//   task whose tool result has isError: true.
// - The client honors pollIntervalMs, so it tracks the capture's own poll advice.

export const TASKS_EXTENSION = "io.modelcontextprotocol/tasks"
const CLIENT_CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities"

/** Default wait inside one wait_for_capture call. Codex gives an MCP tool call 60s by default. */
export const WAIT_DEFAULT_SECONDS = 40
export const WAIT_MAX_SECONDS = 50
export const WAIT_STEP_MS = 5_000

type Envelope = Record<string, unknown> | undefined

/** Whether this request's per-request capabilities (protocol 2026-07-28) declare the Tasks extension. */
export function clientDeclaresTasks(ctx: unknown): boolean {
  const envelope = (ctx as { mcpReq?: { envelope?: Envelope } } | undefined)?.mcpReq?.envelope
  const caps = envelope?.[CLIENT_CAPABILITIES_KEY] as { extensions?: Record<string, unknown> } | undefined
  return !!caps?.extensions && Object.prototype.hasOwnProperty.call(caps.extensions, TASKS_EXTENSION)
}

export type CaptureTaskStatus = "working" | "completed" | "cancelled"

/** Whether the capture has reached an end state (the task, or a wait, is over). */
export const isFinished = (ref: Reference) => ref.status === "ready" || ref.status === "failed"

/** Whether waiting is pointless right now: nobody is capturing this, so only the user can move it. */
export const needsUser = (ref: Reference, status: CaptureStatus) =>
  !isFinished(ref) && (ref.status === "paused" || status.pollAfterSeconds == null)

export function taskStatus(ref: Reference): CaptureTaskStatus {
  if (ref.status === "ready") return "completed"
  // Stopping a capture before its first page is the one way it ends with nothing, so that is a cancellation.
  if (ref.status === "failed") return ref.error === STOPPED_EMPTY ? "cancelled" : "completed"
  return "working"
}

/** The Task fields shared by CreateTaskResult and tasks/get. */
export function taskFields(ref: Reference, status: CaptureStatus) {
  const state = taskStatus(ref)
  const message = state === "working" ? [ref.progress, status.advice].filter(Boolean).join(". ") : status.advice
  return {
    taskId: ref.id,
    status: state,
    statusMessage: message,
    createdAt: ref.createdAt,
    lastUpdatedAt: ref.updatedAt,
    // References persist until the user deletes them, so the task does too.
    ttlMs: null,
    // Paused or waiting for the Mac: check back slowly instead of stopping, so the task still ends when the user acts.
    pollIntervalMs: (status.pollAfterSeconds ?? 60) * 1000,
  }
}
