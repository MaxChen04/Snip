import { test, mock } from "node:test"
import assert from "node:assert/strict"
import type { Job } from "../../web/shared/types"
import { JobGoneError, SnipApi } from "../src/api"
import { CaptureRuntime } from "../src/runtime"

// Regression tests for runtime recovery bugs (hung capture, local stop, lost lease).
// They assert the CORRECT behaviour and fail until the runtime is fixed.

const job1 = { id: "job-1", attempt: "a" } as Job
const job2 = { id: "job-2", attempt: "b" } as Job
const browser = () => ({ isConnected: () => true, close: async () => {} })
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve)) }

/** The abort signal a capture function was handed, wherever the fix puts it (extra argument, or a `signal` field). */
const signalOf = (rest: unknown[]): AbortSignal | undefined => {
  for (const arg of rest) {
    if (arg instanceof AbortSignal) return arg
    const inner = (arg as { signal?: unknown } | null)?.signal
    if (inner instanceof AbortSignal) return inner
  }
  return undefined
}

test("a capture that never settles is failed within 10 minutes, its heartbeat stops, and the next job is claimed", async () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] })
  try {
    const queue: (Job | null)[] = [job1, job2, null]
    const heartbeats: (string | null)[] = []
    const failed: string[] = []
    const captured: string[] = []
    let claims = 0
    const runtime = new CaptureRuntime({
      api: {
        claim: async () => { claims++; return queue.shift() ?? null },
        heartbeat: async (id) => { heartbeats.push(id) },
        fail: async (id) => { failed.push(id) },
      },
      launch: async () => browser(),
      // job-1 hangs forever; job-2 finishes at once.
      capture: async (_browser, job) => { captured.push(job.id); if (job.id === job1.id) await new Promise<void>(() => {}) },
      status: () => {}, pollMs: 5, idleMs: 50, once: false,
    })
    void runtime.run()
    await flush()
    assert.deepEqual(captured, ["job-1"])

    // Ten minutes of fake time, with no progress from the capture.
    for (let elapsed = 0; elapsed < 600_000; elapsed += 5_000) {
      mock.timers.tick(5_000)
      await flush()
    }
    assert.deepEqual(failed, ["job-1"], "the hung job is reported failed through api.fail within 10 minutes")
    assert.ok(captured.includes("job-2"), "the worker went on to claim and capture the next job")

    // The hung job's heartbeat is gone: no more beats for it, however long we wait.
    const before = heartbeats.filter((id) => id === job1.id).length
    for (let elapsed = 0; elapsed < 300_000; elapsed += 5_000) {
      mock.timers.tick(5_000)
      await flush()
    }
    assert.equal(heartbeats.filter((id) => id === job1.id).length, before, "no heartbeats for the failed job")
    runtime.stop()
  } finally {
    mock.timers.reset()
  }
})

test("stop() aborts the signal handed to the running capture", async () => {
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  let signal: AbortSignal | undefined
  let started = false
  const runtime = new CaptureRuntime({
    api: { claim: async () => job1, heartbeat: async () => {}, fail: async () => {} },
    launch: async () => browser(),
    capture: async (...args: unknown[]) => { started = true; signal = signalOf(args.slice(2)); await held },
    status: () => {}, pollMs: 5, idleMs: 50, once: false,
  } as ConstructorParameters<typeof CaptureRuntime<ReturnType<typeof browser>>>[0])
  const done = runtime.run()
  try {
    for (let i = 0; i < 100 && !started; i++) await flush()
    assert.ok(started, "capture started")
    assert.ok(signal, "the capture function is given an AbortSignal")
    assert.equal(signal!.aborted, false, "not aborted before stop()")
    runtime.stop()
    assert.equal(signal!.aborted, true, "stop() aborts the running capture's signal")
  } finally {
    // Wind the runtime down even when an assertion failed, so its real heartbeat timer cannot keep the process alive.
    runtime.stop()
    release()
    await done
  }
})

test("a 410 on heartbeat aborts the running capture's signal instead of being swallowed", async () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] })
  const originalFetch = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = new URL(String(input instanceof Request ? input.url : input)).pathname
    calls.push(path)
    if (path === "/agent/jobs/claim") return new Response(JSON.stringify(job1), { status: 200, headers: { "content-type": "application/json" } })
    if (path === "/agent/heartbeat") return new Response("gone", { status: 410 })
    return new Response("{}", { status: 200 })
  }) as typeof fetch
  try {
    let signal: AbortSignal | undefined
    let started = false
    const runtime = new CaptureRuntime({
      api: new SnipApi("http://example.test", "token"),
      launch: async () => browser(),
      // Never settles by itself: only the signal can tell it the lease is gone.
      capture: async (...args: unknown[]) => { started = true; signal = signalOf(args.slice(2)); await new Promise<void>(() => {}) },
      status: () => {}, pollMs: 5, idleMs: 50, once: false,
    } as ConstructorParameters<typeof CaptureRuntime<ReturnType<typeof browser>>>[0])
    void runtime.run()
    for (let i = 0; i < 100 && !started; i++) await flush()
    assert.ok(started, "capture started")
    assert.ok(signal, "the capture function is given an AbortSignal")
    mock.timers.tick(30_000)
    for (let i = 0; i < 20; i++) await flush()
    assert.ok(calls.includes("/agent/heartbeat"), "the heartbeat fired and got the 410")
    assert.equal(signal!.aborted, true, "a lost lease (410) aborts the capture")
    runtime.stop()
  } finally {
    globalThis.fetch = originalFetch
    mock.timers.reset()
  }
})

test("a lost lease stops the heartbeat for that job, and the capture reports progress to hold off the hang timeout", async () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] })
  try {
    const heartbeats: (string | null)[] = []
    const failed: string[] = []
    let progress!: () => void
    let finish!: () => void
    const runtime = new CaptureRuntime({
      api: {
        claim: async () => (heartbeats.length ? null : job1),
        heartbeat: async (id) => { heartbeats.push(id); if (heartbeats.length === 21) throw new JobGoneError() },
        fail: async (id) => { failed.push(id) },
      },
      launch: async () => browser(),
      capture: async (_browser, _job, _signal, report) => { progress = report; await new Promise<void>((resolve) => { finish = resolve }) },
      status: () => {}, pollMs: 5, idleMs: 50, once: false,
    })
    const done = runtime.run()
    await flush()
    // Ten minutes in which the capture keeps reporting progress: it is not failed.
    for (let elapsed = 0; elapsed < 600_000; elapsed += 30_000) {
      mock.timers.tick(30_000)
      progress()
      await flush()
    }
    assert.deepEqual(failed, [])
    assert.equal(heartbeats.length, 20)
    // The next beat is answered "job is gone": no beat after it.
    mock.timers.tick(30_000)
    await flush()
    mock.timers.tick(90_000)
    await flush()
    assert.equal(heartbeats.length, 21)
    runtime.stop()
    finish()
    await done
  } finally {
    mock.timers.reset()
  }
})
