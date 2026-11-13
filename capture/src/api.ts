import { gzip as zlibGzip } from "node:zlib"
import { promisify } from "node:util"
import type { CaptureControl, CrawlState, Job, JobComplete, PageUpload } from "../../web/shared/types"
import { packStyles, stylePartsKey, type CapturedStyles, type StylesSummary } from "./style-parts"

export class CaptureAuthenticationError extends Error {
  constructor() { super("Snip rejected the capture token (401)") }
}

/** The reference was deleted or recaptured, or another agent claimed the job, while this capture ran; stop the job. */
export class JobGoneError extends Error {
  constructor() { super("The reference was deleted or recaptured during capture") }
}

// Copies of web/shared/capture-protocol.ts: released apps ship capture/src without web/shared, and web/tests/capture-protocol-copies.test.ts keeps them equal.
export const CAPTURE_PROTOCOL = 4
export const CAPTURE_PROTOCOL_HEADER = "x-snip-capture-protocol"
export const AGENT_OLDER_MESSAGE = "This capture agent is older than your cloud library. Update the Snip app."
export const CLOUD_OLDER_MESSAGE = "Your cloud library is older than this Snip. Update cloud (npm run update)."
export const MISMATCH_MESSAGE = "This capture agent and your cloud library are on different versions. Update the Snip app, then update cloud (npm run update)."

/**
 * The Worker refused this agent's protocol (426). `outdated` is the half that needs updating: "app" is this agent, which the Snip app carries,
 * "cloud" is the Worker, and null is a refusal that does not say.
 */
export class CaptureUpgradeError extends Error {
  constructor(readonly outdated: "app" | "cloud" | null = null) {
    super(outdated === "app" ? AGENT_OLDER_MESSAGE : outdated === "cloud" ? CLOUD_OLDER_MESSAGE : MISMATCH_MESSAGE)
  }
}

/**
 * Which half a 426 says is out of date. A Worker from 1.5.0 names the protocol it expects, so the numbers decide. Worker 1.4.0 and
 * earlier answer with JSON that carries only an `error`, and speak a protocol below every agent that reads this, so the Worker is the older one.
 * Anything that is not a Snip Worker's JSON is not blamed on either side.
 */
async function outdatedHalf(res: Response): Promise<"app" | "cloud" | null> {
  const body = (await res.json().catch(() => null)) as { error?: unknown; expectedProtocol?: unknown } | null
  if (!body || typeof body !== "object") return null
  if (typeof body.expectedProtocol === "number") return body.expectedProtocol > CAPTURE_PROTOCOL ? "app" : "cloud"
  return typeof body.error === "string" ? "cloud" : null
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
      headers: { authorization: `Bearer ${this.token}`, [CAPTURE_PROTOCOL_HEADER]: String(CAPTURE_PROTOCOL), ...(this.lease ? { "x-snip-capture-lease": this.lease } : {}), ...(init.headers ?? {}) },
    })
    if (res.status === 401) {
      await res.body?.cancel()
      throw new CaptureAuthenticationError()
    }
    if (res.status === 426) throw new CaptureUpgradeError(await outdatedHalf(res))
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

/**
 * Uploads the split styles file next to `stylesKey` and returns the summary that points into it, for a Worker that
 * advertises "style-parts". A failed upload costs only the split: the page keeps its full styles file and goes without
 * a summary, which the Worker reads the slow way.
 */
export async function uploadStyleParts(api: Pick<SnipApi, "upload">, stylesKey: string, styles: CapturedStyles): Promise<StylesSummary | undefined> {
  const key = stylePartsKey(stylesKey)
  if (!key) return undefined
  try {
    const { bytes, summary } = await packStyles(styles, key)
    await api.upload(key, Buffer.from(bytes), "application/octet-stream")
    return summary
  } catch (error) {
    if (error instanceof JobGoneError) throw error
    console.log("  split styles not uploaded:", (error as Error).message.split("\n")[0])
    return undefined
  }
}
