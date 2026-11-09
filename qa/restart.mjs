// node qa/restart.mjs <ch>  — J8 (restart with same profile) and, if both apps are up, J9 (isolation)
import fs from "node:fs"
import path from "node:path"
import { execFileSync, spawnSync } from "node:child_process"
import { CHANNELS, origin, startApp, stopApp, waitHttp, readPid, alive, connect, QA, sleep, tree, du } from "./lib.mjs"
const [ch, only = "j8,j9"] = process.argv.slice(2)
const c = CHANNELS[ch]
const get = async (p) => (await fetch(origin(ch) + "/api" + p)).json()
const d1 = () => { const dir = path.join(c.state, "v3/d1/miniflare-D1DatabaseObject"); const f = fs.readdirSync(dir).find((x) => x.endsWith(".sqlite") && x !== "metadata.sqlite"); return path.join(dir, f) }
const sql = (q) => execFileSync("sqlite3", ["-readonly", d1(), q], { encoding: "utf8" }).trim()
const out = { ch }
const snap = async () => ({
  refs: (await get("/references?limit=100")).items.map((r) => r.id + ":" + r.status).sort(),
  counts: await get("/counts"), collections: (await get("/collections")).map((x) => x.name + ":" + x.id),
  migrations: sql("select name||'@'||applied_at from d1_migrations order by id"), migrationNames: sql("select name from d1_migrations order by id").split("\n"),
  backups: fs.existsSync(path.join(c.library, "backups")) ? fs.readdirSync(path.join(c.library, "backups")) : fs.existsSync(path.join(c.library, "../backups")) ? "n/a" : [],
  r2Files: Number(execFileSync("sh", ["-c", `find "${c.state}/v3/r2" -type f | wc -l`], { encoding: "utf8" })),
  creds: fs.existsSync(path.join(c.library, "web/.dev.vars")) ? fs.readFileSync(path.join(c.library, "web/.dev.vars"), "utf8").length : null,
})
if (only.includes("j8")) {
  // make a board + note + a localStorage preference so there is something to persist
  const b = await (await fetch(origin(ch) + "/api/collections", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Persist board" }) })).json()
  await fetch(origin(ch) + `/api/boards/${b.id}/notes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "persist me", x: 10, y: 10 }) }).then((r) => (out.noteStatus = r.status))
  let { browser, page } = await connect(ch)
  await page.evaluate(() => { localStorage.setItem("qa.pref", "kept"); localStorage.setItem("snip.viewer.scheme", "dark") }); await browser.close()
  const before = await snap(); out.before = before
  const t = Date.now(); const stop = await stopApp(ch); out.stop = stop
  out.leftoverChildren = readPid(ch) && alive(readPid(ch))
  const pid = startApp(ch, { SNIP_WINDOW_IDLE_SECONDS: "0" }); const t1 = Date.now()
  await waitHttp(origin(ch) + "/api/me"); out.restartReadyMs = Date.now() - t1
  const after = await snap(); out.after = after
  out.same = Object.fromEntries(Object.keys(before).map((k) => [k, JSON.stringify(before[k]) === JSON.stringify(after[k])]))
  ;({ browser, page } = await connect(ch))
  out.localStorage = await page.evaluate(() => [localStorage.getItem("qa.pref"), localStorage.getItem("snip.viewer.scheme")])
  const bd = await (await fetch(origin(ch) + `/api/boards/${b.id}`)).json(); out.boardAfter = { status: 200, notes: bd.notes?.length, items: bd.items?.length }
  await browser.close()
  const log = fs.readFileSync(path.join(c.logs, "web.log"), "utf8"); out.webLogErrors = log.split("\n").filter((l) => /error|fail/i.test(l) && !/CIMD/.test(l)).slice(-5)
  out.migrationCounts = sql("select name,count(*) from d1_migrations group by name").split("\n")
}
if (only.includes("j9")) {
  const other = ch === "stable" ? "dev" : "stable"
  out.j9 = { both: alive(readPid("stable")) && alive(readPid("dev")) }
  if (out.j9.both) {
    const listen = execFileSync("sh", ["-c", `lsof -nP -iTCP -sTCP:LISTEN | grep -E ":(5373|5383)" | awk '{print $1,$2,$9}' | sort -u`], { encoding: "utf8" }).trim().split("\n")
    out.j9.listeners = listen
    out.j9.counts = { stable: await (await fetch(origin("stable") + "/api/counts")).json(), dev: await (await fetch(origin("dev") + "/api/counts")).json() }
    out.j9.libraryDirs = { stable: CHANNELS.stable.state, dev: CHANNELS.dev.state, distinct: CHANNELS.stable.state !== CHANNELS.dev.state }
    out.j9.locks = ["stable", "dev"].map((x) => { try { return x + ": " + fs.readlinkSync(path.join(CHANNELS[x].profile, "SingletonLock")) } catch { return x + ": none" } })
    // single-instance lock: a second copy on the SAME profile must exit quickly and leave the first untouched
    const t = Date.now(); const r = spawnSync(CHANNELS.dev.exe, [], { env: { ...process.env, SNIP_DESKTOP_PROFILE: CHANNELS.dev.profile, SNIP_DESKTOP_PORT: "5383" }, timeout: 20000 })
    out.j9.secondDevInstance = { exitStatus: r.status, signal: r.signal, ms: Date.now() - t, firstStillUp: (await fetch(origin("dev") + "/api/me")).status }
  }
}
fs.writeFileSync(path.join(QA, "out", `j8j9-${ch}.json`), JSON.stringify(out, null, 1))
console.log(JSON.stringify(out, null, 1))
