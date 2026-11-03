const test = require("node:test")
const assert = require("node:assert/strict")
const { EventEmitter } = require("node:events")
const { Service, stopServices } = require("../service.cjs")

function fixture(key = "web", { missing = false, development = false } = {}) {
  const children = [], kills = [], output = [], logs = []
  const service = new Service(key, {
    kill: (...args) => kills.push(args),
    spawnProcess() {
      const child = new EventEmitter()
      Object.assign(child, { pid: missing ? undefined : 100 + children.length, stdout: new EventEmitter(), stderr: new EventEmitter(), connected: true })
      child.send = message => output.push(message)
      child.kill = signal => output.push(signal)
      children.push(child)
      return child
    },
  })
  const start = () => service.start({ executable: "/node", args: [], cwd: "/repo", env: {}, development, log: { write(chunk) { logs.push(chunk.toString()) }, end(chunk) { logs.push(chunk) } } })
  start()
  return { service, children, kills, output, logs, start }
}

test("a failed spawn can be retried and old close events cannot clear the new child", () => {
  const f = fixture("web", { missing: true })
  const old = f.children[0]
  old.emit("error", new Error("ENOENT"))
  assert.equal(f.service.status, "crashed")
  assert.equal(f.service.proc, null)
  f.start()
  old.emit("close", -2)
  assert.equal(f.service.proc, f.children[1])
  assert.deepEqual(f.kills, [])
})

test("IPC readiness and connectivity describe usable services rather than spawned processes", () => {
  const f = fixture("capture")
  assert.equal(f.service.status, "starting")
  f.children[0].emit("message", { type: "snip:capture-status", state: "disconnected", error: "Token rejected" })
  assert.equal(f.service.status, "disconnected")
  f.children[0].emit("message", { type: "snip:capture-status", state: "idle" })
  assert.equal(f.service.status, "idle")
  void f.service.stop()
  f.children[0].emit("message", { type: "snip:capture-status", state: "idle" })
  assert.equal(f.service.status, "stopping")
  assert.deepEqual(f.output, [{ type: "snip:stop" }])
})

test("development readiness accepts split output and only loopback HTTP URLs", () => {
  const f = fixture("web", { development: true })
  f.service.ready("https://example.com")
  assert.equal(f.service.status, "starting")
  f.children[0].stdout.emit("data", Buffer.from("Local: http://local"))
  // A partial hostname is rejected, then the accumulated complete line succeeds.
  assert.equal(f.service.status, "starting")
  f.children[0].stdout.emit("data", Buffer.from("host:51"))
  assert.equal(f.service.status, "starting")
  f.children[0].stdout.emit("data", Buffer.from("73/\n"))
  assert.equal(f.service.url, "http://localhost:5173")
  void f.service.stop()
  assert.deepEqual(f.output, ["SIGTERM"])
})

test("exit sweeps descendants immediately and close retains trailing crash output", async () => {
  const f = fixture()
  const child = f.children[0]
  let completed = false
  void f.service.closed.then(() => { completed = true })
  child.emit("exit", 1, null)
  assert.deepEqual(f.kills, [[-100, "SIGKILL"]])
  assert.equal(f.service.proc, child)
  child.stderr.emit("data", Buffer.from("fatal configuration error\n"))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(completed, false)
  child.emit("close", 1, null)
  await f.service.closed
  assert.equal(f.service.status, "crashed")
  assert.equal(f.service.detail, "fatal configuration error")
  assert.match(f.logs.join(""), /fatal configuration error/)
  assert.deepEqual(f.kills, [[-100, "SIGKILL"]])
})

test("shutdown waits for a slow capture before stopping the backend", async () => {
  const capture = fixture("capture"), web = fixture("web")
  let complete = false
  const stopping = stopServices(capture.service, web.service, { webTimeoutMs: 20 }).then(() => { complete = true })
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(complete, false)
  assert.deepEqual(web.output, [])
  assert.deepEqual(capture.kills, [])
  capture.children[0].emit("exit", 0, null)
  capture.children[0].emit("close", 0, null)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(web.output, [{ type: "snip:stop" }])
  web.children[0].emit("exit", 0, null)
  web.children[0].emit("close", 0, null)
  await stopping
  assert.equal(complete, true)
})
