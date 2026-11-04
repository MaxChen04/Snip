const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")
const { SourceUpdates, repositoryFrom, comparison } = require("../source-updates.cjs")

const timers = { setTimeout: () => ({ unref() {} }), clearTimeout() {} }
const response = (status, body) => ({ status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body), body: { cancel: async () => {} } })
function setup(t, { branch = "main", remote = "https://github.com/MaxChen04/Snip.git", reply = response(200, { status: "identical", ahead_by: 0, commits: [] }) } = {}) {
  const urls = []
  const git = async (...args) => args[0] === "rev-parse" ? (args[1] === "--abbrev-ref" ? branch : "a".repeat(40)) : remote
  const updates = new SourceUpdates({ root: "/repo", git, timers, fetcher: async url => { urls.push(url); return typeof reply === "function" ? reply() : reply } })
  t.after(() => updates.dispose())
  return { updates, urls }
}

test("reads owner/name from https and ssh GitHub remotes", () => {
  assert.equal(repositoryFrom("https://github.com/MaxChen04/Snip.git"), "MaxChen04/Snip")
  assert.equal(repositoryFrom("git@github.com:someone/snip-fork.git\n"), "someone/snip-fork")
  assert.equal(repositoryFrom("https://gitlab.com/a/b"), null)
})

test("summarizes commits main has beyond the checkout, newest first", () => {
  const commits = Array.from({ length: 7 }, (_, i) => ({ sha: `s${i}`, commit: { message: `Change ${i}\n\nbody` } }))
  const result = comparison({ status: "ahead", ahead_by: 7, commits })
  assert.equal(result.behind, 7)
  assert.equal(result.head, "s6")
  assert.deepEqual(result.commits, ["Change 6", "Change 5", "Change 4", "Change 3", "Change 2"])
  assert.equal(comparison({ status: "identical", ahead_by: 0 }).behind, 0)
  assert.equal(comparison({ status: "diverged", ahead_by: 2 }).diverged, true)
  assert.throws(() => comparison({}))
})

test("reports an available update against the checkout's own remote", async t => {
  const { updates, urls } = setup(t, { remote: "git@github.com:fork/Snip.git", reply: response(200, { status: "ahead", ahead_by: 2, commits: [{ sha: "x", commit: { message: "One" } }, { sha: "y", commit: { message: "Two" } }] }) })
  await updates.check()
  assert.equal(updates.phase, "available")
  assert.equal(updates.behind, 2)
  assert.equal(updates.head, "y")
  assert.equal(urls[0], `https://api.github.com/repos/fork/Snip/compare/${"a".repeat(40)}...main`)
})

test("stays quiet on other branches, unpushed commits and network failures", async t => {
  const other = setup(t, { branch: "feature" })
  await other.updates.check()
  assert.equal(other.updates.phase, "unsupported")
  assert.equal(other.urls.length, 0)
  const unknown = setup(t, { reply: response(404, {}) })
  await unknown.updates.check()
  assert.equal(unknown.updates.phase, "unsupported")
  const offline = setup(t, { reply: () => { throw new Error("offline") } })
  await offline.updates.check()
  assert.equal(offline.updates.phase, "error")
  const current = setup(t)
  await current.updates.check()
  assert.equal(current.updates.phase, "current")
})

test("launches the update script in Terminal with the resolved Node", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "snip-source-updates-"))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const { updates } = setup(t)
  const opened = []
  await updates.launch({ directory, node: "/opt/homebrew/bin/node", open: async file => { opened.push(file); return "" } })
  const file = path.join(directory, "Update Snip.command")
  assert.deepEqual(opened, [file])
  const script = await fs.readFile(file, "utf8")
  assert.match(script, /^#!\/bin\/zsh -l\ncd '\/repo' \|\| exit 1\nexport PATH='\/opt\/homebrew\/bin':"\$PATH"\n'\/opt\/homebrew\/bin\/node' scripts\/update\.mjs --relaunch\n/)
  assert.equal((await fs.stat(file)).mode & 0o777, 0o700)
  await updates.launch({ directory, open: async () => "No application" })
  assert.equal(updates.phase, "error")
})
