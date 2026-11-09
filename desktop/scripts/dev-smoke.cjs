// Verify the installed source launcher and hot reload use one isolated test library.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { _electron } = require('playwright')
const { prepareRuntimeLayout } = require('../runtime-layout.cjs')
const ROOT = path.resolve(__dirname, '../..')

async function main() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'snip-dev-smoke-'))
  const profile = path.join(temp, 'Snip Dev')
  const reservation = http.createServer()
  await new Promise(resolve => reservation.listen(0, 'localhost', resolve))
  const port = reservation.address().port
  await new Promise(resolve => reservation.close(resolve))
  const origin = `http://localhost:${port}`
  const layout = prepareRuntimeLayout({ root: ROOT, userData: profile, isolated: true, port })
  const credentials = await fs.readFile(layout.webEnvPath, 'utf8')
  const sourceEnv = await fs.readFile(path.join(ROOT, 'web/.dev.vars'), 'utf8').catch(() => null)
  const env = { ...process.env, SNIP_DESKTOP_PROFILE: profile, SNIP_DESKTOP_PORT: String(port), WRANGLER_SEND_METRICS: 'false', WRANGLER_WRITE_LOGS: 'false' }
  delete env.ELECTRON_RUN_AS_NODE
  let application
  try {
    application = await _electron.launch({ executablePath: path.join(ROOT, 'desktop/dist/Snip Dev-darwin-arm64/Snip Dev.app/Contents/MacOS/Snip Dev'), env })
    let page = await application.firstWindow()
    await page.waitForURL(`${origin}/`, { timeout: 120000 })
    assert.equal(await application.evaluate(({ app }) => app.getName()), 'Snip Dev')
    assert.equal(await application.evaluate(({ app }) => app.getPath('userData')), profile)
    assert.equal(await application.evaluate(({ app }) => app.getPath('sessionData')), profile)
    assert.equal((await page.evaluate(() => fetch('/api/me').then(r => r.json()))).login, 'local')
    assert.equal((await page.evaluate(() => fetch('/api/references').then(r => r.json()))).items.length, 0)
    // A collection is durable without starting an external capture.
    const collection = await page.evaluate(() => fetch('/api/collections', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Nightly isolation smoke' }) }).then(r => r.json()))
    assert.ok(collection.id, JSON.stringify(collection))
    const closed = application.waitForEvent('close')
    await application.evaluate(({ app }) => app.quit()); await closed
    application = null
    application = await _electron.launch({ executablePath: require('../node_modules/electron'), args: [path.join(ROOT, 'desktop'), '--dev'], env })
    page = await application.firstWindow()
    await page.waitForURL(`${origin}/`, { timeout: 120000 })
    const collections = await page.evaluate(() => fetch('/api/collections').then(r => r.json()))
    assert.ok(collections.some(item => item.id === collection.id), JSON.stringify(collections))
    assert.equal(await fs.readFile(layout.webEnvPath, 'utf8'), credentials)
    assert.equal(await fs.readFile(path.join(ROOT, 'web/.dev.vars'), 'utf8').catch(() => null), sourceEnv)
    assert.equal(JSON.parse(await fs.readFile(layout.pointerPath, 'utf8')).path, path.join(profile, 'library'))
    console.log('PASS Snip Dev launcher and hot reload share an isolated test library, preserve credentials and keep source credentials untouched')
    console.log(`Evidence profile: ${profile}`)
  } catch (error) {
    if (application) for (const page of application.windows()) console.error('WINDOW', page.url(), await page.locator('body').innerText().catch(() => 'unavailable'))
    for (const name of ['web', 'capture']) console.error(await fs.readFile(path.join(profile, 'logs', `${name}.log`), 'utf8').catch(() => ''))
    throw error
  } finally {
    if (application) await application.close().catch(() => {})
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
