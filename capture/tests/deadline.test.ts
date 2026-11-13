import { test } from "node:test"
import assert from "node:assert/strict"
import { diagnoseCaptureError } from "../../web/shared/capture-errors"
import { PageDeadlineError, pageDeadline, within } from "../src/deadline"

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const never = () => new Promise<never>(() => {})

test("a page that finishes no step is freed when its stall clock runs out, with a reason the app already explains", async () => {
  const deadline = pageDeadline(40)
  const started = Date.now()
  await assert.rejects(Promise.race([deadline.expiry, never()]), (e: Error) => e instanceof PageDeadlineError && e.message === "Page stopped making progress: Timeout 40ms exceeded.")
  assert.ok(Date.now() - started < 1000)
  assert.equal(deadline.expired, true)
  assert.equal(deadline.error.message, "Page stopped making progress: Timeout 40ms exceeded.")
  // The wording follows Playwright's own timeout messages, so the Retry card says the site was too slow, with nothing new in capture-errors.ts.
  assert.match(diagnoseCaptureError(deadline.error.message)!.summary, /in time/)
})

test("every finished step restarts the clock: a page that keeps stepping is never stalled, however long it takes", async () => {
  const deadline = pageDeadline(100)
  const started = Date.now()
  // Several times the stall window, a step every 30 ms.
  while (Date.now() - started < 450) {
    await delay(30)
    assert.equal(deadline.tick(), true)
    assert.equal(deadline.expired, false)
  }
  // Then it stops stepping, and the clock runs out from the last step.
  const lastTick = Date.now()
  await assert.rejects(deadline.expiry, PageDeadlineError)
  assert.ok(Date.now() - lastTick >= 90, "a full stall window after the last step")
  assert.ok(Date.now() - lastTick < 1000)
})

test("ticks of a page that was given up on or is done are ignored and do not count", async () => {
  const stalled = pageDeadline(20)
  await delay(80)
  assert.equal(stalled.tick(), false, "no reviving a page that was given up on")
  assert.equal(stalled.expired, true)

  const done = pageDeadline(40)
  done.finish()
  assert.equal(done.tick(), false)
  await delay(120)
  assert.equal(done.expired, false, "and none restarts a clock that was stopped")
})

test("past its ceiling a page is given up on however steadily it steps", async () => {
  const deadline = pageDeadline(60, 200)
  const started = Date.now()
  const stepping = setInterval(() => deadline.tick(), 20)
  try {
    await assert.rejects(deadline.expiry, (e: Error) => e.message === "Page took too long to capture: Timeout 200ms exceeded.")
  } finally {
    clearInterval(stepping)
  }
  assert.ok(Date.now() - started >= 190 && Date.now() - started < 1500)
  assert.equal(deadline.error.message, "Page took too long to capture: Timeout 200ms exceeded.")
  assert.match(diagnoseCaptureError(deadline.error.message)!.summary, /in time/)
})

test("work that was given up on is refused at finish(), so it cannot go on to upload", async () => {
  const deadline = pageDeadline(20)
  await delay(80)
  assert.equal(deadline.expired, true)
  assert.throws(() => deadline.finish(), PageDeadlineError)
})

test("a page that finishes in time is never given up on, and its clocks stop", async () => {
  const deadline = pageDeadline(40, 80)
  deadline.tick()
  deadline.finish()
  await delay(200)
  assert.equal(deadline.expired, false, "neither the stall clock nor the ceiling fired after finish()")
})

test("a deadline nobody waits on is no unhandled rejection", async () => {
  const unhandled: unknown[] = []
  const record = (reason: unknown) => unhandled.push(reason)
  process.on("unhandledRejection", record)
  try {
    pageDeadline(10)
    await delay(100)
  } finally {
    process.off("unhandledRejection", record)
  }
  assert.deepEqual(unhandled, [])
})

test("clear() stops the clocks without judging the page", async () => {
  const deadline = pageDeadline(20, 40)
  deadline.clear()
  await delay(100)
  assert.equal(deadline.expired, false)
  deadline.finish() // no throw
})

test("within() waits for its work but never longer than the limit, and never fails", async () => {
  const quick = Date.now()
  await within(5_000, delay(20))
  assert.ok(Date.now() - quick < 1000, "returns as soon as the work does")

  const stuck = Date.now()
  await within(60, never())
  assert.ok(Date.now() - stuck >= 50 && Date.now() - stuck < 1000, "gives up on work that never ends")

  await within(1_000, Promise.reject(new Error("closing failed")))
  await within(1_000, undefined)
})
