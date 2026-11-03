// Snip desktop launcher (macOS). Starts the web dev server and the capture
// agent from this repo, shows the app in a window, and puts Start/Stop
// controls in the menu bar. Quitting stops both.

const { app, BrowserWindow, Menu, Notification, Tray, dialog, nativeImage, shell } = require("electron")
const { execFileSync, spawn } = require("node:child_process")
const fs = require("node:fs")
const path = require("node:path")

if (!app.requestSingleInstanceLock()) app.exit(0)

// The packaged app runs this repo in place; build.mjs records where it is.
function repoRoot() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "repo.json"), "utf8")).root
  } catch {
    return path.resolve(__dirname, "..")
  }
}
const ROOT = repoRoot()

// Apps opened from Finder get a bare PATH, so node from Homebrew, nvm or
// fnm aren't found. Borrow the PATH of the user's login shell.
function shellPath() {
  const fallback = ["/opt/homebrew/bin", "/usr/local/bin", process.env.PATH].join(":")
  try {
    const out = execFileSync(process.env.SHELL || "/bin/zsh", ["-ilc", 'printf "__SNIP__%s__SNIP__" "$PATH"'], {
      encoding: "utf8",
      timeout: 8000,
      stdio: ["ignore", "pipe", "ignore"],
    })
    return out.split("__SNIP__")[1] || fallback
  } catch {
    return fallback
  }
}
const ENV = { ...process.env, PATH: shellPath(), FORCE_COLOR: "0", NO_COLOR: "1", BROWSER: "none" }

// Run the tools directly rather than through `npm run`: npm exits on SIGTERM
// without waiting for its child, which would orphan the capture agent mid-job.
const bin = (name) => path.join(ROOT, "node_modules/.bin", name)
const services = {
  web: {
    label: "Web app",
    cwd: path.join(ROOT, "web"),
    cmd: bin("vite"),
    // strictPort: capture/.env points at a fixed URL, so fail loudly instead of drifting to 5174.
    args: ["--strictPort"],
  },
  capture: { label: "Capture agent", cwd: path.join(ROOT, "capture"), cmd: bin("tsx"), args: ["src/index.ts"] },
}
for (const s of Object.values(services)) Object.assign(s, { proc: null, status: "stopped", url: null, stopping: false, tail: "" })

let tray = null
let win = null
let quitting = false

const logFile = (key) => path.join(app.getPath("logs"), `${key}.log`)

function start(key) {
  const s = services[key]
  if (s.proc) return
  fs.mkdirSync(app.getPath("logs"), { recursive: true })
  const log = fs.createWriteStream(logFile(key), { flags: "a" })
  log.write(`\n--- ${new Date().toISOString()} starting ${s.label.toLowerCase()} ---\n`)

  // detached: own process group, so a forced stop can take down every child (vite, workerd, Chromium).
  const p = spawn(s.cmd, s.args, { cwd: s.cwd, env: ENV, detached: true })
  Object.assign(s, { proc: p, status: "starting", url: null, stopping: false, tail: "" })

  const onData = (buf) => {
    log.write(buf)
    const text = buf.toString()
    s.tail = (s.tail + text).slice(-4000)
    if (key === "web" && !s.url) {
      const m = text.replace(/\x1b\[[0-9;]*m/g, "").match(/Local:\s+(https?:\/\/\S+)/)
      if (m) {
        s.url = m[1].replace(/\/$/, "")
        s.status = "running"
        showApp()
        refresh()
      }
    }
  }
  p.stdout.on("data", onData)
  p.stderr.on("data", onData)
  if (key === "capture") s.status = "running"

  p.on("error", (err) => {
    log.write(`\n${err.message}\n`)
    dialog.showErrorBox("Snip", `Couldn't start the ${s.label.toLowerCase()}: ${err.message}\n\nIs Node installed and on your shell's PATH?`)
    // A failed spawn emits no "exit", so reset here to let Start retry.
    if (p.pid === undefined) {
      log.end()
      Object.assign(s, { proc: null, url: null, stopping: false, status: "crashed" })
      refresh()
    }
  })
  p.on("exit", (code, signal) => {
    log.end(`--- exited (${signal ?? code}) ---\n`)
    killGroup(p, "SIGKILL") // sweep any children left behind (workerd, Chromium)
    const crashed = !s.stopping && !quitting
    Object.assign(s, { proc: null, url: null, stopping: false, status: crashed ? "crashed" : "stopped" })
    if (crashed) reportCrash(key)
    if (key === "web") showLoading()
    refresh()
  })
  refresh()
}

function killGroup(p, signal) {
  try {
    process.kill(-p.pid, signal)
  } catch {}
}

// Graceful: SIGTERM to the top process only; tsx forwards it once to the agent.
// (Signalling the whole group would hit the agent twice, which it treats as
// "force quit".) The capture agent finishes its current job before exiting.
function stop(key) {
  const s = services[key]
  if (!s.proc) return
  s.stopping = true
  s.status = "stopping"
  s.proc.kill("SIGTERM")
  refresh()
}

function forceStop(key) {
  const s = services[key]
  if (s.proc) killGroup(s.proc, "SIGKILL")
}

function reportCrash(key) {
  const s = services[key]
  let hint = "See the log for details."
  if (/already in use|EADDRINUSE/i.test(s.tail)) hint = "The port is already in use. Is Snip running in a terminal?"
  else if (/SNIP_URL and CAPTURE_TOKEN/.test(s.tail)) hint = "capture/.env is missing SNIP_URL or CAPTURE_TOKEN."
  else if (/Executable doesn't exist|playwright install/i.test(s.tail)) hint = "Run `npx playwright install chromium` once."
  const n = new Notification({ title: `${s.label} stopped`, body: hint })
  n.on("click", () => shell.openPath(logFile(key)))
  n.show()
}

// --- Window -----------------------------------------------------------------

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    title: "Snip",
    backgroundColor: "#f6f5f2",
    webPreferences: { contextIsolation: true, sandbox: true },
  })
  // Snip's own new-tab links (HTML snapshots, files) open in their own window
  // so the gallery stays put; links to other sites open in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (services.web.url && url.startsWith(services.web.url)) {
      return { action: "allow", overrideBrowserWindowOptions: { width: 1280, height: 860, autoHideMenuBar: true } }
    }
    shell.openExternal(url)
    return { action: "deny" }
  })
  // Closing the window keeps Snip running in the menu bar.
  win.on("close", (e) => {
    if (quitting) return
    e.preventDefault()
    win.hide()
    app.dock?.hide()
  })
  services.web.url ? win.loadURL(services.web.url) : showLoading()
}

function showLoading() {
  if (!win) return
  const s = services.web
  const msg = s.status === "crashed" ? "The web app stopped. Check the log from the menu bar icon." : s.status === "stopped" ? "The web app is stopped. Start it from the menu bar icon." : "Starting Snip…"
  const logo = require("node:url").pathToFileURL(path.join(ROOT, "web/public/logo.png")).href
  win.loadFile(path.join(__dirname, "loading.html"), { query: { msg, logo } })
}

function showApp() {
  if (!win) createWindow()
  else if (services.web.url && !win.webContents.getURL().startsWith(services.web.url)) win.loadURL(services.web.url)
  app.dock?.show()
  win.show()
  win.focus()
}

// --- Menu bar ---------------------------------------------------------------

const STATUS = { stopped: "Stopped", starting: "Starting…", running: "Running", stopping: "Stopping…", crashed: "Stopped (error)" }

function serviceItems(key) {
  const s = services[key]
  const detail = key === "web" && s.url ? ` · ${s.url.replace(/^https?:\/\//, "")}` : ""
  const items = [{ label: `${s.label}: ${STATUS[s.status]}${detail}`, enabled: false }]
  if (s.status === "stopping") items.push({ label: `Force stop ${s.label.toLowerCase()}`, click: () => forceStop(key) })
  else if (s.proc) items.push({ label: `Stop ${s.label.toLowerCase()}`, click: () => stop(key) })
  else items.push({ label: `Start ${s.label.toLowerCase()}`, click: () => start(key) })
  return items
}

function refresh() {
  if (!tray) return
  const anyRunning = Object.values(services).some((s) => s.proc)
  tray.setToolTip(anyRunning ? "Snip: running" : "Snip: stopped")
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Snip", click: showApp },
      { type: "separator" },
      ...serviceItems("web"),
      { type: "separator" },
      ...serviceItems("capture"),
      { type: "separator" },
      { label: "Show logs", click: () => shell.openPath(app.getPath("logs")) },
      { label: "Quit Snip", accelerator: "Cmd+Q", click: () => app.quit() },
    ]),
  )
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(ROOT, "web/public/favicon-32.png")).resize({ width: 18, height: 18 })
  tray = new Tray(icon)
  refresh()
}

// --- Lifecycle --------------------------------------------------------------

app.on("second-instance", showApp)
app.on("activate", showApp)
app.on("window-all-closed", () => {}) // stay alive in the menu bar

let quitTimer = null
app.on("before-quit", (e) => {
  quitting = true // lets the window close instead of hiding
  if (!Object.values(services).some((s) => s.proc)) return
  e.preventDefault()
  if (quitTimer) return
  for (const key of Object.keys(services)) stop(key)
  // Give processes a few seconds to exit cleanly, then force them.
  const deadline = Date.now() + 5000
  quitTimer = setInterval(() => {
    const left = Object.keys(services).filter((k) => services[k].proc)
    if (!left.length || Date.now() > deadline) {
      clearInterval(quitTimer)
      left.forEach(forceStop)
      app.exit(0)
    }
  }, 200)
})

app.whenReady().then(() => {
  app.setName("Snip")
  if (!fs.existsSync(path.join(ROOT, "node_modules"))) {
    dialog.showErrorBox("Snip", `Snip's dependencies aren't installed.\n\nRun \`npm install\` in:\n${ROOT}`)
    app.exit(1)
    return
  }
  start("web")
  start("capture")
  createTray()
  createWindow()
})
