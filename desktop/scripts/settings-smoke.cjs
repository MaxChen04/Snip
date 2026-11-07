// End-to-end check of the Settings window and the mode branch, with no Cloudflare:
// a real Electron app, the real static Settings bundle, and the fixture engine CLI.
// It proves: Settings opens over snip://, enabling runs the engine and shows one
// browser action at a time, the app switches to the cloud origin without a preload,
// and a relaunch opens that origin instead of the local library.
const assert = require("node:assert/strict")
const fs = require("node:fs/promises")
const fsSync = require("node:fs")
const path = require("node:path")
const os = require("node:os")
const http = require("node:http")
const { _electron } = require("playwright")

const ROOT = path.resolve(__dirname, "../..")
const desktop = path.join(ROOT, "desktop")
const fixture = path.join(desktop, "tests/fixtures/fake-cloud-cli.cjs")
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check, message, timeout = 60000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await check()) return
    await sleep(100)
  }
  throw new Error(message)
}
async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  return server.address().port
}
async function freePort() {
  const server = http.createServer()
  const port = await listen(server)
  await new Promise(resolve => server.close(resolve))
  return port
}
async function copy(from, to) {
  await fs.mkdir(path.dirname(to), { recursive: true })
  await fs.cp(from, to, { recursive: true })
}

async function prepare() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "snip-settings-smoke-"))
  const root = path.join(temp, "repo")
  const appDir = path.join(root, "desktop")
  await fs.mkdir(root, { recursive: true })
  await fs.mkdir(appDir)
  for (const name of ["capture/src", "web/dist", "web/dist-settings", "web/migrations", "web/public"]) await copy(path.join(ROOT, name), path.join(root, name))
  for (const name of ["package.json", "web/wrangler.jsonc"]) await copy(path.join(ROOT, name), path.join(root, name))
  await fs.symlink(path.join(ROOT, "node_modules"), path.join(root, "node_modules"), "dir")
  for (const name of await fs.readdir(desktop)) {
    if (name.endsWith(".cjs") || ["loading.html", "cloud-unreachable.html", "package.json"].includes(name)) await fs.copyFile(path.join(desktop, name), path.join(appDir, name))
  }
  await fs.symlink(path.join(desktop, "node_modules"), path.join(appDir, "node_modules"), "dir")
  await fs.writeFile(path.join(appDir, "repo.json"), JSON.stringify({ root }))

  const port = await freePort()
  const origin = `http://localhost:${port}`
  await fs.writeFile(path.join(root, "web/.dev.vars"), `DEV_LOGIN=reviewer\nSESSION_SECRET=synthetic-local-session\nCAPTURE_TOKEN=synthetic-capture-token\nPUBLIC_URL=${origin}\n`)
  await fs.writeFile(path.join(root, "capture/.env"), `SNIP_URL=${origin}\nCAPTURE_TOKEN=synthetic-capture-token\nPOLL_SECONDS=1\nBROWSER_IDLE_SECONDS=2\n`)
  return { temp, root, appDir, port, origin }
}

async function launch({ appDir, ...overrides }) {
  const env = {
    ...process.env,
    SNIP_CLOUD_ENGINE: fixture,
    // Slow enough that a person (and this test) can see each human step.
    SNIP_FAKE_DELAY: "250",
    ...overrides,
  }
  for (const key of ["ELECTRON_RUN_AS_NODE", "SNIP_URL", "CAPTURE_TOKEN", "DEV_LOGIN"]) delete env[key]
  return _electron.launch({ executablePath: require("electron"), args: [appDir], env, timeout: 30000 })
}

async function main() {
  assert.equal(process.platform, "darwin", "settings smoke requires macOS")
  const site = await prepare()
  const stub = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html")
    res.end("<!doctype html><html><head><title>Snip cloud fixture</title></head><body><h1>Cloud fixture</h1><script>window.__noBridge = typeof window.snipDesktop === 'undefined'</script></body></html>")
  })
  const stubPort = await listen(stub)
  const cloudUrl = `http://127.0.0.1:${stubPort}`
  const base = { appDir: site.appDir, SNIP_DESKTOP_PROFILE: path.join(site.temp, "profile"), SNIP_DESKTOP_PORT: String(site.port), SNIP_FAKE_URL: cloudUrl, WRANGLER_SEND_METRICS: "false" }
  let application
  try {
    application = await launch(base)
    let page = await application.firstWindow()
    page.setDefaultTimeout(20000)
    await until(async () => (await page.evaluate(() => document.readyState).catch(() => "")) === "complete", "gallery never loaded")

    // Open Settings through the real menu item, the same path a person takes.
    await application.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById("snip-settings").click())
    const settingsEvent = await application.waitForEvent("window")
    const settings = await settingsEvent
    settings.setDefaultTimeout(20000)
    await settings.waitForURL(/^snip:\/\/settings\/index\.html/)
    await settings.getByRole("button", { name: "Enable cloud" }).waitFor({ timeout: 60000 }).catch(async error => {
      console.error("BRIDGE STATE:", JSON.stringify(await settings.evaluate(() => window.snipCloud.state()).catch(() => "unavailable")))
      throw error
    })
    assert.equal(await settings.evaluate(() => location.protocol), "snip:")
    console.log("PASS settings opens from the app menu over snip:// with no local Worker dependency")

    await settings.getByRole("button", { name: "Enable cloud" }).click()
    await settings.getByRole("heading", { name: "Turn on cloud for this library?" }).waitFor()
    assert.match(await settings.locator("[role=dialog]").innerText(), /Nothing on this Mac changes until the copy is verified/)
    await settings.getByRole("button", { name: "Continue to Cloudflare" }).click()

    // One browser action at a time: the card names R2 and carries the only Open button.
    await settings.getByText("Turn on R2 in Cloudflare").waitFor({ timeout: 30000 }).catch(async error => {
      console.error("SETTINGS TEXT:\n" + await settings.locator("body").innerText().catch(() => "unavailable"))
      console.error("MAIN LOG:", await application.evaluate(({ app }) => app.getPath("logs")).catch(() => "unavailable"))
      throw error
    })
    assert.equal(await settings.getByRole("button", { name: "Open", exact: true }).count(), 1)
    assert.match(await settings.locator("main").innerText(), /Setting up your cloud library/)
    console.log("PASS progress shows one human action at a time")

    await settings.getByRole("heading", { name: "Cloud library", exact: true }).waitFor({ timeout: 60000 })
    await settings.getByText("Connected", { exact: true }).waitFor()
    console.log("PASS a successful run lands on the cloud state")

    const state = JSON.parse(await fs.readFile(path.join(site.root, ".snip/cloud.json"), "utf8"))
    assert.equal(state.mode, "cloud")
    const capture = await fs.readFile(path.join(site.root, "capture/.env.cloud"), "utf8")
    assert.match(capture, /^SNIP_URL=/m)
    assert.equal(fsSync.existsSync(path.join(site.root, "capture/.env.local")), true, "the local capture settings were kept before retargeting")
    console.log("PASS cloud.json, .env.local and .env.cloud agree with the new mode")

    // The gallery is recreated on the cloud origin, and that window has no bridge.
    await until(async () => application.windows().some(candidate => candidate.url().startsWith(cloudUrl)), "the gallery never moved to the cloud origin")
    const cloud = application.windows().find(candidate => candidate.url().startsWith(cloudUrl))
    await cloud.waitForLoadState("domcontentloaded")
    assert.equal(await cloud.evaluate(() => typeof window.snipDesktop), "undefined")
    assert.equal(await cloud.evaluate(() => window.__noBridge), true)
    console.log("PASS the cloud window loads without a preload")

    await application.close()
    application = null

    // Restart: the mode branch must open the cloud origin, not the empty local library.
    application = await launch(base)
    await application.firstWindow()
    // The startup window is replaced once the mode is known, so look for the new one.
    await until(async () => application.windows().some(candidate => candidate.url().startsWith(cloudUrl)), "a restart did not open the cloud origin", 45000)
    const reopened = application.windows().find(candidate => candidate.url().startsWith(cloudUrl))
    await reopened.waitForLoadState("domcontentloaded")
    assert.equal(await reopened.evaluate(() => typeof window.snipDesktop), "undefined")
    console.log("PASS a restart in cloud mode opens the cloud library directly")

    // Turn off cloud = detach: cloud.json goes back to local with detachedAt set, and
    // the app leaves the cloud origin for the local library.
    await application.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById("snip-settings").click())
    const settingsAgain = await application.waitForEvent("window")
    settingsAgain.setDefaultTimeout(30000)
    await settingsAgain.getByRole("button", { name: "Turn off cloud…" }).click()
    await settingsAgain.getByRole("button", { name: /Turn off and keep local/ }).click()
    await settingsAgain.getByRole("button", { name: "Turn off cloud", exact: true }).click()
    await settingsAgain.getByRole("heading", { name: "This Mac", exact: true }).waitFor({ timeout: 60000 })
    const detachedState = JSON.parse(await fs.readFile(path.join(site.root, ".snip/cloud.json"), "utf8"))
    assert.equal(detachedState.mode, "local")
    assert.ok(detachedState.cloud?.detachedAt, "the cloud copy is remembered as detached")
    await until(async () => application.windows().some(candidate => candidate.url().startsWith(site.origin)), "the gallery never returned to the local origin")
    console.log("PASS turning off cloud detaches and brings the app back to this Mac")
  } finally {
    if (application) await application.close().catch(() => {})
    await new Promise(resolve => stub.close(resolve))
    await fs.rm(site.temp, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
