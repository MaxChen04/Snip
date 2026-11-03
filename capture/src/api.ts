import type { Job, JobComplete, PageUpload } from "../../web/shared/types"

export class SnipApi {
  constructor(
    private base: string,
    private token: string,
  ) {
    this.base = base.replace(/\/$/, "")
  }

  private async call(path: string, init: RequestInit = {}) {
    const res = await fetch(`${this.base}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.token}`, ...(init.headers ?? {}) },
    })
    if (res.status === 401) throw new Error("Snip rejected CAPTURE_TOKEN (401). Check capture/.env matches the Worker secret.")
    if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} failed: ${res.status} ${await res.text()}`)
    return res
  }

  async claim(): Promise<Job | null> {
    const res = await this.call("/agent/jobs/claim", { method: "POST" })
    return res.status === 204 ? null : ((await res.json()) as Job)
  }

  async progress(jobId: string, message: string) {
    await this.call(`/agent/jobs/${jobId}/progress`, json({ message })).catch(() => {})
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

  async fail(jobId: string, error: string) {
    await this.call(`/agent/jobs/${jobId}/fail`, json({ error })).catch(() => {})
  }
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
})
