'use strict';
// The provisioning engine, end to end against fakes. No live Cloudflare call is
// possible here: wrangler, the Cloudflare API, the local Worker and the cloud
// transfer surface are all fakes, and fetch is asserted to stay on the fake.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const { runSteps, StepError, NeedsInputError } = require('../provision/engine.cjs');
const stateModule = require('../provision/state.cjs');
const lib = require('../provision/lib.cjs');
const deploy = require('../provision/deploy.cjs');
const { createEmitter } = require('../provision/emit.cjs');
const { createContext } = require('../provision/context.cjs');
const realLocal = require('../provision/local.cjs');
const transfer = require('../provision/transfer.cjs');
const setup = require('../provision/setup.cjs');
const commands = require('../provision/commands.cjs');
const cli = require('../provision/cli.cjs');

const PROVIDED = 'https://snip.tester.workers.dev';

function tempDir(prefix = 'snip-provision-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A fake library checkout: runtime files, local dev vars and an empty cloud dir. */
function fakeLibrary({ root = tempDir() } = {}) {
  const dataRoot = root;
  fs.mkdirSync(path.join(root, 'web/dist/snip'), { recursive: true });
  fs.mkdirSync(path.join(root, 'web/dist/client/assets'), { recursive: true });
  fs.mkdirSync(path.join(root, 'web/migrations'), { recursive: true });
  fs.writeFileSync(path.join(root, 'web/dist/snip/index.js'), 'export default { async fetch() { return new Response("ok") } }\n//# sourceMappingURL=index.js.map\n');
  fs.writeFileSync(path.join(root, 'web/dist/snip/index.js.map'), '{"version":3}\n');
  fs.writeFileSync(path.join(root, 'web/dist/client/index.html'), '<!doctype html><title>Snip</title>\n');
  fs.writeFileSync(path.join(root, 'web/dist/client/assets/app.js'), 'console.log(1)\n');
  fs.writeFileSync(path.join(root, 'web/migrations/0001_init.sql'), 'CREATE TABLE refs (id TEXT PRIMARY KEY);\n');
  fs.writeFileSync(path.join(root, 'web/.dev.vars'), 'DEV_LOGIN=local\nPUBLIC_URL=http://localhost:5199\nSESSION_SECRET=x\nCAPTURE_TOKEN=y\n');
  fs.writeFileSync(path.join(root, 'web/wrangler.jsonc'), JSON.stringify({
    name: 'snip',
    main: 'worker/index.ts',
    compatibility_date: '2026-10-01',
    d1_databases: [{ binding: 'DB', database_name: 'snip', database_id: 'local-db', migrations_dir: 'migrations' }],
    kv_namespaces: [{ binding: 'OAUTH_KV', id: 'local-kv' }],
    r2_buckets: [{ binding: 'FILES', bucket_name: 'snip-files' }],
    vars: { PUBLIC_URL: 'http://localhost:5199' },
  }));
  const built = {
    name: 'snip', main: 'index.js', no_bundle: true, compatibility_date: '2026-10-01',
    upload_source_maps: true,
    configPath: path.join(root, 'web/wrangler.jsonc'),
    userConfigPath: path.join(root, 'web/wrangler.jsonc'),
    assets: { not_found_handling: 'single-page-application', directory: '../client', run_worker_first: ['/api/*'] },
    d1_databases: [{ binding: 'DB', database_name: 'snip', database_id: 'REPLACE_WITH_D1_DATABASE_ID', migrations_dir: '../../migrations' }],
    kv_namespaces: [{ binding: 'OAUTH_KV', id: 'REPLACE_WITH_KV_NAMESPACE_ID' }],
    r2_buckets: [{ binding: 'FILES', bucket_name: 'snip-files' }],
    vars: { PUBLIC_URL: 'https://snip.YOUR-SUBDOMAIN.workers.dev', ALLOWED_GITHUB_LOGINS: 'your-github-login' },
  };
  fs.writeFileSync(path.join(root, 'web/dist/snip/wrangler.json'), JSON.stringify(built));
  return { root, dataRoot };
}

function digest(rows, sig) {
  return { rows, sig };
}

const LIBRARY = { refs: 2, pages: 3, animations: 1, collections: 1, reference_collections: 2, page_collections: 1 };

/** A wrangler CLI double: records every call and mutates a small account model. */
function fakeWrangler(model) {
  const calls = [];
  async function run(args, options = {}) {
    const line = args.join(' ');
    calls.push({ args, line, env: options.env || {} });
    const json = (value) => ({ ok: true, code: 0, stdout: JSON.stringify(value), stderr: '', output: '' });
    const text = (value, ok = true) => ({ ok, code: ok ? 0 : 1, stdout: value, stderr: ok ? '' : value, output: value });

    if (args[0] === 'whoami') return json({ loggedIn: true, email: model.email || 'tester@example.com', accounts: [{ id: model.accountId, name: 'Test Account' }] });
    if (line === 'd1 list --json') return json(model.d1.map((db) => ({ uuid: db.id, name: db.name, num_tables: db.tables || 0 })));
    if (args[0] === 'd1' && args[1] === 'create') {
      const db = { id: crypto.randomUUID(), name: args[2], tables: 0 };
      model.d1.push(db);
      return text(`✅ Successfully created DB '${db.name}'\n\ndatabase_id = "${db.id}"\n`);
    }
    if (line === 'kv namespace list') return json(model.kv.map((ns) => ({ id: ns.id, title: ns.title })));
    if (args[0] === 'kv' && args[1] === 'namespace' && args[2] === 'create') {
      const ns = { id: crypto.randomBytes(16).toString('hex'), title: args[3] };
      model.kv.push(ns);
      return text(`✅ Success\n\nid = "${ns.id}"\n`);
    }
    if (line === 'r2 bucket list') {
      if (model.r2Disabled) return text('R2 is not enabled on this account. Use the dashboard to enable R2.', false);
      return text(model.r2.map((bucket) => `name: ${bucket.name}`).join('\n'));
    }
    if (args[0] === 'r2' && args[1] === 'bucket' && args[2] === 'create') {
      model.r2.push({ name: args[3] });
      return text(`Created bucket '${args[3]}'`);
    }
    if (args[0] === 'secret' && args[1] === 'list') return json([...model.secrets].map((name) => ({ name })));
    if (args[0] === 'secret' && args[1] === 'bulk') {
      const file = args[2];
      const values = JSON.parse(fs.readFileSync(file, 'utf8'));
      Object.assign(model.secretValues, values);
      for (const name of Object.keys(values)) model.secrets.add(name);
      return text('Successfully uploaded secrets');
    }
    if (args[0] === 'secret' && args[1] === 'delete') {
      model.secrets.delete(args[2]);
      delete model.secretValues[args[2]];
      return text(`Deleted secret ${args[2]}`);
    }
    if (args[0] === 'd1' && args[1] === 'migrations' && args[2] === 'apply') {
      model.migrationsApplied = true;
      return text('Migrations to be applied:\n0001_init.sql\n\n✅ Applied 1 migration');
    }
    if (args[0] === 'd1' && args[1] === 'migrations' && args[2] === 'list') {
      return text(model.migrationsApplied ? 'No migrations to apply!' : 'Migrations to be applied:\n0001_init.sql');
    }
    if (args[0] === 'deploy') {
      model.deployed = true;
      return text('Uploaded snip (3.2 sec)');
    }
    if (args[0] === 'd1' && args[1] === 'export') {
      const output = args[args.indexOf('--output') + 1];
      const statements = [];
      for (const table of model.tables) {
        for (let index = 0; index < LIBRARY[table]; index++) statements.push(`INSERT INTO "${table}" (id, url) VALUES ('${table}-${index}', 'https://x.test/${index}');`);
      }
      fs.writeFileSync(output, `${statements.join('\n')}\n`);
      return text(`Export complete`);
    }
    if (args[0] === 'd1' && args[1] === 'execute') {
      const command = args[args.indexOf('--command') + 1] || options.input || '';
      const remote = args.includes('--remote');
      const match = command.match(/FROM\s+"?([A-Za-z0-9_]+)"?\s*;?\s*$/i);
      const table = match ? match[1] : null;
      const rows = table ? (LIBRARY[table] ?? 0) : 0;
      const sigValue = table ? digest(rows, rows * 17) : digest(0, 0);
      if (command.trim().startsWith('DELETE')) {
        if (!remote) throw new Error('unexpected local truncate');
        return json([{ success: true, results: [], meta: {} }]);
      }
      return json([{ success: true, results: [sigValue], meta: {} }]);
    }
    if (args[0] === 'login') return text('Successfully logged in');
    return text(`unhandled wrangler command: ${line}`, false);
  }
  return { bin: '/fake/wrangler.js', root: model.root, run, calls };
}

// A closed port and no local server: nothing in this suite can reach or affect
// a real Snip that another process is running (including another agent's).
const LOCAL_FAKE = {
  ...realLocal,
  reachable: async () => false,
  localOrigin: () => 'http://127.0.0.1:9',
  // Nothing to pause and an idle agent: the real client would need a server.
  createLocalApi: () => ({ async listReferences() { return []; }, async pauseReference() { return { ok: false, status: 409 }; }, async agent() { return { activity: 'idle' }; } }),
};

function fakeApi(model) {
  const schemaTables = ['refs', 'pages', 'animations', 'collections', 'reference_collections', 'page_collections', 'd1_migrations', 'worker_presence'];
  return {
    async memberships() {
      return model.memberships || [{ id: model.accountId, name: 'Test Account' }];
    },
    async subdomain() {
      return model.subdomain;
    },
    async workerExists() {
      return Boolean(model.deployed);
    },
    async worker() {
      return model.deployed ? { id: 'snip' } : null;
    },
    async workerSettings() {
      return { bindings: model.deployed && model.bindings ? model.bindings : [] };
    },
    async d1Query(_accountId, _databaseId, sql) {
      if (/sqlite_master/i.test(sql)) {
        const names = model.deployed && model.schema ? schemaTables : (model.deployed ? ['_cf_METADATA'] : []);
        return names.map((name) => ({ name }));
      }
      const table = (sql.match(/FROM\s+"?([A-Za-z0-9_]+)"?/i) || [])[1];
      if (!table) return [{ rows: 0 }];
      const rows = model.remoteRows && model.remoteRows[table] !== undefined ? model.remoteRows[table] : 0;
      return [{ rows }];
    },
  };
}

/**
 * A fake cloud /transfer surface. It holds the deployed Worker's secrets, counts
 * and objects, so the engine's real transfer client is exercised over a fake
 * fetch instead of a socket.
 */
function fakeCloud(model) {
  const objects = new Map();
  const calls = [];
  let owner = Boolean(model.hasOwner);
  const counts = () => ({ refs: LIBRARY.refs, pages: LIBRARY.pages, animations: LIBRARY.animations, collections: LIBRARY.collections });
  async function fetchImpl(url, options = {}) {
    const target = new URL(String(url));
    const route = `${options.method || 'GET'} ${target.pathname}`;
    calls.push({ route, url: String(url) });
    const auth = (options.headers && (options.headers.authorization || options.headers.Authorization)) || '';
    const token = String(auth).replace(/^Bearer\s+/i, '');
    const header = (name) => (options.headers && options.headers[name]) || (options.headers && options.headers[name.toLowerCase()]);
    const jsonResponse = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

    if (target.origin !== new URL(PROVIDED).origin) {
      throw new Error(`unexpected host ${target.origin}`);
    }
    if (route === 'POST /agent/ping') {
      const ok = token && token === model.secretValues.CAPTURE_TOKEN;
      return jsonResponse(ok ? 200 : 401, { ok: Boolean(ok) });
    }
    if (!model.secretValues.TRANSFER_TOKEN || token !== model.secretValues.TRANSFER_TOKEN) {
      return jsonResponse(404, { error: 'not found' });
    }
    if (route === 'GET /transfer/status') {
      return jsonResponse(200, {
        version: '1.1.0',
        hasOwner: owner,
        ownerId: owner ? 'tester' : null,
        counts: counts(),
        ownerSecretHash: transfer.ownerSecretHash(model.secretValues.OWNER_LINK_SECRET || ''),
      });
    }
    if (route === 'GET /transfer/manifest') {
      return jsonResponse(200, {
        version: 1,
        tables: { ...LIBRARY },
        keys: [
          { key: 'refs/aaaaaaaaaaaaaaaa/11111111111111111111111111111111/desktop.png', size: 11, contentType: 'image/png' },
          { key: 'refs/bbbbbbbbbbbbbbbb/22222222222222222222222222222222/snapshot.html', size: 7, contentType: 'text/html' },
        ],
        totalBytes: 18,
        excluded: ['owner_nonces', 'webauthn_challenges'],
        version: '1.1.0',
      });
    }
    if (route === 'GET /transfer/manifest-empty') return jsonResponse(200, { version: 1, tables: {}, keys: [], totalBytes: 0 });
    if (route === 'POST /transfer/resume') {
      const body = JSON.parse(options.body || '{}');
      return jsonResponse(200, { resumed: (body.ids || []).length, skipped: 0 });
    }
    if (target.pathname.startsWith('/transfer/file/')) {
      const key = decodeURIComponent(target.pathname.slice('/transfer/file/'.length));
      if ((options.method || 'GET') === 'HEAD') {
        return new Response(null, { status: objects.has(key) ? 200 : 404, headers: { 'content-length': String(objects.get(key)?.length || 0) } });
      }
      if (options.method === 'PUT') {
        const chunks = [];
        const body = options.body;
        if (body && typeof body.getReader === 'function') {
          const reader = body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(Buffer.from(value));
          }
        } else if (body && typeof body[Symbol.asyncIterator] === 'function') {
          for await (const chunk of body) chunks.push(Buffer.from(chunk));
        } else if (body !== undefined && body !== null) chunks.push(Buffer.from(body));
        const buffer = Buffer.concat(chunks);
        if (objects.has(key) && !target.searchParams.get('overwrite')) return jsonResponse(409, { error: 'exists' });
        objects.set(key, buffer);
        model.uploadedContentTypes = { ...(model.uploadedContentTypes || {}), [key]: header('content-type') };
        return jsonResponse(200, { ok: true, size: buffer.length });
      }
      if (!objects.has(key)) return jsonResponse(404, { error: 'not found' });
      return new Response(objects.get(key), { status: 200, headers: { 'content-type': 'image/png' } });
    }
    return jsonResponse(404, { error: 'not found' });
  }
  return {
    fetch: fetchImpl,
    calls,
    objects,
    setOwner: (value) => { owner = value; },
    get owner() { return owner; },
  };
}

function fakeLibraryModule(model) {
  const manifest = {
    version: 1,
    tables: { ...LIBRARY },
    keys: [
      { key: 'refs/aaaaaaaaaaaaaaaa/11111111111111111111111111111111/desktop.png', size: 11, contentType: 'image/png' },
      { key: 'refs/bbbbbbbbbbbbbbbb/22222222222222222222222222222222/snapshot.html', size: 7, contentType: 'text/html' },
    ],
    totalBytes: 18,
  };
  return {
    async withLocalWorker(options, fn) {
      const handle = {
        url: 'http://127.0.0.1:59999',
        transfer: {
          async manifest() { return model.manifest || manifest; },
          async get(key) {
            const entry = manifest.keys.find((item) => item.key === key);
            const size = entry ? entry.size : 4;
            return new Response(Buffer.alloc(size, 120), { status: 200, headers: { 'content-type': entry ? entry.contentType : 'application/octet-stream' } });
          },
          async head(key) { return (model.localObjects || new Map()).get(key) ?? null; },
          async put(key, body) { void body; return { ok: true }; },
        },
        async dispose() {},
      };
      return fn(handle);
    },
    async localWorker() { throw new Error('not used in this test'); },
  };
}

function collectedEmitter() {
  const events = [];
  const stdout = { write: (line) => { events.push(JSON.parse(line)); return true; } };
  const stderr = { write: () => true };
  const emit = createEmitter({ json: true, stdout, stderr });
  return { emit, events, stdout, stderr };
}

function buildModel(overrides = {}) {
  const library = fakeLibrary();
  return {
    root: library.root,
    accountId: 'acct_0123456789',
    email: 'tester@example.com',
    d1: [],
    kv: [],
    r2: [],
    secrets: new Set(),
    secretValues: {},
    deployed: false,
    migrationsApplied: false,
    tables: ['refs', 'pages', 'animations', 'collections', 'reference_collections', 'page_collections'],
    subdomain: 'tester',
    ...overrides,
  };
}

async function runSetup(model, flags = {}, options = {}) {
  const emitter = collectedEmitter();
  const cloudFake = options.cloud || fakeCloud(model);
  const wrangler = fakeWrangler(model);
  const deps = {
    fetch: cloudFake.fetch,
    library: fakeLibraryModule(model),
    local: LOCAL_FAKE,
  };
  const ctx = createContext({
    root: model.root,
    dataRoot: model.root,
    flags: { login: 'tester', domain: 'tester', noOpen: true, ...flags },
    emit: emitter.emit,
    api: fakeApi(model),
    wrangler,
    deps,
  });
  // The emitter's human event is how the fake browser "completes" the owner link.
  const originalHuman = emitter.emit.human;
  emitter.emit.human = (step, action, url, message) => {
    if (step === 'owner') cloudFake.setOwner(true);
    return originalHuman(step, action, url, message);
  };
  const result = await commands.commandSetup(ctx);
  return { result, ctx, events: emitter.events, wrangler, cloud: cloudFake, model };
}

test('patches the built config for the library layout', () => {
  const built = {
    configPath: '/build/web/wrangler.jsonc',
    userConfigPath: '/build/web/wrangler.jsonc',
    name: 'snip', main: 'index.js', no_bundle: true,
    assets: { directory: '../client', not_found_handling: 'single-page-application' },
    d1_databases: [{ binding: 'DB', database_name: 'snip', database_id: 'REPLACE_WITH_D1_DATABASE_ID', migrations_dir: '../../migrations' }],
    kv_namespaces: [{ binding: 'OAUTH_KV', id: 'REPLACE_WITH_KV_NAMESPACE_ID' }],
    r2_buckets: [{ binding: 'FILES', bucket_name: 'snip-files' }],
    vars: { PUBLIC_URL: 'https://snip.YOUR-SUBDOMAIN.workers.dev' },
  };
  const patched = lib.patchDeployConfig(built, { d1Id: 'd1-id', kvId: 'kv-id', login: 'tester', url: PROVIDED });
  assert.equal(patched.configPath, undefined);
  assert.equal(patched.userConfigPath, undefined);
  assert.equal(patched.main, 'index.js');
  assert.equal(patched.no_bundle, true);
  assert.equal(patched.assets.directory, '../client');
  assert.equal(patched.d1_databases[0].database_id, 'd1-id');
  assert.equal(patched.d1_databases[0].migrations_dir, '../migrations');
  assert.equal(patched.kv_namespaces[0].id, 'kv-id');
  assert.equal(patched.vars.PUBLIC_URL, PROVIDED);
  assert.equal(patched.vars.ALLOWED_GITHUB_LOGINS, 'tester');
  // Untouched fields survive.
  assert.equal(patched.assets.not_found_handling, 'single-page-application');
  assert.equal(built.d1_databases[0].database_id, 'REPLACE_WITH_D1_DATABASE_ID');
});

test('prepareDeployLayout copies snip, client and migrations and never touches the runtime', () => {
  const library = fakeLibrary();
  const result = deploy.prepareDeployLayout({ root: library.root, dataRoot: library.root, d1Id: 'd1-id', kvId: 'kv-id', login: 'tester', url: PROVIDED });
  assert.ok(fs.existsSync(path.join(library.root, 'cloud/snip/index.js.map')), 'the source map must be copied');
  assert.ok(fs.existsSync(path.join(library.root, 'cloud/client/assets/app.js')));
  assert.ok(fs.existsSync(path.join(library.root, 'cloud/migrations/0001_init.sql')));
  const config = JSON.parse(fs.readFileSync(result.file, 'utf8'));
  assert.equal(config.d1_databases[0].migrations_dir, '../migrations');
  assert.equal(config.vars.PUBLIC_URL, PROVIDED);
  // Re-deploying replaces, never merges: a stale file must not survive.
  fs.writeFileSync(path.join(library.root, 'cloud/client/stale.txt'), 'old');
  deploy.prepareDeployLayout({ root: library.root, dataRoot: library.root, d1Id: 'd1-id', kvId: 'kv-id', login: 'tester', url: PROVIDED });
  assert.equal(fs.existsSync(path.join(library.root, 'cloud/client/stale.txt')), false);
});

test('public URL, canonical origin and hosts', () => {
  assert.equal(lib.publicUrlFrom('octo'), 'https://snip.octo.workers.dev');
  assert.equal(lib.publicUrlFrom('snip.example.com'), 'https://snip.example.com');
  assert.equal(lib.publicUrlFrom('https://snip.example.com/path/'), 'https://snip.example.com');
  assert.equal(lib.canonicalOrigin('https://snip.example.com/'), 'https://snip.example.com');
  // new URL normalizes the host, which is exactly the canonical form PUBLIC_URL needs.
  assert.equal(lib.canonicalOrigin('https://Snip.Example.com'), 'https://snip.example.com');
  assert.throws(() => lib.canonicalOrigin('https://snip.example.com/a'), /origin/);
  assert.throws(() => lib.canonicalOrigin('https://user:pass@snip.example.com'), /credentials/);
  assert.throws(() => lib.canonicalOrigin('ftp://snip.example.com'), /http or https/);
  assert.equal(lib.originHost('https://snip.example.com/x'), 'snip.example.com');
});

test('dump parsing handles quotes, comments and multi-line statements', () => {
  const sql = `-- header\nINSERT INTO "refs" (id, title) VALUES ('a', 'it''s; fine');\nINSERT INTO "pages" (id, url)\nVALUES ('p1', 'https://x.test');\n`;
  const statements = lib.splitSqlStatements(sql);
  assert.equal(statements.length, 2);
  assert.match(statements[0], /it''s; fine/);
  assert.deepEqual(lib.columnsFromDump(sql), { refs: ['id', 'title'], pages: ['id', 'url'] });
  assert.deepEqual(lib.countsFromDump(sql), { refs: 1, pages: 1 });
  assert.deepEqual(lib.batchStatements(['a', 'b', 'c'], 3), [['a'], ['b'], ['c']]);
});

test('the digest is stable, order independent and column aware', () => {
  const sql = 'SELECT COUNT(*) AS rows, coalesce(SUM(LENGTH(coalesce(quote("id"),\'\')||char(30)||coalesce(quote("url"),\'\'))),0) AS sig FROM "refs"';
  assert.match(sql, /FROM "refs"/);
  const a = lib.digestOf({ refs: digest(2, 30), pages: digest(1, 4) });
  const b = lib.digestOf({ pages: digest(1, 4), refs: digest(2, 30) });
  assert.equal(a, b);
  assert.match(a, /^snip-digest-v1:[0-9a-f]{64}$/);
  assert.notEqual(a, lib.digestOf({ refs: digest(2, 31), pages: digest(1, 4) }));
  assert.match(lib.digestSql('refs', ['id', 'url']), /quote\("id"\)/);
});

test('cloud.json is written atomically, 0600, and preserves unknown fields', () => {
  const dir = tempDir();
  const first = stateModule.readState(dir);
  assert.equal(first.mode, 'local');
  stateModule.acquireLock(dir).release();
  stateModule.setMode(dir, 'cloud');
  const file = stateModule.statePath(dir);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.futureField = { fromNewerApp: true };
  fs.writeFileSync(file, JSON.stringify(raw));
  stateModule.journalStep(dir, 'deploy', 'done');
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(after.futureField, { fromNewerApp: true });
  assert.equal(after.steps[0].id, 'deploy');
  assert.equal(after.mode, 'cloud');
});

test('a live lock blocks another process; a dead one is reclaimed', () => {
  const dir = tempDir();
  const taken = stateModule.acquireLock(dir, { command: 'setup', pid: process.pid, now: Date.now() });
  assert.throws(() => stateModule.acquireLock(dir, { command: 'setup', pid: process.pid + 999999, now: Date.now() }), (error) => error.code === 'LOCKED');
  taken.release();
  // A dead PID from the past is stale.
  const stale = stateModule.acquireLock(dir, { pid: 999999, now: Date.now() });
  stale.release();
  fs.writeFileSync(stateModule.lockPath(dir), JSON.stringify({ v: 1, pid: 2 ** 30, startedAt: Date.now() - 20 * 60 * 1000, command: 'setup', host: 'x' }));
  const reclaimed = stateModule.acquireLock(dir, { pid: process.pid, now: Date.now() });
  reclaimed.release();
});

test('verify-then-skip: completed steps re-verify and are skipped, stale ones re-run', async () => {
  const dir = tempDir();
  const emitter = collectedEmitter();
  let runs = 0;
  let valid = false;
  const steps = [{
    id: 'one',
    title: 'One',
    async run() { runs++; valid = true; return { message: 'ran' }; },
    async verify() { return valid; },
  }];
  const ctx = createContext({ root: dir, dataRoot: dir, flags: {}, emit: emitter.emit, api: {}, wrangler: { bin: '/x', run: async () => ({ ok: true }) } });
  await runSteps(steps, ctx);
  assert.equal(runs, 1);
  // Marked done and still valid → skipped.
  await runSteps(steps, ctx);
  assert.equal(runs, 1);
  // Marked done but no longer valid → runs again (and verifies again after).
  valid = false;
  await runSteps(steps, ctx);
  assert.equal(runs, 2);
  assert.ok(emitter.events.some((event) => event.event === 'step' && event.status === 'skipped'));
});

test('a failing step journals the failure and stops the run', async () => {
  const dir = tempDir();
  const emitter = collectedEmitter();
  const order = [];
  const steps = [
    { id: 'ok', title: 'Ok', async run() { order.push('ok'); }, async verify() { return true; } },
    { id: 'bad', title: 'Bad', async run() { throw new StepError('NOPE', 'It broke.', { hint: 'Fix it.' }); }, async verify() { return false; } },
    { id: 'never', title: 'Never', async run() { order.push('never'); }, async verify() { return true; } },
  ];
  const ctx = createContext({ root: dir, dataRoot: dir, flags: {}, emit: emitter.emit, api: {}, wrangler: { bin: '/x', run: async () => ({ ok: true }) } });
  await assert.rejects(() => runSteps(steps, ctx), (error) => error.code === 'NOPE' && error.step === 'bad');
  assert.deepEqual(order, ['ok']);
  assert.equal(ctx.stepStatus('bad'), 'failed');
  assert.equal(ctx.state().error, null, 'the command layer records the error, not the runner');
  assert.ok(emitter.events.some((event) => event.event === 'step' && event.status === 'failed' && event.step === 'bad'));
});

test('needs_input propagates out of a step without being turned into a failure', async () => {
  const dir = tempDir();
  const emitter = collectedEmitter();
  const steps = [{ id: 'ask', title: 'Ask', async run() { throw new NeedsInputError([{ key: 'domain', label: 'domain', secret: false }]); }, async verify() { return false; } }];
  const ctx = createContext({ root: dir, dataRoot: dir, flags: {}, emit: emitter.emit, api: {}, wrangler: { bin: '/x', run: async () => ({ ok: true }) } });
  await assert.rejects(() => runSteps(steps, ctx), (error) => error.code === 'NEEDS_INPUT');
  assert.notEqual(ctx.stepStatus('ask'), 'failed');
});

test('owner links are signed, scoped and single-shaped', () => {
  const secret = 'a'.repeat(64);
  const minted = transfer.mintOwnerLink({ secret, url: PROVIDED, ownerId: 'tester', port: 1234, now: 1_700_000_000_000, nonce: 'b'.repeat(32) });
  const url = new URL(minted.link);
  assert.equal(url.origin, PROVIDED);
  assert.equal(url.pathname, '/auth/owner');
  const token = url.searchParams.get('t');
  const [payload, signature] = token.split('.');
  assert.equal(payload, `snip-owner-v1|tester|${1_700_000_000 + 600}|${'b'.repeat(32)}|1234`);
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  assert.equal(signature, expected);
  assert.equal(transfer.ownerSecretHash(secret), crypto.createHash('sha256').update(`snip-owner-hash-v1|${secret}`).digest('base64url').slice(0, 16));
});

test('the loopback accepts exactly one token and drops the fragment', async () => {
  const loopback = transfer.startLoopback({ timeoutMs: 5000 });
  const port = await loopback.listening;
  const tokenPromise = loopback.token;
  const page = await fetch(`http://127.0.0.1:${port}/done`);
  const html = await page.text();
  assert.match(html, /location\.hash/);
  assert.match(html, /history\.replaceState/);
  const stored = await fetch(`http://127.0.0.1:${port}/store`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'session-value' }) });
  assert.equal(stored.status, 200);
  assert.equal(await tokenPromise, 'session-value');
  const second = await fetch(`http://127.0.0.1:${port}/store`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'other' }) }).catch(() => null);
  assert.ok(!second || second.status !== 200);
  loopback.close();
});

test('the transfer client streams uploads, respects 409 and lists the manifest', async () => {
  const model = buildModel();
  const cloud = fakeCloud(model);
  model.secretValues.TRANSFER_TOKEN = 'transfer-token';
  model.secretValues.OWNER_LINK_SECRET = 'owner-secret';
  const client = transfer.createTransfer({ url: PROVIDED, token: 'transfer-token', fetchImpl: cloud.fetch });
  const manifest = await client.manifest();
  assert.equal(manifest.keys.length, 2);
  const { Readable } = require('node:stream');
  const put = await client.put(manifest.keys[0].key, Readable.from([Buffer.from('hello world')]), { size: 11, contentType: 'image/png' });
  assert.equal(put.ok, true);
  assert.equal(cloud.objects.get(manifest.keys[0].key).toString(), 'hello world');
  assert.equal(model.uploadedContentTypes[manifest.keys[0].key], 'image/png');
  const again = await client.put(manifest.keys[0].key, Readable.from([Buffer.from('hello world')]), { size: 11 });
  assert.equal(again.skipped, true);
  assert.equal(await client.head(manifest.keys[0].key), 11);
  assert.equal(await client.head('refs/cccccccccccccccc/33333333333333333333333333333333/missing.png'), null);
  const resumed = await client.resume(['aaaaaaaaaaaaaaaa', 'aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb']);
  assert.equal(resumed.resumed, 2);
  // A bad token is a 404 at the surface and a clear error here.
  const wrong = transfer.createTransfer({ url: PROVIDED, token: 'nope', fetchImpl: cloud.fetch });
  await assert.rejects(() => wrong.manifest(), (error) => ['TRANSFER_DISABLED', 'TRANSFER_TOKEN_INVALID'].includes(error.code));
});

test('a full setup runs every step against fakes and never succeeds on an empty copy', async () => {
  const model = buildModel();
  const outcomePromise = runSetup(model);
  const { events, wrangler, cloud, result } = await outcomePromise;
  const statuses = new Map();
  for (const event of events) if (event.event === 'step') statuses.set(event.step, event.status);
  for (const id of setup.ENABLE_STEPS) {
    assert.ok(statuses.has(id), `step ${id} did not report`);
    assert.ok(['ok', 'skipped', 'failed'].includes(statuses.get(id)), `step ${id} ended ${statuses.get(id)}`);
  }
  // The CLI emits the terminal `result`; the command returns the same outcome.
  assert.equal(result.ok, true);
  assert.equal(result.code, 'OK');
  assert.equal(result.mode, 'cloud');
  // Order is the contract's order: release before export.
  const started = events.filter((event) => event.event === 'step' && event.status === 'started').map((event) => event.step);
  assert.deepEqual(started, setup.ENABLE_STEPS);
  assert.ok(started.indexOf('release') < started.indexOf('export'));
  // Nothing secret is ever printed.
  const text = JSON.stringify(events);
  for (const value of Object.values(model.secretValues)) assert.equal(text.includes(value), false, 'a secret leaked into the event stream');
  // The deploy used the patched config in the library, never the checkout.
  const deployCall = wrangler.calls.find((call) => call.args[0] === 'deploy');
  assert.ok(deployCall.args.includes(path.join(model.root, 'cloud/snip/wrangler.json')));
  assert.equal(cloud.calls.some((call) => call.route === 'PUT /transfer/file/refs/aaaaaaaaaaaaaaaa/11111111111111111111111111111111/desktop.png'), true);
  const state = stateModule.readState(model.root);
  assert.equal(state.mode, 'cloud');
  assert.equal(state.cloud.url, PROVIDED);
  assert.equal(state.cloud.detachedAt, null);
  assert.ok(state.cloud.transfer.digest.startsWith('snip-digest-v1:'));
  assert.equal(state.cloud.snapshot.refs, LIBRARY.refs);
});

test('the guard refuses a foreign Snip before creating anything', async () => {
  const model = buildModel({
    d1: [{ id: 'someone-elses', name: 'snip', tables: 4 }],
    deployed: true,
    schema: false,
    bindings: [{ name: 'SOME_OTHER_BINDING' }],
    memberships: [{ id: 'acct_0123456789', name: 'Test Account' }],
  });
  const emitter = collectedEmitter();
  const wrangler = fakeWrangler(model);
  const ctx = createContext({ root: model.root, dataRoot: model.root, flags: { login: 'tester', domain: 'tester', noOpen: true }, emit: emitter.emit, api: fakeApi(model), wrangler, deps: { fetch: fakeCloud(model).fetch, library: fakeLibraryModule(model), local: LOCAL_FAKE } });
  await assert.rejects(() => commands.commandSetup(ctx), (error) => error.code === 'FOREIGN_SNIP');
  const failed = emitter.events.find((event) => event.event === 'step' && event.status === 'failed');
  assert.ok(failed, 'the run must report a failed step');
  assert.match(failed.message, /not a Snip library/);
  assert.equal(wrangler.calls.some((call) => call.args[0] === 'd1' && call.args[1] === 'create'), false, 'nothing may be created');
  assert.equal(model.deployed, true, 'the existing Worker is left alone');
});

test('R2 disabled waits for the human, then fails clearly when it never arrives', async () => {
  const model = buildModel({ r2Disabled: true });
  const emitter = collectedEmitter();
  const wrangler = fakeWrangler(model);
  let clock = 1_700_000_000_000;
  const ctx = createContext({
    root: model.root,
    dataRoot: model.root,
    flags: { login: 'tester', domain: 'tester', noOpen: true, managed: true },
    emit: emitter.emit,
    api: fakeApi(model),
    wrangler,
    deps: {
      fetch: fakeCloud(model).fetch,
      library: fakeLibraryModule(model),
      local: LOCAL_FAKE,
      // A clock that jumps five minutes per sleep: the wait expires immediately.
      now: () => clock,
      sleep: async (ms) => { clock += Math.max(ms, 5 * 60_000); },
    },
  });
  await assert.rejects(() => commands.commandSetup(ctx), (error) => error.code === 'R2_NOT_ENABLED');
  assert.ok(emitter.events.some((event) => event.event === 'human' && event.action === 'enable_r2'));
  assert.ok(emitter.events.some((event) => event.event === 'step' && event.step === 'r2' && event.status === 'waiting'));
});

test('an empty library skips the copy steps and records no snapshot', async () => {
  const model = buildModel({ hasOwner: true });
  model.tables = [];
  Object.assign(model, { emptyLibrary: true });
  const emitter = collectedEmitter();
  const wrangler = fakeWrangler(model);
  const localModule = fakeLibraryModule(model);
  const ctx = createContext({
    root: model.root,
    dataRoot: model.root,
    flags: { login: 'tester', domain: 'tester', noOpen: true },
    emit: emitter.emit,
    api: fakeApi(model),
    wrangler,
    deps: {
      fetch: fakeCloud(model).fetch,
      library: localModule,
      local: LOCAL_FAKE,
      deploy: {
        ...deploy,
        localQuery: async () => [{ rows: 0 }],
      },
    },
  });
  emitter.emit.human = (step, action, url, message) => {
    if (step === 'owner') ctx.deps.fetch;
    return createEmitter({ json: true, stdout: { write: (line) => { emitter.events.push(JSON.parse(line)); return true; } }, stderr: { write: () => true } }).human(step, action, url, message);
  };
  const result = await commands.commandSetup(ctx);
  assert.equal(result.ok, true);
  const state = stateModule.readState(model.root);
  assert.equal(state.mode, 'cloud');
  assert.equal(state.snapshot, null);
  const skipped = emitter.events.filter((event) => event.event === 'step' && event.status === 'skipped').map((event) => event.step);
  assert.deepEqual(skipped.sort(), ['export', 'import', 'quiesce', 'release', 'verify'].sort());
  assert.equal(wrangler.calls.some((call) => call.args[0] === 'd1' && call.args[1] === 'export'), false);
});

test('a second membership needs --account and exits as needs_input', async () => {
  const model = buildModel({ memberships: [{ id: 'acct_a', name: 'A' }, { id: 'acct_b', name: 'B' }] });
  const emitter = collectedEmitter();
  const ctx = createContext({
    root: model.root,
    dataRoot: model.root,
    flags: { login: 'tester', domain: 'tester', noOpen: true },
    emit: emitter.emit,
    api: fakeApi(model),
    wrangler: fakeWrangler(model),
    deps: { fetch: fakeCloud(model).fetch, library: fakeLibraryModule(model), local: LOCAL_FAKE },
  });
  await assert.rejects(() => commands.commandSetup(ctx), (error) => error.code === 'NEEDS_INPUT' && error.keys[0].key === 'account');
});

test('an existing Snip library asks before adopting, and --adopt-existing adopts it', async () => {
  const model = buildModel({
    deployed: true,
    schema: true,
    bindings: [{ name: 'DB' }, { name: 'FILES' }, { name: 'OAUTH_KV' }],
    d1: [{ id: 'legacy-d1', name: 'snip', tables: 6 }],
    remoteRows: { refs: 1284, pages: 9120, collections: 7 },
  });
  const emitter = collectedEmitter();
  const ctx = createContext({
    root: model.root,
    dataRoot: model.root,
    flags: { login: 'tester', domain: 'tester', noOpen: true },
    emit: emitter.emit,
    api: fakeApi(model),
    wrangler: fakeWrangler(model),
    deps: { fetch: fakeCloud(model).fetch, library: fakeLibraryModule(model), local: LOCAL_FAKE },
  });
  await assert.rejects(() => commands.commandSetup(ctx), (error) => {
    assert.equal(error.code, 'NEEDS_INPUT');
    assert.equal(error.resumeWith, '--adopt-existing');
    assert.equal(error.choice.id, 'existing-library');
    assert.equal(error.choice.data.counts.refs, 1284);
    assert.deepEqual(error.choice.options.map((option) => option.id), ['adopt-existing', 'stop']);
    return true;
  });
});

test('adopting an existing library copies nothing, keeps SESSION_SECRET and rotates CAPTURE_TOKEN', async () => {
  const model = buildModel({
    deployed: true,
    schema: true,
    bindings: [{ name: 'DB' }, { name: 'FILES' }, { name: 'OAUTH_KV' }],
    d1: [{ id: 'legacy-d1', name: 'snip', tables: 6 }],
    remoteRows: { refs: 1284, pages: 9120, collections: 7 },
    // A legacy install's secrets: SESSION_SECRET and GitHub exist; OWNER_LINK_SECRET
    // does not, because the old script never set one.
    secrets: new Set(['SESSION_SECRET', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET']),
    secretValues: { SESSION_SECRET: 'keep-me', GITHUB_CLIENT_ID: 'gh', GITHUB_CLIENT_SECRET: 'ghs' },
  });
  const emitter = collectedEmitter();
  const cloudFake = fakeCloud(model);
  const wrangler = fakeWrangler(model);
  emitter.emit.human = (step, action, url, message) => {
    if (step === 'owner') cloudFake.setOwner(true);
    return createEmitter({ json: true, stdout: { write: (line) => { emitter.events.push(JSON.parse(line)); return true; } }, stderr: { write: () => true } }).human(step, action, url, message);
  };
  const ctx = createContext({
    root: model.root,
    dataRoot: model.root,
    flags: { login: 'tester', domain: 'tester', noOpen: true, adoptExisting: true },
    emit: emitter.emit,
    api: fakeApi(model),
    wrangler,
    deps: {
      fetch: cloudFake.fetch,
      library: fakeLibraryModule(model),
      local: LOCAL_FAKE,
      transferOf: (context) => ({ status: async () => ({
        version: '1.1.0',
        counts: { refs: 1284, pages: 9120, collections: 7 },
        hasOwner: true,
        ownerId: 'tester',
        ownerSecretHash: transfer.ownerSecretHash(context.secrets().ownerLinkSecret),
      }) }),
    },
  });
  await commands.commandSetup(ctx);
  const state = stateModule.readState(model.root);
  assert.equal(state.mode, 'cloud');
  assert.equal(state.cloud.move.status, 'skipped');
  assert.equal(state.cloud.move.reason, 'adopted-existing');
  assert.equal(state.cloud.adoptedFrom, 'legacy');
  assert.equal(state.cloud.adoptedLibrary.refs, 1284);
  assert.equal(state.snapshot.keptLocal, true);
  assert.equal(state.cloud.workerVersion, '1.1.0');
  // SESSION_SECRET is never overwritten; CAPTURE_TOKEN always rotates.
  assert.equal(model.secretValues.SESSION_SECRET, 'keep-me');
  assert.notEqual(model.secretValues.CAPTURE_TOKEN, undefined);
  assert.equal(model.secretValues.GITHUB_CLIENT_ID, 'gh');
  assert.equal(model.secretValues.GITHUB_CLIENT_SECRET, 'ghs');
  // Legacy had no owner secret, so one is created for the new owner link.
  assert.match(model.secretValues.OWNER_LINK_SECRET, /^[0-9a-f]{64}$/);
  // Nothing was copied: no export, no import, no upload.
  assert.equal(wrangler.calls.some((call) => call.args[0] === 'd1' && call.args[1] === 'export'), false);
  assert.equal(cloudFake.calls.some((call) => call.route.startsWith('PUT /transfer/file/')), false);
  const skipped = emitter.events.filter((event) => event.event === 'step' && event.status === 'skipped').map((event) => event.step);
  for (const id of ['quiesce', 'release', 'export', 'import']) assert.ok(skipped.includes(id), `${id} should skip`);
});

test('an empty existing Snip is adopted silently and the move still runs', async () => {
  const model = buildModel({
    deployed: true,
    schema: true,
    bindings: [{ name: 'DB' }, { name: 'FILES' }, { name: 'OAUTH_KV' }],
    d1: [{ id: 'legacy-d1', name: 'snip', tables: 6 }],
    remoteRows: { refs: 0, pages: 0, collections: 0 },
  });
  const emitter = collectedEmitter();
  const cloudFake = fakeCloud(model);
  const wrangler = fakeWrangler(model);
  const ctx = createContext({
    root: model.root,
    dataRoot: model.root,
    flags: { login: 'tester', domain: 'tester', noOpen: true },
    emit: emitter.emit,
    api: fakeApi(model),
    wrangler,
    deps: { fetch: cloudFake.fetch, library: fakeLibraryModule(model), local: LOCAL_FAKE },
  });
  emitter.emit.human = (step, action, url, message) => {
    if (step === 'owner') cloudFake.setOwner(true);
    return createEmitter({ json: true, stdout: { write: (line) => { emitter.events.push(JSON.parse(line)); return true; } }, stderr: { write: () => true } }).human(step, action, url, message);
  };
  await commands.commandSetup(ctx);
  const state = stateModule.readState(model.root);
  assert.equal(state.mode, 'cloud');
  assert.equal(state.cloud.adoptedFrom, 'legacy');
  assert.equal(state.cloud.move, undefined, 'an empty adoption is not a skipped move');
  // The normal move ran: the copy was imported and uploaded.
  assert.ok(wrangler.calls.some((call) => call.args[0] === 'd1' && call.args[1] === 'export'));
  assert.ok(cloudFake.calls.some((call) => call.route.startsWith('PUT /transfer/file/')));
});

test('CLI exit codes: 0 ok, 2 needs_input, 3 locked, 4 unsupported', async () => {
  // 4: not a library (no web/, no wrangler, no dist).
  const empty = tempDir();
  const unsupported = await cli.main(['setup', '--root', empty, '--data-root', empty, '--json'], { stdout: { write: () => true }, stderr: { write: () => true } });
  assert.equal(unsupported.code, 4);

  // 3: someone else holds the lock.
  const library = fakeLibrary();
  stateModule.acquireLock(library.root, { command: 'setup', pid: process.pid, now: Date.now() });
  const locked = await cli.main(['setup', '--root', library.root, '--data-root', library.root, '--json'], { stdout: { write: () => true }, stderr: { write: () => true } });
  assert.equal(locked.code, 3);
});

test('CLI --json keeps stdout pure NDJSON and never reads stdin', async () => {
  const library = fakeLibrary();
  const model = buildModel({ root: library.root });
  const lines = [];
  const io = {
    stdout: { write: (line) => { lines.push(line); return true; } },
    stderr: { write: () => true },
  };
  const result = await cli.main(['status', '--root', library.root, '--data-root', library.root, '--json'], io);
  assert.equal(result.code, 0);
  for (const line of lines) assert.doesNotThrow(() => JSON.parse(line), `not NDJSON: ${line}`);
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.event, 'result');
  assert.equal(last.ok, true);
  void model;
});

test('detach is offline, keeps the cloud record and refuses during enabling', async () => {
  const library = fakeLibrary();
  stateModule.setMode(library.root, 'cloud');
  stateModule.updateState(library.root, (next) => {
    next.cloud = { url: PROVIDED, accountId: 'acct', workerName: 'snip', d1: { name: 'snip', id: 'd1' }, kv: { name: 'OAUTH_KV', id: 'kv' }, bucket: 'snip-files', ownerId: 'tester', detachedAt: null };
    return next;
  });
  const emitter = collectedEmitter();
  const deps = {
    fetch: async () => { throw new Error('detach must not use the network'); },
    cloud: new Proxy({}, { get() { throw new Error('detach must not touch Cloudflare'); } }),
    deploy: new Proxy({}, { get() { throw new Error('detach must not touch wrangler'); } }),
  };
  const ctx = createContext({ root: library.root, dataRoot: library.root, flags: {}, emit: emitter.emit, api: {}, wrangler: { bin: '/x', run: async () => { throw new Error('no wrangler'); } }, deps });
  const result = await commands.commandDetach(ctx);
  assert.equal(result.ok, true);
  const state = stateModule.readState(library.root);
  assert.equal(state.mode, 'local');
  assert.equal(state.cloud.url, PROVIDED);
  assert.equal(state.cloud.workerName, 'snip');
  assert.ok(state.cloud.detachedAt);
  // A healthy cloud install cannot be aborted.
  stateModule.setMode(library.root, 'cloud');
  await assert.rejects(() => commands.commandAbort(ctx), (error) => error.code === 'HEALTHY_CLOUD');
});

test('delete-resources refuses without an exact host confirmation', async () => {
  const library = fakeLibrary();
  stateModule.setMode(library.root, 'cloud');
  stateModule.updateState(library.root, (next) => {
    next.cloud = { url: PROVIDED, accountId: 'acct', workerName: 'snip', d1: { name: 'snip', id: 'd1' }, kv: { name: 'OAUTH_KV', id: 'kv' }, bucket: 'snip-files' };
    return next;
  });
  const emitter = collectedEmitter();
  const ctx = createContext({
    root: library.root,
    dataRoot: library.root,
    flags: { confirm: 'example.com' },
    emit: emitter.emit,
    api: {},
    wrangler: { bin: '/x', run: async () => ({ ok: true, stdout: '', stderr: '' }) },
    deps: { fetch: async () => { throw new Error('no network'); } },
  });
  await assert.rejects(() => commands.commandDeleteResources(ctx), (error) => error.code === 'CONFIRM_REQUIRED' && error.data.expected === 'snip.tester.workers.dev');
});

test('abort returns an interrupted enabling to local and never touches a healthy cloud', async () => {
  const library = fakeLibrary();
  const emitter = collectedEmitter();
  const ctx = createContext({ root: library.root, dataRoot: library.root, flags: {}, emit: emitter.emit, api: {}, wrangler: { bin: '/x', run: async () => ({ ok: true }) }, deps: { fetch: async () => { throw new Error('no network'); } } });
  stateModule.beginEnabling(library.root);
  const result = await commands.commandAbort(ctx);
  assert.equal(result.ok, true);
  assert.equal(stateModule.readState(library.root).mode, 'local');
  await assert.rejects(() => commands.commandAbort(ctx), (error) => error.code === 'NOTHING_TO_ABORT');
});

test('the capture env keeps existing values and adds the cloud ones', () => {
  const existing = 'SNIP_URL=http://localhost:5173\nCAPTURE_TOKEN=local\nOTHER=1\n';
  const out = lib.captureEnvText(existing, { url: PROVIDED, token: 'cloud-token' });
  assert.match(out, /^SNIP_URL=https:\/\/snip\.tester\.workers\.dev$/m);
  assert.match(out, /^CAPTURE_TOKEN=cloud-token$/m);
  assert.match(out, /^OTHER=1$/m);
  const fresh = lib.captureEnvText('', { url: PROVIDED, token: 't' });
  assert.equal(fresh, `SNIP_URL=${PROVIDED}\nCAPTURE_TOKEN=t\n`);
});

test('exit codes map preflight refusals to 4 and only two of them are retryable', () => {
  const { exitCodeFor, retryableFor } = cli;
  for (const code of ['NOT_A_LIBRARY', 'NO_NODE', 'NO_WRANGLER', 'NO_BUILD', 'BAD_CONFIG', 'NOT_AN_ACCOUNT', 'LOCAL_SERVER_RUNNING', 'UNSUPPORTED_PLATFORM', 'FOREIGN_SNIP']) {
    assert.equal(exitCodeFor({ code }), 4, `${code} must exit 4`);
  }
  assert.equal(exitCodeFor({ code: 'DEPLOY_FAILED' }), 1);
  assert.equal(exitCodeFor({ code: 'LOCKED' }), 3);
  assert.equal(exitCodeFor({ code: 'CANCELLED' }), 1);
  assert.equal(retryableFor({ code: 'NOT_AN_ACCOUNT' }), true);
  assert.equal(retryableFor({ code: 'LOCAL_SERVER_RUNNING' }), true);
  assert.equal(retryableFor({ code: 'FOREIGN_SNIP' }), false);
  assert.equal(retryableFor({ code: 'NOT_A_LIBRARY' }), false);
  // An explicit flag always wins.
  assert.equal(retryableFor({ code: 'FOREIGN_SNIP', retryable: true }), true);
});

test('npm run setup:cloudflare forwards its arguments instead of forcing setup', () => {
  const { spawnSync } = require('node:child_process');
  const library = fakeLibrary();
  const result = spawnSync(process.execPath, [path.join(__dirname, '../../scripts/cloudflare.mjs'), 'status', '--root', library.root, '--data-root', library.root, '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const events = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(events[events.length - 1].event, 'result');
  assert.equal(events[events.length - 1].ok, true);
  // The setup steps must not have run: this was a read-only status.
  assert.equal(events.some((event) => event.event === 'step'), false);
  // An unknown command is a usage error, not a silent setup.
  const unknown = spawnSync(process.execPath, [path.join(__dirname, '../../scripts/cloudflare.mjs'), 'nonsense'], { encoding: 'utf8' });
  assert.equal(unknown.status, 4);
  assert.match(unknown.stderr, /Unknown command nonsense/);
});

test('snapshot restore moves a state snapshot back and refuses in cloud mode', async () => {
  const library = fakeLibrary();
  const live = path.join(library.root, 'web/.wrangler/state');
  fs.mkdirSync(path.join(live, 'v3/d1'), { recursive: true });
  fs.writeFileSync(path.join(live, 'v3/d1/marker'), 'cloud-copy');
  const kept = path.join(library.root, 'backups/cloud-move-2026-11-06');
  fs.mkdirSync(path.join(kept, 'v3/d1'), { recursive: true });
  fs.writeFileSync(path.join(kept, 'v3/d1/marker'), 'snapshot');
  stateModule.updateState(library.root, (next) => {
    next.mode = 'local';
    next.snapshot = { path: 'backups/cloud-move-2026-11-06', takenAt: new Date().toISOString(), kind: 'state' };
    return next;
  });
  const emitter = collectedEmitter();
  const ctx = createContext({ root: library.root, dataRoot: library.root, flags: { snapshotAction: 'restore' }, emit: emitter.emit, api: {}, wrangler: { bin: '/x', run: async () => ({ ok: true }) }, deps: { fetch: async () => { throw new Error('no network'); } } });
  await commands.commandSnapshot(ctx);
  assert.equal(fs.readFileSync(path.join(live, 'v3/d1/marker'), 'utf8'), 'snapshot');
  // The replaced copy is kept, never deleted.
  const backups = fs.readdirSync(path.join(library.root, 'backups')).filter((name) => name.startsWith('replaced-'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(library.root, 'backups', backups[0], 'v3/d1/marker'), 'utf8'), 'cloud-copy', 'the replaced copy must be kept for recovery');

});

test('snapshot restore refuses in cloud mode and delete clears the record', async () => {
  const library = fakeLibrary();
  const kept = path.join(library.root, 'backups/cloud-move-x');
  fs.mkdirSync(kept, { recursive: true });
  fs.writeFileSync(path.join(kept, 'dump.sql'), '');
  stateModule.updateState(library.root, (next) => {
    next.mode = 'cloud';
    next.snapshot = { path: 'backups/cloud-move-x', takenAt: new Date().toISOString() };
    return next;
  });
  const emitter = collectedEmitter();
  const ctx = createContext({ root: library.root, dataRoot: library.root, flags: { snapshotAction: 'restore' }, emit: emitter.emit, api: {}, wrangler: { bin: '/x', run: async () => ({ ok: true }) }, deps: { fetch: async () => { throw new Error('no network'); } } });
  await assert.rejects(() => commands.commandSnapshot(ctx), (error) => error.code === 'IN_CLOUD');
  const del = createContext({ root: library.root, dataRoot: library.root, flags: { snapshotAction: 'delete' }, emit: emitter.emit, api: {}, wrangler: { bin: '/x', run: async () => ({ ok: true }) }, deps: { fetch: async () => { throw new Error('no network'); } } });
  await commands.commandSnapshot(del);
  assert.equal(stateModule.readState(library.root).snapshot, null);
  assert.equal(fs.existsSync(kept), false);
});

test('no resource is created before guard has classified the account', async () => {
  const CREATES = ['d1 create', 'kv namespace create', 'r2 bucket create'];
  for (const scenario of ['fresh', 'foreign', 'adopt-empty', 'adopt-existing']) {
    const model = buildModel(scenario === 'fresh' ? {} : {
      deployed: true,
      schema: true,
      bindings: [{ name: 'DB' }, { name: 'FILES' }, { name: 'OAUTH_KV' }],
      d1: [{ id: 'legacy-d1', name: 'snip', tables: 6 }],
      remoteRows: { refs: scenario === 'adopt-existing' ? 1284 : 0, pages: scenario === 'adopt-existing' ? 9120 : 0, collections: 0 },
      ...(scenario === 'foreign' ? { schema: false, bindings: [{ name: 'OTHER' }] } : {}),
    });
    const wrangler = fakeWrangler(model);
    const cloudFake = fakeCloud(model);
    let guardSeen = false;
    const emitter = collectedEmitter();
    const originalStep = emitter.emit.step;
    emitter.emit.step = (step, status, message, extra) => {
      if (step === 'guard') guardSeen = true;
      return originalStep(step, status, message, extra);
    };
    const createsBeforeGuard = [];
    const spyRun = wrangler.run;
    wrangler.run = async (args, options) => {
      const line = args.join(' ');
      if (!guardSeen && CREATES.some((prefix) => line.startsWith(prefix))) createsBeforeGuard.push(line);
      return spyRun(args, options);
    };
    const ctx = createContext({
      root: model.root,
      dataRoot: model.root,
      flags: { login: 'tester', domain: 'tester', noOpen: true, adoptExisting: scenario === 'adopt-existing' },
      emit: emitter.emit,
      api: fakeApi(model),
      wrangler,
      deps: {
        fetch: cloudFake.fetch,
        library: fakeLibraryModule(model),
        local: LOCAL_FAKE,
        transferOf: (context) => ({ status: async () => ({
          version: '1.1.0', counts: { refs: 1284, pages: 0, collections: 0 }, hasOwner: true, ownerId: 'tester',
          ownerSecretHash: transfer.ownerSecretHash(context.secrets().ownerLinkSecret),
        }) }),
      },
    });
    emitter.emit.human = (step, action, url, message) => {
      if (step === 'owner') cloudFake.setOwner(true);
      return createEmitter({ json: true, stdout: { write: (line) => { emitter.events.push(JSON.parse(line)); return true; } }, stderr: { write: () => true } }).human(step, action, url, message);
    };
    await commands.commandSetup(ctx).catch((error) => {
      // A foreign account must refuse; every other scenario should finish.
      if (scenario !== 'foreign') throw error;
      assert.equal(error.code, 'FOREIGN_SNIP');
    });
    assert.deepEqual(createsBeforeGuard, [], `${scenario}: created ${createsBeforeGuard.join(', ')} before guard`);
  }
});
