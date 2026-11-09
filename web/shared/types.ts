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
  /** Starts at 1; each Recapture adds one. An MCP task belongs to one run. */
  captureRun: number
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
  /** The desktop page cut into its visual sections, top to bottom. Empty for captures made before sections existed. */
  sections: PageSection[]
  /** The page in its other color scheme, when the site has a theme for it. Desktop only. */
  altScheme: AltScheme | null
  /** Whether sections were looked for at capture. False for older captures; true with no sections for a page that doesn't break into any. */
  sectionsCaptured: boolean
  /** Collections this page was saved to on its own (not through its website). */
  collectionIds: string[]
  createdAt: string
}

/**
 * The desktop page in the color scheme it was not captured in (dark for a light capture), when flipping
 * prefers-color-scheme repainted it. Sections are cut at the same lines as the main capture.
 */
export interface AltScheme {
  scheme: "light" | "dark"
  desktopKey: string
  desktopThumbKey: string
  desktopWidth: number
  desktopHeight: number
  /** One per page section, in order; null where the section starts below this scheme's page. */
  sectionKeys: (string | null)[]
}

/** One visual section of a page (header, hero, a content block, footer), found from the DOM at capture time. */
export interface PageSection {
  kind: "header" | "hero" | "section" | "footer"
  /** The section's aria-label, first heading or id; otherwise its kind. */
  label: string
  /** Top edge and height in CSS px of the desktop full-page screenshot. The sections tile it top to bottom. */
  y: number
  height: number
  /** JPEG of just this section, at desktop width. */
  key: string
  /**
   * A short looping WebM of the section playing in real time (canvas and WebGL backgrounds, marquees, carousels),
   * recorded only when something in it moved. It covers `height` CSS px from its own `y` (at most one viewport),
   * at desktop width, with the page's fixed bars hidden so it lines up with the screenshot. Touching sections
   * that move are recorded together, so neighbours can share one clip (same key and y). Absent when still.
   * Clips from before sharing have no `y`: theirs is the section's.
   */
  live?: { key: string; y?: number; height: number; durationMs: number }
}

/**
 * One CSS transition, CSS animation or Web Animation the browser ran while a recording was made, as the browser
 * reported it: real duration, delay, easing and from/to keyframes. Motion that scripts write frame by frame
 * (GSAP, scroll libraries) never creates one, so it is not listed.
 */
export interface MotionEntry {
  type: "transition" | "animation" | "web-animation"
  /** Short CSS selector of the animated element, with ::before/::after where it was a pseudo-element. */
  target: string
  /** The transitioned property or the @keyframes name. */
  property: string | null
  durationMs: number
  delayMs: number
  easing: string
  iterations: number | "infinite"
  keyframes: Record<string, string | number>[]
  /** ms after the recording started (hover: after the pointer arrived). */
  startMs: number
  /** window.scrollY when it started. */
  scrollY: number
  /** How many elements ran this same effect (e.g. each letter of a heading); startMs and scrollY are the first one's. */
  count?: number
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
  /** Animations the browser ran during the recording. Absent for captures made before motion logging existed. */
  motion?: MotionEntry[]
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
  /** Uploaded images on this board. */
  imageCount: number
  /** Covers of the most recently added websites, pages and images, newest first (max 3). */
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
  /** Formats the serving Worker can display. Older Workers omit this and require GIF. Not persisted. */
  recordingFormats?: ("gif" | "webm")[]
  /** What the serving Worker stores beyond the basics: page sections, and live clips of them. Older Workers omit this. Not persisted. */
  features?: ("sections" | "live" | "schemes")[]
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
  /** Older agents send none. */
  sections?: PageSection[]
  altScheme?: AltScheme
  animations: {
    kind: AnimationKind
    label: string | null
    selector: string | null
    viewport: "desktop" | "mobile"
    /** .webm when both Worker and agent support video; otherwise .gif */
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

// ---------- Canvas: uploaded images, sections, boards ----------

/** The source a page or section came from, embedded so a tile can label itself. */
export interface RefSummary {
  id: string
  title: string | null
  domain: string
}

/** An image the owner uploaded as moodboard material (not captured from a website). */
export interface SavedImage {
  id: string
  /** The file name it was uploaded with, without extension. */
  title: string | null
  /** Full-size original, stored at uploads/<id>/original.<ext>. */
  key: string
  /** At most 800 px wide, made in the browser at upload: uploads/<id>/thumb.webp, or thumb.jpg where the browser can't encode WebP. */
  thumbKey: string
  width: number
  height: number
  mime: string
  /** Up to 6 hex colours ("#a1b2c3") pulled from the image in the browser at upload, most prominent first. */
  palette: string[]
  /** Boards (collections) it is on. */
  collectionIds: string[]
  createdAt: string
}

/** One section of a captured page, listed on its own for the canvas Sections filter. */
export interface SectionItem {
  /** `${pageId}:${index}`, stable while the page row lives. */
  id: string
  pageId: string
  referenceId: string
  /** Position in the page's sections array. */
  index: number
  kind: PageSection["kind"]
  label: string
  /** JPEG of just this section (PageSection.key). */
  key: string
  /** Size in desktop CSS px: the page's desktop width by the section's height. */
  width: number
  height: number
  path: string
  url: string
  reference: RefSummary
  createdAt: string
}

/** How many of each kind of material match a filter (the canvas filter dock). */
export interface LibraryTypeCounts {
  websites: number
  pages: number
  sections: number
  animations: number
  images: number
}

export type BoardItemKind = "reference" | "page" | "image" | "note"

/**
 * Something on a board's canvas. References, pages and images are the board's members (collection membership);
 * notes exist only on the board. x/y are null until the item is first placed, and the client lays those out.
 */
export interface BoardItem {
  kind: BoardItemKind
  /** Reference id, page id (the current row), image id or note id. */
  id: string
  /** Top-left corner in canvas px. */
  x: number | null
  y: number | null
  /** Display width in canvas px; null means the kind's default. Height follows the item's aspect ratio. */
  w: number | null
  groupId: string | null
  /** How it looks on this board; absent is the plain default. */
  style?: BoardItemStyle
  /** Notes only. */
  text?: string
  reference?: Reference
  page?: Page & { reference: RefSummary }
  image?: SavedImage
}

/**
 * An item's look on a board (the layer menu). Every key is optional; absent means the default: rot 0 (degrees,
 * -180..180), op 1 (0..1), round 6 (corner radius px, 0..40), blur 0 (px, 0..20), every flag false.
 */
export interface BoardItemStyle {
  rot?: number
  flip?: boolean
  op?: number
  round?: number
  blur?: number
  crop?: boolean
  mask?: boolean
  outline?: boolean
  hidden?: boolean
  locked?: boolean
}

/** A titled frame that groups items on a board. Moving it moves the items whose groupId points at it. */
export interface BoardGroup {
  id: string
  name: string
  x: number
  y: number
  w: number
  h: number
}

export interface BoardCanvas {
  collection: Collection
  items: BoardItem[]
  groups: BoardGroup[]
}

/** A position write for one board item (PUT /api/boards/:id/items). */
export interface BoardItemPlacement {
  kind: BoardItemKind
  id: string
  x: number
  y: number
  /** Omitted: keep the stored width. null: back to the default. */
  w?: number | null
  /** Omitted: keep the stored group. null: out of any group. */
  groupId?: string | null
  /** Omitted: keep the stored style. null: back to the plain look. */
  style?: BoardItemStyle | null
}
