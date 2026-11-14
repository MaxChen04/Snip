/**
 * How long a page may go without finishing a step before it is given up on and the capture goes on to the next page.
 * "Stuck" means no step finished in this long, never "took long": a heavy page that keeps finishing steps (a scroll frame, a
 * section, a hover, a stylesheet) is working and is left alone. So every step's own limit must sit below this, and a wait that
 * may never be answered has a short cap of its own. This is the one number the limits around a page follow: the page's ceiling
 * and the runtime's hang watchdog (runtime.ts) are multiples of it, and captureJob takes it as its default (tests pass a short one).
 *
 * Measured as the longest gap between two finished steps on healthy pages, on a 4-core box with six busy loops running beside
 * the capture (load average 12 to 21): 6.3 s on a 22 000 px page with 28 sections, 8 live clips and a canvas loop (158 to 287 s
 * in all, so no fixed wall would do); 2.3 s on a page whose every frame and scroll event costs 40 ms of script; 36 to 42 s on a
 * page of 120 000 elements, where reading every element's styles is one call. The logs of real runs (coframe.com, 237 s in all)
 * show no phase outside the scroll loop over 9 s. The slowest step with a limit of its own is a navigation, 45 s. 90 s is twice
 * that, and twice the worst gap measured.
 */
export const PAGE_STALL_MS = 90_000

/**
 * The most a page may take in all, however steadily it progresses: one that finishes a step every few seconds for ever is not
 * working either. The slowest healthy page seen took 287 s with the machine at a load of 15 to 21; 10 stalls is 900 s, 3x that.
 * Every loop in a page is capped as well (SCROLL_MAX_FRAMES frames, 40 000 px, MAX_LIVE clips, MAX_HOVERS hovers), so a
 * healthy page is far from this.
 */
const CEILING_FACTOR = 10

/**
 * Why a page was given up on. Both texts follow Playwright's own timeout messages ("page.goto: Timeout 45000ms exceeded."), so
 * diagnoseCaptureError (web/shared/capture-errors.ts) reads them as "the site didn't respond in time" with no new wording there.
 */
export class PageDeadlineError extends Error {
  constructor(ms: number, ceiling = false) {
    super(`${ceiling ? "Page took too long to capture" : "Page stopped making progress"}: Timeout ${ms}ms exceeded.`)
  }
}

/**
 * A page's deadline. The clock restarts at every tick(), which says a real step of the capture finished (a call into the page
 * that returned, a response that arrived), never that time passed. Without a tick for `stallMs` the page is stuck, and past
 * `ceilingMs` in all it is given up on whatever it does. `expiry` rejects then, so racing the page's work against it frees the
 * capture even when a call into the page never returns. Work that was cut off may still be running: its ticks are ignored,
 * and it must call finish() before it does anything with effects outside the browser (uploading), which refuses once the
 * page has been given up on.
 */
export function pageDeadline(stallMs: number, ceilingMs = stallMs * CEILING_FACTOR) {
  let expired = false
  let ended = false
  let reason: PageDeadlineError | undefined
  let stallTimer: ReturnType<typeof setTimeout> | undefined
  let ceilingTimer: ReturnType<typeof setTimeout> | undefined
  let reject!: (error: PageDeadlineError) => void
  const stop = () => {
    clearTimeout(stallTimer)
    clearTimeout(ceilingTimer)
  }
  const expire = (error: PageDeadlineError) => {
    if (expired || ended) return
    expired = true
    reason = error
    stop()
    reject(error)
  }
  const stalled = new PageDeadlineError(stallMs)
  const arm = () => {
    clearTimeout(stallTimer)
    stallTimer = setTimeout(() => expire(stalled), stallMs)
  }
  const expiry = new Promise<never>((_, fail) => { reject = fail })
  expiry.catch(() => {}) // the page's work is raced against it, but a deadline nobody waits on must not be an unhandled rejection
  arm()
  ceilingTimer = setTimeout(() => expire(new PageDeadlineError(ceilingMs, true)), ceilingMs)
  return {
    expiry,
    /** Why the page was given up on (the stall error until it is). */
    get error() {
      return reason ?? stalled
    },
    get expired() {
      return expired
    },
    /** A step finished: restart the stall clock. Returns whether it counted (it does not for a page that was given up on or is done). */
    tick() {
      if (expired || ended) return false
      arm()
      return true
    },
    /** The browser's work on the page is done: stop the clock. Throws if the page was already given up on, so it never goes on to save anything. */
    finish() {
      if (expired) throw reason
      ended = true
      stop()
    },
    /** Stop the clock without judging the page (it ended some other way). */
    clear() {
      ended = true
      stop()
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
