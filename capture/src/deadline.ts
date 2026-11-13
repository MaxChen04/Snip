/**
 * How long one page may take, from its first request to its last screenshot, before it is given up on and the capture
 * goes on to the next page. This is the one number the limits around a page follow: the runtime's hang watchdog
 * (runtime.ts) is a multiple of it, and captureJob takes it as its default (tests pass a short one).
 *
 * Healthy pages took 17 to 68 s on a 4-core Linux box (70 of 83 real captures of nine sites, median 41 s); the
 * other 13, from the heaviest sites (coframe.com, twelvelabs.io, poolside.ai, cohere.com/research), took 125 to 237 s and
 * nothing fell between. 120 s clears the first group's slowest page by 1.75x and is the longest a stuck page is waited
 * on. Hardware that needs longer for the heavy sites is a reason to raise this one constant, not to add another limit.
 */
export const PAGE_DEADLINE_MS = 120_000

/**
 * Why a page was given up on. The text follows Playwright's own timeout messages ("page.goto: Timeout 45000ms exceeded."), so
 * diagnoseCaptureError (web/shared/capture-errors.ts) reads it as "the site didn't respond in time" with no new wording there.
 */
export class PageDeadlineError extends Error {
  constructor(ms: number) {
    super(`Page took too long to capture: Timeout ${ms}ms exceeded.`)
  }
}

/**
 * A page's deadline, running from the moment it is made. `expiry` rejects when the time is up, so racing the page's work
 * against it frees the capture even when a call into the page never returns. Work that was cut off may still be running:
 * it must call finish() before it does anything with effects outside the browser (uploading), and finish() refuses once
 * the time is up.
 */
export function pageDeadline(ms: number) {
  let expired = false
  const error = new PageDeadlineError(ms)
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true
      reject(error)
    }, ms)
  })
  expiry.catch(() => {}) // the page's work is raced against it, but a deadline nobody waits on must not be an unhandled rejection
  return {
    expiry,
    error,
    get expired() {
      return expired
    },
    /** The browser's work on the page is done: stop the clock. Throws if the time was already up, so a page that was given up on never goes on to save anything. */
    finish() {
      clearTimeout(timer)
      if (expired) throw error
    },
    /** Stop the clock without judging the page (it ended some other way). */
    clear() {
      clearTimeout(timer)
    },
  }
}

/** Wait for `work`, but never longer than `ms`, and never fail: for teardown that must not hold up what follows. */
export async function within(ms: number, work: PromiseLike<unknown> | undefined) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([Promise.resolve(work).catch(() => {}), new Promise<void>((resolve) => { timer = setTimeout(resolve, ms) })])
  } finally {
    clearTimeout(timer)
  }
}
