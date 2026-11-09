// node qa/resource.mjs <ch> — fresh restart, 5 min idle, capture, 4 min idle after, soak canvas, soak viewer. Writes out/res-<ch>-*.csv
import { spawn, execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { startApp, stopApp, waitHttp, origin, CHANNELS, QA, sleep, load1 } from "./lib.mjs"
import { session } from "./jlib.mjs"
const [ch] = process.argv.slice(2)
const log = (...a) => console.log(new Date().toISOString(), ...a)
const marks = []
const mark = (m) => { marks.push({ t: new Date().toISOString(), m, load: load1() }); fs.writeFileSync(path.join(QA, "out", `res-${ch}-marks.json`), JSON.stringify(marks, null, 1)); log(m, "load", load1()) }
let sampler
const startSampler = (label) => { sampler = spawn("node", [path.join(QA, "sampler.mjs"), ch, `${ch}-${label}`, `res-${ch}-${label}`, "3"], { stdio: "ignore" }) }
const stopSampler = async (label) => { fs.writeFileSync(path.join(QA, `.stop-${ch}-${label}`), ""); await sleep(5000) }
const phase = async (label, fn) => { mark("begin " + label); startSampler(label); try { await fn() } finally { await stopSampler(label); mark("end " + label) } }
if (!process.env.FROM_CAPTURE) {
  log("stop + fresh start", JSON.stringify(await stopApp(ch)))
  startApp(ch); await waitHttp(origin(ch) + "/api/me"); await sleep(8000)
  await phase("idle", () => sleep(300000))
}
await phase("capture", async () => {
  const S = await session(ch); await S.goto("/")
  const r = await S.api("/references", "POST", { url: "https://linear.app", mode: "crawl", maxPages: 5, allowDuplicate: true })
  const w = await S.waitRef(r.body.id, 400000); log("capture", w.status, w.pages); await S.browser.close()
})
await phase("post-capture-idle", () => sleep(240000))
const run = (script, args, env = {}) => { try { execFileSync("node", [path.join(QA, script), ch, ...args], { stdio: "inherit", env: { ...process.env, ...env } }) } catch (e) { log("FAILED", script, e.message) } }
await phase("soak-canvas", async () => run("soak.mjs", ["canvas", "60"]))
const ids = JSON.parse(fs.readFileSync(path.join(QA, "out", `fixture-ids-${ch}.json`)))
await phase("soak-viewer", async () => run("soak.mjs", ["viewer", "50"], { REF: ids.ref, PAGE: ids.page }))
await phase("final-idle", () => sleep(120000))
mark("done")
