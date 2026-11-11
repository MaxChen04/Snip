import type {
  AgentPresence,
  Animation,
  BoardCanvas,
  BoardGroup,
  BoardItem,
  BoardItemKind,
  BoardItemPlacement,
  CaptureMode,
  CaptureOptions,
  Collection,
  LibraryTypeCounts,
  Page,
  Paged,
  Reference,
  RefSummary,
  SavedImage,
  SectionItem,
  StorageUsage,
} from "../../shared/types"

export type {
  AgentPresence,
  Animation,
  BoardCanvas,
  BoardGroup,
  BoardItem,
  BoardItemKind,
  BoardItemPlacement,
  CaptureMode,
  CaptureOptions,
  Collection,
  LibraryTypeCounts,
  Page,
  Paged,
  Reference,
  RefSummary,
  SavedImage,
  SectionItem,
  StorageUsage,
}
export type PageWithRef = Page & { reference: RefSummary }
export type AnimationWithRef = Animation & { reference: RefSummary }

export class UnauthorizedError extends Error {}
/** Fired on window when any request is answered 401: the session is over. App reacts to it. */
export const SIGNED_OUT = "snip:signed-out"
function signedOut() {
  window.dispatchEvent(new Event(SIGNED_OUT))
  return new UnauthorizedError("Not signed in")
}
export class NotFoundError extends Error {}

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
  if (res.status === 401) throw signedOut()
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; existing?: Reference }
    if (res.status === 409 && body.existing) throw new DuplicateError(body.existing)
    const message = body.error ?? `Request failed (${res.status})`
    throw res.status === 404 ? new NotFoundError(message) : new Error(message)
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
  references: (f: Filters, cursor?: string | null, limit = 24) =>
    request<Paged<Reference>>(`/api/references?${qs({ ...f, cursor, limit })}`),
  pages: (f: Filters, cursor?: string | null, limit = 30) => request<Paged<PageWithRef>>(`/api/pages?${qs({ ...f, cursor, limit })}`),
  animations: (f: Filters, cursor?: string | null, limit = 30) =>
    request<Paged<AnimationWithRef>>(`/api/animations?${qs({ ...f, cursor, limit })}`),
  /** Sections of captured pages, newest page first, each page's sections top to bottom. */
  sections: (f: Filters, cursor?: string | null, limit = 60) => request<Paged<SectionItem>>(`/api/sections?${qs({ ...f, cursor, limit })}`),
  /** Uploaded images, newest first. q matches the title; collection narrows to a board. */
  images: (f: Filters, cursor?: string | null, limit = 60) => request<Paged<SavedImage>>(`/api/images?${qs({ ...f, cursor, limit })}`),
  /** Counts per kind for the filter dock, for the whole library or one board, matching q. */
  counts: (f: Pick<Filters, "q" | "collection"> = {}) => request<LibraryTypeCounts>(`/api/counts?${qs({ ...f })}`),
  /**
   * Upload one image (multipart). The browser makes the thumbnail and palette; see lib/images.ts.
   * With collectionId it is also put on that board.
   */
  uploadImage: async (body: { file: Blob; fileName: string; thumb: Blob; width: number; height: number; palette: string[]; collectionId?: string }) => {
    const form = new FormData()
    form.set("file", body.file, body.fileName)
    // WebP, or JPEG where the browser can't encode WebP.
    form.set("thumb", body.thumb, body.thumb.type === "image/jpeg" ? "thumb.jpg" : "thumb.webp")
    form.set("width", String(body.width))
    form.set("height", String(body.height))
    form.set("palette", JSON.stringify(body.palette))
    if (body.collectionId) form.set("collectionId", body.collectionId)
    // No content-type header: the browser sets the multipart boundary.
    const res = await fetch("/api/images", { method: "POST", body: form })
    if (res.status === 401) throw signedOut()
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `Upload failed (${res.status})`)
    return (await res.json()) as SavedImage
  },
  deleteImage: (id: string) => request<{ ok: true }>(`/api/images/${id}`, { method: "DELETE" }),
  /** Put images on a board or take them off. */
  setImageMembership: (cid: string, imageIds: string[], member: boolean) =>
    request<{ ok: true; changed: number }>(`/api/collections/${cid}/images`, { method: "POST", body: JSON.stringify({ imageIds, member }) }),
  /** A board's members, notes and groups with their canvas positions. */
  board: (id: string) => request<BoardCanvas>(`/api/boards/${id}`),
  /** Save positions (and optionally width and group) for up to 200 items at once. */
  placeBoardItems: (id: string, items: BoardItemPlacement[]) =>
    request<{ ok: true }>(`/api/boards/${id}/items`, { method: "PUT", body: JSON.stringify({ items }) }),
  /** `z` is the stacking order (a whole number); omitted, the note goes on top. */
  addBoardNote: (id: string, note: { text: string; x: number; y: number; z?: number; w?: number | null; groupId?: string | null }) =>
    request<BoardItem>(`/api/boards/${id}/notes`, { method: "POST", body: JSON.stringify(note) }),
  updateBoardNote: (id: string, noteId: string, text: string) =>
    request<{ ok: true }>(`/api/boards/${id}/notes/${noteId}`, { method: "PATCH", body: JSON.stringify({ text }) }),
  deleteBoardNote: (id: string, noteId: string) => request<{ ok: true }>(`/api/boards/${id}/notes/${noteId}`, { method: "DELETE" }),
  /** Frame items in a titled group. The items' groupId is set to the new group. */
  createBoardGroup: (id: string, group: Omit<BoardGroup, "id"> & { items: { kind: BoardItemKind; id: string }[] }) =>
    request<BoardGroup>(`/api/boards/${id}/groups`, { method: "POST", body: JSON.stringify(group) }),
  updateBoardGroup: (id: string, groupId: string, patch: Partial<Omit<BoardGroup, "id">>) =>
    request<{ ok: true }>(`/api/boards/${id}/groups/${groupId}`, { method: "PATCH", body: JSON.stringify(patch) }),
  /** Remove the frame. Its items stay where they are, ungrouped. */
  deleteBoardGroup: (id: string, groupId: string) => request<{ ok: true }>(`/api/boards/${id}/groups/${groupId}`, { method: "DELETE" }),
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
