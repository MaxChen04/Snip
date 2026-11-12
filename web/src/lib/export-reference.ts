import type { Animation, Page, Reference } from "../../shared/types"
import { pageSummary } from "../../shared/page-summary"
import { zip, type ZipEntry } from "./zip"

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "page"

const extension = (key: string) => key.match(/\.[a-z0-9]+$/i)?.[0] ?? ""

/** Archive paths for every stored file of a reference, plus its metadata. Pure, so it can be tested. */
export function exportPlan(r: Reference, pages: Page[], animations: Animation[]) {
  const files: { path: string; key: string }[] = []
  const pageDir = new Map<string, string>()
  for (const p of pages) {
    const dir = `pages/${String(p.ord + 1).padStart(2, "0")}-${slug(p.path === "/" ? "home" : p.path)}`
    pageDir.set(p.id, dir)
    const add = (key: string | null, name: string) => key && files.push({ path: `${dir}/${name}${extension(key)}`, key })
    add(p.desktopKey, "desktop")
    add(p.mobileKey, "mobile")
    add(p.snapshotKey, "snapshot")
    add(p.stylesKey, "styles")
  }
  animations.forEach((a, i) => {
    const dir = (a.pageId && pageDir.get(a.pageId)) || "animations"
    const name = `${a.kind}-${i + 1}${a.label ? `-${slug(a.label)}` : ""}`
    files.push({ path: `${dir}/animations/${name}${extension(a.gifKey)}`, key: a.gifKey })
    if (a.sheetKey) files.push({ path: `${dir}/animations/${name}-sheet${extension(a.sheetKey)}`, key: a.sheetKey })
  })
  const metadata = {
    exportedAt: new Date().toISOString(),
    reference: { ...r, previewKeys: undefined, coverKey: undefined, favicon: undefined },
    pages: pages.map((p) => ({ ...pageSummary(p), folder: pageDir.get(p.id), tokens: p.tokens, desktop: { width: p.desktopWidth, height: p.desktopHeight }, mobile: { width: p.mobileWidth, height: p.mobileHeight } })),
    animations: animations.map((a) => ({ id: a.id, pageId: a.pageId, kind: a.kind, label: a.label, selector: a.selector, viewport: a.viewport, width: a.width, height: a.height, meta: a.meta })),
  }
  return { name: `snip-${slug(r.title || r.domain)}.zip`, files, metadata }
}

/** Downloads a reference's screenshots, HTML snapshots, styles, recordings and tokens as one .zip. */
export async function exportReference(r: Reference, pages: Page[], animations: Animation[], onProgress?: (done: number, total: number) => void) {
  const plan = exportPlan(r, pages, animations)
  const entries: ZipEntry[] = [{ name: "reference.json", data: new TextEncoder().encode(JSON.stringify(plan.metadata, null, 2)) }]
  let done = 0
  for (const f of plan.files) {
    const res = await fetch(`/files/${f.key}`)
    // A missing file would make an incomplete archive look complete, so stop instead.
    if (!res.ok) throw new Error(`${f.path} couldn't be downloaded (${res.status === 401 ? "signed out" : `HTTP ${res.status}`})`)
    entries.push({ name: f.path, data: new Uint8Array(await res.arrayBuffer()) })
    onProgress?.(++done, plan.files.length)
  }
  const url = URL.createObjectURL(new Blob([zip(entries)], { type: "application/zip" }))
  const a = document.createElement("a")
  a.href = url
  a.download = plan.name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
  return entries.length - 1
}
