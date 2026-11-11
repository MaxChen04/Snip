// The engine is a child process that speaks NDJSON. These tests pin how main builds
// its arguments and environment, and that nothing it prints can reach a renderer
// unexamined.
const { test } = require("node:test")
const assert = require("node:assert/strict")
const { EventEmitter } = require("node:events")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { enginePath, engineAvailable, engineArgs, setupFlags, retryArgs, engineEnv, runEngine, safeEvent } = require("../cloud-engine.cjs")

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

test("an answer stored under the engine's key becomes that flag", () => {
  // `needs_input` asks for "account"; the answer is kept under that name and sent back as --account.
  const flags = setupFlags({ account: " acct-2 ", domain: "snip.example.com", adoptExisting: true })
  assert.deepEqual(flags, { account: "acct-2", domain: "snip.example.com", login: undefined, "adopt-existing": true, "capture-env": "replace" })
  const args = engineArgs({ appDir: APP, root: "/repo", dataRoot: "/library", command: "setup", flags, env: {} })
  assert.equal(args[args.indexOf("--account") + 1], "acct-2")
  assert.equal(setupFlags({ accountId: "acct-2" }).account, undefined, "there is one name for the account, the engine's")
})

test("Retry resumes an unfinished setup, re-runs what failed, and never sets up a healthy library", () => {
  assert.equal(retryArgs({ mode: "cloud", failed: undefined, answers: {} }), null)
  assert.equal(retryArgs({ mode: "local", failed: undefined, answers: {} }), null)
  const pull = ["pull", {}, undefined]
  assert.equal(retryArgs({ mode: "cloud", failed: pull, answers: {} }), pull)
  const restore = ["snapshot", { confirm: "replaced-2026" }, "restore"]
  assert.equal(retryArgs({ mode: "local", failed: restore, answers: {} }), restore)
  // Setup resumes from its journal with the answers given since, in whatever mode it stopped.
  assert.deepEqual(retryArgs({ mode: "enabling", failed: undefined, answers: { account: "acct-2" } }), ["setup", setupFlags({ account: "acct-2" })])
  assert.equal(retryArgs({ mode: "cloud", failed: ["setup", { account: "old" }, undefined], answers: { account: "acct-2" } })[1].account, "acct-2")
})

test("snapshot actions are positional subcommands", () => {
  const args = engineArgs({ appDir: APP, root: "/repo", dataRoot: "/library", command: "snapshot", subcommand: "restore", env: {} })
  assert.deepEqual(args.slice(1, 3), ["snapshot", "restore"])
})

test("an owner link run asks for no handoff and keeps --managed", () => {
  // The link is for another browser or device, so the run must never open a loopback:
  // on that device it would point at its own localhost (contracts v3.22 §1.4.2).
  const args = engineArgs({ appDir: APP, root: "/repo", dataRoot: "/library", command: "owner", subcommand: "link", flags: { "no-handoff": true }, env: {} })
  assert.deepEqual(args.slice(1, 3), ["owner", "link"])
  assert.equal(args.includes("--managed"), true)
  assert.equal(args[args.indexOf("--no-handoff") + 1], undefined, "a boolean flag takes no value")
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

test("a child that ends without a result yields one FAILED result before onExit", () => {
  const child = fakeChild()
  const seen = []
  runEngine({
    appDir: APP, root: "/repo", dataRoot: "/library", command: "setup", baseEnv: {}, env: {},
    spawnProcess: () => child,
    onEvent: event => seen.push(event.event === "result" ? `result:${event.ok}:${event.code}` : event.event),
    onExit: info => seen.push(`exit:${info.code}`),
  })
  child.stdout.emit("data", '{"v":1,"event":"step","step":"preflight","status":"started"}\n')
  child.emit("close", 1, null)
  child.emit("close", 1, null)
  assert.deepEqual(seen, ["step", "result:false:FAILED", "exit:1"])
})

test("cancel sends SIGINT exactly once the child is alive", () => {
  const child = fakeChild()
  const run = runEngine({ appDir: APP, root: "/repo", dataRoot: "/library", command: "setup", baseEnv: {}, env: {}, spawnProcess: () => child, onEvent: () => {} })
  assert.equal(run.cancel(), true)
  assert.deepEqual(child.killedWith, ["SIGINT"])
  assert.equal(run.cancelled, true)
})

test("a cancelled run can be awaited until the child is gone", async () => {
  const child = fakeChild()
  const seen = []
  const run = runEngine({ appDir: APP, root: "/repo", dataRoot: "/library", command: "setup", baseEnv: {}, env: {}, spawnProcess: () => child, onExit: info => seen.push(info.cancelled) })
  let settled = false
  void run.exited.then(() => (settled = true))
  assert.equal(run.cancel(), true)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false, "cancel alone does not end the run")
  child.emit("close", null, "SIGINT")
  await run.exited
  assert.deepEqual(seen, [true])
})

test("a snapshot delete without the rendered basename stops before deleting", async t => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "snip-cloud-confirm-"))
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }))
  fs.mkdirSync(path.join(dataRoot, ".snip"), { recursive: true })
  const state = {
    version: 1, mode: "cloud", library: { id: "x" }, cloud: { url: "https://snip.max.workers.dev" },
    snapshot: { kind: "backup", path: "backups/replaced-2026-11-06T10-12-00", takenAt: "2026-11-06T10:12:00Z", refs: 42, files: 311, bytes: 1, keptLocal: false, export: null },
    steps: [], error: null,
  }
  fs.writeFileSync(path.join(dataRoot, ".snip/cloud.json"), JSON.stringify(state))
  const run = async flags => {
    const events = []
    const exit = await new Promise(resolve => {
      runEngine({
        appDir: APP, root: dataRoot, dataRoot, command: "snapshot", subcommand: "delete", flags,
        baseEnv: { ...process.env }, env: { ...process.env, SNIP_CLOUD_ENGINE: FIXTURE, SNIP_FAKE_DELAY: "0" },
        onEvent: event => events.push(event), onExit: resolve,
      })
    })
    return { exit, events, result: events.at(-1) }
  }

  const missing = await run({})
  assert.equal(missing.exit.code, 2)
  assert.equal(missing.result.code, "NEEDS_INPUT")
  assert.equal(missing.events.some(event => event.event === "needs_input" && event.keys[0].key === "confirm"), true)

  const wrong = await run({ confirm: "some-other-directory" })
  assert.equal(wrong.result.code, "FAILED")
  assert.equal(wrong.result.data.code, "CONFIRM_MISMATCH")
  assert.ok(JSON.parse(fs.readFileSync(path.join(dataRoot, ".snip/cloud.json"), "utf8")).snapshot, "the backup was kept")

  const right = await run({ confirm: "replaced-2026-11-06T10-12-00" })
  assert.equal(right.result.code, "OK")
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataRoot, ".snip/cloud.json"), "utf8")).snapshot, null)
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
