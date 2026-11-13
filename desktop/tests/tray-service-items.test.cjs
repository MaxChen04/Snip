// A cloud run stops the local Worker and pauses captures, then counts on both staying
// stopped. The tray's Start items must not undo that while the run is in flight.
//
// main.cjs needs Electron to load, so serviceItems is lifted out of its source and run
// against stand-ins for the state it reads.
const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")

const source = fs.readFileSync(path.join(__dirname, "../main.cjs"), "utf8")
const lifted = source.match(/^function serviceItems\(key\) \{\n[\s\S]*?\n\}/m)
assert.ok(lifted, "main.cjs has no serviceItems")

function items(key, { cloudRun = null, cloudUpdatePending = false, mode = "local", webStatus = "running" } = {}) {
  const service = status => ({ status, proc: null, stopping: false })
  const context = vm.createContext({
    services: { web: service(webStatus), capture: service("stopped") },
    labels: { web: "Web app", capture: "Capture agent" },
    STATUS: { stopped: "Stopped", running: "Running" },
    node: {},
    mode: () => mode,
    shutdown: null,
    quitting: false,
    cloudRun,
    cloudUpdatePending,
  })
  vm.runInContext(lifted[0], context)
  return context.serviceItems(key)
}
const enabled = (list, label) => list.find(item => item.label === label)?.enabled

test("Start web and Start capture agent are both off while a cloud run is in flight", () => {
  const run = { command: "setup" }
  assert.equal(enabled(items("web", { cloudRun: run, webStatus: "stopped" }), "Start web app"), false)
  assert.equal(enabled(items("capture", { cloudRun: run }), "Start capture agent"), false)
  // Cloud mode needs no local Worker, and its capture agent is held back the same way.
  assert.equal(enabled(items("capture", { cloudRun: run, mode: "cloud" }), "Start capture agent"), false)
})

test("the same items are on again once the run has ended", () => {
  assert.equal(enabled(items("web", { webStatus: "stopped" }), "Start web app"), true)
  assert.equal(enabled(items("capture"), "Start capture agent"), true)
  assert.equal(enabled(items("capture", { mode: "cloud", webStatus: "stopped" }), "Start capture agent"), true)
})

test("Start capture agent still waits for the local Worker in local mode", () => {
  assert.equal(enabled(items("capture", { webStatus: "stopped" }), "Start capture agent"), false)
})

test("a failed cloud update keeps Start capture agent off until cloud is verified or the owner returns to local", () => {
  assert.equal(enabled(items("capture", { cloudUpdatePending: true, mode: "cloud" }), "Start capture agent"), false)
  assert.equal(enabled(items("capture", { cloudUpdatePending: true, mode: "local" }), "Start capture agent"), true)
})
