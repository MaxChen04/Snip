import type { CaptureStatus, Reference } from "../shared/types"
import { STOPPED_EMPTY } from "../shared/capture-errors"

// MCP Tasks extension (io.modelcontextprotocol/tasks, 2026-07-28). A capture is
// already a durable job in D1, so the task id is "<reference id>.<capture run>" and
// tasks/get reads the capture's current state; nothing extra is stored. A Recapture
// starts a new run, which ends the old run's task as cancelled.
//
// Spec rules this module encodes:
// - A task is returned only to a client that declared the extension on that request.
// - "failed" is reserved for JSON-RPC errors; a capture that failed is a completed
//   task whose tool result has isError: true.
// - "input_required" is a capture only the user can move (paused, or no capture agent). It asks the
//   client nothing, so there are no input requests; statusMessage says what the user has to do.
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

export type CaptureTaskStatus = "working" | "input_required" | "completed" | "cancelled"

/**
 * Where a capture stands for anyone following it. wait_for_capture and tasks/get both read this,
 * so they agree on when it is over and when waiting is pointless.
 */
export function taskStatus(ref: Reference, status: CaptureStatus): CaptureTaskStatus {
  if (ref.status === "ready") return "completed"
  // Stopping a capture before its first page is the one way it ends with nothing, so that is a cancellation.
  if (ref.status === "failed") return ref.error === STOPPED_EMPTY ? "cancelled" : "completed"
  // No poll advice means nobody is capturing this (paused, or no capture agent): only the user can move it.
  return status.pollAfterSeconds == null ? "input_required" : "working"
}

/** Whether the capture has reached an end state (the task, or a wait, is over). */
export const isOver = (state: CaptureTaskStatus) => state === "completed" || state === "cancelled"

export const taskIdFor = (ref: Reference) => `${ref.id}.${ref.captureRun}`

/** The reference and run a task id names, or null when it is not one of ours. */
export function parseTaskId(taskId: string): { referenceId: string; run: number } | null {
  const m = /^([0-9a-f]{16})\.([1-9][0-9]{0,8})$/.exec(taskId)
  return m ? { referenceId: m[1]!, run: Number(m[2]) } : null
}

/** A task whose run was replaced by a Recapture. Its own result is gone with the old pages. */
export function supersededTaskFields(ref: Reference, run: number) {
  return {
    taskId: `${ref.id}.${run}`,
    status: "cancelled" as const,
    statusMessage: `The user recaptured this reference, which replaced this capture. Follow the new capture with wait_for_capture(reference_id "${ref.id}").`,
    createdAt: ref.createdAt,
    lastUpdatedAt: ref.updatedAt,
    ttlMs: null,
  }
}

/** The Task fields shared by CreateTaskResult and tasks/get. */
export function taskFields(ref: Reference, status: CaptureStatus) {
  const state = taskStatus(ref, status)
  // Queued advice already starts with the progress text ("Waiting for your Mac: …"); don't say it twice.
  const progress = ref.progress && !status.advice.startsWith(ref.progress) ? ref.progress : null
  const message = state === "working" ? [progress, status.advice].filter(Boolean).join(". ") : status.advice
  return {
    taskId: taskIdFor(ref),
    status: state,
    statusMessage: message,
    createdAt: ref.createdAt,
    lastUpdatedAt: ref.updatedAt,
    // References persist until the user deletes them, so the task does too.
    ttlMs: null,
    // Waiting on the user: check back slowly instead of stopping, so the task still ends when they act.
    pollIntervalMs: (status.pollAfterSeconds ?? 60) * 1000,
  }
}
