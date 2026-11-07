// Types shared by the Worker, the web app and the capture agent.

export type CaptureMode = "single" | "crawl"
export type RefStatus = "queued" | "capturing" | "paused" | "ready" | "failed"
/** A pause or stop the user asked for while capturing. The agent acts on it before its next page. */
export type CaptureControl = "pause" | "stop"

/** Per-capture options. Capture protocol 3 requires agents to honor them. */
export interface CaptureOptions {
  /** Emulated prefers-color-scheme. Default light. */
  colorScheme?: "light" | "dark"
  /** Desktop viewport width in px. Default 1440. */
  desktopWidth?: number
  /** Use the capture agent's saved sign-in (STORAGE_STATE in capture/.env). */
  signedIn?: boolean
}

export const DESKTOP_WIDTHS = [1280, 1440, 1920] as const

export interface DesignTokens {
  colors: { value: string; count: number }[]
  fonts: { family: string; count: number }[]
  fontSizes: { value: string; count: number }[]
  spacing: { value: string; count: number }[]
  radii: { value: string; count: number }[]
  shadows: { value: string; count: number }[]
  transitions: { value: string; count: number }[]
  keyframes: string[]
  cssVariables: Record<string, string>
}

export interface Reference {
  id: string
  url: string
  domain: string
  title: string | null
  description: string | null
  favicon: string | null
  mode: CaptureMode
  maxPages: number
  status: RefStatus
  /** Set while capturing when a pause or stop is waiting for the current page to finish. */
  control: CaptureControl | null
  progress: string | null
  error: string | null
  coverKey: string | null
  /** Desktop viewport thumbnails (else mobile) of the first pages, for the folder view. Max 3. */
  previewKeys: string[]
  pageCount: number
  animationCount: number
  tokens: DesignTokens | null
  collectionIds: string[]
  /** The owner's note: why this was saved. */
  notes: string | null
  options: CaptureOptions | null
  createdAt: string
  updatedAt: string
  /** Last claim or progress time while capturing. */
  claimedAt: string | null
}

export interface Page {
  id: string
  referenceId: string
  url: string
  path: string
  title: string | null
  ord: number
  desktopKey: string | null
  desktopThumbKey: string | null
  desktopWidth: number | null
  desktopHeight: number | null
  mobileKey: string | null
  mobileThumbKey: string | null
  mobileWidth: number | null
  mobileHeight: number | null
  snapshotKey: string | null
  stylesKey: string | null
  tokens: DesignTokens | null
  /** Collections this page was saved to on its own (not through its website). */
  collectionIds: string[]
  createdAt: string
}

export type AnimationKind = "scroll" | "hover"

/** Whether an animation's recording is a video (WebM). Older captures stored GIFs under the same field. */
export const isVideoKey = (key: string) => key.toLowerCase().endsWith(".webm")

export interface Animation {
  id: string
  referenceId: string
  pageId: string | null
  kind: AnimationKind
  label: string | null
  selector: string | null
  viewport: "desktop" | "mobile"
  /** The recording: a WebM video, or a GIF for captures made before recordings switched to video (see isVideoKey). */
  gifKey: string
  width: number
  height: number
  /** Still keyframe overview (JPEG). Null for captures made before contact sheets existed. */
  sheetKey: string | null
  meta: AnimationMeta | null
  createdAt: string
}

/**
 * How an animation was recorded, kept separate by provenance:
 * playback timing is what the recording displays; capture offsets and scroll positions are only set where measured.
 */
export interface AnimationMeta {
  version: 1
  frameCount: number
  /** Total playback time. Scroll recordings use synthetic per-frame delays, so this is not the site's real timing. */
  playbackMs: number
  timing: "synthetic" | "measured"
  /** Uniformly sampled frames, stored as JPEGs and tiled into the contact sheet in this order. */
  frames: AnimationFrame[]
  sheet: { width: number; height: number; columns: number } | null
  /** Computed styles of the hovered element at rest (no :hover applied). Observed values, not the author's source CSS. */
  observedStyles: Record<string, string> | null
}

export interface AnimationFrame {
  key: string
  width: number
  height: number
  /** Index in the recording's full frame sequence. */
  sourceIndex: number
  /** When this frame appears during playback. */
  playbackMs: number
  /** Measured ms since the recording started (hover only). */
  captureOffsetMs: number | null
  /** Recorded window.scrollY (scroll only). */
  scrollY: number | null
  phase: "rest" | "enter" | "hold" | "leave" | "scroll"
}

export interface Collection {
  id: string
  name: string
  description: string | null
  /** Websites saved whole. */
  referenceCount: number
  /** Pages saved individually. They point at the same stored files as the page in its website. */
  pageCount: number
  /** Covers of the most recently added websites and pages, newest first (max 3). */
  coverKeys: string[]
  createdAt: string
}

export interface Job {
  id: string
  url: string
  mode: CaptureMode
  maxPages: number
  /** Server-issued capture lease and file namespace. */
  attempt: string
  /** Where a paused crawl left off. Pages already captured are kept; continue from here. */
  resume: CrawlState | null
  options: CaptureOptions | null
}

/** Crawl position saved when a capture pauses. */
export interface CrawlState {
  version: 1
  /** URLs still to visit, in order. */
  queue: string[]
  /** URLs already visited (captured or failed), so they are not queued again. */
  visited: string[]
  captured: number
  failures: number
  navLinksQueued: boolean
  /** Hover effects already recorded, as selector|label. */
  hoverSeen: string[]
  meta: { title: string | null; description: string | null; favicon: string | null } | null
  /** Tokens merged from the pages captured so far. */
  tokens: DesignTokens | null
}

export interface PageUpload {
  url: string
  path: string
  title: string | null
  ord: number
  desktopKey: string | null
  desktopThumbKey: string | null
  desktopWidth: number | null
  desktopHeight: number | null
  mobileKey: string | null
  mobileThumbKey: string | null
  mobileWidth: number | null
  mobileHeight: number | null
  snapshotKey: string | null
  stylesKey: string | null
  tokens: DesignTokens | null
  animations: {
    kind: AnimationKind
    label: string | null
    selector: string | null
    viewport: "desktop" | "mobile"
    /** .webm, or .gif from an agent that can't encode video */
    gifKey: string
    width: number
    height: number
    sheetKey?: string | null
    meta?: AnimationMeta | null
  }[]
}

export interface JobComplete {
  title: string | null
  description: string | null
  favicon: string | null
  coverKey: string | null
  tokens: DesignTokens | null
}

export interface CaptureStatus {
  state: RefStatus
  progress: string | null
  error: string | null
  /** Last time this capture reported progress (or was claimed). Null unless capturing. */
  lastProgressAt: string | null
  worker: {
    lastSeenAt: string | null
    secondsSinceSeen: number | null
    /** recent: contacted the server in the last 90s. stale: seen before but not lately. never: no contact recorded. */
    freshness: "recent" | "stale" | "never"
    activity: "idle" | "busy" | null
    currentJobId: string | null
  }
  pollAfterSeconds: number | null
  advice: string
}

/** The capture agent's last check-in, for the gallery's offline banner. */
export interface AgentPresence {
  lastSeenAt: string | null
  freshness: "recent" | "stale" | "never"
  activity: "idle" | "busy" | null
}

export interface StorageUsage {
  bytes: number
  objects: number
  /** True when the count stopped early; bytes is then a lower bound. */
  partial: boolean
  /** R2 free-tier storage. */
  freeBytes: number
}

export interface Paged<T> {
  items: T[]
  nextCursor: string | null
}
