// A synthetic library for the site-scope tests and screenshots: five websites with pages, sections, recordings and
// tokens, uploads, and one site mid-crawl. `mockLibrary` answers the gallery's list, detail and count endpoints from it
// the way the Worker does, filtered by website (?reference=) and search (?q=).
import type { Animation, DesignTokens, LibraryTypeCounts, Page, Reference, SavedImage, SectionItem } from "../../shared/types.ts"
import { image, reference, savedPage, type Req, type Reply } from "./harness.ts"

const SITES = [
  { id: "judgment", domain: "judgmentlabs.ai", title: "Judgment Labs", pages: ["/", "/pricing", "/blog", "/blog/evals", "/docs", "/careers", "/customers", "/security", "/changelog", "/about", "/blog/agents", "/docs/quickstart", "/legal/terms", "/legal/privacy", "/integrations"] },
  { id: "linear", domain: "linear.app", title: "Linear", pages: ["/", "/pricing", "/method", "/customers", "/changelog", "/careers", "/readme", "/features"] },
  { id: "stripe", domain: "stripe.com", title: "Stripe", pages: ["/", "/pricing", "/payments", "/billing", "/docs", "/customers"] },
  { id: "hone", domain: "hone.com", title: "Hone", pages: ["/", "/pricing", "/product", "/customers", "/about", "/blog"] },
  { id: "ando", domain: "ando.so", title: "Ando", pages: ["/", "/pricing", "/about", "/journal"] },
]

const tokens: DesignTokens = {
  colors: ["#f0512c", "#1b1b1d", "#ffffff", "#f6f6f5", "#8a8a8e", "#2d6cdf"].map((value, i) => ({ value, count: 40 - i * 5 })),
  fonts: [{ family: "Inter, sans-serif", count: 120 }, { family: "\"Geist Mono\", monospace", count: 20 }],
  fontSizes: ["12px", "14px", "16px", "20px", "32px", "56px"].map((value) => ({ value, count: 4 })),
  spacing: ["4px", "8px", "16px", "24px", "48px"].map((value) => ({ value, count: 4 })),
  radii: ["6px", "999px"].map((value) => ({ value, count: 4 })),
  shadows: [],
  transitions: [],
  keyframes: [],
  cssVariables: { "--accent": "#f0512c" },
}

const day = (n: number) => new Date(Date.UTC(2026, 10, 12, 12, 0, n)).toISOString()

export type Library = {
  references: Reference[]
  pages: Page[]
  animations: Animation[]
  images: SavedImage[]
  /** The site mid-crawl: how many of its pages have been saved, and its status. */
  crawl: { id: string; done: number; total: number; status: "capturing" | "paused" | "ready" }
}

export function library(): Library {
  const references: Reference[] = []
  const pages: Page[] = []
  const animations: Animation[] = []
  let t = 0
  for (const s of SITES) {
    const sitePages = s.pages.map((path, i) =>
      savedPage({
        id: `${s.id}-p${i}`,
        referenceId: s.id,
        url: `https://${s.domain}${path}`,
        path,
        title: path === "/" ? s.title : `${s.title} · ${path.slice(1)}`,
        ord: i,
        desktopKey: `pages/${s.id}/${i}/desktop.png`,
        desktopThumbKey: `pages/${s.id}/${i}/thumb.png`,
        tokens,
        sections: i < 3 ? (["header", "hero", "section", "footer"] as const).map((kind, k) => ({ kind, label: kind === "section" ? "Pricing table" : kind, y: k * 600, height: 600, key: `pages/${s.id}/${i}/s${k}.png` })) : [],
        createdAt: day(t++),
      }),
    )
    pages.push(...sitePages)
    for (let a = 0; a < (s.id === "judgment" ? 3 : 1); a++) {
      animations.push({ id: `${s.id}-a${a}`, referenceId: s.id, pageId: sitePages[0]!.id, kind: a % 2 ? "hover" : "scroll", label: a % 2 ? "Get started button" : "Home scroll", selector: null, viewport: "desktop", gifKey: `anim/${s.id}/${a}.gif`, width: 1280, height: 800, sheetKey: null, meta: null, createdAt: day(t++) })
    }
    references.push(
      reference({ id: s.id, url: `https://${s.domain}/`, domain: s.domain, title: s.title, mode: "crawl", maxPages: s.pages.length, pageCount: s.pages.length, animationCount: s.id === "judgment" ? 3 : 1, tokens, coverKey: `pages/${s.id}/0/thumb.png`, createdAt: day(t++) }),
    )
  }
  const images = [0, 1, 2].map((i) => image({ id: `img${i}`, title: `Moodboard ${i + 1}`, key: `uploads/img${i}/original.png`, thumbKey: `uploads/img${i}/thumb.png`, width: 1200, height: 900, collectionIds: [], createdAt: day(t++) }))
  return { references, pages, animations, images, crawl: { id: "hone", done: 3, total: 6, status: "capturing" } }
}

/** A library of one website with these pages and recordings, for tests that need a single site's scope. */
export function oneSite(r: Reference, pages: Page[], animations: Animation[] = []): Library {
  return {
    references: [r],
    pages: pages.map((p, ord) => ({ ...p, referenceId: r.id, ord })),
    animations: animations.map((a) => ({ ...a, referenceId: r.id })),
    images: [],
    crawl: { id: "", done: 0, total: 0, status: "ready" },
  }
}

/** Advance the crawl one page, or pause, resume, stop or cancel it. */
export function crawlStep(lib: Library, action: "next" | "pause" | "resume" | "stop" | "cancel") {
  const c = lib.crawl
  if (action === "next" && c.status === "capturing") c.done = Math.min(c.total, c.done + 1)
  if (action === "pause") c.status = "paused"
  if (action === "resume") c.status = "capturing"
  if (action === "stop" || action === "cancel" || c.done >= c.total) {
    c.status = "ready"
    c.total = c.done
  }
}

const like = (q: string | null, ...fields: (string | null | undefined)[]) => !q || fields.some((f) => f?.toLowerCase().includes(q.toLowerCase()))

function view(lib: Library) {
  const c = lib.crawl
  const crawling = (p: { referenceId: string; ord?: number }) => p.referenceId !== c.id || (p.ord ?? 0) < c.done
  const pages = lib.pages.filter(crawling)
  const references = lib.references.map((r) =>
    r.id !== c.id
      ? r
      : {
          ...r,
          pageCount: c.done,
          maxPages: c.status === "ready" ? c.done : 6,
          status: c.status === "ready" ? ("ready" as const) : c.status,
          progress: c.status === "capturing" ? `Capturing ${c.done + 1}/${c.total}: ${lib.pages.find((p) => p.referenceId === c.id && p.ord === c.done)?.path}` : null,
        },
  )
  return { pages, references }
}

const ofRef = (refs: Reference[], id: string) => {
  const r = refs.find((x) => x.id === id)!
  return { id: r.id, title: r.title, domain: r.domain, favicon: r.favicon }
}

export function sectionsOf(pages: Page[], refs: Reference[]): SectionItem[] {
  return pages.flatMap((p) =>
    p.sections.map((s, index) => ({ id: `${p.id}:${index}`, pageId: p.id, referenceId: p.referenceId, index, kind: s.kind, label: s.label, key: s.key, thumbKey: null, width: 1440, height: s.height, path: p.path, url: p.url, reference: ofRef(refs, p.referenceId), createdAt: p.createdAt })),
  )
}

/** A handler for the harness's `on()`: answers every gallery read from the library. */
export function mockLibrary(lib: Library) {
  return (req: Req): Reply | undefined => {
    if (req.method === "POST") {
      const m = req.path.match(/^\/api\/references\/([^/]+)\/(pause|resume|stop|cancel)$/)
      if (m) {
        crawlStep(lib, m[2] as "pause" | "resume" | "stop" | "cancel")
        return { json: view(lib).references.find((r) => r.id === m[1]) }
      }
      return
    }
    if (req.method !== "GET") return
    const { pages, references } = view(lib)
    const site = req.query.get("reference")
    const q = req.query.get("q")
    const newest = <T extends { createdAt: string }>(xs: T[]) => [...xs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    const inSite = <T extends { referenceId: string }>(xs: T[]) => (site ? xs.filter((x) => x.referenceId === site) : xs)
    const siteMatch = (id: string) => (site ? false : like(q, references.find((r) => r.id === id)?.title, references.find((r) => r.id === id)?.domain))
    const feed = {
      references: newest(references.filter((r) => (!site || r.id === site) && like(q, r.title, r.domain))),
      pages: newest(inSite(pages).filter((p) => siteMatch(p.referenceId) || like(q, p.title, p.path))).map((p) => ({ ...p, reference: ofRef(references, p.referenceId) })),
      sections: newest(sectionsOf(inSite(pages), references).filter((s) => siteMatch(s.referenceId) || like(q, s.path))),
      animations: newest(inSite(lib.animations).filter((a) => siteMatch(a.referenceId) || like(q, a.label))).map((a) => ({ ...a, reference: ofRef(references, a.referenceId) })),
      images: site ? [] : newest(lib.images.filter((i) => like(q, i.title))),
    }
    const list = req.path.match(/^\/api\/(references|pages|sections|animations|images)$/)
    if (list) return { json: { items: feed[list[1] as keyof typeof feed], nextCursor: null } }
    if (req.path === "/api/counts")
      return { json: { websites: feed.references.length, pages: feed.pages.length, sections: feed.sections.length, animations: feed.animations.length, images: feed.images.length } satisfies LibraryTypeCounts }
    const detail = req.path.match(/^\/api\/references\/([^/]+)$/)
    if (detail) {
      const r = references.find((x) => x.id === detail[1])
      if (!r) return { status: 404, json: { error: "reference not found" } }
      return { json: { reference: r, pages: pages.filter((p) => p.referenceId === r.id), animations: lib.animations.filter((a) => a.referenceId === r.id) } }
    }
  }
}
