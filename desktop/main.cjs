// Apple Silicon launcher. The existing Worker remains the data/API authority.
const { app, BrowserWindow, Menu, Notification, Tray, dialog, nativeImage, shell, ipcMain } = require("electron")
const fs = require("node:fs")
const path = require("node:path")
const os = require("node:os")
const { createRequire } = require("node:module")
const { resolveNode } = require("./node-runtime.cjs")
const { createLog } = require("./rotating-log.cjs")
const { Service, stopServices } = require("./service.cjs")

if (!app.requestSingleInstanceLock()) app.exit(0)
// Bound disposable HTTP cache separately from the user's captured library.
app.commandLine.appendSwitch("disk-cache-size", String(64 * 1024 * 1024))
function repoRoot() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, "repo.json"), "utf8")).root }
  catch { return path.resolve(__dirname, "..") }
}
const ROOT = repoRoot()
const fromRepo = createRequire(path.join(ROOT, "package.json"))
const development = process.argv.includes("--dev")
const PORT = Number(process.env.SNIP_DESKTOP_PORT || 5173)
const idleSeconds = Number(process.env.SNIP_WINDOW_IDLE_SECONDS ?? 120)
const idleMs = Number.isFinite(idleSeconds) && idleSeconds >= 0 ? idleSeconds * 1000 : 120000
const services = { web: new Service("web"), capture: new Service("capture") }
const labels = { web: "Web app", capture: "Capture agent" }
let tray, win, node, idleTimer, readyTimer
let quitting = false, finishedQuit = false, shutdown = null, autoCapture = true
let startupError = "", lastUrl = null, position = null
let resolvingNode = false
const uiState = Object.create(null)
const logs = new Set()

function isGallery(url) {
  try {
    const u = new URL(url)
    return services.web.url && u.origin === services.web.url && (u.pathname === "/" || u.pathname === "/guide" || /^\/r\/[^/]+$/.test(u.pathname))
  } catch { return false }
}
function trustedSender(event) {
  return win && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame && isGallery(event.senderFrame.url)
}
ipcMain.on("snip:ui-state", (event, { key, value } = {}) => {
  if (!trustedSender(event) || typeof key !== "string" || key.length > 150 || !key.startsWith("snip:")) return
  try {
    if (Buffer.byteLength(JSON.stringify(value)) > 16000) return
    if (!(key in uiState) && Object.keys(uiState).length >= 40) delete uiState[Object.keys(uiState)[0]]
    if (Buffer.byteLength(JSON.stringify({ ...uiState, [key]: value })) <= 48000) uiState[key] = value
  } catch {}
})
ipcMain.on("snip:position", (event, value) => {
  if (!trustedSender(event) || !value || value.url !== event.senderFrame.url || !Number.isFinite(value.y) || !Number.isFinite(value.x)) return
  position = { url: value.url, x: Math.max(0, value.x), y: Math.max(0, value.y) }
  lastUrl = value.url
})
ipcMain.on("snip:retry-capture", event => {
  if (trustedSender(event)) services.capture.send({ type: "snip:retry" })
})

function makeLog(key) {
  const log = createLog(path.join(app.getPath("logs"), `${key}.log`), { onError: error => console.error(`Could not write ${key} log: ${error.code || "I/O error"}`) })
  logs.add(log)
  log.write(`\n--- ${new Date().toISOString()} starting ${key} ---\n`)
  return { write: chunk => log.write(chunk), end: async chunk => { await log.end(chunk); logs.delete(log) } }
}
function start(key) {
  if (!node || quitting || shutdown || services[key].proc) return
  if (key === "capture" && services.web.status !== "running") return
  try {
    let args, cwd
    if (key === "web") {
      cwd = path.join(ROOT, "web")
      if (development) args = [path.join(ROOT, "node_modules/vite/bin/vite.js"), "--host", "localhost", "--port", String(PORT), "--strictPort"]
      else {
        if (!fs.existsSync(path.join(cwd, "dist/snip/wrangler.json"))) throw new Error("Build the web app first: npm run build -w web")
        args = [path.join(__dirname, "local-server.cjs"), ROOT, String(PORT)]
      }
    } else {
      cwd = path.join(ROOT, "capture")
      args = ["--import", fromRepo.resolve("tsx"), path.join(cwd, "src/index.ts")]
    }
    services[key].start({ executable: node.executable, args, cwd, env: node.env, log: makeLog(key), development: key === "web" && development })
    if (key === "web" && services.web.proc) {
      clearTimeout(readyTimer)
      readyTimer = setTimeout(() => {
        if (services.web.proc && services.web.status === "starting") {
          startupError = "The local server did not become ready. Check its log, then retry from the menu bar."
          services.web.forceStop()
          showLoading()
        }
      }, 60000)
    }
  } catch (error) {
    services[key].status = "crashed"
    services[key].detail = error.message
    if (key === "web") startupError = error.message
    showLoading()
    refresh()
  }
}

for (const [key, service] of Object.entries(services)) {
  let previous = service.status
  service.on("change", () => {
    if (key === "web") {
      if (service.status !== "starting") clearTimeout(readyTimer)
      if (service.status === "running" && previous !== "running") {
        startupError = ""
        if (win) void win.loadURL(isGallery(lastUrl) ? lastUrl : service.url).catch(() => {})
        if (autoCapture) start("capture")
      } else if (["stopped", "crashed"].includes(service.status) && !quitting) showLoading()
    }
    if (service.status === "crashed" && previous !== "crashed" && !quitting) {
      const note = new Notification({ title: `${labels[key]} stopped`, body: service.detail || "Open the log from the menu bar, then retry." })
      note.on("click", () => shell.openPath(path.join(app.getPath("logs"), `${key}.log`)))
      note.show()
    }
    previous = service.status
    refresh()
  })
}

function showLoading() {
  if (!win || win.isDestroyed() || quitting) return
  const s = services.web
  const msg = startupError || (s.status === "crashed" ? "The web app stopped. Check its log and retry from the menu bar." : s.status === "stopped" && node ? "The web app is stopped. Start it from the menu bar." : "Starting Snip…")
  const logo = require("node:url").pathToFileURL(path.join(ROOT, "web/public/logo.png")).href
  void win.loadFile(path.join(__dirname, "loading.html"), { query: { msg, logo } }).catch(() => {})
}
function openExternal(url) {
  try { if (["https:", "http:"].includes(new URL(url).protocol)) void shell.openExternal(url) } catch {}
}
function configureLinks(window) {
  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      if (services.web.url && new URL(url).origin === services.web.url) {
        if (isGallery(url)) { showApp(); void win.loadURL(url).catch(() => {}); return { action: "deny" } }
        const child = new BrowserWindow({ width: 1280, height: 860, autoHideMenuBar: true, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } })
        configureLinks(child)
        // Snapshot windows close normally. Minimized viewers release their
        // document after the same idle grace period and reload on restoration.
        let timer, suspendedUrl
        child.on("minimize", () => {
          clearTimeout(timer)
          if (idleMs) timer = setTimeout(() => {
            if (child.isDestroyed() || !child.isMinimized()) return
            suspendedUrl = child.webContents.getURL()
            void child.loadURL("about:blank").catch(() => {})
          }, idleMs)
        })
        child.on("restore", () => {
          clearTimeout(timer)
          if (suspendedUrl) { const restoreUrl = suspendedUrl; suspendedUrl = null; void child.loadURL(restoreUrl).catch(() => {}) }
        })
        child.on("closed", () => clearTimeout(timer))
        void child.loadURL(url).catch(() => {})
      } else openExternal(url)
    } catch {}
    return { action: "deny" }
  })
  window.webContents.on("will-navigate", (event, url) => {
    try {
      if (!services.web.url || new URL(url).origin !== services.web.url) { event.preventDefault(); openExternal(url) }
    } catch { event.preventDefault() }
  })
}
function createWindow() {
  const restore = Buffer.from(JSON.stringify({ values: uiState, position })).toString("base64")
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 720, minHeight: 480, title: "Snip", backgroundColor: "#f6f5f2",
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, preload: path.join(__dirname, "preload.cjs"), additionalArguments: [`--snip-ui-state=${restore}`] },
  })
  configureLinks(win)
  const current = win
  const isBackground = () => !current.isVisible() || current.isMinimized() || app.isHidden()
  const releaseWhenIdle = () => {
    clearTimeout(idleTimer)
    if (idleMs) idleTimer = setTimeout(async () => {
      if (win !== current || current.isDestroyed() || !isBackground()) return
      // Keep a dialog's unfinished input intact. Check only on idle transition,
      // not with a background polling timer.
      const editing = await current.webContents.executeJavaScript("!!document.querySelector('[role=dialog] input, [role=dialog] textarea')").catch(() => true)
      if (!editing && win === current && !current.isDestroyed() && isBackground()) current.destroy()
    }, idleMs)
  }
  const rememberUrl = (_event, url) => { if (isGallery(url)) lastUrl = url }
  win.webContents.on("did-navigate", rememberUrl)
  win.webContents.on("did-navigate-in-page", rememberUrl)
  win.on("close", event => {
    if (quitting) return
    event.preventDefault()
    current.hide()
    app.dock?.hide()
    releaseWhenIdle()
  })
  win.on("minimize", releaseWhenIdle)
  win.on("hide", releaseWhenIdle)
  win.on("blur", releaseWhenIdle)
  win.on("focus", () => clearTimeout(idleTimer))
  win.on("show", () => clearTimeout(idleTimer))
  win.on("restore", () => clearTimeout(idleTimer))
  win.on("closed", () => { if (win === current) win = null })
  if (services.web.url) void win.loadURL(isGallery(lastUrl) ? lastUrl : services.web.url).catch(() => {})
  else showLoading()
}
function showApp() {
  if (quitting) return
  clearTimeout(idleTimer)
  if (!win || win.isDestroyed()) createWindow()
  if (win.isMinimized()) win.restore()
  app.dock?.show()
  win.show()
  win.focus()
}

async function stopWeb() {
  if (shutdown || quitting) return
  autoCapture = false
  shutdown = stopServices(services.capture, services.web)
  refresh()
  try { await shutdown } finally { shutdown = null; refresh() }
}
async function forceQuit() {
  const { response } = await dialog.showMessageBox({ type: "warning", buttons: ["Keep finishing", "Force quit"], defaultId: 0, cancelId: 0, message: "Interrupt the current capture?", detail: "An unfinished capture may need to be retried when Snip starts again." })
  if (response !== 1) return
  quitting = true
  services.capture.forceStop()
  services.web.forceStop()
  finishedQuit = true
  app.exit(0)
}
const STATUS = { stopped: "Stopped", starting: "Starting…", running: "Running", connecting: "Connecting…", idle: "Ready", busy: "Capturing", disconnected: "Disconnected — retrying", stopping: "Finishing…", crashed: "Stopped (error)" }
function serviceItems(key) {
  const s = services[key]
  const items = [{ label: `${labels[key]}: ${STATUS[s.status]}`, enabled: false }]
  if (s.detail && s.status === "disconnected") items.push({ label: s.detail.slice(0, 100), enabled: false })
  if (s.proc && !s.stopping) items.push({ label: `Stop ${labels[key].toLowerCase()}`, enabled: !shutdown && !quitting, click: () => key === "web" ? void stopWeb() : (autoCapture = false, void s.stop()) })
  else if (!s.proc) items.push({ label: `Start ${labels[key].toLowerCase()}`, enabled: !!node && !shutdown && !quitting && (key === "web" || services.web.status === "running"), click: () => { autoCapture = true; start(key) } })
  if (key === "capture" && s.proc && !s.stopping) items.push({ label: "Check queue now", enabled: !quitting, click: () => s.send({ type: "snip:retry" }) })
  return items
}
function refresh() {
  if (!tray) return
  tray.setToolTip(quitting ? "Snip: finishing capture before quitting" : `Snip: ${STATUS[services.capture.status]}`)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open Snip", enabled: !quitting, click: showApp }, { type: "separator" },
    ...(!node ? [{ label: resolvingNode ? "Finding Node.js…" : "Retry setup", enabled: !resolvingNode && !quitting, click: () => void setup() }] : []),
    ...serviceItems("web"), { type: "separator" }, ...serviceItems("capture"), { type: "separator" },
    { label: "Show logs", click: () => shell.openPath(app.getPath("logs")) },
    ...(quitting || shutdown || services.capture.stopping ? [{ label: "Force quit Snip…", click: () => void forceQuit() }] : []),
    { label: quitting ? "Finishing capture before quitting…" : "Quit Snip", enabled: !quitting, accelerator: "Cmd+Q", click: () => app.quit() },
  ]))
}
app.on("second-instance", showApp)
app.on("activate", () => { if (app.isReady()) showApp() })
app.on("window-all-closed", () => {})
app.on("before-quit", event => {
  if (finishedQuit) return
  event.preventDefault()
  if (quitting) return
  quitting = true
  clearTimeout(idleTimer)
  clearTimeout(readyTimer)
  refresh()
  void (async () => {
    await (shutdown || stopServices(services.capture, services.web))
    await Promise.all([...logs].map(log => log.end()))
    finishedQuit = true
    app.exit(0)
  })()
})
async function setup() {
  if (resolvingNode || quitting) return
  resolvingNode = true
  startupError = ""
  refresh()
  try {
    if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error("SNIP_DESKTOP_PORT must be between 1 and 65535.")
    if (!fs.existsSync(path.join(ROOT, "node_modules"))) throw new Error(`Install Snip's dependencies with npm ci in ${ROOT}`)
    node = await resolveNode({ cacheFile: path.join(app.getPath("userData"), "node-path.json") })
    node.env = { ...node.env, PATH: [path.dirname(node.executable), node.env.PATH].filter(Boolean).join(path.delimiter), FORCE_COLOR: "0", NO_COLOR: "1", BROWSER: "none", WRANGLER_SEND_METRICS: "false", WRANGLER_WRITE_LOGS: "false" }
    if (!quitting) start("web")
  } catch (error) { startupError = error.message; showLoading() }
  finally { resolvingNode = false; refresh() }
}
app.whenReady().then(async () => {
  app.setName("Snip")
  if (process.platform !== "darwin" || process.arch !== "arm64" || Number(os.release().split(".")[0]) < 23) {
    dialog.showErrorBox("Snip", "Snip requires Apple Silicon and macOS 14 or later. Intel and Rosetta are not supported.")
    app.exit(1)
    return
  }
  const icon = nativeImage.createFromPath(path.join(ROOT, "web/public/favicon-32.png")).resize({ width: 18, height: 18 })
  tray = new Tray(icon)
  createWindow() // Never wait for shell initialization before displaying the UI.
  refresh()
  await setup()
})
