import { gzip as zlibGzip } from "node:zlib"
import { promisify } from "node:util"
import type { CaptureControl, CrawlState, Job, JobComplete, PageUpload } from "../../web/shared/types"

export class CaptureAuthenticationError extends Error {
  constructor() { super("Snip rejected the capture token (401)") }
}

/** The reference was deleted or recaptured, or another agent claimed the job, while this capture ran; stop the job. */
export class JobGoneError extends Error {
  constructor() { super("The reference was deleted or recaptured during capture") }
}

export class CaptureUpgradeError extends Error {
  constructor() { super("Capture agent upgrade required. Install the latest Snip capture agent.") }
}

export class SnipApi {
  private lease: string | null = null
  constructor(
    private base: string,
    private token: string,
    private requestTimeoutMs = 120_000,
    private claimTimeoutMs = 15_000,
  ) {
    this.base = base.replace(/\/$/, "")
  }

  private async call(path: string, init: RequestInit = {}, { read = path === "/agent/jobs/claim", conflict = false } = {}) {
    const res = await fetch(`${this.base}${path}`, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(path === "/agent/jobs/claim" ? this.claimTimeoutMs : this.requestTimeoutMs),
      headers: { authorization: `Bearer ${this.token}`, "x-snip-capture-protocol": "4", ...(this.lease ? { "x-snip-capture-lease": this.lease } : {}), ...(init.headers ?? {}) },
    })
    if (res.status === 401) {
      await res.body?.cancel()
      throw new CaptureAuthenticationError()
    }
    if (res.status === 426) {
      await res.body?.cancel()
      throw new CaptureUpgradeError()
    }
    if (res.status === 410) {
      await res.body?.cancel()
      throw new JobGoneError()
    }
    if (conflict && res.status === 409) {
      await res.body?.cancel()
      return null
    }
    if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} failed: ${res.status} ${await res.text()}`)
    // Mutations return small acknowledgements. Drain them so a long-lived
    // agent can reuse HTTP connections without relying on garbage collection.
    if (!read) await res.arrayBuffer()
    return res
  }

  async claim(): Promise<Job | null> {
    const res = await this.call("/agent/jobs/claim", { method: "POST" })
    const job = res!.status === 204 ? null : ((await res!.json()) as Job)
    this.lease = job?.lease ?? null
    return job
  }

  async progress(jobId: string, message: string) {
    await this.call(`/agent/jobs/${jobId}/progress`, json({ message })).catch((error: unknown) => { if (error instanceof JobGoneError) throw error })
  }

  async heartbeat(jobId: string | null) {
    await this.call("/agent/heartbeat", json({ jobId })).catch((error: unknown) => { if (error instanceof JobGoneError) throw error })
  }

  async upload(key: string, body: Buffer | string, contentType: string) {
    await this.call(`/agent/files/${key}`, { method: "PUT", body: typeof body === "string" ? body : new Uint8Array(body), headers: { "content-type": contentType } })
    return key
  }

  async addPage(jobId: string, page: PageUpload) {
    await this.call(`/agent/jobs/${jobId}/pages`, json(page))
  }

  async complete(jobId: string, c: JobComplete) {
    await this.call(`/agent/jobs/${jobId}/complete`, json(c))
  }

  /** A pause or stop the user asked for, checked between pages. */
  async control(jobId: string): Promise<CaptureControl | null> {
    const res = await this.call(`/agent/jobs/${jobId}/control`, {}, { read: true })
    return ((await res!.json()) as { control: CaptureControl | null }).control
  }

  /**
   * Hand back the crawl position and release the job. False when the pause was cancelled or replaced by a stop meanwhile.
   * `release` is a stopping worker handing the crawl back unasked; a Worker that predates it answers false.
   */
  async pause(jobId: string, state: CrawlState, release = false) {
    return (await this.call(`/agent/jobs/${jobId}/pause${release ? "?release" : ""}`, json(state), { conflict: true })) !== null
  }

  async fail(jobId: string, error: string) {
    await this.call(`/agent/jobs/${jobId}/fail`, json({ error })).catch(() => {})
  }
}

const gzipAsync = promisify(zlibGzip)

/**
 * Uploads a text file, gzipped under a `.gz.` key when `gzip` is true. Pass `features.has("gzip")` from the claimed job:
 * a Worker that doesn't advertise it would serve the compressed bytes as they are. Returns the key it stored.
 * The key rule is gzipKey in web/shared/types.ts, copied because released apps ship capture/src without web/shared;
 * web/tests/gzip-files.test.ts keeps the two equal.
 */
export async function uploadText(api: Pick<SnipApi, "upload">, key: string, text: string, contentType: string, gzip: boolean) {
  if (!gzip) return api.upload(key, text, contentType)
  return api.upload(key.replace(/\.(html|json)$/, ".gz.$1"), await gzipAsync(text, { level: 9 }), contentType)
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
})
