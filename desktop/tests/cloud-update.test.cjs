// Run the actual main-process functions against fake services/engine, without Electron or Cloudflare.
const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const { retryArgs } = require("../cloud-engine.cjs")
const source = fs.readFileSync(path.join(__dirname, "../main.cjs"), "utf8")
const functionSource = name => {
  const match = source.match(new RegExp(`^(?:async )?function ${name}\\([^\\n]*\\) \\{\\n[\\s\\S]*?\\n\\}`, "m"))
  assert.ok(match, `missing ${name}`)
  return match[0]
}
const gate = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve() }
const plain = value => JSON.parse(JSON.stringify(value))

function setup() {
  const drained = gate(), exited = gate(), calls = [], handlers = new Map()
  let engine, currentMode = "cloud", available = true, launchError = null
  const context = vm.createContext({
    cloudRun: null, cloudResult: null, cloudUpdatePending: false, failedRun: null, cloudInput: new Map(), cloudState: {},
    layout: { dataRoot: "/private/library" }, node: { executable: "/app/node", env: {} }, ROOT: "/app/runtime", __dirname: "/app",
    ownerLink: null, autoCapture: true, quitting: false, shutdown: null, applied: "cloud", localLibrary: null, lastUrl: "https://library.test/r/one",
    services: { capture: { stop: () => { calls.push("drain"); return drained.promise } }, web: { proc: null } },
    mode: () => currentMode,
    engineAvailable: () => available,
    loadCloud: () => {},
    keepLocalCaptureEnv: () => {},
    modePlan: () => ({ kind: "cloud", stopCapture: false, stopWeb: false, recreateWindow: false, start: ["capture"] }),
    start: key => calls.push(`start:${key}`), stopWeb: async () => {}, recreateWindow: () => {}, refresh: () => {},
    win: { isDestroyed: () => false, loadURL: async url => { calls.push(`load:${url}`) } },
    cloudOrigin: () => "https://library.test", isCloudRoute: () => true,
    makeLog: () => ({ end: async () => {} }),
    sendToSettings: (channel, event) => calls.push({ channel, event }),
    onCloudEvent: (run, event) => {
      calls.push({ progress: event })
      if (event.event === "result") { context.cloudResult = event; run.resultSeen = true }
    },
    runEngine: options => {
      calls.push("engine")
      if (launchError) throw launchError
      engine = options
      return { child: {}, exited: exited.promise, cancel: () => { calls.push("cancel-engine"); return true } }
    },
    retryRun: () => retryArgs({ mode: currentMode, failed: context.failedRun, answers: {} }),
    trustedSettingsSender: event => event?.trusted === true,
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
  })
  for (const name of ["applyMode", "finishCloudRun", "startCloudRun", "registerCloudIpc"]) vm.runInContext(functionSource(name), context)
  context.registerCloudIpc()
  return {
    context, calls, drained, handlers,
    mode: value => { currentMode = value }, available: value => { available = value }, failLaunch: error => { launchError = error },
    update: event => handlers.get("snip:cloud-update")(event ?? { trusted: true }),
    async finish(ok, code = ok ? "OK" : "FAILED") {
      assert.ok(engine, "engine started")
      engine.onEvent({ v: 1, event: "result", ok, code, mode: "cloud" })
      engine.onExit({ code: ok ? 0 : 1 })
      exited.resolve()
      await flush()
    },
  }
}

test("Update cloud is trusted Settings-only, requires a connected library, and exposes no generic command", async () => {
  const s = setup()
  assert.equal((await s.update({ trusted: false })).error, "untrusted")
  s.mode("local")
  assert.equal((await s.update()).error, "No cloud library is connected.")
  s.mode("cloud"); s.available(false)
  assert.equal((await s.update()).code, "UNSUPPORTED")
  assert.deepEqual(s.calls, [])
})

test("updating waits for capture to drain, reserves the operation, and restarts only after verified success", async () => {
  const s = setup()
  const pending = s.update()
  assert.equal(s.context.cloudRun.command, "deploy")
  assert.equal(s.context.autoCapture, false)
  assert.ok(s.calls.includes("drain"))
  assert.equal(s.calls.includes("engine"), false)
  assert.equal((await s.update()).error, "busy")
  s.drained.resolve()
  assert.equal((await pending).started, true)
  assert.ok(s.calls.indexOf("drain") < s.calls.indexOf("engine"))
  assert.equal(s.calls.includes("start:capture"), false)
  await s.finish(true)
  assert.equal(s.context.autoCapture, true)
  assert.equal(s.context.failedRun, null)
  assert.ok(s.calls.includes("start:capture"))
  assert.ok(s.calls.includes("load:https://library.test/r/one"))
})

test("cancel while draining makes no cloud changes and leaves a retryable update", async () => {
  const s = setup()
  const pending = s.update()
  const waiting = s.context.cloudRun.exited
  assert.equal((await s.handlers.get("snip:cloud-cancel")({ trusted: true })).cancelled, true)
  s.drained.resolve()
  await pending
  await waiting
  assert.equal(s.calls.includes("engine"), false)
  assert.equal(s.calls.includes("start:capture"), false)
  assert.equal(s.context.cloudRun, null)
  assert.equal(s.context.failedRun[0], "deploy")
})

test("failed and cancelled deployments keep captures paused, and Retry repeats deploy", async () => {
  for (const resultCode of ["FAILED", "CANCELLED"]) {
    const s = setup()
    s.drained.resolve()
    await s.update()
    await s.finish(false, resultCode)
    assert.equal(s.context.autoCapture, false)
    assert.equal(s.calls.includes("start:capture"), false)
    assert.equal(s.context.failedRun[0], "deploy")
    await s.handlers.get("snip:cloud-retry-step")({ trusted: true })
    assert.equal(s.context.cloudRun.command, "deploy")
    await s.finish(true)
    assert.ok(s.calls.includes("start:capture"))
  }
})

test("a draining or engine-launch failure releases the operation and keeps capture paused", async () => {
  for (const fail of ["drain", "engine"]) {
    const s = setup()
    if (fail === "engine") s.failLaunch(new Error("Could not launch"))
    const pending = s.update()
    const waiting = s.context.cloudRun.exited
    if (fail === "drain") s.drained.reject(new Error("Could not drain"))
    else s.drained.resolve()
    assert.match((await pending).error, /Could not/)
    await waiting
    assert.equal(s.context.cloudRun, null)
    assert.equal(s.context.autoCapture, false)
    assert.equal(s.context.failedRun[0], "deploy")
    const result = s.calls.find(call => call.progress?.event === "result")?.progress
    assert.equal(result.ok, false)
    assert.equal(result.retryable, true)
    assert.match(result.message, /Could not/)
  }
})

test("unrelated cloud operations cannot undo a failed update's capture pause", async () => {
  for (const next of [{ command: "snapshot", subcommand: "delete-export", ok: true }, { command: "pull", ok: false }]) {
    const s = setup()
    s.drained.resolve()
    await s.update()
    await s.finish(false)
    await s.context.startCloudRun(next.command, {}, next.subcommand)
    await s.finish(next.ok)
    assert.equal(s.context.autoCapture, false)
    assert.equal(s.context.cloudUpdatePending, true)
    assert.equal(s.calls.includes("start:capture"), false)
    await s.update()
    await s.finish(true)
    assert.equal(s.context.cloudUpdatePending, false)
    assert.ok(s.calls.includes("start:capture"))
  }
})

test("quitting while draining never launches a deployment", async () => {
  const s = setup()
  const pending = s.update()
  s.context.quitting = true
  s.drained.resolve()
  await pending
  assert.equal(s.calls.includes("engine"), false)
  assert.equal(s.calls.includes("start:capture"), false)
})

test("the Settings preload maps update to its fixed IPC with no caller arguments", async () => {
  const calls = []
  let bridge
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../preload-settings.cjs"), "utf8"), {
    require: id => {
      assert.equal(id, "electron")
      return { contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value } }, ipcRenderer: { invoke: (...args) => calls.push(args) } }
    },
  })
  bridge.update({ command: "delete-resources" })
  assert.deepEqual(plain(calls), [["snip:cloud-update", {}]])
})
