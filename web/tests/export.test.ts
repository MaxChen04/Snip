import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { crc32, zip } from "../src/lib/zip"
import { exportPlan } from "../src/lib/export-reference"
import type { Animation, Page, Reference } from "../shared/types"

test("crc32 matches the standard check value", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926)
})

test("the zip writer produces an archive standard tools can read", () => {
  const enc = new TextEncoder()
  const bytes = zip([
    { name: "reference.json", data: enc.encode('{"ok":true}') },
    { name: "pages/01-home/desktop.jpg", data: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) },
  ])
  const dir = mkdtempSync(join(tmpdir(), "snip-zip-"))
  try {
    const file = join(dir, "x.zip")
    writeFileSync(file, bytes)
    const out = execFileSync("python3", ["-I", "-c", "import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print(','.join(z.namelist()));print(z.read('reference.json').decode())", file], { encoding: "utf8" })
    assert.equal(out, 'reference.json,pages/01-home/desktop.jpg\n{"ok":true}\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("export puts each page's files in its own folder", () => {
  const r = { id: "r1", title: "Linear", domain: "linear.app" } as Reference
  const page = (id: string, ord: number, path: string): Page => ({ id, ord, path, url: `https://linear.app${path}`, desktopKey: `refs/r1/a/p${ord}/desktop.jpg`, mobileKey: null, snapshotKey: `refs/r1/a/p${ord}/snapshot.html`, stylesKey: null } as Page)
  const anim = { id: "a1", pageId: "p1", kind: "hover", label: "Get started", gifKey: "refs/r1/a/p1/hover-0.gif", sheetKey: "refs/r1/a/p1/hover-0-sheet.jpg" } as Animation
  const plan = exportPlan(r, [page("p0", 0, "/"), page("p1", 1, "/pricing")], [anim])
  assert.equal(plan.name, "snip-linear.zip")
  assert.deepEqual(plan.files.map((f) => f.path), [
    "pages/01-home/desktop.jpg",
    "pages/01-home/snapshot.html",
    "pages/02-pricing/desktop.jpg",
    "pages/02-pricing/snapshot.html",
    "pages/02-pricing/animations/hover-1-get-started.gif",
    "pages/02-pricing/animations/hover-1-get-started-sheet.jpg",
  ])
})

test("reference.json lists each page's warnings, with an empty list for a page with none", () => {
  const r = { id: "r1", title: "Linear", domain: "linear.app" } as Reference
  const page = (id: string, ord: number, warnings: Page["warnings"]) => ({ id, ord, path: `/${id}`, url: `https://linear.app/${id}`, title: id, warnings, tokens: null, desktopKey: null, mobileKey: null, snapshotKey: null, stylesKey: null }) as unknown as Page
  const { metadata } = exportPlan(r, [page("a", 0, []), page("b", 1, ["blank"]), page("c", 2, ["truncated", "blank"])], [])
  const written = JSON.parse(JSON.stringify(metadata, null, 2)) as { pages: { id: string; warnings: string[] }[] }
  assert.deepEqual(written.pages.map((p) => [p.id, p.warnings]), [["a", []], ["b", ["blank"]], ["c", ["truncated", "blank"]]])
})

test("pasted text with several websites becomes a list", async () => {
  const { extractUrls, parseSiteUrl } = await import("../src/lib/site-url")
  assert.equal(parseSiteUrl("linear"), null)
  assert.equal(parseSiteUrl("linear.app")?.href, "https://linear.app/")
  assert.deepEqual(extractUrls("linear.app\nhttps://stripe.com/pricing, vercel.com  linear.app notaurl").map((u) => u.href), ["https://linear.app/", "https://stripe.com/pricing", "https://vercel.com/"])
})
