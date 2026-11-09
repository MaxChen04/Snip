const test = require("node:test")
const assert = require("node:assert/strict")
const { EventEmitter } = require("node:events")
const fs = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")
const { fileURLToPath } = require("node:url")
const { Updates, releaseFrom, newer, latestRelease, CHECK_INTERVAL } = require("../updates.cjs")

const release = (version = "1.2.0") => ({ tag_name: `v${version}`, draft: false, prerelease: false, assets: [{
  name: `Snip-${version}-darwin-arm64.zip`, state: "uploaded", size: 123,
  browser_download_url: `https://github.com/MaxChen04/Snip/releases/download/v${version}/Snip-${version}-darwin-arm64.zip`, digest: `sha256:${"a".repeat(64)}`,
}] })
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const nightlyRelease = (build = 42) => {
  const version = `0.0.${build}`, name = `Snip-Dev-${version}-darwin-arm64.zip`
  return { tag_name: `nightly-v${version}`, draft: false, prerelease: true, assets: [{ name, state: 'uploaded', size: 123,
    browser_download_url: `https://github.com/MaxChen04/Snip/releases/download/nightly-v${version}/${name}`, digest: `sha256:${'a'.repeat(64)}` }] }
}
async function setup(t, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "snip-updates-"))
  const calls = []
  const native = new EventEmitter()
  native.setFeedURL = value => calls.push(["feed", value])
  native.checkForUpdates = () => calls.push(["download"])
  native.quitAndInstall = () => calls.push(["install"])
  const scheduled = new Set()
  const timers = { setTimeout: (fn, ms) => { const timer = { fn, ms, unref() {} }; scheduled.add(timer); return timer }, clearTimeout: timer => scheduled.delete(timer) }
  const updates = new Updates({ native, directory, version: "1.0.0", enabled: true, fetchRelease: async () => release(), drain: async () => calls.push(["drain"]), timers, ...overrides })
  t.after(async () => { updates.dispose(); await fs.rm(directory, { recursive: true, force: true }) })
  return { updates, native, calls, directory, scheduled }
}

test("only complete stable Apple Silicon releases from this repository can update forward", () => {
  assert.equal(newer("1.10.0", "1.9.0"), true)
  for (const v of ["1.0.0", "0.9.9", "1.1.0-beta", "01.2.0", "9007199254740993.0.0"]) assert.equal(newer(v, "1.0.0"), false)
  assert.equal(releaseFrom({ ...release(), draft: true }, "1.0.0"), null)
  assert.equal(releaseFrom({ ...release(), prerelease: true }, "1.0.0"), null)
  assert.equal(releaseFrom(release("1.0.0"), "1.0.0"), null)
  for (const change of [{ digest: null }, { size: -1 }, { browser_download_url: "https://example.com/update.zip" }, { name: "Snip-1.2.0-darwin-x64.zip" }]) {
    const value = release(); Object.assign(value.assets[0], change)
    assert.throws(() => releaseFrom(value, "1.0.0"), /complete, verified/)
  }
})

test("discovery never downloads automatically and concurrent checks share one request", async t => {
  const gate = deferred(); let requested = 0
  const { updates, calls } = await setup(t, { fetchRelease: () => { requested++; return gate.promise } })
  const check = updates.check()
  await updates.check()
  assert.equal(requested, 1)
  assert.equal(updates.phase, "checking")
  gate.resolve(release()); await check
  assert.equal(updates.phase, "available")
  assert.deepEqual(calls, [])
})

test("download stages a pinned checksum and waits for capture drain before install", async t => {
  const drain = deferred()
  const { updates, native, calls } = await setup(t, { drain: () => drain.promise })
  await updates.check()
  await Promise.all([updates.download(), updates.download()])
  assert.equal(calls.filter(c => c[0] === "download").length, 1)
  const feed = JSON.parse(await fs.readFile(fileURLToPath(calls[0][1].url), "utf8"))
  assert.equal(feed.sha256, "a".repeat(64))
  assert.equal(feed.size, 123)
  native.emit("update-downloaded")
  assert.equal(updates.phase, "ready")
  const install = updates.install()
  await updates.install()
  assert.equal(calls.some(c => c[0] === "install"), false)
  drain.resolve(); await install
  assert.equal(calls.filter(c => c[0] === "install").length, 1)
})

test("download errors preserve the running version and allow retry", async t => {
  const { updates, native, calls } = await setup(t)
  await updates.check(); await updates.download()
  native.emit("error", new Error("invalid signature or lost connection"))
  assert.equal(updates.phase, "error")
  assert.equal(calls.some(c => c[0] === "drain" || c[0] === "install"), false)
  await updates.download()
  assert.equal(updates.phase, "downloading")
  assert.equal(calls.filter(c => c[0] === "download").length, 2)
})

test("native installation failure restores services instead of leaving a stopped app", async t => {
  let restored = 0
  const { updates, native } = await setup(t, { installFailed: async () => { restored++ } })
  await updates.check(); await updates.download(); native.emit("update-downloaded")
  await updates.install()
  native.emit("error", new Error("installation failed"))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(restored, 1)
  assert.equal(updates.phase, "ready")
  assert.match(updates.error, /could not restart/)
})

test("checks are sparse, persisted across restarts, and disabled for unsigned builds", async t => {
  const clock = 10 * CHECK_INTERVAL
  const { updates, directory, scheduled } = await setup(t, { now: () => clock })
  await updates.start()
  assert.equal([...scheduled][0].ms, 60000)
  await updates.check()
  assert.equal([...scheduled].length, 1)
  assert.equal([...scheduled][0].ms, CHECK_INTERVAL)
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, "state.json"), "utf8")), { lastCheck: clock })
  updates.dispose()
  const disabled = await setup(t, { enabled: false, fetchRelease: () => { throw new Error("must not request") } })
  await disabled.updates.start(); await disabled.updates.check(); disabled.updates.resume()
  assert.equal(disabled.scheduled.size, 0)
  assert.equal(disabled.native.eventNames().length, 0)
  assert.equal(disabled.updates.phase, "disabled")
})

test("an update error during drain waits before recovery and does not install", async t => {
  const drain = deferred(); let restored = 0
  const { updates, native, calls } = await setup(t, { drain: () => drain.promise, installFailed: () => { restored++ } })
  await updates.check(); await updates.download(); native.emit("update-downloaded")
  const installing = updates.install()
  native.emit("error", new Error("staged update unavailable"))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(restored, 0)
  drain.resolve(); await installing
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(restored, 1)
  assert.equal(calls.some(c => c[0] === "install"), false)
  assert.equal(updates.phase, "ready")
})

test("disposal prevents a late discovery result from notifying or scheduling", async t => {
  const gate = deferred()
  const { updates, scheduled } = await setup(t, { fetchRelease: () => gate.promise })
  const checking = updates.check(); updates.dispose(); gate.resolve(release()); await checking
  assert.equal(scheduled.size, 0)
  assert.equal(updates.release, null)
})

test("metadata errors are bounded and private or absent releases do not look up to date", async () => {
  await assert.rejects(latestRelease(async () => new Response("not found", { status: 404 })), /No public Snip release/)
  await assert.rejects(latestRelease(async () => new Response("x".repeat(1024 * 1024 + 1))), /unexpected response/)
  const value = await latestRelease(async (url, options) => {
    assert.equal(url, "https://api.github.com/repos/MaxChen04/Snip/releases/latest")
    assert.equal(options.redirect, "error")
    assert.equal(options.headers.authorization, undefined)
    return Response.json(release())
  })
  assert.equal(value.tag_name, "v1.2.0")
})

test('channels never cross over and nightly builds only advance', () => {
  assert.equal(releaseFrom(nightlyRelease(), '0.0.1'), null)
  assert.equal(releaseFrom(release(), '0.0.1', 'nightly'), null)
  assert.equal(releaseFrom(nightlyRelease(41), '0.0.42', 'nightly'), null)
  assert.equal(releaseFrom(nightlyRelease(42), '0.0.42', 'nightly'), null)
  assert.equal(releaseFrom(nightlyRelease(43), '0.0.42', 'nightly').version, '0.0.43')
  assert.equal(releaseFrom({ ...nightlyRelease(), draft: true }, '0.0.1', 'nightly'), null)
  assert.equal(releaseFrom({ ...nightlyRelease(), prerelease: false }, '0.0.1', 'nightly'), null)
  for (const change of [{ name: 'Snip-0.0.42-darwin-arm64.zip' }, { browser_download_url: 'https://example.com/nightly.zip' }, { digest: null }]) {
    const value = nightlyRelease(); Object.assign(value.assets[0], change)
    assert.throws(() => releaseFrom(value, '0.0.1', 'nightly'), /complete, verified/)
  }
})

test('nightly discovery skips stable releases, drafts and unrelated previews', async () => {
  const value = await latestRelease(async (url, options) => {
    assert.match(url, /releases\?per_page=20&page=1$/)
    assert.equal(options.redirect, 'error')
    return Response.json([release(), { ...nightlyRelease(100), draft: true }, { ...nightlyRelease(90), tag_name: 'beta-v0.0.90' }, nightlyRelease(9), nightlyRelease(12)])
  }, 'nightly')
  assert.equal(value.tag_name, 'nightly-v0.0.12')
  await assert.rejects(latestRelease(async () => Response.json([]), 'nightly'), /No public Snip Dev nightly/)
  const urls = []
  const paged = await latestRelease(async url => {
    urls.push(url)
    return Response.json(urls.length === 1 ? Array(20).fill(release()) : [nightlyRelease()])
  }, 'nightly')
  assert.equal(paged.tag_name, 'nightly-v0.0.42')
  assert.match(urls[1], /page=2$/)
})

test('unsigned nightlies discover updates but never invoke the native installer', async t => {
  const { updates, native, calls } = await setup(t, { channel: 'nightly', version: '0.0.1', nativeEnabled: false, fetchRelease: async () => nightlyRelease() })
  await updates.check()
  assert.equal(updates.phase, 'available')
  assert.equal(updates.release.version, '0.0.42')
  await updates.download(); await updates.install()
  assert.deepEqual(calls, [])
  assert.equal(native.eventNames().length, 0)
})
