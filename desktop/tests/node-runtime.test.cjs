const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { resolveNode } = require("../node-runtime.cjs")

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "snip-node-test-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}
function fakeNode(dir, version, arch = "arm64") {
  fs.mkdirSync(dir, { recursive: true })
  const executable = path.join(dir, "node")
  fs.writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' '{"platform":"darwin","arch":"${arch}","version":"${version}"}'\n`, { mode: 0o755 })
  return executable
}

test("uses a valid cached node first and rejects stale or Intel entries", async t => {
  const root = setup(t)
  const cached = fakeNode(path.join(root, "cached"), "24.11.0")
  const candidate = fakeNode(path.join(root, "path"), "25.0.0")
  const cacheFile = path.join(root, "cache", "node.json")
  fs.mkdirSync(path.dirname(cacheFile))
  fs.writeFileSync(cacheFile, JSON.stringify({ executable: cached }))
  const env = { PATH: path.dirname(candidate), SHELL: "/bin/false" }
  assert.equal((await resolveNode({ cacheFile, env })).executable, cached)
  fakeNode(path.dirname(cached), "24.11.0", "x64")
  assert.equal((await resolveNode({ cacheFile, env })).executable, candidate)
  assert.equal(JSON.parse(fs.readFileSync(cacheFile)).executable, candidate)
})

test("login shell fallback finds an eligible node and returns its PATH", async t => {
  const root = setup(t)
  const tooOld = fakeNode(path.join(root, "old"), "22.17.0")
  const candidate = fakeNode(path.join(root, "login"), "22.18.0")
  const shell = path.join(root, "shell")
  fs.writeFileSync(shell, `#!/bin/sh\nprintf '\\n__SNIP_PATH__%s\\n' '${path.dirname(candidate)}'\n`, { mode: 0o755 })
  const found = await resolveNode({ cacheFile: path.join(root, "cache"), env: { PATH: path.dirname(tooOld), SHELL: shell } })
  assert.equal(found.executable, candidate)
  assert.equal(found.env.PATH, path.dirname(candidate))
})

test("missing eligible node reports an actionable error even if cache cannot be written", async t => {
  const root = setup(t)
  fakeNode(path.join(root, "old"), "24.10.0")
  await assert.rejects(resolveNode({ cacheFile: path.join(root, "absent", "cache"), env: { PATH: path.join(root, "old"), SHELL: "/bin/false" } }), /native Apple Silicon Node/)
  const candidate = fakeNode(path.join(root, "new"), "25.0.0")
  assert.equal((await resolveNode({ cacheFile: "/dev/null/cache", env: { PATH: path.dirname(candidate) } })).executable, candidate)
})
