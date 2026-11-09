// node qa/journeys.mjs <stable|dev> [tag] [j1,j2,...]   Drives the running app over CDP. Needs `node qa/app.mjs start <ch>` first.
import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { session, sleep, diskMB } from "./jlib.mjs"
import { CHANNELS, ROOT, QA, tree, readPid, role, du } from "./lib.mjs"
const [ch, tag = "run", only] = process.argv.slice(2)
const want = (n) => !only || only.split(",").includes(n)
const S = await session(ch); S.tag = tag
const { page, api } = S
const c = CHANNELS[ch]
const SITE = { single: ch === "dev" ? "https://example.com" : "https://example.org", crawl: "https://linear.app", dark: "https://vercel.com" }
const ids = {}
const r2Count = () => { try { return Number(execFileSync("sh", ["-c", `find "${c.state}/v3/r2" -type f ! -name '*.sqlite*' | wc -l`], { encoding: "utf8" }).trim()) } catch { return -1 } }
const r2MB = () => du(path.join(c.state, "v3/r2"))
const chromiumCount = () => tree(readPid(ch), ch).filter((r) => role(r).startsWith("capture-chromium")).length
const dock = () => page.getByRole("toolbar", { name: "Filter saves" })
const centers = (sel) => page.evaluate((sel) => [...document.querySelectorAll(sel)].map((e) => { const r = e.getBoundingClientRect(); const x = r.x + r.width / 2, y = r.y + r.height / 2; const t = document.elementFromPoint(x, y); return t && e.contains(t) ? [x, y] : null }).filter(Boolean), sel)
const clickAt = async ([x, y], opts = {}) => { if (opts.shift) await page.keyboard.down("Shift"); await page.mouse.click(x, y, { button: opts.button ?? "left" }); if (opts.shift) await page.keyboard.up("Shift") }
async function snipUrl(url, mode = "single", extra = {}) { return api("/references", "POST", { url, mode, maxPages: mode === "crawl" ? 5 : 1, ...extra }) }

if (want("j1")) await S.J("J1 first launch, empty library", async ({ note, fail, shot }) => {
  await S.goto("/")
  const counts = (await api("/counts")).body
  note("counts " + JSON.stringify(counts))
  if (Object.values(counts).some((n) => n)) { note("library not empty; empty-state UI checked on the fresh-profile screenshot taken earlier"); return }
  const txt = await page.locator("body").innerText()
  if (!/Start your library/.test(txt)) fail("empty state text missing")
  if (!(await page.getByLabel("Link to capture").isVisible())) fail("capture card input not visible")
  await shot("j1-empty")
  // icon: bundle icon file equals the channel asset
  const bundle = path.resolve(path.dirname(c.exe), "..", "Resources/electron.icns")
  const asset = path.join(ROOT, "desktop/assets", ch === "dev" ? "Snip-dev.icns" : "Snip.icns")
  const md5 = (f) => createHash("md5").update(fs.readFileSync(f)).digest("hex")
  if (md5(bundle) !== md5(asset)) fail("bundle icon differs from channel asset")
  else note(`bundle icon == ${path.basename(asset)}`)
  const plist = execFileSync("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", path.resolve(path.dirname(c.exe), "..", "Info.plist")], { encoding: "utf8" }).trim()
  note("bundle id " + plist)
})

if (want("j2")) await S.J("J2a single capture via capture card (UI)", async ({ note, fail, shot }) => {
  await S.goto("/")
  const before = (await api("/references")).body.items.length
  await page.getByLabel("Link to capture").fill(SITE.single)
  await page.getByRole("button", { name: /^Snip/ }).click()
  await sleep(1200); await shot("j2a-capturing")
  const ref = (await api("/references")).body.items[0]; ids.single = ref.id
  const w = await S.waitRef(ref.id, 120000)
  note(`status ${w.status}, pages ${w.pages}, timeline ${JSON.stringify(w.timeline)}`)
  if (w.status !== "ready") fail("capture did not become ready")
  await sleep(1500); await shot("j2a-done")
  if (/Capturing|Queued/i.test(await page.locator("body").innerText())) fail("card still shows capturing")
  const disk = await Promise.all([api(`/references/${ref.id}`)])
  const p0 = disk[0].body.pages[0]
  for (const k of ["desktopKey", "thumbKey", "snapshotKey"]) if (p0[k]) { const r = await page.evaluate((k) => fetch("/files/" + k, { cache: "no-store" }).then((r) => r.status), p0[k]); if (r !== 200) fail(`${k} -> ${r}`) }
  note("page keys: " + Object.keys(p0).filter((k) => /Key$/.test(k)).join(","))
})
if (want("j2")) await S.J("J2b crawl of a marketing site capped at 5 pages", async ({ note, fail, shot }) => {
  const mem0 = r2MB(), cnt0 = r2Count()
  const r = await snipUrl(SITE.crawl, "crawl"); if (r.status !== 200 && r.status !== 201) return fail("POST " + r.status + JSON.stringify(r.body))
  ids.crawl = r.body.id
  await S.goto("/"); await sleep(3000); await shot("j2b-crawling")
  const w = await S.waitRef(ids.crawl, 400000)
  note(`status ${w.status}, pages ${w.pages}, timeline ${JSON.stringify(w.timeline)}`)
  if (w.status !== "ready") fail("crawl ended " + w.status)
  if (w.pages > 5) fail("more than 5 pages: " + w.pages)
  if (w.timeline.filter((t) => t.st === "capturing").length < 2) note("pages did not visibly land incrementally in polling (timeline has <2 capturing steps)")
  await sleep(1500); await shot("j2b-done")
  note(`r2 files +${r2Count() - cnt0}, +${(r2MB() - mem0).toFixed(1)} MB for ${w.pages} pages`)
  note("chromium procs after capture: " + chromiumCount())
})
if (want("j2")) await S.J("J2c failed and cancelled captures leave no stuck card", async ({ note, fail, shot }) => {
  await S.goto("/")
  const bad = await snipUrl("https://qa-nonexistent-host.invalid/")
  note("bad host POST " + bad.status)
  if (bad.body?.id) { const w = await S.waitRef(bad.body.id, 120000); note("bad host -> " + w.status + " " + (w.detail?.reference?.error ?? "")); if (w.status !== "failed") fail("bad host did not fail: " + w.status) }
  await sleep(2000)
  const ok = await snipUrl("https://vercel.com/pricing", "crawl", { allowDuplicate: true })
  await sleep(6000)
  const stop = await api(`/references/${ok.body.id}/stop`, "POST"); note("stop " + stop.status)
  const w = await S.waitRef(ok.body.id, 90000, ["stopped", "ready", "failed"]); note("after stop: " + w.status); ids.stopped = ok.body.id
  await S.goto("/"); await sleep(3000); await shot("j2c-after-cancel")
  const txt = await page.locator("body").innerText()
  if (/Capturing|Queued|Stopping/i.test(txt)) fail("a loading card is stuck: " + txt.slice(0, 200).replace(/\n/g, " | "))
  const live = (await api("/references?status=capturing")).body.items.length + (await api("/references?status=queued")).body.items.length
  if (live) fail(live + " references still capturing/queued")
  await sleep(4000); note("chromium procs after cancel: " + chromiumCount())
})
if (want("j3")) await S.J("J3 sections: inspector, dock filter, page viewer (Live, Light/Dark)", async ({ note, fail, shot }) => {
  const r = await snipUrl(SITE.dark, "single", { allowDuplicate: true }); ids.dark = r.body.id
  const w = await S.waitRef(ids.dark, 300000); note(`vercel capture ${w.status}, ${w.pages} page(s), ${w.timeline.at(-1)?.s}s`)
  if (w.status !== "ready") return fail("capture " + w.status)
  const pg = w.detail.pages[0]; ids.darkPage = pg.id
  note("sections on page: " + (pg.sections?.length ?? "?") + "; altScheme: " + JSON.stringify(pg.altScheme ?? pg.alt ?? null).slice(0, 120))
  await S.goto(`/?open=page:${pg.id}`); await sleep(2500); await shot("j3-inspector")
  const tab = page.getByRole("tab", { name: "Sections" })
  if (!(await tab.count())) fail("inspector has no Sections tab")
  else {
    await tab.click(); await sleep(800)
    const n = await page.locator("[data-section]").count(); note("inspector [data-section] overlays: " + n)
    const items = page.locator('[role="tabpanel"] button'); note("sections tab buttons: " + (await items.count()))
    const scroller = () => page.evaluate(() => { const el = document.querySelector("[data-section]"); let p = el?.parentElement; while (p && p.scrollHeight <= p.clientHeight + 4) p = p.parentElement; return p ? p.scrollTop : -1 })
    const s0 = await scroller()
    const k = Math.min(await items.count() - 1, 4); if (k > 0) { await items.nth(k).click(); await sleep(1200) }
    const s1 = await scroller(); note(`preview scrollTop ${s0} -> ${s1}`); if (k > 0 && s1 === s0) fail("clicking a section did not scroll the preview")
    await shot("j3-inspector-sections")
    const names = await page.getByRole("button").evaluateAll((e) => e.map((x) => x.getAttribute("aria-label") || x.innerText).join("|"))
    const live = /Live/.test(names), scheme = /Light mode|Dark mode/.test(names)
    note(`inspector has Live toggle: ${live}; Light/Dark toggle: ${scheme} (expected: both absent, known gap)`)
    if (live || scheme) note("UNEXPECTED: inspector now has Live/Light-Dark controls; known-gap note outdated")
  }
  await page.keyboard.press("Escape"); await sleep(500)
  await S.goto("/"); await dock().getByRole("button", { name: /^Sections/ }).click(); await sleep(1500)
  const secTiles = await page.locator("div.group button[aria-label]").count(); note("Sections filter tiles in DOM: " + secTiles)
  if (!secTiles) fail("Sections filter shows no tiles"); await shot("j3-sections-filter")
  await S.goto(`/r/${ids.dark}?page=${pg.id}`); await sleep(3500); await shot("j3-viewer")
  const hide = page.getByRole("button", { name: "Show sidebar" }); if (await hide.isVisible().catch(() => false)) await hide.click()
  const liveBtn = page.getByRole("radio", { name: /Live: play/ }).or(page.getByLabel(/Live: play sections/))
  const liveOn = await liveBtn.count()
  note("viewer Live toggle present: " + !!liveOn)
  if (liveOn) {
    await liveBtn.first().click(); await sleep(2500)
    const v = await page.locator("video").evaluateAll((vs) => vs.map((v) => ({ playing: !v.paused, t: v.currentTime, src: v.currentSrc.slice(-40) })))
    note(`videos with Live on: ${v.length}, playing ${v.filter((x) => x.playing).length}`); await shot("j3-viewer-live")
    if (!v.length) fail("Live on but no <video>")
    const st = page.getByLabel(/Static|static/).first(); if (await st.count()) { await st.click(); await sleep(800); note("videos after Static: " + (await page.locator("video").count())) }
  } else note("no Live toggle: page had no moving sections or toggle missing")
  const dark = page.getByLabel("Dark mode"), light = page.getByLabel("Light mode")
  const has = (await dark.count()) + (await light.count()); note("Light/Dark toggle present: " + !!has)
  if (has) { const t = (await dark.count()) ? dark : light; await t.first().click(); await sleep(2500); await shot("j3-viewer-altscheme") } else fail("Light/Dark toggle not shown for vercel.com (site has both themes)")
})
if (want("j4")) await S.J("J4 canvas: pan, zoom, filters, search, select, layer menu, multi-select", async ({ note, fail, shot }) => {
  await S.goto("/"); await sleep(1500)
  const cv = page.locator('[aria-label*="Drag or use the arrow keys"]').first()
  const tx = () => cv.evaluate((el) => { const w = el.querySelector("div"); return getComputedStyle(w).transform }).catch(() => "?")
  const t0 = await tx()
  await page.mouse.move(500, 600); await page.mouse.down(); await page.mouse.move(300, 450, { steps: 8 }); await page.mouse.up(); const t1 = await tx()
  note(`pan transform changed: ${t0 !== t1}`); if (t0 === t1) fail("drag did not pan")
  await page.getByRole("button",{name:"Zoom in"}).click(); await page.getByRole("button",{name:"Zoom in"}).click(); const z1 = await page.getByRole("button",{name:/^Zoom \d+%/}).getAttribute("aria-label")
  await page.getByRole("button",{name:"Zoom out"}).click(); await page.getByRole("button",{name:"Recenter"}).click(); await page.mouse.move(600, 500); await page.mouse.wheel(0, -300); await sleep(300)
  note("zoom label after 2x in: " + z1)
  for (const f of ["Websites", "Pages", "Sections", "Animations", "Images", "All"]) { await dock().getByRole("button", { name: new RegExp("^" + f) }).click(); await sleep(500) }
  await page.getByLabel("Search your saves").fill("vercel"); await sleep(1200)
  const hits = await page.locator("div.group button[aria-label]").count(); note("search 'vercel' tiles: " + hits); await shot("j4-search")
  await page.getByLabel("Clear search").click(); await sleep(800); await S.goto("/"); await sleep(1500)
  const tiles = page.locator("div.group button[aria-label]"); const n = await tiles.count(); note("tiles on canvas: " + n)
  const vis = await centers("div.group button[aria-label]"); note("tiles visible & unobstructed: " + vis.length)
  if (vis.length >= 2) {
    await clickAt(vis[0]); await sleep(800); const open = page.url().includes("open="); note("click opens inspector: " + open); if (!open) fail("tile click did not open inspector"); await page.keyboard.press("Escape"); await sleep(600)
    await clickAt(vis[0], { button: "right" }); await sleep(700); await shot("j4-contextmenu")
    note("home canvas right-click: .lmn-menu open " + (await page.locator(".lmn-menu:not(.shut)").count()) + ", role=menu " + (await page.getByRole("menu").count()) + " (selection, layer menu and multi-select toolbar exist only in board-canvas.tsx; exercised in J5)")
    await page.keyboard.press("Escape")
  } else fail("fewer than 2 tiles")
})
if (want("j5")) await S.J("J5 boards: create, add, note, group, restyle, reload, delete", async ({ note, fail, shot }) => {
  await S.goto("/")
  await page.getByRole("button", { name: /switch board/ }).click(); await sleep(500)
  await page.getByRole("button", { name: /New board/ }).click(); await page.getByLabel("Board name").fill("QA board"); await page.getByRole("button", { name: /^Create/ }).click(); await sleep(2000)
  note("url after create: " + page.url().replace(S.origin, "")); const bid = page.url().split("/b/")[1]?.split(/[?#]/)[0]; ids.board = bid
  if (!bid) return fail("no board route")
  const pages = (await api("/pages")).body.items.slice(0, 3)
  for (const p of pages) await api(`/collections/${bid}/pages`, "POST", { pageIds: [p.id] }).then((r) => r.status >= 300 && note("add page " + r.status + JSON.stringify(r.body).slice(0, 100)))
  // uploaded image
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64")
  const up = await page.evaluate(async ([b64, bid]) => { const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); const fd = new FormData(); fd.append("file", new File([bin], "qa-pixel.png", { type: "image/png" })); fd.append("thumb", new File([new Uint8Array([255,216,255,224,0,16,74,70,73,70,0,1,1,0,0,1,0,1,0,0,255,217])], "t.jpg", { type: "image/jpeg" })); fd.append("width", "1"); fd.append("height", "1"); fd.append("collectionId", bid); const r = await fetch("/api/images", { method: "POST", body: fd }); return { status: r.status, body: await r.json().catch(() => null) } }, [png.toString("base64"), bid])
  note("image upload to board " + up.status)
  await page.reload(); await sleep(2500)
  await page.getByLabel("Add note").click(); await sleep(800)
  await page.locator('[aria-label="Note"], textarea').first().fill("QA sticky").catch(() => note("note textarea not found")); await sleep(600)
  await shot("j5-board")
  const tiles = page.locator("[aria-label]").filter({ hasNot: page.locator("x") })
  // select two tiles, group (G)
  const vis = await centers('[data-key]'); note("board items visible: " + vis.length); await shot("j5-board-items")
  if (vis.length >= 2) { await clickAt(vis[0], { shift: true }); await clickAt(vis[1], { shift: true }); await sleep(600); note("multi-select toolbar: " + (await page.getByRole("toolbar", { name: /selected/ }).count())); await shot("j5-multiselect"); const g = page.getByRole("toolbar", { name: /selected/ }).getByRole("button", { name: "Group" }); if (await g.count()) { await g.click(); await sleep(1500); note("group created") } else fail("Group button missing after selecting two items"); await shot("j5-grouped") } else fail("fewer than 2 clickable board items")
  const vis2 = await centers('[data-key]')
  if (vis2.length) { await clickAt(vis2[0], { button: "right" }); await sleep(700); await shot("j5-layer-menu"); note(".lmn-menu open: " + (await page.locator(".lmn-menu:not(.shut)").count()));
    const snap0 = JSON.stringify((await api(`/boards/${bid}`)).body)
    const labels = await page.locator(".lmn-menu:not(.shut) [aria-label]").evaluateAll((e) => e.map((x) => x.getAttribute("aria-label")).slice(0, 14)); note("layer menu controls: " + labels.join(", "))
    const btn = page.locator(".lmn-menu:not(.shut) button[aria-label], .lmn-menu:not(.shut) [role=menuitem]").first(); if (await btn.count()) { await btn.click({ force: true }).catch(() => {}); await sleep(1800) }
    await page.keyboard.press("Escape")
    const vis3 = await centers("[data-key]"); if (vis3.length) { const [x, y] = vis3[0]; await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 90, y + 60, { steps: 10 }); await page.mouse.up(); await sleep(2200) }
    const snap1 = JSON.stringify((await api(`/boards/${bid}`)).body); note("board changed after restyle click + drag: " + (snap0 !== snap1)); if (snap0 === snap1) fail("drag/restyle did not change the saved board") }
  const before = (await api(`/boards/${bid}`)).body
  note(`board api: items ${before?.items?.length}, notes ${before?.notes?.length}, groups ${before?.groups?.length}`)
  await page.reload(); await sleep(2500)
  const after = (await api(`/boards/${bid}`)).body
  if (JSON.stringify(after) !== JSON.stringify(before)) fail("board API response changed after reload")
  const txt = await page.locator("body").innerText(); if (!/QA sticky/.test(txt)) fail("sticky note text missing after reload")
  await shot("j5-after-reload")
  await page.getByLabel("Board actions").click(); await sleep(400); await page.getByRole("menuitem", { name: /Delete/ }).click(); await sleep(2000)
  const gone = (await api(`/boards/${bid}`)).status; note("board GET after delete " + gone); if (gone !== 404) fail("board still exists")
  const cols = (await api("/collections")).body; if (cols.some?.((x) => x.id === bid)) fail("board in collections list")
})
if (want("j6")) await S.J("J6 image upload: ok, wrong type, oversized", async ({ note, fail, shot }) => {
  await S.goto("/")
  fs.mkdirSync(path.join(QA, "fixtures"), { recursive: true })
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64")
  fs.writeFileSync(path.join(QA, "fixtures/ok.png"), png); fs.writeFileSync(path.join(QA, "fixtures/notes.txt"), "not an image")
  const big = Buffer.concat([png.subarray(0, 33), Buffer.alloc(21 * 1024 * 1024, 0)]); fs.writeFileSync(path.join(QA, "fixtures/big.png"), big)
  fs.writeFileSync(path.join(QA, "fixtures/fake.png"), "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>")
  const input = page.locator('input[type="file"]').first()
  const counts0 = (await api("/counts")).body.images
  await input.setInputFiles(path.join(QA, "fixtures/ok.png")); await sleep(2500); await shot("j6-ok")
  const c1 = (await api("/counts")).body.images; note(`images ${counts0} -> ${c1}`); if (c1 !== counts0 + 1) fail("valid upload not added")
  for (const f of ["notes.txt", "big.png", "fake.png"]) {
    await input.setInputFiles(path.join(QA, "fixtures", f)); await sleep(2500)
    const toast = await page.locator("[data-sonner-toast]").allInnerTexts(); note(`${f}: toast ${JSON.stringify(toast).slice(0, 160)}`); await shot("j6-" + f.replace(".", "-"))
    const c2 = (await api("/counts")).body.images; if (c2 !== c1) fail(`${f} was stored (count ${c1} -> ${c2})`)
  }
  const raw = await page.evaluate(async () => { const fd = new FormData(); fd.append("file", new File([new Uint8Array(21 * 1024 * 1024 + 100).fill(1)], "huge.png", { type: "image/png" })); const r = await fetch("/api/images", { method: "POST", body: fd }); return [r.status, await r.text()] }); note("raw 21MB POST -> " + raw.join(" ").slice(0, 120))
  const ims = (await api("/images")).body.items; ids.image = ims[0]?.id
})
if (want("j7")) await S.J("J7 re-capture (asks first), delete website, files gone", async ({ note, fail, shot }) => {
  const id = ids.single ?? (await api("/references")).body.items.at(-1).id
  await S.goto(`/r/${id}`); await sleep(1500)
  const pre = r2Count(); note("r2 files before: " + pre)
  S.setDialog("dismiss")
  const menuBtn = page.getByRole("button", { name: /More actions|actions|Re-capture|Capture again/i }); note("candidate buttons: " + await menuBtn.count())
  await shot("j7-ref-page")
  const rec = page.getByRole("button", { name: /Re-?capture/i })
  if (!(await rec.count())) { const more = page.getByLabel(/More|actions/i).first(); if (await more.count()) { await more.click(); await sleep(400) } }
  await rec.first().click().catch((e) => note("recapture click: " + e.message.split("\n")[0])); await sleep(1000)
  const d = S.errors.dialogs.at(-1); note("dialog on recapture: " + d); if (!/Re-capture/.test(d ?? "")) fail("no confirm before re-capture")
  const st = (await api(`/references/${id}`)).body.reference.status; if (st !== "ready") fail("dismissed confirm still started a re-capture: " + st)
  S.setDialog("accept")
  await rec.first().click().catch(() => {}); await sleep(1000)
  const w = await S.waitRef(id, 150000, ["ready", "failed"]); note("recapture -> " + w.status + " pages " + w.pages + " " + JSON.stringify(w.timeline))
  note("r2 files after recapture: " + r2Count() + " chromium " + chromiumCount())
  // delete the stopped/crawl ref via UI for the disk test
  const target = (await api("/references?limit=100")).body.items.find((r) => /linear\.app/.test(r.domain ?? r.url))?.id ?? ids.crawl ?? id; note("delete target " + target); const before = r2Count(), mb = r2MB()
  const detail = (await api(`/references/${target}`)).body; const keys = detail.pages.flatMap((p) => Object.entries(p).filter(([k, v]) => /Key$/.test(k) && v).map(([, v]) => v))
  await S.goto(`/r/${target}`); await sleep(1200)
  await page.getByRole("button", { name: "More", exact: true }).click(); await sleep(500)
  await page.getByRole("menuitem", { name: /Delete reference/ }).or(page.getByRole("button", { name: /Delete reference/ })).first().click().catch((e) => fail("delete click: " + e.message.split("\n")[0])); await sleep(3000)
  const gone = (await api(`/references/${target}`)).status; note("GET after delete " + gone); if (gone !== 404) fail("reference still present")
  let still = 0; for (const k of keys.slice(0, 40)) { const s = await page.evaluate((k) => fetch("/files/" + k, { cache: "no-store" }).then((r) => r.status), k); if (s === 200) still++ }
  note(`files for ${keys.length} keys; still served after delete: ${still}`); if (still) fail(`${still} files still served after delete`)
  note(`r2 files ${before} -> ${r2Count()}, MB ${mb.toFixed(1)} -> ${r2MB().toFixed(1)}`)
  if (r2Count() >= before) fail("R2 file count on disk did not drop after deleting the website (may be a delayed purge; re-checked later in report)")
  ids.deleted = target
})
if (want("j10")) await S.J("J10 hostile patterns", async ({ note, fail, shot }) => {
  await S.goto("/")
  const n0 = (await api("/references")).body.items.length
  const input = page.getByLabel("Link to capture"); await input.fill("https://www.iana.org/help/example-domains")
  const go = page.getByRole("button", { name: /^Snip/ }); await go.dblclick({ delay: 10 }); await sleep(2500)
  const n1 = (await api("/references")).body.items.length; note(`double-submit created ${n1 - n0} reference(s)`); if (n1 - n0 > 1) fail("double submit created duplicates")
  const newest = (await api("/references")).body.items[0]
  await page.reload(); await sleep(2500); note("reload mid-capture: card text " + (await page.locator("body").innerText()).replace(/\n/g, " | ").slice(0, 120)); await shot("j10-reload-mid-capture")
  const w = await S.waitRef(newest.id, 150000); note("capture after reload: " + w.status); if (w.status !== "ready") fail("capture did not finish after reload: " + w.status)
  await input.fill("not a url !!"); await go.click(); await sleep(1200); await shot("j10-invalid-url")
  note("invalid url: toast/text " + JSON.stringify(await page.locator("[data-sonner-toast]").allInnerTexts()) + " refs " + (await api("/references")).body.items.length)
  const inv = await snipUrl("javascript:alert(1)"); note("javascript: url POST -> " + inv.status); if (inv.status < 400) fail("javascript: URL accepted")
  const prv = await snipUrl("http://127.0.0.1:1/"); note("private url POST -> " + prv.status)
  const pg = (await api("/pages")).body.items[0]
  for (let i = 0; i < 6; i++) { await page.goto(`${S.origin}/?open=page:${pg.id}`); await sleep(40); await page.keyboard.press("Escape") }
  await sleep(1000); note("inspector open/close mid-load x6: no crash, url " + page.url().replace(S.origin, ""))
  await S.goto("/")
  for (let i = 0; i < 40; i++) await dock().getByRole("button", { name: new RegExp("^" + ["Websites", "Pages", "Sections", "Animations", "Images", "All"][i % 6]) }).click({ delay: 0 })
  await sleep(1000); note("40 rapid filter switches ok; tiles " + await page.locator("div.group button[aria-label]").count())
  const vs = await page.evaluate(() => [innerWidth, innerHeight]); await page.setViewportSize({ width: 360, height: 640 }); await sleep(1200); await shot("j10-narrow")
  const ov = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2); note("narrow 360px horizontal overflow: " + ov)
  await page.goto(`${S.origin}/?open=page:${pg.id}`); await sleep(2000); await shot("j10-narrow-inspector"); await page.setViewportSize({ width: vs[0], height: vs[1] })
})
console.log("DISK", JSON.stringify(diskMB(ch)))
fs.writeFileSync(path.join(QA, "out", `ids-${ch}.json`), JSON.stringify(ids))
await S.browser.close()
