import { test } from "node:test"
import assert from "node:assert/strict"
import { diagnoseCaptureError } from "../../web/shared/capture-errors"
import { PageDeadlineError, pageDeadline, within } from "../src/deadline"

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const never = () => new Promise<never>(() => {})

test("a page's work that never settles is freed when its deadline passes, with a reason the app already explains", async () => {
  const deadline = pageDeadline(40)
  const started = Date.now()
  await assert.rejects(Promise.race([deadline.expiry, never()]), (e: Error) => e instanceof PageDeadlineError && e.message === "Page took too long to capture: Timeout 40ms exceeded.")
  assert.ok(Date.now() - started < 1000)
  assert.equal(deadline.expired, true)
  // The wording follows Playwright's own timeout messages, so the Retry card says the site was too slow, with nothing new in capture-errors.ts.
  assert.match(diagnoseCaptureError(deadline.error.message)!.summary, /in time/)
})

test("a page that finishes in time is never given up on, and its clock stops", async () => {
  const deadline = pageDeadline(40)
  deadline.finish()
  await delay(120)
  assert.equal(deadline.expired, false, "the clock stopped at finish()")
})

test("work that was given up on is refused at finish(), so it cannot go on to upload", async () => {
  const deadline = pageDeadline(20)
  await delay(80)
  assert.equal(deadline.expired, true)
  assert.throws(() => deadline.finish(), PageDeadlineError)
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

test("clear() stops the clock without judging the page", async () => {
  const deadline = pageDeadline(20)
  deadline.clear()
  await delay(80)
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
