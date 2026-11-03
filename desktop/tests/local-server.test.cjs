const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');

const launcher = path.join(__dirname, '..', 'local-server.cjs');

async function launch(root) {
  const child = fork(launcher, [root, '0'], {
    cwd: path.join(root, 'web'),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Server startup timed out: ${output}`)), 20000);
    child.on('message', (message) => {
      if (message.type === 'snip:web-ready') { clearTimeout(timeout); resolve(message.url); }
      if (message.type === 'snip:web-error') { clearTimeout(timeout); reject(new Error(message.message)); }
    });
    child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Server exited ${code}: ${output}`)); });
  }).catch((error) => { child.kill('SIGKILL'); throw error; });
  return { child, url: result, output: () => output };
}

async function stop(child) {
  const exited = once(child, 'exit');
  child.send({ type: 'snip:stop' });
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  const [code] = await exited;
  clearTimeout(timer);
  assert.equal(code, 0);
}

test('startup failure is reported and exits', { timeout: 15000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'snip-local-server-error-'));
  await fs.mkdir(path.join(root, 'web'));
  const child = fork(launcher, [root, '0'], {
    cwd: path.join(root, 'web'), stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  try {
    const message = once(child, 'message');
    const exited = once(child, 'exit');
    assert.equal((await message)[0].type, 'snip:web-error');
    assert.equal((await exited)[0], 1);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('built assets and local bindings survive a restart', { timeout: 60000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'snip-local-server-'));
  const web = path.join(root, 'web');
  // The launcher also lives inside a packaged .app, outside this checkout.
  // Its dependencies must resolve from the supplied project root.
  await fs.symlink(path.resolve(__dirname, '../../node_modules'), path.join(root, 'node_modules'), 'dir');
  await fs.mkdir(path.join(web, 'dist/snip'), { recursive: true });
  await fs.mkdir(path.join(web, 'dist/client'), { recursive: true });
  await fs.writeFile(path.join(web, '.dev.vars'), 'TEST_SECRET=local-secret-canary\n');
  await fs.writeFile(path.join(web, 'dist/client/index.html'), '<h1>built asset</h1>');
  await fs.writeFile(path.join(web, 'dist/snip/wrangler.json'), JSON.stringify({
    name: 'snip-test', main: 'index.js', compatibility_date: '2025-01-01', no_bundle: true,
    assets: { directory: '../client', run_worker_first: ['/api/*'] },
    kv_namespaces: [{ binding: 'KV', id: 'test-kv' }],
    r2_buckets: [{ binding: 'FILES', bucket_name: 'test-files' }],
    d1_databases: [{ binding: 'DB', database_name: 'test-db', database_id: 'test-db' }],
  }));
  await fs.writeFile(path.join(web, 'dist/snip/index.js'), `export default { async fetch(request, env) {
    if (new URL(request.url).pathname === '/api/write') {
      await env.KV.put('key', 'kv-value');
      await env.FILES.put('key', 'r2-value');
      await env.DB.exec('CREATE TABLE IF NOT EXISTS t (value TEXT); DELETE FROM t; INSERT INTO t VALUES (\"d1-value\");');
      return new Response('written');
    }
    const row = await env.DB.prepare('SELECT value FROM t').first();
    return Response.json({ secret: env.TEST_SECRET, kv: await env.KV.get('key'), r2: await (await env.FILES.get('key')).text(), d1: row.value });
  } }`);
  let running;
  try {
    running = await launch(root);
    assert.match(await (await fetch(running.url)).text(), /built asset/);
    assert.equal(await (await fetch(`${running.url}/api/write`)).text(), 'written');
    await stop(running.child);
    assert.doesNotMatch(running.output(), /local-secret-canary/);
    running = await launch(root);
    assert.deepEqual(await (await fetch(`${running.url}/api/read`)).json(), {
      secret: 'local-secret-canary', kv: 'kv-value', r2: 'r2-value', d1: 'd1-value',
    });
    await stop(running.child);
    assert.doesNotMatch(running.output(), /local-secret-canary/);
    running = undefined;
  } finally {
    if (running && running.child.exitCode === null) running.child.kill('SIGKILL');
    await fs.rm(root, { recursive: true, force: true });
  }
});
