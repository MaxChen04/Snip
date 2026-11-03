import { test } from "node:test"
import assert from "node:assert/strict"
import type { Job } from "../../web/shared/types"
import { CaptureAuthenticationError, SnipApi } from "../src/api"
import { CaptureRuntime, idlePollDelay, type CaptureStatus } from "../src/runtime"

const job = { id: "job-1" } as Job
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await delay(5)
  assert.ok(check(), "condition was not met")
}
const browser = () => ({ isConnected: () => true, close: async () => {} })

test("stop during claim finishes the claimed job and closes the browser", async () => {
  let resolveClaim!: (value: Job | null) => void
  const claim = new Promise<Job | null>((resolve) => { resolveClaim = resolve })
  const statuses: CaptureStatus[] = []
  let captured = 0, closed = 0, claims = 0
  const runtime = new CaptureRuntime({
    api: { claim: () => { claims++; return claim }, heartbeat: async () => {}, fail: async () => {} },
    launch: async () => ({ ...browser(), close: async () => { closed++ } }),
    capture: async () => { captured++ }, status: (s) => statuses.push(s), pollMs: 5, idleMs: 20, once: false,
  })
  const done = runtime.run()
  runtime.stop()
  resolveClaim(job)
  await done
  assert.equal(captured, 1)
  assert.equal(closed, 1)
  assert.equal(claims, 1)
  assert.equal(statuses.at(-1)?.state, "stopping")
})

test("offline retries back off, retry wakes immediately, and a successful poll resets the delay", async () => {
  let calls = 0
  const statuses: CaptureStatus[] = []
  const runtime = new CaptureRuntime({
    api: { claim: async () => { calls++; if (calls === 3) return null; throw Error("secret") }, heartbeat: async () => {}, fail: async () => {} },
    launch: async () => browser(), capture: async () => {}, status: (s) => statuses.push(s),
    pollMs: 10, idleMs: 50, once: false, random: () => 0.5,
  })
  const done = runtime.run()
  await until(() => statuses.filter((s) => s.state === "disconnected").length === 1)
  runtime.retry()
  await until(() => statuses.filter((s) => s.state === "disconnected").length === 2)
  runtime.retry()
  await until(() => statuses.filter((s) => s.state === "disconnected").length === 3)
  runtime.stop()
  await done
  const disconnected = statuses.filter((s) => s.state === "disconnected")
  assert.deepEqual(disconnected.map((s) => s.retryInMs), [1000, 2000, 1000])
  assert.ok(statuses.some((s) => s.state === "idle"))
  assert.ok(!JSON.stringify(statuses).includes("secret"))
})

test("browser closes after idle, never during a capture", async () => {
  let calls = 0, captured = false, closed = 0, release!: () => void
  const pending = new Promise<void>((resolve) => { release = resolve })
  const statuses: CaptureStatus[] = []
  const runtime = new CaptureRuntime({
    api: { claim: async () => ++calls === 1 ? job : null, heartbeat: async () => {}, fail: async () => {} },
    launch: async () => ({ ...browser(), close: async () => { closed++ } }),
    capture: async () => { captured = true; await pending }, status: (s) => statuses.push(s), pollMs: 5, idleMs: 15, once: false,
  })
  const done = runtime.run()
  await until(() => captured)
  await delay(30)
  assert.equal(closed, 0)
  release()
  await until(() => closed === 1)
  runtime.stop()
  await done
  assert.ok(statuses.some((s) => s.state === "busy" && s.jobId === job.id))
})

test("claim request times out when a server never responds", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
  })) as typeof fetch
  try {
    const api = new SnipApi("http://example.test", "test", 100, 30)
    await assert.rejects(api.claim())
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("healthy idle polling grows to a 30-second cap and resets to its baseline", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 1].map((n) => idlePollDelay(5000, n)), [5000, 10000, 20000, 30000, 30000, 5000])
})

for (const result of ["empty", "error"] as const) {
  test(`retry during an in-flight ${result} claim triggers an immediate poll`, async () => {
    let resolveClaim!: (value: Job | null) => void
    let rejectClaim!: (reason: Error) => void
    const pending = new Promise<Job | null>((resolve, reject) => { resolveClaim = resolve; rejectClaim = reject })
    let calls = 0
    const runtime = new CaptureRuntime({
      api: { claim: () => { calls++; return calls === 1 ? pending : Promise.resolve(null) }, heartbeat: async () => {}, fail: async () => {} },
      launch: async () => browser(), capture: async () => {}, status: () => {}, pollMs: 10_000, idleMs: 100, once: false,
    })
    const done = runtime.run()
    runtime.retry()
    if (result === "empty") resolveClaim(null)
    else rejectClaim(new Error("offline"))
    await until(() => calls === 2)
    runtime.stop()
    await done
  })
}

test("authentication errors produce an actionable status without disclosing details", async () => {
  const statuses: CaptureStatus[] = []
  const runtime = new CaptureRuntime({
    api: { claim: async () => { throw new CaptureAuthenticationError() }, heartbeat: async () => {}, fail: async () => {} },
    launch: async () => browser(), capture: async () => {}, status: (s) => statuses.push(s), pollMs: 5, idleMs: 50, once: true,
  })
  await runtime.run()
  assert.match(statuses.find((s) => s.state === "disconnected")?.error ?? "", /token.*401/i)
})
