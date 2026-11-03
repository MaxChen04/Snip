import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test as nodeTest } from "node:test"
import { installApp } from "../install.mjs"

// These exercise real macOS bundle identity checks through plutil.
const test = (name, fn) => nodeTest(name, { skip: process.platform !== "darwin" && "macOS bundle identity checks" }, fn)

function bundle(dir, id, marker) {
  fs.mkdirSync(path.join(dir, "Contents"), { recursive: true })
  fs.writeFileSync(path.join(dir, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string></dict></plist>`)
  fs.writeFileSync(path.join(dir, "marker"), marker)
}

function setup(t, existing = "dev.snip.desktop") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "snip-installer-test-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const built = path.join(root, "built.app")
  const apps = path.join(root, "Applications")
  const target = path.join(apps, "Snip.app")
  fs.mkdirSync(apps)
  bundle(built, "dev.snip.desktop", "new")
  if (existing) bundle(target, existing, "old")
  const options = { copy: (src, dst) => fs.cpSync(src, dst, { recursive: true }), verify: () => {} }
  return { root, built, apps, target, options }
}

test("foreign and malformed apps are never replaced", t => {
  const s = setup(t, "other.app")
  assert.throws(() => installApp(s.built, s.apps, s.options), /Refusing to replace/)
  assert.equal(fs.readFileSync(path.join(s.target, "marker"), "utf8"), "old")
  fs.writeFileSync(path.join(s.target, "Contents", "Info.plist"), "not a plist")
  assert.throws(() => installApp(s.built, s.apps, s.options), /Cannot read bundle identity/)
  fs.rmSync(path.join(s.target, "Contents", "Info.plist"))
  assert.throws(() => installApp(s.built, s.apps, s.options))
  assert.equal(fs.readFileSync(path.join(s.target, "marker"), "utf8"), "old")
})

test("a symlink target is never followed or replaced", t => {
  const s = setup(t, null)
  const other = path.join(s.root, "other.app")
  bundle(other, "dev.snip.desktop", "old")
  fs.symlinkSync(other, s.target)
  assert.throws(() => installApp(s.built, s.apps, s.options), /Unsafe app bundle path/)
  assert.equal(fs.readFileSync(path.join(other, "marker"), "utf8"), "old")
  assert.ok(fs.lstatSync(s.target).isSymbolicLink())
})

test("failed staged verification preserves the old app", t => {
  const s = setup(t)
  assert.throws(() => installApp(s.built, s.apps, { ...s.options, copy: () => { throw new Error("copy failed") } }), /copy failed/)
  assert.throws(() => installApp(s.built, s.apps, { ...s.options, verify: () => { throw new Error("invalid signature") } }), /invalid signature/)
  assert.equal(fs.readFileSync(path.join(s.target, "marker"), "utf8"), "old")
  assert.deepEqual(fs.readdirSync(s.apps), ["Snip.app"])
})

test("keeps a recoverable backup if restoring the previous app fails", t => {
  const s = setup(t)
  const rename = (src, dst) => {
    if (src.endsWith("staged.app") || src.endsWith("previous.app")) throw new Error("rename failed")
    fs.renameSync(src, dst)
  }
  assert.throws(() => installApp(s.built, s.apps, { ...s.options, rename }), /previous app could not be restored/)
  const work = fs.readdirSync(s.apps).find(name => name.startsWith(".snip-install-"))
  assert.equal(fs.readFileSync(path.join(s.apps, work, "previous.app", "marker"), "utf8"), "old")
})

test("failed replacement restores the old app", t => {
  const s = setup(t)
  const rename = (src, dst) => {
    if (src.endsWith("staged.app")) throw new Error("rename failed")
    fs.renameSync(src, dst)
  }
  assert.throws(() => installApp(s.built, s.apps, { ...s.options, rename }), /rename failed/)
  assert.equal(fs.readFileSync(path.join(s.target, "marker"), "utf8"), "old")
  assert.deepEqual(fs.readdirSync(s.apps), ["Snip.app"])
})

test("replaces our existing app and installs when absent", t => {
  const s = setup(t)
  assert.equal(installApp(s.built, s.apps, s.options), s.target)
  assert.equal(fs.readFileSync(path.join(s.target, "marker"), "utf8"), "new")
  fs.rmSync(s.target, { recursive: true })
  installApp(s.built, s.apps, s.options)
  assert.equal(fs.readFileSync(path.join(s.target, "marker"), "utf8"), "new")
  assert.deepEqual(fs.readdirSync(s.apps), ["Snip.app"])
})
