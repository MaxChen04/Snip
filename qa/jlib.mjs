import fs from "node:fs"
import path from "node:path"
import { connect, CHANNELS, origin, QA, sleep, du } from "./lib.mjs"
export { sleep }
export async function session(ch) {
  const { browser, page } = await connect(ch)
  const c = CHANNELS[ch]
  const results = []
  const errors = { console: [], failed: [], dialogs: [] }
  page.on("console", (m) => { if (m.type() === "error") errors.console.push(m.text().slice(0, 300)) })
  page.on("pageerror", (e) => errors.console.push("pageerror: " + e.message.slice(0, 300)))
  page.on("requestfailed", (r) => errors.failed.push(`${r.method()} ${r.url().replace(origin(ch), "")} ${r.failure()?.errorText}`))
  page.on("response", (r) => { if (r.status() >= 400 && r.url().startsWith(origin(ch))) errors.failed.push(`${r.status()} ${r.request().method()} ${r.url().replace(origin(ch), "")}`) })
  let dialogMode = "accept"
  page.on("dialog", async (d) => { errors.dialogs.push(`${d.type()}: ${d.message()}`); dialogMode === "accept" ? await d.accept() : await d.dismiss() })
  const logSize = () => ["web", "capture"].map((n) => { try { return fs.readFileSync(path.join(c.logs, n + ".log"), "utf8").length } catch { return 0 } })
  const logTail = (from) => ["web", "capture"].flatMap((n, i) => { try { return fs.readFileSync(path.join(c.logs, n + ".log"), "utf8").slice(from[i]).split("\n").filter((l) => /error|exception|fail|ERR_|unhandled|TypeError/i.test(l) && !/CIMD/.test(l)).map((l) => `[${n}] ${l.slice(0, 250)}`) } catch { return [] } })
  const S = {
    ch, page, browser, c, results, errors, origin: origin(ch),
    setDialog: (m) => (dialogMode = m),
    api: (p, method = "GET", body) => page.evaluate(async ([p, method, body]) => {
      const r = await fetch("/api" + p, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined })
      let j = null; try { j = await r.json() } catch {}
      return { status: r.status, body: j }
    }, [p, method, body]),
    shot: async (name) => { const f = path.join(QA, "shots", `${ch}-${name}.png`); await page.screenshot({ path: f }).catch(() => {}); return `qa/shots/${ch}-${name}.png` },
    goto: async (p = "/") => { await page.goto(origin(ch) + p); await page.waitForLoadState("domcontentloaded"); await sleep(800) },
    async J(name, fn) {
      const e0 = { console: errors.console.length, failed: errors.failed.length, dialogs: errors.dialogs.length }, l0 = logSize()
      const t = Date.now(); const rec = { journey: name, status: "pass", notes: [], shots: [] }
      const note = (s) => rec.notes.push(s)
      const fail = (s) => { rec.status = "fail"; rec.notes.push("FAIL: " + s) }
      try { await fn({ note, fail, shot: async (n) => rec.shots.push(await S.shot(n)) }) } catch (e) { fail("exception: " + e.message.split("\n")[0]); rec.shots.push(await S.shot("exc-" + name.split(" ")[0])) }
      rec.secs = (Date.now() - t) / 1000
      rec.console = errors.console.slice(e0.console); rec.failedRequests = errors.failed.slice(e0.failed); rec.dialogs = errors.dialogs.slice(e0.dialogs); rec.serverLog = logTail(l0)
      results.push(rec); console.log(`[${ch}] ${rec.status.toUpperCase()} ${name} (${rec.secs}s)`, rec.notes.filter((n) => n.startsWith("FAIL")).join(" | "))
      fs.writeFileSync(path.join(QA, "out", `journeys-${ch}-${S.tag || "run"}.json`), JSON.stringify(results, null, 1))
      return rec
    },
    async waitRef(id, ms = 240000, until = ["ready", "failed", "stopped"]) {
      const t = Date.now(); const timeline = []
      while (Date.now() - t < ms) {
        const r = await S.api(`/references/${id}`)
        const st = r.body?.reference?.status, n = r.body?.pages?.length ?? 0
        if (!timeline.length || timeline.at(-1).st !== st || timeline.at(-1).n !== n) timeline.push({ s: Math.round((Date.now() - t) / 1000), st, n })
        if (until.includes(st)) return { status: st, pages: n, timeline, detail: r.body }
        await sleep(1500)
      }
      return { status: "timeout", timeline }
    },
  }
  return S
}
export const diskMB = (ch) => ({ profile: du(CHANNELS[ch].profile), library: du(CHANNELS[ch].library) })
