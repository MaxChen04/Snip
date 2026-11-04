const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { createHash } = require('node:crypto');

async function runtimeSnapshot(root) {
  const files = [];
  async function visit(directory, prefix = '') {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const relative = path.join(prefix, entry.name);
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) { files.push(`${relative}/`); await visit(absolute, relative); }
      else if (entry.isSymbolicLink()) files.push(`${relative} -> ${await fs.readlink(absolute)}`);
      else files.push(`${relative} ${createHash('sha256').update(await fs.readFile(absolute)).digest('hex')}`);
    }
  }
  await visit(root);
  return files.sort();
}

const launcher = path.join(__dirname, '..', 'local-server.cjs');

async function launch(root, dataRoot = root, releaseManaged = false) {
  const child = fork(launcher, [root, '0', dataRoot, ...(releaseManaged ? ['release'] : [])], {
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
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snip-local-data-'));
  const nextRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snip-next-runtime-'));
  await fs.mkdir(path.join(dataRoot, 'web'));
  // The launcher also lives inside a packaged .app, outside this checkout.
  // Its dependencies must resolve from the supplied project root.
  await fs.symlink(path.resolve(__dirname, '../../node_modules'), path.join(root, 'node_modules'), 'dir');
  await fs.mkdir(path.join(web, 'dist/snip'), { recursive: true });
  await fs.mkdir(path.join(web, 'dist/client'), { recursive: true });
  await fs.writeFile(path.join(dataRoot, 'web/.dev.vars'), 'TEST_SECRET=local-secret-canary\n');
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
    running = await launch(root, dataRoot);
    assert.match(await (await fetch(running.url)).text(), /built asset/);
    assert.equal(await (await fetch(`${running.url}/api/write`)).text(), 'written');
    await stop(running.child);
    assert.doesNotMatch(running.output(), /local-secret-canary/);
    await fs.symlink(path.resolve(__dirname, '../../node_modules'), path.join(nextRoot, 'node_modules'), 'dir');
    await fs.cp(web, path.join(nextRoot, 'web'), { recursive: true });
    running = await launch(nextRoot, dataRoot);
    assert.deepEqual(await (await fetch(`${running.url}/api/read`)).json(), {
      secret: 'local-secret-canary', kv: 'kv-value', r2: 'r2-value', d1: 'd1-value',
    });
    await stop(running.child);
    assert.doesNotMatch(running.output(), /local-secret-canary/);
    running = undefined;
  } finally {
    if (running && running.child.exitCode === null) running.child.kill('SIGKILL');
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(nextRoot, { recursive: true, force: true });
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
});

test('release migrations run before startup and back up an existing D1 database', { timeout: 90000 }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'snip-migrate-'));
  const root = path.join(temp, 'runtime');
  const dataRoot = path.join(temp, 'library');
  const web = path.join(root, 'web');
  await fs.mkdir(path.join(web, 'dist/snip'), { recursive: true });
  await fs.mkdir(path.join(web, 'migrations'), { recursive: true });
  await fs.mkdir(path.join(dataRoot, 'web'), { recursive: true });
  await fs.mkdir(path.join(root, 'node_modules'));
  await fs.symlink(path.resolve(__dirname, '../../node_modules/wrangler'), path.join(root, 'node_modules/wrangler'), 'dir');
  const database = { binding: 'DB', database_name: 'snip', database_id: 'test-db', migrations_dir: 'migrations' };
  await fs.writeFile(path.join(web, 'wrangler.jsonc'), JSON.stringify({ name: 'snip-test', compatibility_date: '2025-01-01', d1_databases: [database] }));
  await fs.writeFile(path.join(web, 'dist/snip/wrangler.json'), JSON.stringify({ name: 'snip-test', main: 'index.js', compatibility_date: '2025-01-01', no_bundle: true, d1_databases: [database] }));
  await fs.writeFile(path.join(web, 'dist/snip/index.js'), `export default { async fetch(request, env) { const row = await env.DB.prepare('SELECT value FROM t').first(); return new Response(row.value); } }`);
  await fs.writeFile(path.join(web, 'migrations/0001_init.sql'), "CREATE TABLE t (value TEXT);\nINSERT INTO t VALUES ('preserved');\n");
  let running;
  try {
    let pristine = await runtimeSnapshot(root);
    running = await launch(root, dataRoot, true);
    assert.equal(await (await fetch(running.url)).text(), 'preserved');
    await stop(running.child);
    running = undefined;
    assert.deepEqual(await runtimeSnapshot(root), pristine, 'first release migration and startup must not write inside the runtime');
    const backups = path.join(dataRoot, 'backups');
    for (let i = 0; i < 4; i++) {
      const folder = path.join(backups, `d1-old-${i}`);
      await fs.mkdir(folder, { recursive: true });
      await fs.writeFile(path.join(folder, 'snip-backup.json'), JSON.stringify({ owner: 'snip-d1-backup-v1', status: 'complete', time: i }));
    }
    for (const name of ['d1-foreign', 'd1-failed']) await fs.mkdir(path.join(backups, name));
    await fs.writeFile(path.join(backups, 'd1-failed/snip-backup.json'), JSON.stringify({ owner: 'snip-d1-backup-v1', status: 'incomplete', time: 0 }));
    await fs.writeFile(path.join(web, 'migrations/0002_upgrade.sql'), 'ALTER TABLE t ADD COLUMN extra TEXT;\n');
    pristine = await runtimeSnapshot(root);
    running = await launch(root, dataRoot, true);
    assert.equal(await (await fetch(running.url)).text(), 'preserved');
    await stop(running.child);
    running = undefined;
    assert.deepEqual(await runtimeSnapshot(root), pristine, 'release upgrade must not write inside the runtime');
    const beforeNoop = (await fs.readdir(backups)).sort();
    assert.equal(beforeNoop.length, 5); // Three complete, plus foreign and failed backups.
    assert.ok(beforeNoop.includes('d1-foreign') && beforeNoop.includes('d1-failed'));
    running = await launch(root, dataRoot, true);
    assert.equal(await (await fetch(running.url)).text(), 'preserved');
    await stop(running.child);
    running = undefined;
    assert.deepEqual((await fs.readdir(path.join(dataRoot, 'backups'))).sort(), beforeNoop);
    assert.deepEqual(await runtimeSnapshot(root), pristine, 'release restart must not write inside the runtime');
    await fs.writeFile(path.join(web, 'migrations/0003_bad.sql'), 'THIS IS NOT SQL;\n');
    await assert.rejects(launch(root, dataRoot, true), /backup is at .*manual recovery/);
    assert.equal((await fs.readdir(path.join(dataRoot, 'backups'))).length, beforeNoop.length + 1);
  } finally {
    if (running && running.child.exitCode === null) running.child.kill('SIGKILL');
    await fs.rm(temp, { recursive: true, force: true });
  }
});

for (const mode of ['graceful', 'forced']) {
  test(`${mode} stop during migration terminates Wrangler and its child`, { timeout: 15000 }, async () => {
    const { Service } = require('../service.cjs');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'snip-cancel-'));
    await fs.mkdir(path.join(root, 'web'), { recursive: true });
    await fs.mkdir(path.join(root, 'node_modules/wrangler/bin'), { recursive: true });
    await fs.mkdir(path.join(root, 'web/dist/snip'), { recursive: true });
    await fs.writeFile(path.join(root, 'node_modules/wrangler/index.js'), `exports.unstable_readConfig = () => ({ compatibility_date: '2025-01-01', d1_databases: [], r2_buckets: [], kv_namespaces: [] });`);
    await fs.writeFile(path.join(root, 'node_modules/wrangler/bin/wrangler.js'), `
      const { spawn } = require('node:child_process');
      const fs = require('node:fs');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      fs.writeFileSync('child-pids', JSON.stringify([process.pid, child.pid]));
      setInterval(() => {}, 1000);
    `);
    const service = new Service('web');
    service.start({ executable: process.execPath, args: [launcher, root, '0', root, 'release'], cwd: root, env: process.env, log: { write() {}, end() {} } });
    let descendants = [];
    try {
      for (let i = 0; i < 100; i++) {
        try { descendants = JSON.parse(await fs.readFile(path.join(root, 'child-pids'), 'utf8')); break; }
        catch { await new Promise(resolve => setTimeout(resolve, 30)); }
      }
      assert.equal(descendants.length, 2, 'migration subprocesses started');
      await (mode === 'forced' ? service.forceStop() : service.stop());
      for (const pid of descendants) {
        let alive = true;
        for (let i = 0; i < 100 && alive; i++) {
          try { process.kill(pid, 0); await new Promise(resolve => setTimeout(resolve, 30)); }
          catch (error) { if (error.code === 'ESRCH') alive = false; else throw error; }
        }
        assert.equal(alive, false, `migration process ${pid} must not outlive ${mode} shutdown`);
      }
    } finally {
      await service.forceStop();
      for (const pid of descendants) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}

test('release imports custom local storage identities and keeps them across future runtimes', { timeout: 90000 }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'snip-custom-identity-'));
  const root = path.join(temp, 'runtime');
  const dataRoot = path.join(temp, 'library');
  const web = path.join(root, 'web');
  const dataWeb = path.join(dataRoot, 'web');
  await fs.mkdir(path.join(web, 'dist/snip'), { recursive: true });
  await fs.mkdir(path.join(web, 'migrations'), { recursive: true });
  await fs.mkdir(dataWeb, { recursive: true });
  await fs.mkdir(path.join(root, 'node_modules'));
  await fs.symlink(path.resolve(__dirname, '../../node_modules/wrangler'), path.join(root, 'node_modules/wrangler'), 'dir');
  const custom = {
    d1_databases: [{ binding: 'DB', database_name: 'old-db', database_id: 'old-id', preview_database_id: 'old-preview-id' }],
    r2_buckets: [{ binding: 'FILES', bucket_name: 'old-files' }],
    kv_namespaces: [{ binding: 'OAUTH_KV', id: 'old-kv' }],
  };
  const bundled = {
    d1_databases: [{ binding: 'DB', database_name: 'snip', database_id: 'new-id', preview_database_id: 'new-preview-id', migrations_dir: 'migrations' }],
    r2_buckets: [{ binding: 'FILES', bucket_name: 'new-files', preview_bucket_name: 'new-preview-files' }],
    kv_namespaces: [{ binding: 'OAUTH_KV', id: 'new-kv', preview_id: 'new-preview-kv' }],
  };
  const base = { name: 'snip-test', compatibility_date: '2025-01-01' };
  // Preserve known settings, but never import arbitrary variables or secrets.
  await fs.writeFile(path.join(dataWeb, 'wrangler.jsonc'), `// old checkout\n${JSON.stringify({ ...base, ...custom, vars: { PUBLIC_URL: 'https://library.example', ALLOWED_GITHUB_LOGINS: 'library-owner', DEV_LOGIN: 'from-config', SECRET_CANARY: 'must-not-copy' } })}`);
  await fs.writeFile(path.join(dataWeb, '.dev.vars'), 'DEV_LOGIN=from-env\n');
  await fs.writeFile(path.join(web, 'wrangler.jsonc'), JSON.stringify({ ...base, ...bundled }));
  const workerConfig = { ...base, main: 'index.js', no_bundle: true, ...custom };
  await fs.writeFile(path.join(web, 'dist/snip/wrangler.json'), JSON.stringify(workerConfig));
  await fs.writeFile(path.join(web, 'dist/snip/index.js'), `export default { async fetch(request, env) {
    if (new URL(request.url).pathname === '/write') {
      await env.DB.exec("CREATE TABLE IF NOT EXISTS t (value TEXT); INSERT INTO t VALUES ('old-row');");
      await env.FILES.put('key', 'old-file'); await env.OAUTH_KV.put('key', 'old-kv-value');
      return new Response('written');
    }
    const row = await env.DB.prepare('SELECT value FROM t').first();
    const migrated = await env.DB.prepare("SELECT name FROM sqlite_master WHERE name = 'new_table'").first();
    return Response.json({ row: row.value, file: await (await env.FILES.get('key')).text(), kv: await env.OAUTH_KV.get('key'), migrated: !!migrated, publicUrl: env.PUBLIC_URL, allowed: env.ALLOWED_GITHUB_LOGINS, login: env.DEV_LOGIN });
  } }`);
  let running;
  try {
    running = await launch(root, dataRoot);
    assert.equal(await (await fetch(`${running.url}/write`)).text(), 'written');
    await stop(running.child); running = undefined;
    await fs.writeFile(path.join(web, 'dist/snip/wrangler.json'), JSON.stringify({ ...workerConfig, ...bundled }));
    await fs.writeFile(path.join(web, 'migrations/0001_upgrade.sql'), 'CREATE TABLE new_table (value TEXT);\n');
    const pristine = await runtimeSnapshot(root);
    running = await launch(root, dataRoot, true);
    const expected = { row: 'old-row', file: 'old-file', kv: 'old-kv-value', migrated: true, publicUrl: 'https://library.example', allowed: 'library-owner', login: 'from-env' };
    assert.deepEqual(await (await fetch(running.url)).json(), expected);
    await stop(running.child); running = undefined;
    const snapshotPath = path.join(dataRoot, '.snip/storage-identities.json');
    const snapshot = await fs.readFile(snapshotPath, 'utf8');
    assert.doesNotMatch(snapshot, /must-not-copy|SECRET_CANARY/);
    assert.equal(JSON.parse(snapshot).d1_databases[0].preview_database_id, 'old-preview-id');
    assert.deepEqual(JSON.parse(snapshot).vars, { PUBLIC_URL: 'https://library.example', ALLOWED_GITHUB_LOGINS: 'library-owner', DEV_LOGIN: 'from-config' });
    assert.deepEqual(await runtimeSnapshot(root), pristine);
    // Once recorded, identity survives loss of the old source configuration.
    await fs.rm(path.join(dataWeb, 'wrangler.jsonc'));
    running = await launch(root, dataRoot, true);
    assert.deepEqual(await (await fetch(running.url)).json(), expected);
    await stop(running.child); running = undefined;
    assert.deepEqual(await runtimeSnapshot(root), pristine);
  } finally {
    if (running && running.child.exitCode === null) running.child.kill('SIGKILL');
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('existing state without a usable identity stops rather than opening empty storage', { timeout: 15000 }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'snip-missing-identity-'));
  const root = path.join(temp, 'runtime');
  const dataRoot = path.join(temp, 'library');
  await fs.mkdir(path.join(root, 'web/dist/snip'), { recursive: true });
  await fs.mkdir(path.join(root, 'node_modules'));
  await fs.symlink(path.resolve(__dirname, '../../node_modules/wrangler'), path.join(root, 'node_modules/wrangler'), 'dir');
  await fs.mkdir(path.join(dataRoot, 'web/.wrangler/state'), { recursive: true });
  await fs.writeFile(path.join(root, 'web/dist/snip/wrangler.json'), JSON.stringify({ name: 'snip-test', main: 'index.js', compatibility_date: '2025-01-01', d1_databases: [{ binding: 'DB', database_name: 'snip', database_id: 'new-id' }] }));
  try {
    await assert.rejects(launch(root, dataRoot, true), /could not determine which local database and files/);
    await assert.rejects(fs.access(path.join(dataRoot, '.snip/storage-identities.json')));
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});
