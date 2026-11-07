import type { AgentPresence, Animation, CaptureMode, CaptureOptions, Collection, Page, Paged, Reference, StorageUsage } from "../../shared/types"

export type { AgentPresence, Animation, CaptureMode, CaptureOptions, Collection, Page, Paged, Reference, StorageUsage }
export type RefSummary = { id: string; title: string | null; domain: string }
export type PageWithRef = Page & { reference: RefSummary }
export type AnimationWithRef = Animation & { reference: RefSummary }

export class UnauthorizedError extends Error {}

/** The URL is already in the library. */
export class DuplicateError extends Error {
  constructor(readonly existing: Reference) {
    super("This URL is already saved")
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  })
  if (res.status === 401) throw new UnauthorizedError("Not signed in")
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; existing?: Reference }
    if (res.status === 409 && body.existing) throw new DuplicateError(body.existing)
    throw new Error(body.error ?? `Request failed (${res.status})`)
  }
  return res.json() as Promise<T>
}

export type Sort = "newest" | "oldest" | "name"
export interface Filters {
  q?: string
  collection?: string
  sort?: Sort
  status?: Reference["status"]
}

const qs = (o: Record<string, string | number | undefined | null>) => {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v))
  return p.toString()
}

export type SessionMethod = "owner" | "passkey" | "github"
export type Me = { login: string; ownerId: string; method: SessionMethod }

export type PasskeyDevice = { id: string; label: string | null; createdAt: string; lastUsedAt: string | null }

export const api = {
  me: () => request<Me>("/api/me"),
  passkeys: () => request<{ devices: PasskeyDevice[] }>("/api/passkeys"),
  removePasskey: (id: string) => request<{ ok: true }>(`/api/passkeys/${id}`, { method: "DELETE" }),
  /** Signs out every browser and the desktop app. MCP tokens are a separate credential and stay valid. */
  signOutAll: () => request<{ ok: true; epoch: number }>("/api/sign-out-all", { method: "POST", body: "{}" }),
  references: (f: Filters, cursor?: string | null) =>
    request<Paged<Reference>>(`/api/references?${qs({ ...f, cursor, limit: 24 })}`),
  pages: (f: Filters, cursor?: string | null) => request<Paged<PageWithRef>>(`/api/pages?${qs({ ...f, cursor, limit: 30 })}`),
  animations: (f: Filters, cursor?: string | null) =>
    request<Paged<AnimationWithRef>>(`/api/animations?${qs({ ...f, cursor, limit: 30 })}`),
  reference: (id: string) => request<{ reference: Reference; pages: Page[]; animations: Animation[] }>(`/api/references/${id}`),
  addReference: async (body: {
    url: string
    mode: CaptureMode
    maxPages?: number
    collectionIds?: string[]
    notes?: string
    options?: CaptureOptions | null
    /** Capture again even if the URL is already saved. Otherwise a DuplicateError carries the saved one. */
    allowDuplicate?: boolean
  }) => {
    const result = await request<Reference>("/api/references", { method: "POST", body: JSON.stringify(body) })
    window.snipDesktop?.checkQueue()
    return result
  },
  recapture: async (id: string) => {
    const result = await request<{ ok: true }>(`/api/references/${id}/recapture`, { method: "POST" })
    window.snipDesktop?.checkQueue()
    return result
  },
  /** Pause, resume or stop a capture. Pause and stop let the page being captured finish first. */
  captureControl: async (id: string, action: "pause" | "resume" | "stop") => {
    const result = await request<Reference | null>(`/api/references/${id}/${action}`, { method: "POST" })
    if (action === "resume") window.snipDesktop?.checkQueue()
    return result
  },
  setNotes: (id: string, notes: string) => request<{ ok: true }>(`/api/references/${id}`, { method: "PATCH", body: JSON.stringify({ notes }) }),
  agent: () => request<AgentPresence>("/api/agent"),
  storage: () => request<StorageUsage>("/api/storage"),
  deleteReference: (id: string) => request<{ ok: true }>(`/api/references/${id}`, { method: "DELETE" }),
  setMembership: (id: string, cid: string, member: boolean) =>
    request<{ ok: true }>(`/api/references/${id}/collections/${cid}`, { method: member ? "PUT" : "DELETE" }),
  /** Save pages to a collection (or take them out). They keep their files and stay in their website. */
  setPageMembership: (cid: string, pageIds: string[], member: boolean) =>
    request<{ ok: true; changed: number }>(`/api/collections/${cid}/pages`, { method: "POST", body: JSON.stringify({ pageIds, member }) }),
  collections: () => request<Collection[]>("/api/collections"),
  createCollection: (name: string, description?: string) =>
    request<{ id: string }>("/api/collections", { method: "POST", body: JSON.stringify({ name, description }) }),
  renameCollection: (id: string, name: string) =>
    request<{ ok: true }>(`/api/collections/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  deleteCollection: (id: string) => request<{ ok: true }>(`/api/collections/${id}`, { method: "DELETE" }),
}

export const fileUrl = (key: string | null | undefined) => (key ? `/files/${key}` : undefined)
