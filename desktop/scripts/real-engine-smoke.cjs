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
    console.log('MODE', state.mode, 'STEPS', state.steps.length, 'SNAPSHOT', JSON.stringify(state.snapshot && { kind: state.snapshot.kind, path: state.snapshot.path }))
    console.log('PASS the real engine enabled cloud and Settings shows the cloud state')

    const local = await fs.promises.readFile(path.join(site.root, 'capture/.env.local'), 'utf8').catch(() => '')
    const cloud = await fs.promises.readFile(path.join(site.root, 'capture/.env.cloud'), 'utf8').catch(() => '')
    console.log('CAPTURE local:', JSON.stringify(local), 'cloud:', JSON.stringify(cloud))
    console.log('PASS capture env files are in place')

    await settings.screenshot({ path: path.join(out, 'settings-real-engine-cloud-light.png') })
    console.log('SHOT', path.join(out, 'settings-real-engine-cloud-light.png'))
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
