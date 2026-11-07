import { Miniflare, convertV4MiniflareOptions } from "miniflare"

// What one D1 round trip costs in this harness. On workerd a D1 call is I/O and is not billed as
// CPU; in Miniflare-in-Node the bridge runs in-process, so its cost lands in process.cpuUsage.
// Reporting it separately keeps the passkey CPU numbers honest.

const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ["DB"] }))
const db = (await mf.getD1Database("DB")) as unknown as D1Database
await db.prepare("CREATE TABLE t (id TEXT PRIMARY KEY, v TEXT)").run()

async function cpu(fn: () => Promise<unknown>, n = 500) {
  const samples: number[] = []
  for (let i = 0; i < n; i++) {
    const before = process.cpuUsage()
    const start = performance.now()
    await fn()
    const d = process.cpuUsage(before)
    samples.push(((d.user + d.system) / 1000))
    if (i === 0) console.log("first wall", (performance.now() - start).toFixed(2))
  }
  samples.sort((a, b) => a - b)
  return { mean: samples.reduce((a, b) => a + b, 0) / samples.length, p50: samples[n >> 1], max: samples.at(-1) }
}

console.log("SELECT 1        ", await cpu(() => db.prepare("SELECT 1 AS one").first()))
console.log("INSERT OR IGNORE", await cpu(() => db.prepare("INSERT OR IGNORE INTO t (id, v) VALUES (?, ?)").bind("a", "b").run(), 200))
console.log("UPDATE          ", await cpu(() => db.prepare("UPDATE t SET v = ? WHERE id = ?").bind("c", "a").run(), 200))
console.log("DELETE          ", await cpu(() => db.prepare("DELETE FROM t WHERE id = ?").bind("missing").run(), 200))
console.log("batch of 2      ", await cpu(() => db.batch([db.prepare("SELECT 1 AS one"), db.prepare("SELECT 2 AS two")]), 200))
await mf.dispose()
