#!/usr/bin/env node
'use strict';
// Drives the Settings window against the REAL provisioning engine, with a fake
// Cloudflare account and no network. This is the integration the fake CLI cannot
// prove: real steps, real state machine, real cloud.json, real capture retargeting.
//
// The engine's Cloudflare client is injected by design (decisions.cjs/context.cjs),
// so this harness builds the real context with a fake API and wrangler, exactly as
// desktop/tests/provision.test.cjs does, and then lets Electron spawn it like the CLI.
//
//   SNIP_CLOUD_ENGINE=desktop/tests/fixtures/real-engine-harness.cjs
//
// Set SNIP_HARNESS_PROFILE=empty for an empty library.

const fs = require('node:fs');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { _electron } = require('playwright');

const ROOT = path.resolve(__dirname, '../..');
const desktop = path.join(ROOT, 'desktop');
const out = path.resolve(process.argv[2] ?? '/Users/Maxsc/.factory/worktrees/98cfc78f/screenshots/desktop');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message, timeout = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error(message);
}
async function freePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function prepare() {
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'snip-real-engine-'));
  const root = path.join(temp, 'repo');
  const appDir = path.join(root, 'desktop');
  await fs.promises.mkdir(appDir, { recursive: true });
  // A library layout the real preflight accepts, plus the built Worker it inspects.
  for (const name of ['web/dist', 'web/dist-settings', 'web/migrations', 'web/public', 'capture/src', 'node_modules']) {
    const from = path.join(ROOT, name);
    if (name === 'node_modules') await fs.promises.symlink(from, path.join(root, name), 'dir');
    else if (fs.existsSync(from)) await fs.promises.cp(from, path.join(root, name), { recursive: true });
  }
  for (const name of ['package.json', 'web/wrangler.jsonc']) await fs.promises.copyFile(path.join(ROOT, name), path.join(root, name));
  // The engine modules, unmodified, from this checkout: this is the real engine.
  await fs.promises.cp(path.join(desktop, 'provision'), path.join(root, 'desktop/provision'), { recursive: true });
  await fs.promises.copyFile(path.join(desktop, 'tests/fixtures/real-engine-harness.cjs'), path.join(root, 'desktop/provision/harness.cjs'));
  for (const name of await fs.promises.readdir(desktop)) {
    if (name.endsWith('.cjs') || ['loading.html', 'cloud-unreachable.html', 'package.json'].includes(name)) {
      await fs.promises.copyFile(path.join(desktop, name), path.join(appDir, name));
    }
  }
  await fs.promises.symlink(path.join(desktop, 'node_modules'), path.join(appDir, 'node_modules'), 'dir')
  await fs.promises.writeFile(path.join(appDir, 'repo.json'), JSON.stringify({ root }))

  const port = await freePort();
  const origin = `http://localhost:${port}`;
  await fs.promises.writeFile(path.join(root, 'web/.dev.vars'), `DEV_LOGIN=harness\nSESSION_SECRET=harness-session\nCAPTURE_TOKEN=harness-capture\nPUBLIC_URL=${origin}\n`)
  await fs.promises.writeFile(path.join(root, 'capture/.env'), `SNIP_URL=${origin}\nCAPTURE_TOKEN=harness-capture\nPOLL_SECONDS=1\nBROWSER_IDLE_SECONDS=2\n`)
  return { temp, root, appDir, port, origin };
}

async function launch({ appDir, ...overrides }) {
  const env = { ...process.env, ...overrides }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'SNIP_URL', 'CAPTURE_TOKEN', 'DEV_LOGIN', 'SNIP_HARNESS_PROFILE']) delete env[key]
  return _electron.launch({ executablePath: require('electron'), args: [appDir], env, timeout: 30000 })
}

async function main() {
  const site = await prepare();
  const env = {
    SNIP_CLOUD_ENGINE: path.join(site.root, 'desktop/provision/harness.cjs'),
    SNIP_DESKTOP_PROFILE: path.join(site.temp, 'profile'),
    SNIP_DESKTOP_PORT: String(site.port),
    WRANGLER_SEND_METRICS: 'false',
  }
  let application
  try {
    application = await launch({ appDir: site.appDir, ...env })
    let page = await application.firstWindow()
    page.setDefaultTimeout(30000)
    await until(async () => (await page.evaluate(() => document.readyState).catch(() => '')) === 'complete', 'gallery never loaded')

    await application.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('snip-settings').click())
    const settings = await (await application.waitForEvent('window'))
    settings.setDefaultTimeout(30000)
    await settings.getByRole('button', { name: 'Enable cloud' }).waitFor({ timeout: 60000 })
    await settings.getByRole('button', { name: 'Enable cloud' }).click()
    await settings.getByRole('button', { name: 'Continue to Cloudflare' }).click()

    // The real engine runs all 18 steps; the harness answers the browser actions.
    await settings.getByRole('heading', { name: 'Cloud library', exact: true }).waitFor({ timeout: 120000 }).catch(async error => {
      console.error('SETTINGS:', (await settings.locator('main').innerText().catch(() => 'n/a')).slice(0, 2500))
      throw error
    })
    const state = JSON.parse(await fs.promises.readFile(path.join(site.root, '.snip/cloud.json'), 'utf8'))
    assert.equal(state.mode, 'cloud')
    assert.equal(state.cloud.url, 'https://snip.snip-harness.workers.dev')
    assert.equal(state.steps.length, 18, 'every setup step ran')
    // The step journal is the engine's, and the UI rendered it in the same order.
    assert.deepEqual(state.steps.map(step => step.id), [
      'preflight', 'cloudflare-auth', 'account', 'url', 'r2', 'guard', 'resources', 'config',
      'schema', 'deploy', 'secrets', 'quiesce', 'release', 'export', 'import', 'verify', 'owner', 'finish',
    ])
    assert.equal(state.steps.some(step => step.status === 'failed'), false)
    // The live model: this Mac's library was never copied, and setup's dump is a
    // separate delete-only export (contracts §1.11).
    assert.equal(state.snapshot.kind, 'live')
    assert.equal(state.snapshot.path, null)
    assert.equal(state.snapshot.keptLocal, true)
    assert.ok(state.snapshot.export.path, 'setup wrote the portable export')
    assert.equal(state.move.status, 'completed')
    console.log('PASS the real engine enabled cloud, all 18 steps in order, and Settings shows the cloud state')

    // The capture agent follows the mode: local settings kept, cloud queue active.
    const local = await fs.promises.readFile(path.join(site.root, 'capture/.env.local'), 'utf8')
    const cloud = await fs.promises.readFile(path.join(site.root, 'capture/.env.cloud'), 'utf8')
    assert.match(local, /^SNIP_URL=http:\/\/localhost:/m)
    assert.match(cloud, /^SNIP_URL=https:\/\/snip\.snip-harness\.workers\.dev$/m)
    assert.match(cloud, /^CAPTURE_TOKEN=\S+$/m)
    console.log('PASS capture/.env.local keeps this Mac and .env.cloud points at the cloud queue')

    // The harness's cloud host is deliberately unreachable, so this also proves the
    // rule that matters most in cloud mode: never fall back to the empty local
    // library. The window must say the cloud copy can't be reached instead.
    await until(async () => application.windows().some(candidate => candidate.url().startsWith('file://') && candidate.url().includes('cloud-unreachable')), 'cloud mode did not show the unreachable state', 45000)
    const failure = application.windows().find(candidate => candidate.url().includes('cloud-unreachable'))
    await failure.waitForLoadState('domcontentloaded')
    const text = await failure.locator('body').innerText()
    console.log('FAILURE URL', failure.url())
    console.log('FAILURE TEXT', JSON.stringify(text.slice(0, 300)))
    assert.match(text, /cloud library can’t be reached/)
    assert.match(text, /snip\.snip-harness\.workers\.dev/)
    assert.equal(await failure.evaluate(() => document.querySelector('h1')?.textContent?.includes('reached')), true)
    assert.equal(application.windows().some(candidate => candidate.url().startsWith(site.origin)), false, 'cloud mode fell back to the local library')
    console.log('PASS an unreachable cloud origin says so and never falls back to the local library')

    await settings.bringToFront()
    // The live row renders from the engine's own record, with one action and no delete.
    await settings.screenshot({ path: path.join(out, 'settings-real-engine-cloud-light.png') })
    await settings.emulateMedia({ colorScheme: 'dark' })
    await settings.evaluate(() => document.documentElement.classList.add('dark'))
    await sleep(300)
    await settings.screenshot({ path: path.join(out, 'settings-real-engine-cloud-dark.png') })
    await settings.emulateMedia({ colorScheme: 'light' })
    await settings.evaluate(() => document.documentElement.classList.remove('dark'))
    await sleep(200)
    console.log('SHOT', path.join(out, 'settings-real-engine-cloud-light.png'))
    console.log('SHOT', path.join(out, 'settings-real-engine-cloud-dark.png'))

    const liveRow = settings.getByText("This Mac's library · 2 references")
    await liveRow.waitFor({ timeout: 30000 })
    const rowText = await liveRow.locator("xpath=ancestor::div[contains(@class,'flex')][1]").innerText()
    assert.match(rowText, /Kept on this Mac and not updated while you use your cloud library/)
    assert.equal(await settings.getByRole('button', { name: 'Switch back to it' }).count(), 1)
    assert.equal(await settings.getByRole('button', { name: 'Restore' }).count(), 0)
    console.log("PASS the live row shows this Mac's library with only Switch back to it")

    // The real `owner link` mints a signed URL from this Mac's own secret. It is the
    // one URL that belongs in Settings, so the guard must accept the engine's output
    // and the run must leave cloud.json untouched. `--no-handoff` (contracts v3.22
    // §1.4.2) is what makes the link work on whichever device opens it.
    const beforeLink = await fs.promises.readFile(path.join(site.root, '.snip/cloud.json'), 'utf8')
    await settings.getByRole('button', { name: 'Create link…' }).click()
    const linkDialog = settings.locator('[role=dialog]')
    await linkDialog.getByText(/\/auth\/owner\?t=/).waitFor({ timeout: 90000 }).catch(async error => {
      console.error('LINK DIALOG:', await linkDialog.innerText().catch(() => 'n/a'))
      const logs = await application.evaluate(({ app }) => app.getPath('logs')).catch(() => null)
      if (logs) console.error('CLOUD LOG:', await fs.promises.readFile(path.join(logs, 'cloud.log'), 'utf8').catch(() => 'n/a'))
      throw error
    })
    const linkUrl = (await linkDialog.locator('p.font-mono').innerText()).trim()
    const minted = new URL(linkUrl)
    assert.equal(minted.origin, 'https://snip.snip-harness.workers.dev')
    assert.equal(minted.pathname, '/auth/owner')
    // snip-owner-v1|ownerId|exp|nonce|port.signature: port 0 means no handoff, so the
    // link works on whichever device opens it instead of that device's localhost.
    const payload = minted.searchParams.get('t')
    assert.match(payload, /^snip-owner-v1\|harness\|\d+\|[0-9a-f]+\|0\.[A-Za-z0-9_-]+$/)
    // The run can't see the other device, so it reports the link, never a sign-in.
    const linkText = await linkDialog.innerText()
    assert.match(linkText, /Link ready/)
    assert.doesNotMatch(linkText, /Signed in/)
    assert.match(linkText, /Works once and expires in 10 minutes\. The browser that opens it is signed in and can add a passkey\./)
    // The wait ends the moment the link arrives, so a fresh link can be asked for
    // straight away instead of leaving the button disabled behind a slow read.
    assert.equal(await linkDialog.getByRole('button', { name: 'Create a new link' }).isDisabled(), false)
    assert.equal(await fs.promises.readFile(path.join(site.root, '.snip/cloud.json'), 'utf8'), beforeLink, 'minting a link must not rewrite cloud.json')
    await settings.screenshot({ path: path.join(out, 'settings-real-engine-owner-link-light.png') })
    await settings.emulateMedia({ colorScheme: 'dark' })
    await settings.evaluate(() => document.documentElement.classList.add('dark'))
    await sleep(300)
    await settings.screenshot({ path: path.join(out, 'settings-real-engine-owner-link-dark.png') })
    await settings.emulateMedia({ colorScheme: 'light' })
    await settings.evaluate(() => document.documentElement.classList.remove('dark'))
    await sleep(200)
    console.log('SHOT', path.join(out, 'settings-real-engine-owner-link-light.png'))
    console.log('SHOT', path.join(out, 'settings-real-engine-owner-link-dark.png'))
    // A second link is a fresh mint, not the first one replayed.
    await linkDialog.getByRole('button', { name: 'Create a new link' }).click()
    await linkDialog.getByText(/\/auth\/owner\?t=/).waitFor({ timeout: 60000 })
    const second = new URL((await linkDialog.locator('p.font-mono').innerText()).trim())
    assert.match(second.searchParams.get('t'), /\|0\.[A-Za-z0-9_-]+$/)
    await linkDialog.getByRole('button', { name: 'Close' }).click()
    console.log('PASS the real engine minted a port-0 owner link and left cloud.json alone')

    // Deleting the export goes through the real `snapshot delete-export --confirm`.
    await settings.getByRole('button', { name: 'Delete export' }).click()
    await settings.getByRole('button', { name: 'Delete export', exact: true }).click()
    await settings.getByRole('button', { name: 'Delete export' }).waitFor({ state: 'detached', timeout: 90000 }).catch(() => {})
    await until(async () => {
      const current = JSON.parse(await fs.promises.readFile(path.join(site.root, '.snip/cloud.json'), 'utf8'))
      return current.snapshot?.export == null
    }, 'the real engine did not delete the export', 90000).catch(async error => {
      console.error('EXPORT STATE:', JSON.stringify(JSON.parse(await fs.promises.readFile(path.join(site.root, '.snip/cloud.json'), 'utf8')).snapshot))
      throw error
    })
    console.log('PASS the real engine deleted the export through the basename confirm')

    // Turn off cloud (detach), then bring it back with pull, which leaves a backup row.
    await settings.getByRole('button', { name: 'Turn off cloud…' }).click()
    await settings.getByRole('button', { name: /Bring the cloud library back/ }).click()
    await settings.getByRole('button', { name: 'Copy back now' }).click()
    await settings.getByRole('heading', { name: 'This Mac', exact: true }).waitFor({ timeout: 120000 })
    const pulled = JSON.parse(await fs.promises.readFile(path.join(site.root, '.snip/cloud.json'), 'utf8'))
    assert.equal(pulled.mode, 'local')
    assert.equal(pulled.snapshot?.kind, 'backup', `pull should leave a backup: ${JSON.stringify(pulled.snapshot)}`)
    assert.ok(pulled.snapshot.path, 'the backup has a directory')
    console.log('PASS pull created a backup and returned the app to this Mac')

    // A pull leaves the app local, so the backup row lives in the local view and is
    // the only place its two actions can be reached.
    const previousRow = settings.getByRole('heading', { name: 'Previous library' })
    await previousRow.waitFor({ timeout: 30000 })
    assert.equal(await settings.getByRole('button', { name: 'Switch back to previous library' }).count(), 1)
    assert.equal(await settings.getByRole('button', { name: 'Delete previous library' }).count(), 1)
    await settings.screenshot({ path: path.join(out, 'settings-real-engine-previous-library-light.png') })
    await settings.emulateMedia({ colorScheme: 'dark' })
    await settings.evaluate(() => document.documentElement.classList.add('dark'))
    await sleep(300)
    await settings.screenshot({ path: path.join(out, 'settings-real-engine-previous-library-dark.png') })
    await settings.emulateMedia({ colorScheme: 'light' })
    await settings.evaluate(() => document.documentElement.classList.remove('dark'))
    await sleep(200)
    console.log('PASS the backup row offers Switch back to previous library and Delete')

    // Enable again, then detach: this is the "turn off and keep local" outcome, and
    // it must leave the cloud copy live and recorded as detached.
    await settings.getByRole('button', { name: 'Enable cloud' }).click()
    await settings.getByRole('button', { name: 'Continue to Cloudflare' }).click()
    await settings.getByRole('heading', { name: 'Cloud library', exact: true }).waitFor({ timeout: 120000 })
    await settings.getByRole('button', { name: 'Turn off cloud…' }).click()
    await settings.getByRole('button', { name: /Turn off and keep local/ }).click()
    await settings.getByRole('button', { name: 'Turn off cloud', exact: true }).click()
    await settings.getByRole('heading', { name: 'This Mac', exact: true }).waitFor({ timeout: 120000 })
    const detached = JSON.parse(await fs.promises.readFile(path.join(site.root, '.snip/cloud.json'), 'utf8'))
    assert.equal(detached.mode, 'local')
    assert.ok(detached.cloud?.detachedAt, 'detach records when the cloud copy was left')
    assert.ok(detached.cloud?.url, 'the cloud copy is still recorded, not deleted')
    await settings.getByRole('heading', { name: 'Detached copy' }).waitFor({ timeout: 30000 })
    await settings.screenshot({ path: path.join(out, 'settings-real-engine-detached-light.png') })
    await settings.emulateMedia({ colorScheme: 'dark' })
    await settings.evaluate(() => document.documentElement.classList.add('dark'))
    await sleep(300)
    await settings.screenshot({ path: path.join(out, 'settings-real-engine-detached-dark.png') })
    console.log('PASS detach leaves the cloud copy live and Settings lists it as detached')

    // The enabled cloud state and the local states are captured by their own smokes;
    // this one owns the states that only the real engine can produce.
    console.log('SHOT', path.join(out, 'settings-real-engine-previous-library-light.png'))
    console.log('SHOT', path.join(out, 'settings-real-engine-detached-light.png'))
    console.log('SHOT', path.join(out, 'settings-real-engine-detached-dark.png'))


  } finally {
    if (application) await application.close().catch(() => {})
    if (!process.env.SNIP_KEEP_HARNESS) await fs.promises.rm(site.temp, { recursive: true, force: true })
    else console.log('kept', site.temp)
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
