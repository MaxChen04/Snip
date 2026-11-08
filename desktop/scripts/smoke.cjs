// Real Apple Silicon Electron + built Worker + local D1/R2 + Chromium capture.
// All application state, credentials and captured pages belong to this fixture.
const assert = require("node:assert/strict")
const fs = require("node:fs/promises")
const path = require("node:path")
const os = require("node:os")
const http = require("node:http")
const { execFile } = require("node:child_process")
const { promisify } = require("node:util")
const { _electron } = require("playwright")
const run = promisify(execFile)
const ROOT = path.resolve(__dirname, "../..")
const desktop = path.join(ROOT, "desktop")
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check, message, timeout = 45000) {
  const start = Date.now()
  while (Date.now() - start < timeout) { if (await check()) return; await sleep(100) }
  throw new Error(message)
}
async function listen(server) {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })
  return server.address().port
}
async function processTree(pid) {
  const { stdout } = await run("ps", ["-axo", "pid=,ppid=,rss=,time="])
  const rows = stdout.trim().split("\n").map(line => {
    const [id, parent, rss, time] = line.trim().split(/\s+/)
    return { pid: +id, parent: +parent, rssKiB: +rss, time }
  })
  const ids = new Set([pid])
  for (let changed = true; changed;) {
    changed = false
    for (const row of rows) if (ids.has(row.parent) && !ids.has(row.pid)) { ids.add(row.pid); changed = true }
  }
  return rows.filter(row => ids.has(row.pid))
}

async function main() {
  assert.equal(process.platform, "darwin", "desktop smoke requires macOS")
  assert.equal(process.arch, "arm64", "desktop smoke requires Apple Silicon")
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "snip-desktop-smoke-"))
  const root = path.join(temp, "repo"), appDir = path.join(root, "desktop")
  let application, fixture
  const evidence = { checks: [], platform: `${os.release()}/${process.arch}`, node: process.version }
  const check = name => { evidence.checks.push(name); console.log("PASS", name) }
  try {
    await fs.mkdir(root, { recursive: true }); await fs.mkdir(appDir)
    for (const name of ["capture/src", "web/dist", "web/dist-settings", "web/migrations", "web/public"]) {
      // dist-settings exists only after `npm run build -w web`; older checkouts lack it.
      if (require("node:fs").existsSync(path.join(ROOT, name))) await fs.cp(path.join(ROOT, name), path.join(root, name), { recursive: true })
    }
    for (const name of ["package.json", "web/wrangler.jsonc"]) await fs.copyFile(path.join(ROOT, name), path.join(root, name))
    await fs.symlink(path.join(ROOT, "node_modules"), path.join(root, "node_modules"), "dir")
    for (const name of await fs.readdir(desktop)) if (name.endsWith(".cjs") || ["loading.html", "cloud-unreachable.html", "build.mjs", "install.mjs"].includes(name)) await fs.copyFile(path.join(desktop, name), path.join(appDir, name))
    await fs.cp(path.join(desktop, "assets"), path.join(appDir, "assets"), { recursive: true })
    await fs.symlink(path.join(desktop, "node_modules"), path.join(appDir, "node_modules"), "dir")
    await fs.writeFile(path.join(appDir, "repo.json"), JSON.stringify({ root }))
    const manifest = JSON.parse(await fs.readFile(path.join(desktop, "package.json"), "utf8"))
    await fs.writeFile(path.join(appDir, "package.json"), JSON.stringify({ ...manifest, main: "bootstrap.cjs" }))
    await fs.writeFile(path.join(appDir, "bootstrap.cjs"), `const {app}=require('electron');app.setPath('userData',${JSON.stringify(path.join(temp, "profile"))});app.setPath('logs',${JSON.stringify(path.join(temp, "logs"))});require('./main.cjs');`)
    const reservation = http.createServer()
    const port = await listen(reservation)
    await new Promise(resolve => reservation.close(resolve))
    const origin = `http://localhost:${port}`
    await fs.writeFile(path.join(root, "web/.dev.vars"), `DEV_LOGIN=reviewer\nSESSION_SECRET=synthetic-local-session\nCAPTURE_TOKEN=synthetic-capture-token\nPUBLIC_URL=${origin}\n`)
    await fs.writeFile(path.join(root, "capture/.env"), `SNIP_URL=${origin}\nCAPTURE_TOKEN=synthetic-capture-token\nBROWSER_IDLE_SECONDS=2\nPOLL_SECONDS=1\nSCROLL_MAX_FRAMES=20\nSHEET_FRAMES=3\nSHEET_WIDTH=600\nALLOW_PRIVATE_URLS=true\n`)
    const env = { ...process.env, SNIP_DESKTOP_PORT: String(port), SNIP_WINDOW_IDLE_SECONDS: "1", WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: path.join(temp, "wrangler.log") }
    for (const key of ["ELECTRON_RUN_AS_NODE", "SNIP_URL", "CAPTURE_TOKEN", "DEV_LOGIN"]) delete env[key]
    await run(process.execPath, [path.join(ROOT, "node_modules/wrangler/bin/wrangler.js"), "d1", "migrations", "apply", "snip", "--local", "--config", path.join(root, "web/wrangler.jsonc"), "--persist-to", path.join(root, "web/.wrangler/state")], { cwd: root, env })
    fixture = http.createServer((req, res) => {
      const send = () => { res.setHeader("content-type", "text/html"); res.end('<!doctype html><html><head><title>Snip owned fixture</title><style>body{margin:0;font-family:Arial}h1{padding:40px}section{height:1600px;background:linear-gradient(#eee,#aac)}button{margin:20px;padding:15px;transition:transform .2s}button:hover{transform:scale(1.1)}</style></head><body><h1>Owned capture fixture</h1><button>Example</button><section>Scroll content</section></body></html>') }
      if (req.url === "/slow") setTimeout(send, 6500); else send()
    })
    const fixturePort = await listen(fixture)
    // Exercise the actual packager/signing path. An unpackaged launch can hide
    // failures when native Node tries to execute a helper inside app.asar.
    const packaged = path.join(temp, "packaged")
    await run(process.execPath, [path.join(appDir, "build.mjs"), "--no-install", "--out", packaged], { cwd: root, env })
    const bundle = path.join(packaged, "Snip-darwin-arm64/Snip.app")
    await run("codesign", ["--verify", "--deep", "--strict", bundle])
    application = await _electron.launch({ executablePath: path.join(bundle, "Contents/MacOS/Snip"), args: [], env, timeout: 30000 })
    // Native macOS runners may leave a launched app behind another window.
    // Exercise visible controls in the foreground without disabling the real
    // background throttling that the idle checks below are meant to verify.
    const foreground = () => application.evaluate(({ app }) => { app.emit("activate"); app.focus({ steal: true }) })
    await foreground()
    let page = await application.firstWindow()
    page.setDefaultTimeout(15000)
    page.on("pageerror", error => console.error("renderer:", error.message))
    await page.waitForURL(`${origin}/`, { timeout: 30000 })
    await until(async () => (await page.evaluate(() => fetch("/api/me").then(r => r.json()))).login === "reviewer", "local auth failed")
    check("normal-mode Electron loads the built gallery and local API")
    const added = await page.evaluate(async url => {
      const ref = await fetch("/api/references", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url, mode: "single" }) }).then(r => r.json())
      window.snipDesktop.checkQueue()
      return ref
    }, `http://127.0.0.1:${fixturePort}/`)
    let detail
    await until(async () => {
      detail = await page.evaluate(id => fetch(`/api/references/${id}`).then(r => r.json()), added.id)
      if (detail.reference.status === "failed") throw new Error(`Capture failed: ${detail.reference.error}`)
      return detail.reference.status === "ready"
    }, "capture did not complete", 90000)
    assert.ok(detail.pages.length)
    const image = await page.evaluate(key => fetch(`/files/${key}`).then(async r => ({ status: r.status, bytes: (await r.arrayBuffer()).byteLength })), detail.pages[0].desktopKey)
    assert.equal(image.status, 200); assert.ok(image.bytes > 100)
    check("real Chromium capture stores retrievable screenshots in local R2")
    await foreground()
    await page.goto(`${origin}/r/${added.id}`)
    await page.getByRole("button", { name: "Select", exact: true }).click()
    await page.getByRole("checkbox").first().click()
    const selected = await page.getByRole("checkbox").first().getAttribute("aria-checked")
    assert.equal(selected, "true")
    await page.evaluate(() => window.scrollTo(0, 150))
    await sleep(350)
    evidence.visible = await processTree(application.process().pid)
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    await until(async () => await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length) === 0, "hidden renderer was retained")
    // Reach the 30-second steady-state queue interval and let Chromium exit.
    await sleep(35000)
    evidence.hidden = await processTree(application.process().pid)
    await sleep(30000)
    evidence.hiddenAfter30Seconds = await processTree(application.process().pid)
    evidence.hiddenMetrics = await application.evaluate(({ app }) => app.getAppMetrics().map(({ type, memory, cpu }) => ({ type, memory, cpu })))
    assert.equal(evidence.hiddenMetrics.some(item => item.type === "Tab"), false)
    check("hidden gallery renderer is released while the background worker remains available")
    await foreground()
    page = await application.firstWindow()
    page.setDefaultTimeout(15000)
    await page.waitForURL(`${origin}/r/${added.id}`)
    await until(async () => await page.getByRole("checkbox").first().getAttribute("aria-checked") === "true", "selection was lost")
    check("reopening restores the selected page and reference route")
    await page.goto(`${origin}/r/${added.id}?tab=animations`)
    await page.getByRole("heading", { name: /^Scroll/ }).waitFor()
    await page.goto(`${origin}/r/${added.id}?page=${detail.pages[0].id}`)
    // The viewer sidebar starts hidden in narrow windows; the HTML tab holds the snapshot.
    const showSidebar = page.getByRole("button", { name: "Show sidebar" })
    await page.getByRole("button", { name: /^(Show|Hide) sidebar$/ }).waitFor()
    if (await showSidebar.isVisible()) await showSidebar.click()
    await page.getByRole("tab", { name: "HTML", exact: true }).click()
    await page.getByText(/^Snapshot · /).waitFor()
    const snapshot = application.waitForEvent("window")
    await page.locator(`a[href="/files/${detail.pages[0].snapshotKey}"]`).click()
    const viewer = await snapshot
    await viewer.waitForURL(`${origin}/files/${detail.pages[0].snapshotKey}`)
    assert.equal(await viewer.evaluate(() => typeof window.snipDesktop), "undefined")
    assert.ok(page.url().includes(`/r/${added.id}`))
    await viewer.close()
    await foreground()
    check("fresh page and animation links take precedence, and snapshots open separately without desktop privileges")
    const slow = await page.evaluate(async url => {
      const ref = await fetch("/api/references", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url, mode: "single" }) }).then(r => r.json())
      window.snipDesktop.checkQueue(); return ref
    }, `http://127.0.0.1:${fixturePort}/slow`)
    await until(async () => (await page.evaluate(id => fetch(`/api/references/${id}`).then(r => r.json()), slow.id)).reference.status === "capturing", "slow capture not claimed")
    const tracked = await processTree(application.process().pid)
    const quitStart = Date.now()
    const closing = application.close()
    await sleep(5500)
    assert.equal(application.process().exitCode, null, "quit killed a capture after five seconds")
    await closing
    application = null
    assert.ok(Date.now() - quitStart > 5500)
    await until(() => tracked.every(({ pid }) => { try { process.kill(pid, 0); return false } catch { return true } }), "child processes survived quit", 10000)
    // Read the persisted DB through the same no-watch server after app exit.
    const { fork } = require("node:child_process")
    const backend = fork(path.join(appDir, "local-server.cjs"), [root, "0"], { env, stdio: ["ignore", "ignore", "ignore", "ipc"] })
    try {
      const ready = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("backend restart timed out")), 30000)
        backend.on("message", message => { clearTimeout(timer); message.type === "snip:web-ready" ? resolve(message.url) : reject(new Error("backend restart failed")) })
        backend.on("exit", () => { clearTimeout(timer); reject(new Error("backend exited")) })
      })
      const result = await fetch(`${ready}/api/references/${slow.id}`).then(r => r.json())
      assert.equal(result.reference.status, "ready")
      assert.ok(result.pages.length)
      backend.send({ type: "snip:stop" })
      await new Promise(resolve => backend.once("exit", resolve))
    } finally { if (backend.exitCode === null) backend.kill("SIGKILL") }
    check("quit drains a capture longer than five seconds before stopping its API; no children survive")
    await fs.writeFile(path.join(temp, "evidence.json"), JSON.stringify(evidence, null, 2))
    console.log(`Evidence: ${temp}/evidence.json`)
  } catch (error) {
    console.error(`Fixture retained for diagnosis: ${temp}`)
    await fs.writeFile(path.join(temp, "evidence.json"), JSON.stringify(evidence, null, 2))
    if (application) {
      console.error("NATIVE WINDOWS", await application.evaluate(({ app, BrowserWindow }) => ({ hidden: app.isHidden(), windows: BrowserWindow.getAllWindows().map(window => ({ visible: window.isVisible(), minimized: window.isMinimized(), focused: window.isFocused() })) })).catch(() => "unavailable"))
      for (const page of application.windows()) {
        console.error("WINDOW", page.url(), await page.evaluate(() => ({ visibility: document.visibilityState, focused: document.hasFocus() })).catch(() => "unavailable"), await page.locator("body").innerText().catch(() => "unavailable"))
      }
    }
    for (const name of ["web", "capture"]) console.error(await fs.readFile(path.join(temp, "logs", `${name}.log`), "utf8").catch(() => ""))
    throw error
  } finally {
    if (application) await application.close().catch(() => {})
    if (fixture) await new Promise(resolve => fixture.close(resolve))
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
