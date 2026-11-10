// node qa/sampler.mjs <channel> <label> <outPrefix> [intervalSec]  — stops when .stop-<label> appears or the app exits
import fs from "node:fs"
import path from "node:path"
import { ps, tree, role, readPid, alive, du, load1, CHANNELS, QA, sleep } from "./lib.mjs"
const [ch, label, prefix, iv = "3"] = process.argv.slice(2)
const c = CHANNELS[ch]
const procCsv = path.join(QA, "out", `${prefix}-procs.csv`), sumCsv = path.join(QA, "out", `${prefix}-summary.csv`)
if (!fs.existsSync(procCsv)) fs.writeFileSync(procCsv, "ts,label,channel,role,pid,cpu_pct,rss_mb,load1\n")
if (!fs.existsSync(sumCsv)) fs.writeFileSync(sumCsv, "ts,label,channel,procs,total_cpu_pct,total_rss_mb,chromium_procs,profile_mb,library_mb,load1\n")
const prev = new Map()
let prevT = 0, tick = 0
const stopFile = path.join(QA, `.stop-${label}`)
fs.rmSync(stopFile, { force: true })
while (!fs.existsSync(stopFile)) {
  const pid = readPid(ch)
  if (!pid || !alive(pid)) { await sleep(1000); if (!alive(readPid(ch))) break; continue }
  const now = Date.now()
  const rows = tree(pid, ch)
  const dt = prevT ? (now - prevT) / 1000 : 0
  let totalCpu = 0, totalRss = 0, chrom = 0
  const out = []
  for (const r of rows) {
    const p = prev.get(r.pid)
    const cpu = p && dt > 0 ? Math.max(0, ((r.cpuSec - p) / dt) * 100) : 0
    const rl = role(r)
    if (rl.startsWith("capture-chromium")) chrom++
    totalCpu += cpu; totalRss += r.rssKiB / 1024
    out.push(`${new Date(now).toISOString()},${label},${ch},${rl},${r.pid},${cpu.toFixed(1)},${(r.rssKiB / 1024).toFixed(1)},${load1()}`)
  }
  prev.clear(); for (const r of rows) prev.set(r.pid, r.cpuSec)
  prevT = now
  if (dt > 0) fs.appendFileSync(procCsv, out.join("\n") + "\n")
  if (dt > 0) {
    const doDu = tick++ % 4 === 0
    fs.appendFileSync(sumCsv, `${new Date(now).toISOString()},${label},${ch},${rows.length},${totalCpu.toFixed(1)},${totalRss.toFixed(1)},${chrom},${doDu ? du(c.profile).toFixed(1) : ""},${doDu ? du(c.library).toFixed(1) : ""},${load1()}\n`)
  }
  await sleep(Number(iv) * 1000)
}
fs.rmSync(stopFile, { force: true })
