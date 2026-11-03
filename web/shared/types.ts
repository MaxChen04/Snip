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
  createdAt: string
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
  }[]
}

export interface JobComplete {
  title: string | null
  description: string | null
  favicon: string | null
  coverKey: string | null
  tokens: DesignTokens | null
}

export interface Paged<T> {
  items: T[]
  nextCursor: string | null
}
