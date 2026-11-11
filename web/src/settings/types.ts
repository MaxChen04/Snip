// Shapes shared with desktop/main.cjs and proposals/cloud-contracts.md. The renderer
// never reads cloud.json itself: every value here arrives over the preload bridge.

export type CloudMode = "local" | "enabling" | "cloud"

export interface CloudRecord {
  url: string
  accountId: string | null
  workerName: string | null
  bucket: string | null
  ownerId: string | null
  detachedAt: string | null
  adoptedAt: string | null
  adoptedFrom: string | null
  adoptedLibrary: { refs: number | null; pages: number | null; collections: number | null } | null
  lastDeployedAt: string | null
  lastVerifiedAt: string | null
  /** Deployed Worker version, when the engine recorded it. */
  workerVersion?: string | null
}

export interface SnapshotRecord {
  /** "live": this Mac's own library, untouched. "backup": the library a pull replaced. */
  kind: "live" | "backup" | null
  /** Non-null only for a backup: a state dir that can be swapped in. */
  path: string | null
  takenAt: string | null
  refs: number | null
  files: number | null
  bytes: number | null
  keptLocal?: boolean
  /** Setup's portable dump. Delete-only: it cannot rebuild the R2 objects. */
  export?: { path: string | null; takenAt: string | null; refs: number | null; files: number | null; bytes: number | null } | null
}

export interface MoveRecord {
  status: "completed" | "empty" | "skipped" | null
  reason: string | null
  at: string | null
}

export interface CloudError {
  step: string | null
  code: string | null
  message: string
  hint: string | null
  at: string | null
  /** False for preflight refusals that retrying cannot fix (contract v3.6). */
  retryable?: boolean
}

export interface CloudStep {
  id: string
  status: "done" | "failed" | "skipped" | "running" | "waiting" | "pending"
  at: string | null
  detail: string | null
}

export interface CloudFile {
  version?: number
  mode: CloudMode
  library: { id?: string } | null
  cloud: CloudRecord | null
  snapshot: SnapshotRecord | null
  transfer: { keys?: number; bytes?: number } | null
  move?: MoveRecord | null
  steps: CloudStep[]
  error: CloudError | null
  pausedForMove?: string[]
  [key: string]: unknown
}

export interface LocalLibrary {
  reachable: boolean
  empty: boolean | null
  refs: number | null
  pages?: number | null
  hasOwner?: boolean
}

export interface CloudAppInfo {
  version: string
  dataRoot: string | null
  captureEnv: string | null
}

/**
 * A one-time URL that signs one browser in. It is the only secret-shaped value that
 * reaches this window, because a person has to open it (contracts §4.2). Main never
 * writes it to a log, and the session token it leads to never comes here at all.
 */
export interface OwnerLink {
  url: string
  note: string
  expiresAt: string
}

export interface CloudSnapshotState {
  /** "unreadable": cloud.json exists but cannot be read, so nothing may be started. */
  mode: CloudMode | "unreadable"
  state: CloudFile | null
  busy: boolean
  running: { command: string; step: string | null } | null
  /** The last link minted on this Mac, while it is still worth anything. */
  link?: OwnerLink | null
  engine?: { available: boolean }
  /** From the Worker's /api/cloud-status; null when it can't be reached. */
  cloudStatus?: { methods: ("passkey" | "github")[]; ownerId: string | null } | null
  /** False while main is still resolving Node and the library layout. */
  ready?: boolean
  local?: LocalLibrary
  app?: CloudAppInfo
}

export type EngineStepStatus = "started" | "ok" | "skipped" | "waiting" | "failed"

export interface EngineStepEvent {
  v: 1
  event: "step"
  command?: string
  step: string
  status: EngineStepStatus
  message?: string
  detail?: string
  at?: string
  progress?: { done?: number; total?: number }
  data?: Record<string, unknown>
}

export interface EngineHumanEvent {
  v: 1
  event: "human"
  step: string
  action: "enable_r2" | "open_url"
  url?: string
  message?: string
}

export interface EngineResultEvent {
  v: 1
  event: "result"
  ok: boolean
  code: "OK" | "NEEDS_INPUT" | "FAILED" | "LOCKED" | "UNSUPPORTED" | "CANCELLED"
  mode: CloudMode
  /** Only preflight refusals set this; absent means a retry is worth offering. */
  retryable?: boolean
  /** The engine's own sentence for a failure (cli.cjs passes it beside `data`). */
  message?: string
  data?: Record<string, unknown>
}

export interface EngineChoiceEvent {
  v: 1
  event: "choice"
  step: string
  id: string
  message: string
  data?: { url?: string; counts?: { refs?: number; pages?: number; collections?: number } }
  options: { id: string; label: string; detail?: string }[]
}

export interface EngineLogEvent {
  v: 1
  event: "log"
  level: "info" | "warn" | "error"
  message: string
}

export interface EngineInputEvent {
  v: 1
  event: "needs_input"
  /** `options` are the only valid answers; the answer is an option's `value`. */
  keys: { key: string; label?: string; secret?: boolean; options?: { value: string; label: string }[] }[]
}

export type EngineEvent =
  | EngineStepEvent
  | EngineHumanEvent
  | EngineChoiceEvent
  | EngineResultEvent
  | EngineLogEvent
  | EngineInputEvent

export interface CloudBridge {
  state(): Promise<CloudSnapshotState>
  enable(options?: { account?: string; domain?: string; login?: string; captureEnv?: string; adoptExisting?: boolean }): Promise<CloudReply>
  disable(action: "detach" | "pull"): Promise<CloudReply>
  retryStep(step: string): Promise<CloudReply>
  cancel(): Promise<{ cancelled: boolean }>
  abort(): Promise<CloudReply>
  answer(key: string, value: string): Promise<{ accepted: boolean }>
  openSettings(): Promise<{ opened: boolean }>
  openUrl(url: string): Promise<{ opened: boolean }>
  signOutAll(): Promise<{ ok?: true; epoch?: number; error?: string }>
  deleteResources(confirm: string): Promise<CloudReply>
  /** `confirm` is the basename of the directory being deleted: a stale-record interlock. */
  snapshot(action: "restore" | "delete" | "delete-export", confirm?: string): Promise<CloudReply>
  /** Mints a one-time link for another browser. Resolves once the run starts. */
  ownerLink(): Promise<CloudReply>
  onProgress(callback: (event: EngineEvent) => void): () => void
  onLog(callback: (entry: { level: "info" | "warn" | "error"; message: string }) => void): () => void
  onLink(callback: (link: OwnerLink) => void): () => void
}

export interface CloudReply {
  started?: true
  cancelled?: boolean
  error?: string
}

declare global {
  interface Window {
    snipCloud?: CloudBridge
  }
}
