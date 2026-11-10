// node qa/soak.mjs <ch> <canvas|viewer> [iterations]
import fs from "node:fs"
import path from "node:path"
import { session, sleep } from "./jlib.mjs"
import { QA } from "./lib.mjs"
const [ch, phase, iters = "60"] = process.argv.slice(2)
const N = Number(iters)
const S = await session(ch); const { page } = S
const cdp = await page.context().newCDPSession(page)
await cdp.send("HeapProfiler.enable"); await cdp.send("Performance.enable")
const out = []
async function measure(label) {
  await cdp.send("HeapProfiler.collectGarbage"); await cdp.send("HeapProfiler.collectGarbage"); await sleep(400)
  const heap = await cdp.send("Runtime.getHeapUsage")
  const dom = await cdp.send("Memory.getDOMCounters")
  const live = await page.evaluate(() => ({ elements: document.getElementsByTagName("*").length, videos: document.querySelectorAll("video").length, playing: [...document.querySelectorAll("video")].filter((v) => !v.paused).length, imgs: document.images.length }))
  const row = { label, heapMB: +(heap.usedSize / 1048576).toFixed(1), heapTotalMB: +(heap.totalSize / 1048576).toFixed(1), domNodesAll: dom.nodes, listeners: dom.jsEventListeners, documents: dom.documents, attached: live.elements, detachedApprox: dom.nodes - live.elements, videos: live.videos, playing: live.playing, imgs: live.imgs, ts: new Date().toISOString() }
  out.push(row); console.log(JSON.stringify(row))
  fs.writeFileSync(path.join(QA, "out", `soak-${ch}-${phase}.json`), JSON.stringify(out, null, 1))
}
const centers = () => page.evaluate(() => [...document.querySelectorAll("div.group button[aria-label]")].map((e) => { const r = e.getBoundingClientRect(); const x = r.x + r.width / 2, y = r.y + r.height / 2; const t = document.elementFromPoint(x, y); return t && e.contains(t) ? [x, y] : null }).filter(Boolean))
const dock = () => page.getByRole("toolbar", { name: "Filter saves" })
const errs0 = S.errors.console.length
if (phase === "canvas") {
  await S.goto("/"); await sleep(2000)
  await measure("start")
  for (let i = 1; i <= N; i++) {
    const vis = await centers()
    if (vis.length) { await page.mouse.click(...vis[i % vis.length]); await sleep(500); await page.keyboard.press("Escape"); await sleep(250) }
    await page.mouse.move(700, 700); await page.mouse.down(); await page.mouse.move(600 + (i % 3) * 40, 620, { steps: 6 }); await page.mouse.up()
    await page.getByRole("button", { name: "Zoom in" }).click(); await page.getByRole("button", { name: "Zoom out" }).click()
    await dock().getByRole("button", { name: new RegExp("^" + ["Pages", "Sections", "Websites", "Animations", "Images", "All"][i % 6]) }).click(); await sleep(150)
    if (i === Math.round(N / 2)) await measure("middle")
  }
  await sleep(1500); await measure("end")
} else {
  await page.evaluate(() => { localStorage.removeItem("snip.viewer.scheme"); localStorage.removeItem("snip.viewer.live") })
  const id = process.env.REF, pg = process.env.PAGE
  await S.goto(`/r/${id}?page=${pg}`); await sleep(3500)
  const hide = page.getByRole("button", { name: "Show sidebar" }); if (await hide.isVisible().catch(() => false)) await hide.click()
  const liveBtn = page.getByLabel(/Live: play sections/), staticBtn = page.getByLabel(/Static|static/).first()
  console.log("live toggle:", await liveBtn.count())
  await measure("start")
  for (let i = 1; i <= N; i++) {
    await liveBtn.first().click(); await sleep(350); await staticBtn.click(); await sleep(250)
    if (i === Math.round(N / 2)) await measure("middle")
  }
  await liveBtn.first().click(); await sleep(1500); await measure("end-live-on")
  await staticBtn.click(); await sleep(1000); await measure("end-live-off")
}
console.log("console errors during soak:", S.errors.console.length - errs0, S.errors.console.slice(errs0, errs0 + 5))
await S.browser.close()
