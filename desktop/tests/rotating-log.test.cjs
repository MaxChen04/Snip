const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { createLog } = require("../rotating-log.cjs")

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "snip-log-test-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return path.join(root, "logs", "app.log")
}

test("rotates to the configured count and caps oversized chunks", async t => {
  const file = setup(t)
  const log = createLog(file, { maxBytes: 256, backups: 2 })
  log.write("a".repeat(180)); log.write("b".repeat(180)); log.write("c".repeat(180))
  log.write("old line\n".repeat(1000) + "latest line\n")
  await log.end()
  const names = fs.readdirSync(path.dirname(file))
  assert.ok(names.length <= 3)
  for (const name of names) assert.ok(fs.statSync(path.join(path.dirname(file), name)).size <= 256)
  const newest = fs.readFileSync(file, "utf8")
  assert.match(newest, /log output dropped/)
  assert.match(newest, /latest line/)
})

test("caps pending output and records a drop while preserving recent output", async t => {
  const file = setup(t)
  const log = createLog(file, { maxBytes: 256, backups: 2 })
  for (let i = 0; i < 10000; i++) log.write(`line ${i}\n`)
  await log.end("last line\n")
  const content = fs.readdirSync(path.dirname(file)).map(name => fs.readFileSync(path.join(path.dirname(file), name), "utf8")).join("")
  assert.match(content, /log output dropped/)
  assert.match(content, /last line/)
  for (const name of fs.readdirSync(path.dirname(file))) assert.ok(fs.statSync(path.join(path.dirname(file), name)).size <= 256)
})

test("contains write failures and reports them without rejecting end", async () => {
  const errors = []
  const log = createLog("/dev/null/app.log", { onError: error => errors.push(error) })
  log.write("data")
  await log.end()
  assert.equal(errors.length, 1)
})
