// node qa/live.mjs <ch> : J3b — Live clips and Light/Dark in the page viewer on a deterministic local fixture
import fs from "node:fs"
import path from "node:path"
import { session, sleep } from "./jlib.mjs"
import { QA } from "./lib.mjs"
const [ch] = process.argv.slice(2)
const S = await session(ch); S.tag = "live"; const { page, api } = S
const ids = {}
await S.J("J3b fixture with motion + dark theme: capture, Live clips, Light/Dark (page viewer), canvas inspector gap", async ({ note, fail, shot }) => {
  await S.goto("/")
  await page.evaluate(() => { localStorage.removeItem("snip.viewer.scheme"); localStorage.removeItem("snip.viewer.live") }); const r = await api("/references", "POST", { url: "http://127.0.0.1:5391/", mode: "single", maxPages: 1, allowDuplicate: true })
  if (r.status >= 300) return fail("POST " + r.status + " " + JSON.stringify(r.body))
  const w = await S.waitRef(r.body.id, 200000); note(`capture ${w.status} ${JSON.stringify(w.timeline)}`)
  if (w.status !== "ready") return fail(w.detail?.reference?.error ?? "capture not ready")
  const pg = w.detail.pages[0]; ids.ref = r.body.id; ids.page = pg.id
  const liveSecs = (pg.sections ?? []).filter((s) => s.live); note(`sections ${pg.sections?.length}, with live clip ${liveSecs.length}; altScheme ${pg.altScheme?.scheme ?? "none"}`)
  if (!liveSecs.length) fail("fixture hero/marquee animate but no section got a live clip")
  fs.writeFileSync(path.join(QA, "out", `fixture-ids-${ch}.json`), JSON.stringify(ids))
  await S.goto(`/r/${ids.ref}?page=${ids.page}`); await sleep(3500)
  const hide = page.getByRole("button", { name: "Show sidebar" }); if (await hide.isVisible().catch(() => false)) await hide.click()
  await shot("j3b-viewer")
  const liveBtn = page.getByLabel(/Live: play sections/); note("viewer Live toggle: " + await liveBtn.count())
  if (await liveBtn.count()) {
    const v1 = await page.locator("video").count(); note("videos (default state): " + v1)
    await liveBtn.first().click(); await sleep(2500)
    const v = await page.locator("video").evaluateAll((vs) => vs.map((v) => ({ playing: !v.paused, t: +v.currentTime.toFixed(2), loop: v.loop, muted: v.muted, w: v.videoWidth })))
    note("videos with Live on: " + JSON.stringify(v)); await shot("j3b-viewer-live")
    if (!v.length || !v.some((x) => x.playing)) fail("no playing <video> with Live on")
    const st = page.getByLabel(/Static|static/).first(); await st.click(); await sleep(800); const after = await page.locator("video").count(); note("videos after Static: " + after); if (after) fail("videos remain after switching Live off")
  } else fail("no Live toggle for a page with moving sections")
  const dark = page.getByLabel("Dark mode"), light = page.getByLabel("Light mode"); note("Light/Dark toggle: " + ((await dark.count()) + (await light.count())))
  if ((await dark.count()) + (await light.count())) { await (await dark.count() ? dark : light).first().click(); await sleep(2500); await shot("j3b-viewer-alt"); note("alt-scheme view shows; Live toggle still shown, reads Static: " + (await liveBtn.count() > 0)); if (!(await liveBtn.count())) fail("Live toggle disappeared in the alt scheme") } else fail("no Light/Dark toggle on fixture with a prefers-color-scheme dark theme")
  await S.goto(`/?open=page:${ids.page}`); await sleep(2500)
  await page.getByRole("tab", { name: "Sections" }).click().catch(() => {}); await sleep(600)
  const names = await page.getByRole("button").evaluateAll((e) => e.map((x) => x.getAttribute("aria-label") || x.innerText).join("|"))
  const inspLive = /Live: play/.test(names), inspScheme = /(Light|Dark) mode/.test(names)
  note(`canvas inspector: Live toggle ${inspLive}, Light/Dark toggle ${inspScheme}`); await shot("j3b-inspector")
  if (!inspLive || !inspScheme) fail("canvas inspector is missing the Live or Light/Dark toggle for a page with both")
  const vids = await page.locator("video").count(); note("inspector <video> elements: " + vids)
})
await S.browser.close()
