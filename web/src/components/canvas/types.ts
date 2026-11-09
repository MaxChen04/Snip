import type { AnimationWithRef, PageWithRef, Reference, SavedImage, SectionItem } from "@/lib/api"

/** What the canvas filter dock can show. "all" is pages, sections and images (websites repeat pages; animations have their own filter). */
export type CanvasFilter = "all" | "websites" | "pages" | "sections" | "animations" | "images"

/** One piece of saved material as the canvas, the inspector and boards pass it around. */
export type CanvasItem =
  | { kind: "page"; id: string; page: PageWithRef }
  | { kind: "section"; id: string; section: SectionItem }
  | { kind: "animation"; id: string; animation: AnimationWithRef }
  | { kind: "image"; id: string; image: SavedImage }
  | { kind: "website"; id: string; reference: Reference }

/** Which filter an item belongs to, for dimming on boards and counting. */
export const filterOf: Record<CanvasItem["kind"], Exclude<CanvasFilter, "all">> = {
  page: "pages",
  section: "sections",
  animation: "animations",
  image: "images",
  website: "websites",
}

/** Natural aspect (width / height) of an item's thumbnail, so layouts can size tiles before images load. */
export function itemAspect(item: CanvasItem): number {
  switch (item.kind) {
    case "page":
      return 16 / 10
    case "section":
      return item.section.width && item.section.height ? Math.max(0.4, Math.min(4, item.section.width / item.section.height)) : 16 / 10
    case "animation":
      return item.animation.width && item.animation.height ? Math.max(0.4, Math.min(4, item.animation.width / item.animation.height)) : 16 / 10
    case "image":
      return item.image.width && item.image.height ? Math.max(0.4, Math.min(4, item.image.width / item.image.height)) : 1
    case "website":
      return 16 / 10
  }
}

/** Fired on window after anything adds or removes material (captures, uploads, deletes), so open canvases refetch. */
export const RELOAD_EVENT = "rs:reload"
export const reloadCanvas = () => window.dispatchEvent(new Event(RELOAD_EVENT))
