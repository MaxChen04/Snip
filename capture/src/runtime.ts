import { CaptureAuthenticationError, CaptureUpgradeError, JobGoneError } from "./api"
import type { Job } from "../../web/shared/types"

export type CaptureStatus = {
  type: "snip:capture-status"
  state: "connecting" | "idle" | "busy" | "disconnected" | "stopping"
  jobId?: string
  error?: string
  retryInMs?: number
}

export const idlePollDelay = (pollMs: number, emptyPolls: number) =>
  Math.min(30_000, pollMs * 2 ** Math.min(Math.max(0, emptyPolls - 1), 20))

/** A capture that reports nothing for this long is hung: its job is failed and the worker takes the next one. */
const STALL_MS = 5 * 60_000

type Browser = { isConnected(): boolean; close(): Promise<void> }
type Api = { claim(): Promise<Job | null>; heartbeat(id: string | null): Promise<void>; fail(id: string, error: string): Promise<void> }

/** One worker owns the claim until it completes, even when shutdown arrives during polling. */
export class CaptureRuntime<B extends Browser> {
  private stopping = false
  private emptyPolls = 0
  private retryPending = false
  private wake: (() => void) | undefined
  private browser: B | undefined
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private closing: Promise<void> | undefined
  private abort: AbortController | undefined

  constructor(private options: {
    api: Api
    launch: (job: Job) => Promise<B>
    /** `signal` aborts when the job should wind down (stop, lost lease, hung); `progress` says the capture is still moving. */
    capture: (browser: B, job: Job, signal: AbortSignal, progress: () => void) => Promise<void>
    status: (status: CaptureStatus) => void
    pollMs: number
    idleMs: number
    once: boolean
    random?: () => number
    logError?: (message: string) => void
  }) {}

  stop() {
    if (this.stopping) return
    this.stopping = true
    this.emit({ state: "stopping" })
    this.abort?.abort()
    this.wake?.()
  }

  retry() {
    this.emptyPolls = 0
    if (this.wake) this.wake()
    else this.retryPending = true
  }

  private emit(status: Omit<CaptureStatus, "type">) {
    this.options.status({ type: "snip:capture-status", ...status })
  }

  private wait(ms: number) {
    if (this.retryPending) { this.retryPending = false; return Promise.resolve() }
    return new Promise<void>((resolve) => {
      const finish = () => { clearTimeout(timer); this.wake = undefined; resolve() }
      const timer = setTimeout(finish, ms)
      this.wake = finish
      if (this.stopping) finish()
    })
  }

  private async closeBrowser() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = undefined
    const browser = this.browser
    this.browser = undefined
    if (browser) {
      this.closing = browser.close().catch(() => {})
      await this.closing
      this.closing = undefined
    } else if (this.closing) await this.closing
  }

  private async getBrowser(job: Job) {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = undefined
    if (this.closing) await this.closing
    if (!this.browser?.isConnected()) this.browser = await this.options.launch(job)
    return this.browser
  }

  async run() {
    let errors = 0
    try {
      while (!this.stopping) {
        this.emit({ state: "connecting" })
        let job: Job | null
        try {
          job = await this.options.api.claim()
          errors = 0
        } catch (error) {
          if (this.stopping) break
          errors++
          this.emptyPolls = 0
          const base = Math.min(60_000, Math.max(1_000, this.options.pollMs) * 2 ** Math.min(errors - 1, 10))
          const retryInMs = Math.min(60_000, Math.round(base * (0.8 + (this.options.random?.() ?? Math.random()) * 0.4)))
          this.emit({ state: "disconnected", error: error instanceof CaptureAuthenticationError ? "Capture token rejected (401). Check your capture token." : error instanceof CaptureUpgradeError ? error.message : "Unable to reach the capture queue", retryInMs })
          this.options.logError?.("Queue poll failed; retrying.")
          if (this.options.once) break
          await this.wait(retryInMs)
          continue
        }
        if (job) {
          this.emptyPolls = 0
          if (!this.stopping) this.emit({ state: "busy", jobId: job.id })
          const abort = this.abort = new AbortController()
          if (this.stopping) abort.abort()
          let stall: ReturnType<typeof setTimeout> | undefined
          let hung!: (error: Error) => void
          const stalled = new Promise<never>((_, reject) => { hung = reject })
          const progress = () => {
            clearTimeout(stall)
            stall = setTimeout(() => {
              abort.abort()
              // Closing the browser ends whatever the hung capture still holds.
              void this.closeBrowser()
              hung(new Error("Capture stopped making progress"))
            }, STALL_MS)
          }
          const beat = setInterval(() => {
            this.options.api.heartbeat(job.id).catch((e: unknown) => {
              if (!(e instanceof JobGoneError)) return
              clearInterval(beat)
              abort.abort()
            })
          }, 30_000)
          progress()
          try {
            const capture = (async () => this.options.capture(await this.getBrowser(job), job, abort.signal, progress))()
            capture.catch(() => {}) // a hung capture that fails later was already reported
            await Promise.race([capture, stalled])
          } catch (e) {
            this.options.logError?.(`[${job.id}] capture failed`)
            await this.options.api.fail(job.id, (e instanceof Error ? e.message : "Capture failed").split("\n")[0] || "Capture failed")
          } finally {
            clearInterval(beat)
            clearTimeout(stall)
            this.abort = undefined
          }
          if (!this.stopping && this.browser) {
            this.idleTimer = setTimeout(() => { void this.closeBrowser() }, this.options.idleMs)
          }
          continue
        }
        if (this.stopping || this.options.once) break
        this.emit({ state: "idle" })
        await this.wait(idlePollDelay(this.options.pollMs, ++this.emptyPolls))
      }
    } finally {
      await this.closeBrowser()
    }
  }
}
