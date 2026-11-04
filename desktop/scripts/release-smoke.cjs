// Exercise the unmodified standalone bundle with a disposable profile/library.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { _electron } = require('playwright')
const { prepareRuntimeLayout } = require('../runtime-layout.cjs')
const { execFile } = require('node:child_process')
const run = require('node:util').promisify(execFile)

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return server.address().port
}
async function main() {
  const bundle = path.resolve(process.argv[2] || path.join(__dirname, '../dist/Snip-darwin-arm64/Snip.app'))
  await run('codesign', ['--verify', '--deep', '--strict', bundle])
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'snip-release-smoke-'))
  const profile = path.join(temp, 'profile')
  const reservation = http.createServer()
  const port = await listen(reservation)
  await new Promise(resolve => reservation.close(resolve))
  const resourcesPath = path.join(bundle, 'Contents/Resources')
  const layout = prepareRuntimeLayout({ release: true, resourcesPath, userData: profile, port })
  await fs.appendFile(layout.captureEnvPath, 'POLL_SECONDS=1\nBROWSER_IDLE_SECONDS=2\nSCROLL_MAX_FRAMES=20\n')
  const originalSettings = await fs.readFile(layout.webEnvPath, 'utf8')
  const fixture = http.createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<html><head><title>Release capture fixture</title></head><body style="height:1800px;background:linear-gradient(#fce8bb,#617cde)"><h1>Portable Snip runtime</h1></body></html>') })
  const fixturePort = await listen(fixture)
  let application, moved = false
  const movedBundle = path.join(temp, 'Updated Snip.app')
  const origin = `http://localhost:${port}`
  const launch = location => _electron.launch({ executablePath: path.join(location, 'Contents/MacOS/Snip'), env: { ...process.env, SNIP_DESKTOP_PROFILE: profile, SNIP_DESKTOP_PORT: String(port), WRANGLER_SEND_METRICS: 'false', WRANGLER_WRITE_LOGS: 'false' }, timeout: 30000 })
  try {
    application = await launch(bundle)
    let page = await application.firstWindow()
    await page.waitForURL(`${origin}/`, { timeout: 120000 })
    assert.equal((await page.evaluate(() => fetch('/api/me').then(r => r.json()))).login, 'local')
    assert.equal(await application.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('snip-update').label), 'Check for updates…')
    const ref = await page.evaluate(async url => fetch('/api/references', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url, mode: 'single' }) }).then(r => r.json()), `http://127.0.0.1:${fixturePort}`)
    let detail
    const deadline = Date.now() + 90000
    while (Date.now() < deadline) {
      detail = await page.evaluate(id => fetch(`/api/references/${id}`).then(r => r.json()), ref.id)
      if (detail.reference.status === 'ready') break
      assert.notEqual(detail.reference.status, 'failed', detail.reference.error)
      await new Promise(resolve => setTimeout(resolve, 300))
    }
    assert.equal(detail.reference.status, 'ready')
    const key = detail.pages[0].desktopKey
    assert.equal(await page.evaluate(key => fetch(`/files/${key}`).then(r => r.status), key), 200)
    await page.goto(`${origin}/r/${ref.id}`)
    const closed = application.waitForEvent('close')
    await application.evaluate(({ app }) => app.quit())
    await closed
    application = null
    // A replacement bundle location must use the same external library/settings.
    await fs.rename(bundle, movedBundle); moved = true
    application = await launch(movedBundle)
    page = await application.firstWindow()
    await page.waitForURL(`${origin}/r/${ref.id}`, { timeout: 120000 })
    assert.equal((await page.evaluate(id => fetch(`/api/references/${id}`).then(r => r.json()), ref.id)).pages[0].desktopKey, key)
    assert.equal(await page.evaluate(key => fetch(`/files/${key}`).then(r => r.status), key), 200)
    assert.equal(await fs.readFile(layout.webEnvPath, 'utf8'), originalSettings)
    assert.equal(JSON.parse(await fs.readFile(path.join(profile, 'library-location.json'), 'utf8')).path, layout.dataRoot)
    console.log('PASS bundled Node/Chromium captures into external D1/R2; moving/restarting the bundle preserves library, credentials and reference route')
    console.log(`Evidence profile: ${profile}`)
  } catch (error) {
    if (application) for (const page of application.windows()) console.error('WINDOW', page.url(), await page.locator('body').innerText().catch(() => 'unavailable'))
    for (const name of ['web', 'capture']) console.error(await fs.readFile(path.join(profile, 'logs', `${name}.log`), 'utf8').catch(() => ''))
    throw error
  } finally {
    if (application) await application.close().catch(() => {})
    if (moved) await fs.rename(movedBundle, bundle)
    await new Promise(resolve => fixture.close(resolve))
    await run('codesign', ['--verify', '--deep', '--strict', bundle])
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
