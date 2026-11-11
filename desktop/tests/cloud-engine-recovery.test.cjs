// Recovery regressions for desktop/cloud-engine.cjs (runEngine). Each test asserts the
// CORRECT behaviour, so it fails today and passes once the matching bug is fixed.
// The "engine" is a throwaway child script chosen through SNIP_CLOUD_ENGINE.
const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { runEngine } = require("../cloud-engine.cjs")

const APP = "/Applications/Snip.app/Contents/Resources/app"

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snip-engine-recovery-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function start(dir, script, { onEvent, onExit }) {
  const engine = path.join(dir, "engine.cjs")
  fs.writeFileSync(engine, script)
  return runEngine({
    appDir: APP, root: dir, dataRoot: dir, command: "setup",
    baseEnv: { ...process.env }, env: { ...process.env, SNIP_CLOUD_ENGINE: engine },
    onEvent, onExit,
  })
}

// ---------------------------------------------------------------------------
// 6. Cancel during a long step produces no result event
// ---------------------------------------------------------------------------
test("BUG 6: a cancelled run whose child dies without a result still ends with a CANCELLED result before onExit", async t => {
  const dir = scratch(t)
  // A child stuck inside a long step: it ignores SIGINT (the real CLI only checks a flag
  // between steps) and never prints a result. Only SIGKILL after the grace ends it.
  const script = `
    process.on("SIGINT", () => {})
    process.stdout.write(JSON.stringify({ v: 1, event: "step", step: "import", status: "started", message: "Copying" }) + "\\n")
    setInterval(() => {}, 1000)
  `
  const timeline = []
  let started
  const sawStep = new Promise(resolve => (started = resolve))
  const exited = new Promise(resolve => {
    const run = start(dir, script, {
      onEvent: event => {
        timeline.push({ kind: "event", event })
        if (event.event === "step") started()
      },
      onExit: info => {
        timeline.push({ kind: "exit", info })
        resolve(info)
      },
    })
    sawStep.then(() => run.cancel())
    t.after(() => {
      try {
        run.child.kill("SIGKILL")
      } catch {}
    })
  })
  const info = await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error("the run never finished")), 20_000).unref())])
  assert.equal(info.cancelled, true, "harness check: the exit says it was cancelled")
  const exitAt = timeline.findIndex(entry => entry.kind === "exit")
  const results = timeline.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.kind === "event" && entry.event.event === "result")
  assert.equal(results.length, 1, `the consumer must receive exactly one terminal result event; it saw: ${JSON.stringify(timeline.map(entry => (entry.kind === "exit" ? "exit" : entry.event.event)))}`)
  assert.ok(results[0].index < exitAt, "the result arrives before onExit")
  assert.equal(results[0].entry.event.ok, false)
  assert.equal(results[0].entry.event.code, "CANCELLED")
})

// ---------------------------------------------------------------------------
// 7. runEngine finishes only on 'close'
// ---------------------------------------------------------------------------
test("BUG 7: onExit fires within 3s of the child exiting even if a grandchild holds the stdio pipes", async t => {
  const dir = scratch(t)
  const pidFile = path.join(dir, "grandchild.pid")
  // The child hands its stdio to a grandchild that sleeps for 8s, prints a result and exits
  // at once. The pipes stay open because of the grandchild, so 'close' does not fire.
  const script = `
    const { spawn } = require("node:child_process")
    const fs = require("node:fs")
    const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 8000)"], { stdio: "inherit", detached: true })
    fs.writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid))
    grandchild.unref()
    process.stdout.write(JSON.stringify({ v: 1, event: "result", ok: true, code: "OK", mode: "cloud" }) + "\\n")
  `
  let childExitedAt = null
  let exitedAt = null
  let grandchildPid = 0
  const done = new Promise(resolve => {
    const run = start(dir, script, {
      onEvent: () => {},
      onExit: () => {
        exitedAt = Date.now()
        resolve()
      },
    })
    run.child.once("exit", () => {
      childExitedAt = Date.now()
    })
    t.after(() => {
      try {
        run.child.kill("SIGKILL")
      } catch {}
      try {
        process.kill(grandchildPid, "SIGKILL")
      } catch {}
    })
  })
  await Promise.race([done, new Promise(resolve => setTimeout(resolve, 3000))])
  grandchildPid = Number(fs.readFileSync(pidFile, "utf8"))
  assert.ok(childExitedAt, "harness check: the child process exited")
  assert.ok(exitedAt, "onExit must fire within 3s of the child exiting; the grandchild still holds the pipes so 'close' has not fired")
  assert.ok(exitedAt - childExitedAt < 3000)
})
