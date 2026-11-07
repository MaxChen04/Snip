// The engine is a child process that speaks NDJSON. These tests pin how main builds
// its arguments and environment, and that nothing it prints can reach a renderer
// unexamined.
const { test } = require("node:test")
const assert = require("node:assert/strict")
const { EventEmitter } = require("node:events")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { enginePath, engineAvailable, engineArgs, engineEnv, runEngine, safeEvent } = require("../cloud-engine.cjs")

const APP = "/Applications/Snip.app/Contents/Resources/app"
const FIXTURE = path.join(__dirname, "fixtures", "fake-cloud-cli.cjs")

function fakeChild() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stdout.setEncoding = () => {}
  child.stderr = new EventEmitter()
  child.stderr.setEncoding = () => {}
  child.killedWith = []
  child.kill = signal => {
    child.killedWith.push(signal)
    return true
  }
  return child
}

test("engine arguments carry the contract's flags", () => {
  const args = engineArgs({ appDir: APP, root: "/repo", dataRoot: "/library", command: "setup", flags: { account: "abc", domain: "", login: undefined }, env: {} })
  assert.deepEqual(args.slice(1), ["setup", "--json", "--root", "/repo", "--data-root", "/library", "--yes", "--no-open", "--managed", "--account", "abc"])
  assert.equal(args[0], path.join(APP, "provision", "cli.cjs"))
})

test("snapshot actions are positional subcommands", () => {
  const args = engineArgs({ appDir: APP, root: "/repo", dataRoot: "/library", command: "snapshot", subcommand: "restore", env: {} })
  assert.deepEqual(args.slice(1, 3), ["snapshot", "restore"])
})

test("SNIP_CLOUD_ENGINE replaces the packaged engine", () => {
  assert.equal(enginePath(APP, { SNIP_CLOUD_ENGINE: "/tmp/fake.cjs" }), "/tmp/fake.cjs")
  assert.equal(enginePath(APP, {}), path.join(APP, "provision", "cli.cjs"))
  assert.equal(engineAvailable(APP, file => file === FIXTURE, { SNIP_CLOUD_ENGINE: FIXTURE }), true)
  assert.equal(engineAvailable(APP, () => false, {}), false)
})

test("the engine gets its own caches and may open a browser", () => {
  const env = engineEnv({ PATH: "/usr/bin", BROWSER: "none", HOME: "/Users/max" }, { dataRoot: "/library" })
  assert.equal(env.MINIFLARE_CACHE_DIR, path.join("/library", ".cache/miniflare"))
  assert.equal(env.WRANGLER_CACHE_DIR, path.join("/library", ".cache/wrangler"))
  assert.equal("BROWSER" in env, false)
  assert.equal(env.HOME, "/Users/max")
})

test("only contract events pass the guard", () => {
  assert.ok(safeEvent({ v: 1, event: "step", step: "import", status: "ok" }))
  assert.ok(safeEvent({ v: 1, event: "session", token: "t", url: "https://x" }))
  assert.equal(safeEvent({ v: 2, event: "step" }), null)
  assert.equal(safeEvent({ event: "step" }), null)
  assert.equal(safeEvent({ v: 1, event: "rm -rf" }), null)
  assert.equal(safeEvent("line"), null)
})

test("stdout is parsed per line, across chunks, and garbage is never echoed", async () => {
  const child = fakeChild()
  const events = []
  const run = runEngine({
    appDir: APP, root: "/repo", dataRoot: "/library", command: "setup", baseEnv: {}, env: {},
    spawnProcess: () => child,
    onEvent: event => events.push(event),
  })
  child.stdout.emit("data", '{"v":1,"event":"step","step":"preflight","status":"started"}\n{"v":1,"event":"')
  child.stdout.emit("data", 'step","step":"preflight","status":"ok"}\nCAPTURE_TOKEN=super-secret\n')
  child.stdout.emit("data", '{"v":1,"event":"result","ok":true,"code":"OK","mode":"cloud"}')
  child.stdout.emit("end")
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(events.length, 4)
  assert.equal(events[0].step, "preflight")
  assert.equal(events[1].status, "ok")
  assert.equal(events[2].event, "log")
  assert.equal(events[2].level, "warn")
  assert.equal(JSON.stringify(events).includes("super-secret"), false)
  assert.equal(events[3].event, "result")
  assert.equal(run.cancelled, false)
})

test("cancel sends SIGINT exactly once the child is alive", () => {
  const child = fakeChild()
  const run = runEngine({ appDir: APP, root: "/repo", dataRoot: "/library", command: "setup", baseEnv: {}, env: {}, spawnProcess: () => child, onEvent: () => {} })
  assert.equal(run.cancel(), true)
  assert.deepEqual(child.killedWith, ["SIGINT"])
  assert.equal(run.cancelled, true)
})

test("a real setup run speaks the contract and writes a usable cloud.json", async t => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "snip-cloud-engine-"))
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }))
  const events = []
  const exit = await new Promise(resolve => {
    runEngine({
      appDir: APP, root: dataRoot, dataRoot, command: "setup",
      baseEnv: { ...process.env },
      env: { ...process.env, SNIP_CLOUD_ENGINE: FIXTURE, SNIP_FAKE_DELAY: "0" },
      onEvent: event => events.push(event),
      onExit: resolve,
    })
  })
  assert.equal(exit.code, 0)
  const result = events.at(-1)
  assert.equal(result.event, "result")
  assert.equal(result.ok, true)
  assert.equal(result.mode, "cloud")
  // The owner link hands a session back to main, which turns it into a cookie.
  const session = events.find(event => event.event === "session")
  assert.ok(session?.token)
  assert.ok(Array.isArray(events.filter(event => event.event === "human").map(event => event.action)))
  assert.ok(events.some(event => event.event === "human" && event.action === "enable_r2"))

  const file = JSON.parse(fs.readFileSync(path.join(dataRoot, ".snip", "cloud.json"), "utf8"))
  assert.equal(file.mode, "cloud")
  assert.equal(file.cloud.url, "https://snip.max.workers.dev")
  assert.ok(file.snapshot?.bytes > 0)
  assert.equal(fs.statSync(path.join(dataRoot, ".snip", "cloud.json")).mode & 0o777, 0o600)
})
