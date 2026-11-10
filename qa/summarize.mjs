// node qa/summarize.mjs <prefix-glob-ish: res-dev> -> markdown table per phase
import fs from "node:fs"
import path from "node:path"
const prefix = process.argv[2]
const dir = path.join(path.dirname(new URL(import.meta.url).pathname), "out")
const rows = (f) => fs.readFileSync(f, "utf8").trim().split("\n").slice(1).map((l) => l.split(","))
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))] }
const avg = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1)
for (const f of fs.readdirSync(dir).filter((f) => f.startsWith(prefix + "-") && f.endsWith("-summary.csv")).sort()) {
  const r = rows(path.join(dir, f)); if (r.length < 2) continue
  const cpu = r.map((x) => +x[4]), rss = r.map((x) => +x[5]), ch = r.map((x) => +x[6]), load = r.map((x) => +x[9])
  const disk = r.filter((x) => x[7]).map((x) => [+x[7], +x[8]])
  const third = Math.floor(r.length / 3) || 1
  console.log(`| ${f.replace("-summary.csv", "").replace(prefix + "-", "")} | ${r.length} | ${avg(cpu).toFixed(1)} / ${q(cpu, 0.95).toFixed(0)} / ${Math.max(...cpu).toFixed(0)} | ${avg(cpu.slice(-third)).toFixed(1)} | ${rss[0].toFixed(0)} -> ${rss.at(-1).toFixed(0)} (max ${Math.max(...rss).toFixed(0)}) | ${Math.max(...ch)} -> ${ch.at(-1)} | ${disk.length ? disk[0][0].toFixed(0) + "->" + disk.at(-1)[0].toFixed(0) : ""} | ${avg(load).toFixed(1)} |`)
  // per role (procs csv)
  const pf = f.replace("-summary", "-procs"); const pr = rows(path.join(dir, pf))
  const by = {}; for (const x of pr) { const k = x[3]; (by[k] ??= { cpu: [], rss: {} }); by[k].cpu.push(+x[5]); (by[k].rss[x[1] + x[0]] ??= 0) }
  const tsBy = {}; for (const x of pr) { (tsBy[x[0]] ??= {}); tsBy[x[0]][x[3]] = (tsBy[x[0]][x[3]] ?? 0) + +x[6] }
  const tss = Object.keys(tsBy).sort(); const roles = Object.keys(by)
  console.log("  roles(avg cpu% per proc-sample | rss first->last MB summed): " + roles.map((k) => `${k} ${avg(by[k].cpu).toFixed(1)} | ${(tsBy[tss[0]][k] ?? 0).toFixed(0)}->${(tsBy[tss.at(-1)][k] ?? 0).toFixed(0)}`).join("; "))
}
