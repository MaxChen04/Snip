// Types shared by the Worker, the web app and the capture agent.

export type CaptureMode = "single" | "crawl"
export type RefStatus = "queued" | "capturing" | "ready" | "failed"

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
  progress: string | null
  error: string | null
  coverKey: string | null
  /** Desktop viewport thumbnails (else mobile) of the first pages, for the folder view. Max 3. */
  previewKeys: string[]
  pageCount: number
  animationCount: number
  tokens: DesignTokens | null
  collectionIds: string[]
  createdAt: string
  updatedAt: string
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
  createdAt: string
}

export type AnimationKind = "scroll" | "hover"

export interface Animation {
  id: string
  referenceId: string
  pageId: string | null
  kind: AnimationKind
  label: string | null
  selector: string | null
  viewport: "desktop" | "mobile"
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
 * playback timing is what the GIF displays; capture offsets and scroll positions are only set where measured.
 */
export interface AnimationMeta {
  version: 1
  frameCount: number
  /** Total GIF playback time. Scroll GIFs use synthetic per-frame delays, so this is not the site's real timing. */
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
  /** Index in the full GIF frame sequence. */
  sourceIndex: number
  /** When this frame appears during GIF playback. */
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
  referenceCount: number
  /** Covers of the most recently added references, newest first (max 3). */
  coverKeys: string[]
  createdAt: string
}

export interface Job {
  id: string
  url: string
  mode: CaptureMode
  maxPages: number
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

export interface Paged<T> {
  items: T[]
  nextCursor: string | null
}
