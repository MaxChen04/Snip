import type { Animation, CaptureMode, Collection, Page, Paged, Reference } from "../../shared/types"

export type { Animation, CaptureMode, Collection, Page, Paged, Reference }
export type RefSummary = { id: string; title: string | null; domain: string }
export type PageWithRef = Page & { reference: RefSummary }
export type AnimationWithRef = Animation & { reference: RefSummary }

export class UnauthorizedError extends Error {}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  })
  if (res.status === 401) throw new UnauthorizedError("Not signed in")
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? `Request failed (${res.status})`)
  }
  return res.json() as Promise<T>
}

export type Sort = "newest" | "oldest" | "name"
export interface Filters {
  q?: string
  collection?: string
  sort?: Sort
}

const qs = (o: Record<string, string | number | undefined | null>) => {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v))
  return p.toString()
}

export const api = {
  me: () => request<{ login: string }>("/api/me"),
  references: (f: Filters, cursor?: string | null) =>
    request<Paged<Reference>>(`/api/references?${qs({ ...f, cursor, limit: 24 })}`),
  pages: (f: Filters, cursor?: string | null) => request<Paged<PageWithRef>>(`/api/pages?${qs({ ...f, cursor, limit: 30 })}`),
  animations: (f: Filters, cursor?: string | null) =>
    request<Paged<AnimationWithRef>>(`/api/animations?${qs({ ...f, cursor, limit: 30 })}`),
  reference: (id: string) => request<{ reference: Reference; pages: Page[]; animations: Animation[] }>(`/api/references/${id}`),
  addReference: (body: { url: string; mode: CaptureMode; maxPages?: number; collectionIds?: string[] }) =>
    request<Reference>("/api/references", { method: "POST", body: JSON.stringify(body) }),
  recapture: (id: string) => request<{ ok: true }>(`/api/references/${id}/recapture`, { method: "POST" }),
  deleteReference: (id: string) => request<{ ok: true }>(`/api/references/${id}`, { method: "DELETE" }),
  setMembership: (id: string, cid: string, member: boolean) =>
    request<{ ok: true }>(`/api/references/${id}/collections/${cid}`, { method: member ? "PUT" : "DELETE" }),
  collections: () => request<Collection[]>("/api/collections"),
  createCollection: (name: string, description?: string) =>
    request<{ id: string }>("/api/collections", { method: "POST", body: JSON.stringify({ name, description }) }),
  renameCollection: (id: string, name: string) =>
    request<{ ok: true }>(`/api/collections/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  deleteCollection: (id: string) => request<{ ok: true }>(`/api/collections/${id}`, { method: "DELETE" }),
}

export const fileUrl = (key: string | null | undefined) => (key ? `/files/${key}` : undefined)
