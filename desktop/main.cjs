// Apple Silicon launcher. The existing Worker remains the data/API authority.
const { app, BrowserWindow, Menu, Notification, Tray, dialog, nativeImage, shell, ipcMain, autoUpdater, powerMonitor, protocol, session, nativeTheme, safeStorage } = require("electron")
const fs = require("node:fs")
const path = require("node:path")
const os = require("node:os")
const { createRequire } = require("node:module")
const { resolveNode } = require("./node-runtime.cjs")
const { createLog } = require("./rotating-log.cjs")
const { Service, stopServices } = require("./service.cjs")
const { Updates } = require("./updates.cjs")
const { channelConfig } = require("./channels.cjs")
const { SourceUpdates } = require("./source-updates.cjs")
const { prepareRuntimeLayout, selectExistingLibrary } = require("./runtime-layout.cjs")
const windowOrigin = require("./window-origin.cjs")
const { readCloudState, cloudMode, selectCaptureEnvFile, keepLocalCaptureEnv } = require("./cloud-state.cjs")
const { engineAvailable, runEngine, cloudFlags } = require("./cloud-engine.cjs")
const { sessionCookie, externalUrl } = require("./cloud-session.cjs")
const { snapshotFlags } = require("./cloud-confirm.cjs")
const { ownerLinkFrom, LINK_NOTE, LINK_TTL_MS } = require("./cloud-link.cjs")
const { resolveSettingsAsset, contentType, settingsCsp, settingsUrl, SETTINGS_ORIGIN } = require("./settings-assets.cjs")

// Settings is a static Vite bundle served from the app, so it keeps working while the
// local Worker is stopped or the app is in cloud mode. Standard+secure makes ES
// modules, CSS and navigator.clipboard behave exactly as they do over HTTP.
protocol.registerSchemesAsPrivileged([{ scheme: "snip", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }])

// Resolve the channel before Electron chooses cookies, locks, logs or settings.
const releaseFile = path.join(__dirname, "release.json")
const releaseBuild = app.isPackaged && fs.existsSync(releaseFile)
const releaseConfig = releaseBuild ? JSON.parse(fs.readFileSync(releaseFile, "utf8")) : null
let sourceConfig = {}
try { sourceConfig = JSON.parse(fs.readFileSync(path.join(__dirname, "repo.json"), "utf8")) } catch {}
const development = !releaseBuild && process.argv.includes("--dev")
const channel = releaseConfig?.channel ?? (development ? "nightly" : sourceConfig.channel ?? "stable")
const identity = channelConfig(channel)
const nightly = channel === "nightly"
const ROOT = releaseBuild ? path.join(process.resourcesPath, "runtime") : sourceConfig.root ?? path.resolve(__dirname, "..")
const fromRepo = createRequire(path.join(ROOT, "package.json"))
if (nightly) {
  app.setName(identity.name)
  app.setPath("userData", path.join(app.getPath("appData"), identity.name))
}
// Explicit alternate profiles support isolated acceptance tests.
if (process.env.SNIP_DESKTOP_PROFILE) {
  if (!path.isAbsolute(process.env.SNIP_DESKTOP_PROFILE)) throw new Error("SNIP_DESKTOP_PROFILE must be an absolute path.")
  app.setPath("userData", process.env.SNIP_DESKTOP_PROFILE)
}
if (nightly || process.env.SNIP_DESKTOP_PROFILE) {
  app.setPath("sessionData", app.getPath("userData"))
  app.setPath("logs", path.join(app.getPath("userData"), "logs"))
}
if (!app.requestSingleInstanceLock()) app.exit(0)
app.commandLine.appendSwitch("disk-cache-size", String(64 * 1024 * 1024))
const PORT = Number(process.env.SNIP_DESKTOP_PORT || identity.port)
const idleSeconds = Number(process.env.SNIP_WINDOW_IDLE_SECONDS ?? 120)
const idleMs = Number.isFinite(idleSeconds) && idleSeconds >= 0 ? idleSeconds * 1000 : 120000
const services = { web: new Service("web"), capture: new Service("capture") }
const labels = { web: "Web app", capture: "Capture agent" }
let tray, win, node, idleTimer, readyTimer, layout, updates, sourceUpdates
let quitting = false, finishedQuit = false, shutdown = null, autoCapture = true
let startupError = "", lastUrl = null, position = null
let resolvingNode = false
let settingsWin = null, cloudState = null
let cloudRun = null, cloudResult = null
// The owner link is minted for a person to open in another browser, so it is the one
// URL that belongs in the renderer. It lives in memory only, and never in a log.
let ownerLink = null
const pins = new WeakMap()
const cloudInput = new Map()
let localLibrary = { at: 0, value: null }
const uiState = Object.create(null)
const logs = new Set()
const windowStateFile = path.join(app.getPath("userData"), "window-state.json")
try {
  if (fs.statSync(windowStateFile).size <= 64000) {
    const saved = JSON.parse(fs.readFileSync(windowStateFile, "utf8"))
    for (const [key, value] of Object.entries(saved.values ?? {}).slice(0, 40)) {
      if (key.startsWith("snip:") && key.length <= 150 && Buffer.byteLength(JSON.stringify(value)) <= 16000) uiState[key] = value
    }
    if (typeof saved.lastUrl === "string") lastUrl = saved.lastUrl
    if (saved.position && typeof saved.position.url === "string" && Number.isFinite(saved.position.x) && Number.isFinite(saved.position.y)) position = saved.position
  }
} catch {} // A corrupt view-state cache must not prevent opening the library.

const mode = () => cloudMode(cloudState)
function cloudOrigin() {
  try { return cloudState?.cloud?.url ? new URL(cloudState.cloud.url).origin : null } catch { return null }
}
function isGallery(url) {
  return windowOrigin.isGallery(url, services.web.url)
}
function isCloudRoute(url) {
  return windowOrigin.isAppRoute(url, cloudOrigin())
}
function pinWindow(window, pin) {
  pins.set(window, { role: pin.role, origin: pin.origin })
}
function trustedSenderFor(event, window) {
  return windowOrigin.trustedSender({
    pin: window && !window.isDestroyed() ? pins.get(window) : null,
    localOrigin: services.web.url,
    senderMatches: !!window && !window.isDestroyed() && event.sender === window.webContents,
    frameIsMain: !!window && !window.isDestroyed() && !!event.senderFrame && event.senderFrame === window.webContents.mainFrame,
    frameUrl: event.senderFrame?.url,
  })
}
function trustedSender(event) {
  return trustedSenderFor(event, win)
}
function trustedSettingsSender(event) {
  return trustedSenderFor(event, settingsWin)
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
/** Cloud mode points the capture agent at the cloud queue; local mode at this Mac. */
function captureEnvFile() {
  if (!layout) return null
  return selectCaptureEnvFile({ dataRoot: layout.dataRoot, mode: mode() })
}
function start(key) {
  if (!node || quitting || shutdown || services[key].proc) return
  if (key === "web" && mode() === "cloud") return
  if (key === "capture" && mode() !== "cloud" && services.web.status !== "running") return
  try {
    let args, cwd
    if (key === "web") {
      cwd = path.join(ROOT, "web")
      if (development) args = [path.join(__dirname, "dev-server.cjs"), ROOT, String(PORT), layout.dataRoot]
      else {
        if (!fs.existsSync(path.join(cwd, "dist/snip/wrangler.json"))) throw new Error("Build the web app first: npm run build -w web")
        args = [path.join(__dirname, "local-server.cjs"), ROOT, String(PORT), layout.dataRoot, ...(releaseBuild || nightly ? ["release"] : [])]
      }
    } else {
      cwd = path.join(ROOT, "capture")
      // A small young generation keeps the agent's memory near its live data; screenshots churn hundreds of MB.
      args = ["--max-semi-space-size=4", "--import", fromRepo.resolve("tsx"), path.join(cwd, "src/index.ts")]
    }
    const env = key === "capture" && captureEnvFile() ? { ...node.env, SNIP_CAPTURE_ENV_FILE: captureEnvFile().path } : node.env
    services[key].start({ executable: node.executable, args, cwd, env, log: makeLog(key) })
    if (key === "web" && services.web.proc) {
      clearTimeout(readyTimer)
      readyTimer = setTimeout(() => {
        if (services.web.proc && services.web.status === "starting") {
          startupError = "The local server did not become ready. Check its log, then retry from the menu bar."
          services.web.forceStop()
          showLoading()
        }
      }, releaseBuild || nightly ? 300000 : 60000)
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
        if (win && mode() !== "cloud") {
          // The first window is created before the local origin is known, so its pin
          // starts empty. Adopt the origin we are about to load, once.
          const pin = pins.get(win)
          if (pin?.role === "local" && !pin.origin) pinWindow(win, { role: "local", origin: service.url })
          void win.loadURL(isGallery(lastUrl) ? lastUrl : service.url).catch(() => {})
        }
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
  if (!win || win.isDestroyed() || quitting || mode() === "cloud") return
  const s = services.web
  const msg = startupError || (s.status === "crashed" ? s.detail || "The web app stopped. Check its log and retry from the menu bar." : s.status === "stopped" && node ? "The web app is stopped. Start it from the menu bar." : "Starting Snip…")
  const logo = require("node:url").pathToFileURL(path.join(ROOT, "web/public/logo.png")).href
  void win.loadFile(path.join(__dirname, "loading.html"), { query: { msg, logo } }).catch(() => {})
}
/** Cloud mode never falls back to the empty local library; it says what happened. */
function showCloudUnreachable(description = "") {
  if (!win || win.isDestroyed() || quitting) return
  const logo = require("node:url").pathToFileURL(path.join(ROOT, "web/public/logo.png")).href
  void win.loadFile(path.join(__dirname, "cloud-unreachable.html"), { query: { url: cloudState?.cloud?.url ?? "", detail: String(description).slice(0, 200), logo } }).catch(() => {})
}
function openExternal(url) {
  const safe = externalUrl(url)
  if (safe) void shell.openExternal(safe)
}
function configureLinks(window, pin) {
  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      if (windowOrigin.isSettingsUrl(url)) { openSettings(); return { action: "deny" } }
      if (pin.origin && windowOrigin.originOf(url) === pin.origin) {
        if (pin.role === "local" && isGallery(url)) { showApp(); void win.loadURL(url).catch(() => {}); return { action: "deny" } }
        const child = new BrowserWindow({ width: 1280, height: 860, autoHideMenuBar: true, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } })
        configureLinks(child, pin)
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
    if (windowOrigin.isSettingsUrl(url)) { event.preventDefault(); openSettings(); return }
    if (!windowOrigin.allowsNavigation(pin, url)) { event.preventDefault(); openExternal(url) }
  })
}
function createWindow() {
  const cloud = mode() === "cloud"
  const target = cloud ? cloudState?.cloud?.url ?? null : services.web.url
  const pin = { role: cloud ? "cloud" : "local", origin: windowOrigin.originOf(target) }
  const restore = Buffer.from(JSON.stringify({ values: uiState, position })).toString("base64")
  const webPreferences = { contextIsolation: true, sandbox: true, nodeIntegration: false }
  // The cloud window gets no preload on purpose: the bridge only exists on pages we ship.
  if (!cloud) Object.assign(webPreferences, { preload: path.join(__dirname, "preload.cjs"), additionalArguments: [`--snip-ui-state=${restore}`] })
  win = new BrowserWindow({ width: 1280, height: 860, minWidth: 720, minHeight: 480, title: identity.name, backgroundColor: "#f6f5f2", webPreferences })
  if (nightly) win.on("page-title-updated", event => { event.preventDefault(); win.setTitle("Snip Dev — Test library") })
  pinWindow(win, pin)
  configureLinks(win, pin)
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
  const rememberUrl = (_event, url) => { if (pin.role === "cloud" ? isCloudRoute(url) : isGallery(url)) lastUrl = url }
  win.webContents.on("did-navigate", rememberUrl)
  win.webContents.on("did-navigate-in-page", rememberUrl)
  win.webContents.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
    // -3 is an aborted load (a redirect or a deliberate navigation), not a failure.
    if (!isMainFrame || code === -3 || pin.role !== "cloud") return
    showCloudUnreachable(description)
  })
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
  if (pin.role === "cloud") {
    if (target) void win.loadURL(isCloudRoute(lastUrl) ? lastUrl : target).catch(() => showCloudUnreachable())
    else showCloudUnreachable("No cloud library address is recorded.")
  } else if (services.web.url) void win.loadURL(isGallery(lastUrl) ? lastUrl : services.web.url).catch(() => {})
  else showLoading()
}
function recreateWindow() {
  if (win && !win.isDestroyed()) {
    const old = win
    win = null
    old.destroy()
  }
  createWindow()
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

// ---------- Settings window ----------

const SETTINGS_DIR = [path.join(__dirname, "settings"), path.join(ROOT, "web/dist-settings")].find(dir => fs.existsSync(path.join(dir, "index.html"))) ?? path.join(__dirname, "settings")
const SETTINGS_CSP = settingsCsp()
function serveSettings() {
  protocol.handle("snip", async request => {
    const file = resolveSettingsAsset(SETTINGS_DIR, request.url)
    if (!file) return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } })
    try {
      const body = await fs.promises.readFile(file)
      return new Response(body, { headers: { "content-type": contentType(file), "cache-control": "no-store", "content-security-policy": SETTINGS_CSP } })
    } catch {
      return new Response("Not found", { status: 404 })
    }
  })
}
function createSettingsWindow() {
  if (!fs.existsSync(path.join(SETTINGS_DIR, "index.html"))) {
    void dialog.showMessageBox({ type: "warning", message: "Settings isn’t built", detail: "Run npm run build -w web to build the Settings window, then try again." })
    return null
  }
  settingsWin = new BrowserWindow({
    width: 760, height: 760, minWidth: 560, minHeight: 480, title: `${identity.name} Settings`, show: false,
    titleBarStyle: "hiddenInset", trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#111110" : "#f6f5f2",
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, preload: path.join(__dirname, "preload-settings.cjs") },
  })
  pinWindow(settingsWin, { role: "settings", origin: SETTINGS_ORIGIN })
  const current = settingsWin
  // Settings has no links of its own; anything else belongs in the browser.
  current.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: "deny" } })
  current.webContents.on("will-navigate", (event, url) => {
    if (!windowOrigin.isSettingsUrl(url)) { event.preventDefault(); openExternal(url) }
  })
  current.once("ready-to-show", () => { if (!current.isDestroyed()) { current.show(); current.focus() } })
  current.on("closed", () => { if (settingsWin === current) settingsWin = null })
  void current.loadURL(settingsUrl()).catch(() => {})
  return current
}
function openSettings() {
  if (quitting) return
  if (settingsWin && !settingsWin.isDestroyed()) {
    if (settingsWin.isMinimized()) settingsWin.restore()
    settingsWin.show()
    settingsWin.focus()
    return
  }
  createSettingsWindow()
}

// ---------- Cloud mode ----------

function sendToSettings(channel, payload) {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send(channel, payload)
}
/** The local library's size, for the confirmation sheet. Never in cloud mode. */
async function localLibraryStatus() {
  const cached = localLibrary.value
  if (cached && Date.now() - localLibrary.at < 5000) return cached
  const origin = services.web.url
  if (mode() === "cloud" || !origin) return { reachable: false, empty: null, refs: null }
  let value = { reachable: false, empty: null, refs: null }
  try {
    const response = await fetch(`${origin}/api/cloud-status`, { signal: AbortSignal.timeout(1500), headers: { accept: "application/json" } })
    if (response.ok) {
      const body = await response.json()
      const refs = Number(body?.counts?.refs)
      value = { reachable: true, empty: Number.isFinite(refs) ? refs === 0 : null, refs: Number.isFinite(refs) ? refs : null, pages: body?.counts?.pages ?? null, hasOwner: body?.hasOwner === true }
    }
  } catch {}
  if (!value.reachable) {
    try {
      const response = await fetch(`${origin}/api/references?limit=1`, { signal: AbortSignal.timeout(2000), headers: { accept: "application/json" } })
      if (response.ok) {
        const list = await response.json()
        if (Array.isArray(list)) value = { reachable: true, empty: list.length === 0, refs: null }
      }
    } catch {}
  }
  localLibrary = { at: Date.now(), value }
  return value
}
/**
 * The Worker reports who owns the library and which methods it has. Settings uses the
 * owner only; sign-in in v1 is passkeys, so GitHub is deliberately not offered.
 */
async function cloudSignInMethods() {
  const origin = cloudOrigin()
  if (mode() !== "cloud" || !origin) return null
  try {
    const response = await session.defaultSession.fetch(`${origin}/api/cloud-status`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(3000) })
    if (!response.ok) return null
    const body = await response.json()
    const methods = Array.isArray(body?.methods) ? body.methods.filter(value => value === "passkey" || value === "github") : []
    return { methods, ownerId: typeof body?.ownerId === "string" ? body.ownerId : null }
  } catch {
    return null
  }
}
async function cloudSnapshotState() {
  // While the engine is writing, its own events are the freshest source; between runs
  // re-read so a change made by the CLI shows the next time Settings opens.
  if (!cloudRun && layout) cloudState = readCloudState(layout.dataRoot)
  // An expired link is dead: drop it rather than offer a button that cannot work.
  if (ownerLink && Date.now() - ownerLink.at >= LINK_TTL_MS) ownerLink = null
  return {
    cloudStatus: await cloudSignInMethods(),
    mode: mode(),
    state: cloudState,
    // A result means the engine is done even if the child has not been reaped yet;
    // Settings should leave the progress view without waiting on the exit event.
    // Minting a link is not a library operation, so it never drives that view.
    busy: !!cloudRun && !cloudRun.resultSeen && cloudRun.purpose !== "owner-link",
    running: cloudRun ? { command: cloudRun.command, step: cloudRun.step } : null,
    // The owner link is for the person at the keyboard; it is never written to disk.
    link: ownerLink ? { url: ownerLink.url, note: LINK_NOTE, expiresAt: new Date(ownerLink.at + LINK_TTL_MS).toISOString() } : null,
    engine: { available: engineAvailable(__dirname) },
    // Enable waits for the runtime (Node, library layout) to be ready; the sheet is
    // still readable, but starting before that only produces a confusing error.
    ready: !!node && !!layout,
    local: await localLibraryStatus(),
    app: { version: app.getVersion(), dataRoot: layout?.dataRoot ?? null, captureEnv: captureEnvFile()?.name ?? null },
  }
}
/** `event: "session"` is consumed here: the token goes to the cookie jar, never the renderer. */
async function acceptCloudSession(event) {
  const cookie = sessionCookie(event, cloudState?.cloud?.url)
  if (!cookie) return
  try {
    await session.defaultSession.cookies.set(cookie)
  } catch {
    sendToSettings("snip:cloud-log", { level: "warn", message: "Snip couldn’t sign this Mac in automatically. Sign in from the cloud window when it opens." })
  }
}
function applyCloudStep(event) {
  if (event.status !== "started") return
  // The engine cannot stop Electron's children; it names the step and Snip reacts.
  if (event.step === "quiesce") { autoCapture = false; void services.capture.stop() }
  if (event.step === "release" || event.step === "pull-swap") void stopWeb()
}
function onCloudEvent(run, event) {
  if (event.event === "step" && typeof event.step === "string") run.step = event.step.slice(0, 64)
  if (event.event === "result") {
    cloudResult = event
    run.resultSeen = true
  }
  if (run.purpose === "owner-link") {
    // `owner link` contributes exactly one thing to Settings: the URL. Its steps,
    // logs and any session handoff stay here, so the window keeps its normal layout
    // and this Mac is never signed in by a link meant for another browser.
    const url = ownerLinkFrom(event, cloudState?.cloud?.url)
    if (url && !run.link) {
      run.link = url
      ownerLink = { url, at: Date.now() }
      sendToSettings("snip:cloud-link", { url, note: LINK_NOTE, expiresAt: new Date(ownerLink.at + LINK_TTL_MS).toISOString() })
      // Without `--managed` the engine's last step only waits to watch a sign-in this
      // Mac does not need, so the run has done its job once the link exists.
      if (run.cancel) run.cancel()
      else run.cancelPending = true
    }
    return
  }
  if (event.event === "session") { void acceptCloudSession(event); return }
  if (event.event === "needs_input") {
    for (const key of Array.isArray(event.keys) ? event.keys : []) {
      if (key && typeof key.key === "string") cloudInput.set(key.key.slice(0, 64), "")
    }
  }
  if (event.event === "step") applyCloudStep(event)
  if (event.event === "log") sendToSettings("snip:cloud-log", { level: ["info", "warn", "error"].includes(event.level) ? event.level : "info", message: String(event.message ?? "").slice(0, 2000) })
  sendToSettings("snip:cloud-progress", event)
}
// A running capture agent keeps the destination it started with, and start() is a
// no-op while it runs, so switching libraries has to stop it first. stop() lets an
// in-flight capture finish.
async function restartCaptureForMode() {
  if (services.capture.proc) await services.capture.stop().catch(() => {})
}
async function enterCloudMode() {
  if (!layout) return
  try { keepLocalCaptureEnv({ dataRoot: layout.dataRoot }) } catch {}
  await restartCaptureForMode()
  autoCapture = true
  recreateWindow()
  start("capture")
}
async function enterLocalMode() {
  await restartCaptureForMode()
  autoCapture = true
  localLibrary = { at: 0, value: null }
  // `pull` stopped the local Worker at pull-swap; wait for that to finish, or start()
  // would return early on the shutdown guard.
  if (shutdown) await shutdown.catch(() => {})
  start("web")
  recreateWindow()
}
async function finishCloudRun(run, { cancelled, code }) {
  const result = cloudResult
  cloudResult = null
  if (cloudRun === run) cloudRun = null
  cloudState = layout ? readCloudState(layout.dataRoot) : null
  if (run.purpose === "owner-link") {
    // Nothing about the library changed, so there is no mode to enter and no log line
    // to add: a link that was minted is already in Settings, and one that was not has
    // a sentence of its own.
    if (!run.link) {
      const message = result?.code === "SECRET_MISSING"
        ? "This Mac holds no owner secret for its cloud library. Turn cloud off and on again to replace it."
        : cancelled
          ? "The sign-in link wasn’t created."
          : "Snip couldn’t create a sign-in link. Try again."
      // The codes are the only thing worth recording: the URL itself is never logged.
      const detail = typeof result?.data?.code === "string" ? ` (${result.data.code})` : ""
      makeLog("cloud").end(`${new Date().toISOString()} owner link exited ${code ?? "?"} ${result?.code ?? "no result"}${detail}\n`)
      sendToSettings("snip:cloud-log", { level: "error", message })
    }
    refresh()
    return
  }
  if (result?.ok) {
    if (result.mode === "cloud") await enterCloudMode()
    else if (result.mode === "local") await enterLocalMode()
    sendToSettings("snip:cloud-log", { level: "info", message: result.mode === "cloud" ? "Snip is now using your cloud library." : "Snip is back on this Mac." })
  } else if (cancelled || result?.code === "CANCELLED") {
    sendToSettings("snip:cloud-log", { level: "info", message: "Stopped. Nothing on Cloudflare was changed." })
  } else {
    // A run that dies without a `result` still needs a sentence a person can act on.
    const fallback = code === 2 ? "Snip needs one more choice before it can continue." : code === 3 ? "Another Snip setup is already running." : code === 4 ? "This build can’t run that part of cloud Snip." : "Setup stopped before it finished. Retry the step that failed."
    const byCode = { NEEDS_INPUT: fallback, UNSUPPORTED: "This build can’t run that part of cloud Snip.", LOCKED: "Another Snip setup is already running." }
    const message = cloudState?.error?.message ?? byCode[result?.code] ?? fallback
    sendToSettings("snip:cloud-log", { level: "error", message })
    // Main's log is the one place a failed run is recorded; the renderer only shows copy.
    makeLog("cloud").end(`${new Date().toISOString()} ${run.command} exited ${code ?? "?"} ${result?.code ?? "no result"}\n`)
  }
  refresh()
}
function startCloudRun(command, flags = {}, subcommand, purpose) {
  if (cloudRun) return { error: "busy" }
  if (!layout || !node) return { error: "Snip is still starting." }
  if (!engineAvailable(__dirname)) return { error: "Cloud setup isn’t included in this build.", code: "UNSUPPORTED" }
  if (command === "setup") {
    try { keepLocalCaptureEnv({ dataRoot: layout.dataRoot }) } catch {}
  }
  const run = { command: subcommand ? `${command} ${subcommand}` : command, step: null, cancel: null, resultSeen: false, purpose, link: null }
  cloudRun = run
  cloudResult = null
  const opening = {
    pull: "Reading your cloud library.",
    detach: "Turning off cloud on this Mac.",
    "delete-resources": "Deleting the cloud copy.",
    "snapshot restore": "Restoring the snapshot on this Mac.",
    "snapshot delete": "Deleting the snapshot.",
    "owner link": "Creating a sign-in link.",
  }[run.command] ?? "Setting up your cloud library."
  // The owner-link run reports through its own channel, so it does not touch the log.
  if (purpose !== "owner-link") sendToSettings("snip:cloud-log", { level: "info", message: opening })
  try {
    const handle = runEngine({
      executable: node.executable, appDir: __dirname, root: ROOT, dataRoot: layout.dataRoot, command, subcommand, flags, baseEnv: node.env,
      onEvent: event => { if (cloudRun === run) onCloudEvent(run, event) },
      onExit: info => { if (cloudRun === run) void finishCloudRun(run, info) },
    })
    run.cancel = () => handle.cancel()
    // An event can land before the handle exists; honour a cancel that came first.
    if (run.cancelPending) run.cancel()
  } catch (error) {
    cloudRun = null
    return { error: error.message }
  }
  refresh()
  return { started: true }
}
function registerCloudIpc() {
  const guard = handler => async (event, payload = {}) => {
    if (!trustedSettingsSender(event)) return { error: "untrusted" }
    try {
      return await handler(payload && typeof payload === "object" ? payload : {})
    } catch (error) {
      return { error: error?.message ?? "Snip couldn’t complete that." }
    }
  }
  ipcMain.handle("snip:cloud-state", guard(() => cloudSnapshotState()))
  ipcMain.handle("snip:cloud-enable", guard(payload => {
    if (mode() === "cloud") return { error: "This Mac is already using a cloud library." }
    const merged = { ...Object.fromEntries(cloudInput), ...payload }
    cloudInput.clear()
    return startCloudRun("setup", cloudFlags(merged))
  }))
  ipcMain.handle("snip:cloud-disable", guard(payload => {
    if (payload.action === "pull") return startCloudRun("pull")
    if (payload.action === "detach") return startCloudRun("detach")
    return { error: "Unknown action." }
  }))
  ipcMain.handle("snip:cloud-retry-step", guard(payload => {
    if (mode() === "enabling") return startCloudRun("setup", cloudFlags(Object.fromEntries(cloudInput)))
    if (mode() === "disabling") return startCloudRun("pull")
    if (mode() === "cloud" && typeof payload.step === "string") return startCloudRun("setup", cloudFlags({}))
    return { error: "Nothing to retry." }
  }))
  ipcMain.handle("snip:cloud-cancel", guard(() => ({ cancelled: !!cloudRun?.cancel?.() })))
  // Undo is not Cancel: it abandons an interrupted `enabling` and is only offered there.
  ipcMain.handle("snip:cloud-abort", guard(() => {
    if (mode() !== "enabling") return { error: "There is no unfinished setup to undo." }
    return startCloudRun("abort")
  }))
  ipcMain.handle("snip:cloud-answer", guard(payload => {
    if (typeof payload.key !== "string" || !payload.key) return { accepted: false }
    cloudInput.set(payload.key.slice(0, 64), typeof payload.value === "string" ? payload.value.slice(0, 500) : "")
    return { accepted: true }
  }))
  ipcMain.handle("snip:cloud-open-url", guard(payload => {
    const url = externalUrl(payload.url)
    if (!url) return { opened: false }
    void shell.openExternal(url)
    return { opened: true }
  }))
  ipcMain.handle("snip:cloud-sign-out-all", guard(async () => {
    const origin = cloudOrigin()
    if (!origin) return { error: "No cloud library is connected." }
    try {
      // Chromium's cookie jar holds rs_session; Node's own fetch would arrive signed out.
      const response = await session.defaultSession.fetch(`${origin}/api/sign-out-all`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) return { error: response.status === 401 ? "This Mac is already signed out. Sign in again from the cloud window." : "Cloudflare couldn’t complete that request." }
      return { ok: true, epoch: body?.epoch ?? null }
    } catch {
      return { error: "This Mac can’t reach the cloud library right now." }
    }
  }))
  ipcMain.handle("snip:cloud-delete-resources", guard(payload => {
    const confirm = typeof payload.confirm === "string" ? payload.confirm.trim().toLowerCase().slice(0, 253) : ""
    let host = null
    try { host = new URL(cloudState?.cloud?.url).host.toLowerCase() } catch {}
    if (!confirm) return { error: "Type your cloud library’s address to confirm." }
    if (!host) return { error: "No cloud library is recorded." }
    if (confirm !== host) return { error: `That doesn’t match ${host}.` }
    return startCloudRun("delete-resources", { confirm })
  }))
  ipcMain.handle("snip:cloud-snapshot", guard(payload => {
    // `delete-export` is a separate action because setup's dump is not a backup: it can
    // never be swapped in, so it is delete-only (contracts §1.11).
    const reply = snapshotFlags(payload.action, payload.confirm)
    if (!reply.ok) return { error: reply.error, code: reply.code }
    return startCloudRun("snapshot", reply.flags, payload.action)
  }))
  // A second way in for a browser with no passkey yet (contracts §4.2, §4.2.1).
  // `--no-handoff` is passed on every invocation: this link is for another browser or
  // device, so a loopback redirect would point at that device's own localhost. The run
  // ends once the link is minted instead of waiting for a sign-in this run can't see.
  ipcMain.handle("snip:cloud-owner-link", guard(() => {
    if (mode() !== "cloud") return { error: "Turn on cloud before creating a sign-in link." }
    return startCloudRun("owner", { "no-handoff": true }, "link", "owner-link")
  }))
}
registerCloudIpc()

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

async function sourceUpdateDialog(check = false) {
  if (!sourceUpdates || quitting) return
  if (check) await sourceUpdates.check()
  if (quitting) return
  const { phase, behind, commits } = sourceUpdates
  if (phase === "available") {
    const list = commits.map(line => `• ${line}`).join("\n")
    const more = behind > commits.length ? `\n…and ${behind - commits.length} more` : ""
    const { response } = await dialog.showMessageBox({ type: "info", buttons: ["Update now", "Later"], defaultId: 0, cancelId: 1,
      message: `${behind} new Snip ${behind === 1 ? "change" : "changes"} on GitHub`,
      detail: `${list}${more}\n\nTerminal will open and run the update. Snip finishes any active capture, quits, updates, and reopens. Your library and settings stay in place.` })
    if (response === 0) await sourceUpdates.launch({ directory: path.join(app.getPath("userData"), "updates"), node: node?.executable, open: file => shell.openPath(file) })
  } else if (phase !== "checking") {
    await dialog.showMessageBox({ type: phase === "current" ? "info" : "warning",
      message: phase === "current" ? "Snip is up to date" : "Couldn’t check for updates",
      detail: phase === "current" ? `Your checkout matches main (${sourceUpdates.local.slice(0, 7)}).` : sourceUpdates.error || "Try again later, or run npm run update in Terminal." })
  }
}
async function updateDialog(check = false) {
  if (sourceUpdates) return sourceUpdateDialog(check)
  if (!updates || quitting) return
  if (check) await updates.check()
  if (quitting) return
  const phase = updates.phase
  if (phase === "available" && !updates.nativeEnabled) {
    const { response } = await dialog.showMessageBox({ type: "info", buttons: ["Download Snip Dev", "Later"], defaultId: 0, cancelId: 1,
      message: `Snip Dev ${updates.release.version} is available`,
      detail: "This nightly uses manual installation. Download and unzip it, quit Snip Dev, then replace Snip Dev.app in Applications. Your test library stays in place. macOS may require you to allow the app in Privacy & Security because it is not signed with an Apple Developer ID." })
    if (response === 0) await shell.openExternal(updates.release.url)
    return
  }
  if (phase === "available") {
    const { response } = await dialog.showMessageBox({ type: "info", buttons: ["Download update", "Later"], defaultId: 0, cancelId: 1,
      message: `${identity.name} ${updates.release.version} is available`, detail: "You can keep using Snip while it downloads. Restart when you’re ready; active captures will finish first." })
    if (response === 0) await updates.download()
  } else if (phase === "ready") {
    const { response } = await dialog.showMessageBox({ type: "info", buttons: ["Restart and update", "Later"], defaultId: 0, cancelId: 1,
      message: "Your Snip update is ready", detail: updates.error || "Snip will finish the current capture, install the update, and reopen. Your saved references and settings stay in place. You can also leave this until your next restart." })
    if (response === 0) await updates.install()
  } else if (!["checking", "downloading", "installing"].includes(phase)) {
    await dialog.showMessageBox({ type: phase === "error" ? "warning" : "info", message: phase === "disabled" ? "This is a local development build" : phase === "error" ? "Couldn’t check for updates" : `${identity.name} is up to date`,
      detail: phase === "disabled" ? "In-app updates are available in signed release builds of Snip." : updates.error || `You’re running ${identity.name} ${app.getVersion()}.` })
  }
}
function updateItems() {
  if (sourceUpdates) {
    const { phase, behind } = sourceUpdates
    const label = phase === "available" ? `Update Snip (${behind} new)…` : phase === "checking" ? "Checking for updates…" : "Check for updates…"
    return [{ id: "snip-update", label, enabled: !quitting && phase !== "checking", click: () => void sourceUpdateDialog(phase !== "available") }]
  }
  if (!updates) return []
  const phase = updates.phase
  const label = phase === "available" ? `Download ${identity.name} ${updates.release.version}…` : phase === "downloading" ? "Downloading update…" : phase === "ready" ? "Restart and update Snip…" : phase === "installing" ? "Finishing capture before updating…" : phase === "checking" ? "Checking for updates…" : "Check for updates…"
  return [{ id: "snip-update", label, enabled: !quitting && !["checking", "downloading", "installing"].includes(phase), click: () => void updateDialog(!["available", "ready", "disabled"].includes(phase)) }]
}
async function drainForQuit() {
  quitting = true
  clearTimeout(idleTimer)
  clearTimeout(readyTimer)
  refresh()
  await (shutdown || stopServices(services.capture, services.web))
  await Promise.all([...logs].map(log => log.end()))
  try {
    const saved = JSON.stringify({ values: uiState, position, lastUrl })
    if (Buffer.byteLength(saved) <= 64000) {
      await fs.promises.mkdir(path.dirname(windowStateFile), { recursive: true, mode: 0o700 })
      await fs.promises.writeFile(`${windowStateFile}.tmp`, saved, { mode: 0o600 })
      await fs.promises.rename(`${windowStateFile}.tmp`, windowStateFile)
    }
  } catch {}
  finishedQuit = true
}
// Local builds run the git checkout in place, so they update from main instead of releases.
function configureSourceUpdates() {
  sourceUpdates = new SourceUpdates({ root: ROOT })
  let notified
  sourceUpdates.on("change", () => {
    refresh()
    if (sourceUpdates.phase === "available" && sourceUpdates.head && notified !== sourceUpdates.head) {
      notified = sourceUpdates.head
      const note = new Notification({ title: "A Snip update is available", body: `${sourceUpdates.behind} new ${sourceUpdates.behind === 1 ? "change" : "changes"} on GitHub. Click to update.` })
      note.on("click", () => void sourceUpdateDialog())
      note.show()
    }
  })
  powerMonitor.on("resume", () => sourceUpdates.resume())
  sourceUpdates.start()
}
function configureUpdates() {
  if (!releaseBuild && !nightly && !development && fs.existsSync(path.join(ROOT, ".git"))) return configureSourceUpdates()
  const config = releaseConfig
  updates = new Updates({ native: autoUpdater, version: nightly && !releaseBuild ? "0.0.0" : app.getVersion(), channel, directory: path.join(app.getPath("userData"), "updates"),
    enabled: nightly || (releaseBuild && config?.repository === "MaxChen04/Snip" && config?.updatesEnabled === true),
    nativeEnabled: releaseBuild && config?.repository === "MaxChen04/Snip" && config?.updatesEnabled === true,
    drain: drainForQuit,
    installFailed: () => { quitting = false; finishedQuit = false; autoCapture = true; start("web"); showApp() },
  })
  let previous = updates.phase, notifiedVersion
  updates.on("change", () => {
    refresh()
    if (updates.phase === "available" && notifiedVersion !== updates.release.version) {
      notifiedVersion = updates.release.version
      const note = new Notification({ title: "A Snip update is available", body: `${identity.name} ${updates.release.version} is ready to download from the menu bar.` })
      note.on("click", () => void updateDialog())
      note.show()
    } else if (updates.phase === "ready" && previous !== "ready") {
      const note = new Notification({ title: "Snip is ready to update", body: "Restart from the menu bar when you’re ready. Active captures will finish first." })
      note.on("click", () => void updateDialog())
      note.show()
    } else if (updates.phase === "error" && previous === "downloading") {
      void dialog.showMessageBox({ type: "warning", message: "The update couldn’t be downloaded", detail: updates.error })
    }
    previous = updates.phase
  })
  powerMonitor.on("resume", () => updates.resume())
  void updates.start()
}
const STATUS = { stopped: "Stopped", starting: "Starting…", running: "Running", connecting: "Connecting…", idle: "Ready", busy: "Capturing", disconnected: "Disconnected — retrying", stopping: "Finishing…", crashed: "Stopped (error)" }
function serviceItems(key) {
  const s = services[key]
  const items = [{ label: `${labels[key]}: ${STATUS[s.status]}`, enabled: false }]
  if (s.detail && s.status === "disconnected") items.push({ label: s.detail.slice(0, 100), enabled: false })
  if (s.proc && !s.stopping) items.push({ label: `Stop ${labels[key].toLowerCase()}`, enabled: !shutdown && !quitting, click: () => key === "web" ? void stopWeb() : (autoCapture = false, void s.stop()) })
  else if (!s.proc) items.push({ label: `Start ${labels[key].toLowerCase()}`, enabled: !!node && !shutdown && !quitting && (key === "web" || services.web.status === "running" || mode() === "cloud"), click: () => { autoCapture = true; start(key) } })
  if (key === "capture" && s.proc && !s.stopping) items.push({ label: "Check queue now", enabled: !quitting, click: () => s.send({ type: "snip:retry" }) })
  return items
}
function refresh() {
  if (!tray) return
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: identity.name, submenu: [{ role: "about" }, { id: "snip-settings", label: "Settings…", accelerator: "Cmd+,", enabled: !quitting, click: openSettings }, ...updateItems(), { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { label: `Quit ${identity.name}`, enabled: !quitting, accelerator: "Cmd+Q", click: () => app.quit() }] },
    { role: "editMenu" }, { role: "windowMenu" },
  ]))
  tray.setToolTip(quitting ? `${identity.name}: finishing capture before quitting` : `${identity.name}: ${STATUS[services.capture.status]}`)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: mode() === "cloud" ? "Open cloud library" : `Open ${identity.name}`, enabled: !quitting, click: showApp },
    ...(mode() === "cloud" && cloudOrigin() ? [{ label: windowOrigin.parse(cloudState.cloud.url)?.host ?? "Cloud library", enabled: false }] : []),
    { id: "snip-settings-tray", label: "Settings…", enabled: !quitting, click: openSettings }, { type: "separator" },
    ...(!node ? [{ label: resolvingNode ? "Finding Node.js…" : "Retry setup", enabled: !resolvingNode && !quitting, click: () => void setup() }] : []),
    ...(mode() === "cloud" ? [] : serviceItems("web")), ...(mode() === "cloud" ? [] : [{ type: "separator" }]), ...serviceItems("capture"), { type: "separator" },
    ...updateItems(), { type: "separator" },
    { label: "Show logs", click: () => shell.openPath(app.getPath("logs")) },
    ...(quitting || shutdown || services.capture.stopping ? [{ label: "Force quit Snip…", click: () => void forceQuit() }] : []),
    { label: quitting ? "Finishing capture before quitting…" : `Quit ${identity.name}`, enabled: !quitting, accelerator: "Cmd+Q", click: () => app.quit() },
  ]))
}
app.on("second-instance", showApp)
app.on("activate", () => { if (app.isReady()) showApp() })
app.on("window-all-closed", () => {})
app.on("will-quit", () => { updates?.dispose(); sourceUpdates?.dispose() })
app.on("before-quit", event => {
  if (finishedQuit) return
  event.preventDefault()
  if (quitting) return
  void (async () => {
    await drainForQuit()
    app.quit() // Let Squirrel's normal quit hooks apply an already staged update.
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
    const options = { root: ROOT, resourcesPath: process.resourcesPath, userData: app.getPath("userData"), release: releaseBuild, isolated: nightly, port: PORT }
    if (releaseBuild && !nightly && !fs.existsSync(path.join(options.userData, "library-location.json"))) {
      const { response } = await dialog.showMessageBox({ type: "question", buttons: ["Use an existing library", "Start a new library", "Quit"], defaultId: 0, cancelId: 2,
        message: "Set up your Snip library", detail: "If you’ve used a local build before, select its Snip project folder to keep your saved references and settings." })
      if (response === 2) { app.quit(); return }
      if (response === 0) {
        const choice = await dialog.showOpenDialog({ title: "Choose your existing Snip project folder", properties: ["openDirectory"] })
        if (choice.canceled) { startupError = "Library setup was cancelled. Choose Retry setup from the menu bar."; showLoading(); return }
        selectExistingLibrary(options, choice.filePaths[0])
      }
    }
    try { layout = prepareRuntimeLayout(options) }
    catch (error) {
      if (nightly || !releaseBuild || error.code !== "SNIP_LIBRARY_LOCATION") throw error
      const { response } = await dialog.showMessageBox({ type: "warning", buttons: ["Locate existing library", "Cancel"], defaultId: 0, cancelId: 1,
        message: "Snip couldn’t open its saved library", detail: `${error.message}\nChoose its current project folder. The old location will be preserved until a valid replacement is selected.` })
      if (response !== 0) throw error
      const choice = await dialog.showOpenDialog({ title: "Locate your Snip library", properties: ["openDirectory"] })
      if (choice.canceled) throw error
      selectExistingLibrary(options, choice.filePaths[0], { replace: true })
      layout = prepareRuntimeLayout(options)
    }
    if (releaseBuild || nightly) {
      // Catch a development server still owning this library's port before migration.
      await new Promise((resolve, reject) => {
        const probe = require("node:net").createServer()
        probe.once("error", () => reject(new Error(`Port ${PORT} is in use. Stop the other Snip server and capture agent, then retry setup.`)))
        probe.listen(PORT, "localhost", () => probe.close(resolve))
      })
      const acknowledged = path.join(options.userData, "external-library-confirmed")
      const canonicalLibrary = fs.realpathSync(layout.dataRoot)
      let confirmedLibrary
      try { confirmedLibrary = fs.readFileSync(acknowledged, "utf8").trim() } catch {}
      if (layout.dataRoot !== path.join(options.userData, "library") && confirmedLibrary !== canonicalLibrary) {
        const { response } = await dialog.showMessageBox({ type: "warning", buttons: ["Use this library", "Cancel"], defaultId: 1, cancelId: 1,
          message: "Finish other Snip sessions first", detail: "Stop any separate Snip development server or capture agent before continuing. This app will upgrade and use your existing library; don’t run another local Snip server against it at the same time." })
        if (response !== 0) { startupError = "Library setup was cancelled. Stop other Snip sessions and choose Retry setup."; showLoading(); return }
        fs.writeFileSync(acknowledged, `${canonicalLibrary}\n`, { mode: 0o600 })
      }
    }
    const resolved = releaseBuild ? { executable: layout.nativeNode, env: { ...process.env } } : await resolveNode({ cacheFile: path.join(app.getPath("userData"), "node-path.json") })
    if (!releaseBuild && !nightly) prepareRuntimeLayout({ ...options, recordSource: true })
    node = resolved
    node.env = { ...node.env, PATH: [path.dirname(node.executable), node.env.PATH].filter(Boolean).join(path.delimiter), FORCE_COLOR: "0", NO_COLOR: "1", BROWSER: "none", WRANGLER_SEND_METRICS: "false", WRANGLER_WRITE_LOGS: "false" }
    // Release builds ship their browser inside the signed bundle; never download into it.
    if (releaseBuild) Object.assign(node.env, { PLAYWRIGHT_BROWSERS_PATH: layout.browsersPath, SNIP_BROWSER_AUTO_INSTALL: "0" })
    // The mode is read before anything loads a URL: a restart in cloud mode must not
    // open the local library, and a restart in local mode must not wait on cloud.
    cloudState = readCloudState(layout.dataRoot)
    if (mode() === "cloud") {
      // The window created at launch still shows the startup page with the local pin.
      recreateWindow()
      if (!quitting) start("capture")
    } else if (!quitting) start("web")
  } catch (error) { startupError = error.message; showLoading() }
  finally { resolvingNode = false; refresh() }
}
app.whenReady().then(async () => {
  app.setName(identity.name)
  if (process.platform !== "darwin" || process.arch !== "arm64" || Number(os.release().split(".")[0]) < 23) {
    dialog.showErrorBox("Snip", "Snip requires Apple Silicon and macOS 14 or later. Intel and Rosetta are not supported.")
    app.exit(1)
    return
  }
  serveSettings()
  if (nightly && !releaseBuild) app.dock.setIcon(path.join(ROOT, "desktop/assets/Snip-dev.png"))
  const icon = nativeImage.createFromPath(path.join(ROOT, "web/public/favicon-32.png")).resize({ width: 18, height: 18 })
  tray = new Tray(icon)
  createWindow() // Never wait for shell initialization before displaying the UI.
  configureUpdates()
  refresh()
  await setup()
})
