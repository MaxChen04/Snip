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

const SYNTHETIC = require('./fixtures/synthetic.cjs');
const { runSteps, StepError, NeedsInputError } = require('../provision/engine.cjs');
const stateModule = require('../provision/state.cjs');
const lib = require('../provision/lib.cjs');
const deploy = require('../provision/deploy.cjs');
const cloudModule = require('../provision/cloud.cjs');
const { retryOf } = require('../provision/context.cjs');
const { createEmitter } = require('../provision/emit.cjs');
const { createContext } = require('../provision/context.cjs');
const realLocal = require('../provision/local.cjs');
const transfer = require('../provision/transfer.cjs');
const { libraryConfig } = require('../provision/library.cjs');
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
    // The Worker's ping is a GET with the capture protocol header.
    if (route === 'GET /agent/ping') {
      const ok = token && token === model.secretValues.CAPTURE_TOKEN;
      return jsonResponse(ok ? 200 : 401, { ok: Boolean(ok) });
    }
    if (!model.secretValues.TRANSFER_TOKEN || token !== model.secretValues.TRANSFER_TOKEN) {
      return jsonResponse(404, { error: 'not found' });
    }
    if (route === 'POST /agent/ping') {
      calls.push({ route: 'WRONG METHOD' });
      return jsonResponse(405, { error: 'method not allowed' });
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
      // A listing of the bucket, exactly like the Worker's: whatever was PUT.
      const keys = [...objects.entries()].map(([key, value]) => ({
        key,
        size: value.length,
        contentType: (model.uploadedContentTypes || {})[key] || 'application/octet-stream',
      }));
      return jsonResponse(200, {
        version: 1,
        tables: { ...LIBRARY },
        keys,
        totalBytes: keys.reduce((sum, entry) => sum + entry.size, 0),
        excluded: ['owner_nonces', 'webauthn_challenges'],
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
      { key: SYNTHETIC.fileKey(1, 'desktop.png'), size: 11, contentType: 'image/png' },
      { key: SYNTHETIC.fileKey(2, 'snapshot.html'), size: 7, contentType: 'text/html' },
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
    libraryConfig: ({ dataRoot }) => path.join(dataRoot, 'web/wrangler.jsonc'),
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
    if (options.onHuman) options.onHuman({ step, action, url, message });
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

test('a build without rate-limit bindings takes them from the tracked template', () => {
  const template = fs.readFileSync(path.join(__dirname, '../../web/wrangler.jsonc'), 'utf8');
  const ratelimits = lib.readRatelimits(template);
  assert.ok(ratelimits && ratelimits.length, 'the tracked template declares rate limits');
  assert.ok(ratelimits.every((entry) => entry.name && entry.namespace_id && entry.simple));
  const base = { d1_databases: [{ binding: 'DB' }], kv_namespaces: [{ binding: 'OAUTH_KV' }] };
  const filled = lib.patchDeployConfig(base, { d1Id: 'd1-id', kvId: 'kv-id', login: 'tester', url: PROVIDED, ratelimits });
  assert.deepEqual(filled.ratelimits, ratelimits);
  // A build that already has them (for example tuned thresholds) keeps its own.
  const own = [{ name: 'OAUTH_TOKEN_LIMITER', namespace_id: '1', simple: { limit: 5, period: 60 } }];
  const kept = lib.patchDeployConfig({ ...base, ratelimits: own }, { d1Id: 'd1-id', kvId: 'kv-id', login: 'tester', url: PROVIDED, ratelimits });
  assert.deepEqual(kept.ratelimits, own);
  assert.equal(lib.readRatelimits('{ "name": "snip" }'), null);
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
  // A blank or placeholder value is "not given", never a URL.
  assert.equal(lib.publicUrlFrom(' '), null);
  assert.equal(lib.canonicalOrigin('https://snip.example.com/'), 'https://snip.example.com');
  // new URL normalizes the host, which is exactly the canonical form PUBLIC_URL needs.
  assert.equal(lib.canonicalOrigin('https://Snip.Example.com'), 'https://snip.example.com');
  assert.throws(() => lib.canonicalOrigin('https://snip.example.com/a'), /origin/);
  assert.throws(() => lib.canonicalOrigin('https://user:pass@snip.example.com'), /credentials/);
  assert.throws(() => lib.canonicalOrigin('ftp://snip.example.com'), /http or https/);
  assert.equal(lib.originHost('https://snip.example.com/x'), 'snip.example.com');
});

// Relocated from the retired cloudflare-script test: `parseCreatedId` is live
// (`cloud.cjs` parses `wrangler d1 create` / `kv namespace create` output with it),
// so its coverage moves here rather than disappearing with the old script.
test('ids printed by wrangler create commands', () => {
  // Synthetic ids: all zeros with a tag, never a real database or namespace.
  const databaseId = '00000000-0000-4000-8000-00000000a001';
  const namespaceId = '00000000000000000000000000000a02';
  assert.equal(lib.parseCreatedId(`[[d1_databases]]\nbinding = "DB"\ndatabase_name = "snip"\ndatabase_id = "${databaseId}"`, 'database_id'), databaseId);
  assert.equal(lib.parseCreatedId(`{\n  "d1_databases": [{ "binding": "DB", "database_id": "${databaseId}" }]\n}`, 'database_id'), databaseId);
  assert.equal(lib.parseCreatedId(`"kv_namespaces": [{ "binding": "OAUTH_KV", "id": "${namespaceId}" }]`, 'id'), namespaceId);
  // Nothing printable is "no id", never a guess.
  assert.equal(lib.parseCreatedId('no ids here', 'database_id'), null);
});

// The tracked config is what a source build compiles against, so it must keep
// shipping placeholders: a real database id committed here would point every
// checkout at one Cloudflare account.
test('the tracked wrangler config ships placeholders only', () => {
  const tracked = fs.readFileSync(path.join(__dirname, '../../web/wrangler.jsonc'), 'utf8');
  assert.deepEqual(lib.readValues(tracked), { d1: null, kv: null, login: null, url: null });
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
  const empty = await client.manifest();
  assert.deepEqual(empty.keys, [], 'a fresh bucket lists nothing until something is uploaded');
  const { Readable } = require('node:stream');
  const key = SYNTHETIC.fileKey(1, 'desktop.png');
  const put = await client.put(key, Readable.from([Buffer.from('hello world')]), { size: 11, contentType: 'image/png' });
  assert.equal(put.ok, true);
  assert.equal(cloud.objects.get(key).toString(), 'hello world');
  assert.equal(model.uploadedContentTypes[key], 'image/png');
  const again = await client.put(key, Readable.from([Buffer.from('hello world')]), { size: 11 });
  assert.equal(again.skipped, true);
  const listed = await client.manifest();
  assert.deepEqual(listed.keys.map((entry) => [entry.key, entry.size, entry.contentType]), [[key, 11, 'image/png']]);
  assert.equal(await client.head(key), 11);
  assert.equal(await client.head(SYNTHETIC.fileKey(3, 'missing.png')), null);
  const resumed = await client.resume([SYNTHETIC.refId(1), SYNTHETIC.refId(1), SYNTHETIC.refId(2)]);
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
  assert.equal(cloud.calls.some((call) => call.route === `PUT /transfer/file/${SYNTHETIC.fileKey(1, 'desktop.png')}`), true);
  const state = stateModule.readState(model.root);
  assert.equal(state.mode, 'cloud');
  assert.equal(state.cloud.url, PROVIDED);
  assert.equal(state.cloud.detachedAt, null);
  assert.ok(state.transfer.digest.startsWith('snip-digest-v1:'));
  assert.equal(state.snapshot.refs, LIBRARY.refs);
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

test('adoption rotates OWNER_LINK_SECRET when the Worker has one and this Mac has no copy', {
  // The case a real second machine hits: the cloud install already carries an
  // OWNER_LINK_SECRET minted elsewhere, and this Mac's .snip/cloud-secrets.json
  // does not exist. Keeping the cloud value would leave this Mac unable to mint
  // a single valid owner link, because a Worker secret can never be read back.
}, async () => {
  const previous = crypto.randomBytes(32).toString('hex');
  const model = buildModel({
    deployed: true,
    schema: true,
    bindings: [{ name: 'DB' }, { name: 'FILES' }, { name: 'OAUTH_KV' }],
    d1: [{ id: 'legacy-d1', name: 'snip', tables: 6 }],
    remoteRows: { refs: 4, pages: 9, collections: 1 },
    // The Worker holds an owner secret this Mac has never seen.
    secrets: new Set(['SESSION_SECRET', 'CAPTURE_TOKEN', 'OWNER_LINK_SECRET']),
    secretValues: { SESSION_SECRET: 'keep-me', CAPTURE_TOKEN: 'old-capture', OWNER_LINK_SECRET: previous },
  });
  assert.equal(stateModule.readSecrets(model.root), null, 'no local secrets file to start from');

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
      // What the Worker really holds, so a secret this Mac saved but never sent
      // would fail the drift check instead of passing silently.
      transferOf: () => ({ status: async () => ({
        version: '1.1.4',
        counts: { refs: 4, pages: 9, collections: 1 },
        hasOwner: true,
        ownerId: 'tester',
        ownerSecretHash: transfer.ownerSecretHash(model.secretValues.OWNER_LINK_SECRET || ''),
      }) }),
    },
  });
  const result = await commands.commandSetup(ctx);
  assert.equal(result.ok, true);

  const stored = stateModule.readSecrets(model.root);
  assert.match(stored.ownerLinkSecret, /^[0-9a-f]{64}$/, 'this Mac now holds an owner secret');
  assert.notEqual(stored.ownerLinkSecret, previous, 'the cloud value cannot be kept: it was never readable');
  assert.equal(model.secretValues.OWNER_LINK_SECRET, stored.ownerLinkSecret, 'and the Worker was given the same one');
  assert.equal(stored.captureToken, model.secretValues.CAPTURE_TOKEN, 'the capture token follows the same rule');
  // The drift check passed against the Worker's real value, not a value the test
  // echoed back: a run that kept the old secret would have thrown SECRET_DRIFT.
  const secretsStep = emitter.events.find((event) => event.event === 'step' && event.step === 'secrets' && event.status === 'ok');
  assert.equal(JSON.parse(secretsStep.data.detail).ownerLinkSecret, true);
  assert.equal(stateModule.readState(model.root).cloud.adoptedFrom, 'legacy', 'this was the adoption path');
});

test('adoption keeps OWNER_LINK_SECRET when this Mac already holds the matching one', async () => {
  // The other direction: a re-run on the machine that minted it must not rotate,
  // because rotating would invalidate owner links already handed out.
  const model = buildModel({
    deployed: true,
    schema: true,
    bindings: [{ name: 'DB' }, { name: 'FILES' }, { name: 'OAUTH_KV' }],
    d1: [{ id: 'legacy-d1', name: 'snip', tables: 6 }],
    remoteRows: { refs: 4, pages: 9, collections: 1 },
    secrets: new Set(['SESSION_SECRET', 'CAPTURE_TOKEN', 'OWNER_LINK_SECRET']),
    secretValues: { SESSION_SECRET: 'keep-me', CAPTURE_TOKEN: 'old-capture' },
  });
  const mine = crypto.randomBytes(32).toString('hex');
  model.secretValues.OWNER_LINK_SECRET = mine;
  stateModule.writeSecrets(model.root, { version: 1, ownerLinkSecret: mine, captureToken: 'old-capture' });

  const emitter = collectedEmitter();
  const cloudFake = fakeCloud(model);
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
    wrangler: fakeWrangler(model),
    deps: {
      fetch: cloudFake.fetch,
      library: fakeLibraryModule(model),
      local: LOCAL_FAKE,
      transferOf: () => ({ status: async () => ({
        version: '1.1.4',
        counts: { refs: 4, pages: 9, collections: 1 },
        hasOwner: true,
        ownerId: 'tester',
        ownerSecretHash: transfer.ownerSecretHash(model.secretValues.OWNER_LINK_SECRET),
      }) }),
    },
  });
  await commands.commandSetup(ctx);
  assert.equal(model.secretValues.OWNER_LINK_SECRET, mine, 'the shared secret was kept, not replaced');
  assert.equal(stateModule.readSecrets(model.root).ownerLinkSecret, mine);
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
  await assert.rejects(() => commands.commandDeleteResources(ctx), (error) => error.code === 'CONFIRM_MISMATCH' && error.data.expected === 'snip.tester.workers.dev');

  // Missing entirely is exit 2 with the exact value and command, not a mutation.
  const missing = createContext({
    root: library.root, dataRoot: library.root, flags: {}, emit: emitter.emit, api: {},
    wrangler: { bin: '/x', run: async () => ({ ok: true, stdout: '', stderr: '' }) },
    deps: { fetch: async () => { throw new Error('no network'); } },
  });
  await assert.rejects(() => commands.commandDeleteResources(missing), (error) => (
    error.code === 'NEEDS_INPUT'
    && error.confirm.expected === 'snip.tester.workers.dev'
    && /delete-resources --confirm snip\.tester\.workers\.dev/.test(error.confirm.command)
  ));
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
  assert.equal(unknown.stdout, '', 'human mode prints the help on stderr and nothing on stdout');

  // The same failure in --json is still one NDJSON `result`, with the field an
  // agent branches on present rather than missing.
  const unknownJson = spawnSync(process.execPath, [path.join(__dirname, '../../scripts/cloudflare.mjs'), 'nonsense', '--json'], { encoding: 'utf8' });
  assert.equal(unknownJson.status, 4);
  assert.match(unknownJson.stderr, /Unknown command nonsense/);
  const lines = unknownJson.stdout.trim().split('\n');
  assert.equal(lines.length, 1, 'only the result event, no step noise');
  const event = JSON.parse(lines[0]);
  assert.equal(event.event, 'result');
  assert.equal(event.code, 'USAGE');
  assert.equal(event.retryable, false);
  assert.equal(event.ok, false);

  // An option's value is not the command: the wrapper used to keep its own list
  // of command names and mistook `--root <path>` for one.
  const withRoot = spawnSync(process.execPath, [path.join(__dirname, '../../scripts/cloudflare.mjs'), '--root', library.root, 'nonsense'], { encoding: 'utf8' });
  assert.equal(withRoot.status, 4);
  assert.match(withRoot.stderr, /Unknown command nonsense/);
  assert.doesNotMatch(withRoot.stderr, new RegExp(library.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('a usage error is one result event with retryable false, never a missing field', async () => {
  const run = async (argv) => {
    const lines = [];
    let stderr = '';
    const io = {
      stdout: { write: (line) => { lines.push(line); return true; } },
      stderr: { write: (line) => { stderr += line; return true; } },
    };
    const result = await cli.main(argv, io);
    const events = lines.map((line) => JSON.parse(line));
    const last = events[events.length - 1];
    assert.equal(last.event, 'result', 'the stream always ends in a result');
    assert.equal(typeof last.retryable, 'boolean', `retryable must be present for ${argv.join(' ')}`);
    return { result, last, stderr, events };
  };

  // An unknown flag.
  const unknownFlag = await run(['setup', '--json', '--bogus']);
  assert.equal(unknownFlag.result.code, 1);
  assert.equal(unknownFlag.last.code, 'USAGE');
  assert.equal(unknownFlag.last.retryable, false);
  assert.match(unknownFlag.last.data.reason, /Unknown option --bogus/);

  // A flag with no value.
  const missingValue = await run(['setup', '--json', '--data-root']);
  assert.equal(missingValue.result.code, 1);
  assert.equal(missingValue.last.code, 'USAGE');
  assert.equal(missingValue.last.retryable, false);
  assert.match(missingValue.last.data.reason, /--data-root needs a value/);

  // An invalid value for a value flag: this used to escape as a stack trace.
  const badValue = await run(['setup', '--json', '--capture-env', 'sideways']);
  assert.equal(badValue.result.code, 1);
  assert.equal(badValue.last.code, 'USAGE');
  assert.equal(badValue.last.retryable, false);
  assert.match(badValue.last.data.reason, /--capture-env must be replace, separate or keep/);
  assert.doesNotMatch(badValue.stderr, /at .*cli\.cjs/, 'no stack trace reaches the user');

  // An unknown command keeps its historical exit 4 and still reports.
  const unknownCommand = await run(['nonsense', '--json']);
  assert.equal(unknownCommand.result.code, 4);
  assert.equal(unknownCommand.last.code, 'USAGE');
  assert.equal(unknownCommand.last.retryable, false);
  assert.match(unknownCommand.last.data.reason, /Unknown command nonsense/);
  assert.match(unknownCommand.stderr, /Usage: node desktop\/provision\/cli\.cjs/, 'the help goes to stderr');
  assert.equal(unknownCommand.events.length, 1, 'stdout stays pure NDJSON');

  // Without --json there is no stream to join, so the human path is unchanged.
  const human = await cli.main(['nonsense'], { stdout: { write: () => true }, stderr: { write: () => true } });
  assert.equal(human.code, 4);
});

/** A snapshot context whose Worker reads the state dir as it really is. */
function snapshotContext(library, { action, confirm = undefined, mode = 'local', counts = { refs: 7, pages: 3, files: 2, bytes: 24 } } = {}) {
  const emitter = collectedEmitter();
  const started = [];
  const ctx = createContext({
    root: library.root,
    dataRoot: library.root,
    flags: { confirm, snapshotAction: action },
    emit: emitter.emit,
    api: {},
    wrangler: { bin: '/x', run: async () => ({ ok: true }) },
    deps: {
      fetch: async () => { throw new Error('no network'); },
      library: {
        async withLocalWorker(options, fn) {
          started.push(options.persist);
          return fn({
            transfer: {
              async status() { return { counts: { refs: counts.refs, pages: counts.pages } }; },
              async manifest() { return { keys: Array.from({ length: counts.files }, (_, index) => ({ key: `k${index}`, size: counts.bytes / Math.max(1, counts.files) })) }; },
            },
            async dispose() {},
          });
        },
        libraryConfig: ({ dataRoot }) => path.join(dataRoot, 'web/wrangler.jsonc'),
      },
    },
  });
  if (mode === 'cloud') stateModule.updateState(library.root, (next) => { next.mode = 'cloud'; return next; });
  return { ctx, emitter, started };
}

function stateDir(base, marker) {
  fs.mkdirSync(path.join(base, 'v3/d1'), { recursive: true });
  fs.writeFileSync(path.join(base, 'v3/d1/marker'), marker);
}

test('restore swaps a backup in, keeps the displaced library, and records real counts', async () => {
  const library = fakeLibrary();
  const live = path.join(library.root, 'web/.wrangler/state');
  stateDir(live, 'cloud-copy');
  const backup = path.join(library.root, 'backups/cloud-pull-2026-11-06T10-12-00');
  stateDir(backup, 'previous');
  stateModule.updateState(library.root, (next) => {
    next.mode = 'local';
    next.snapshot = { kind: 'backup', path: 'backups/cloud-pull-2026-11-06T10-12-00', keptLocal: false, takenAt: new Date().toISOString(), refs: 7 };
    return next;
  });

  const { ctx, started } = snapshotContext(library, { action: 'restore' });
  const result = await commands.commandSnapshot(ctx);
  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(path.join(live, 'v3/d1/marker'), 'utf8'), 'previous');
  assert.deepEqual(started, [path.join(library.root, 'backups', fs.readdirSync(path.join(library.root, 'backups')).find((name) => name.startsWith('replaced-')))], 'the displaced library is counted through a Worker');

  const replaced = fs.readdirSync(path.join(library.root, 'backups')).find((name) => name.startsWith('replaced-'));
  assert.equal(fs.readFileSync(path.join(library.root, 'backups', replaced, 'v3/d1/marker'), 'utf8'), 'cloud-copy', 'the replaced copy must be kept for recovery');
  const after = stateModule.readState(library.root).snapshot;
  assert.equal(after.kind, 'backup');
  assert.equal(after.path, `backups/${replaced}`);
  assert.equal(after.refs, 7, 'counts are read, never claimed as zero');
  assert.equal(after.files, 2);
});

test('restore is valid only for a backup: live is KEPT_LOCAL, never a success', async () => {
  const library = fakeLibrary();
  stateDir(path.join(library.root, 'web/.wrangler/state'), 'kept');
  stateModule.updateState(library.root, (next) => {
    next.mode = 'cloud';
    next.snapshot = { kind: 'live', path: null, keptLocal: true, takenAt: new Date().toISOString(), refs: 3 };
    return next;
  });
  const { ctx } = snapshotContext(library, { action: 'restore' });
  await assert.rejects(() => commands.commandSnapshot(ctx), (error) => error.code === 'KEPT_LOCAL');
  assert.equal(stateModule.readState(library.root).snapshot.kind, 'live');
});

test('restore refuses an export-shaped path even when a live library exists', async () => {
  // The adopt-empty case: live and cloud are both empty, so a false "restored"
  // is invisible to every count check. Only the shape catches it.
  const library = fakeLibrary();
  stateDir(path.join(library.root, 'web/.wrangler/state'), 'empty-live');
  const exported = path.join(library.root, 'backups/cloud-export-2026-11-06T10-12-00');
  fs.mkdirSync(exported, { recursive: true });
  fs.writeFileSync(path.join(exported, 'dump.sql'), '');
  fs.writeFileSync(path.join(exported, 'files.json'), '{"keys":[]}\n');
  stateModule.updateState(library.root, (next) => {
    next.mode = 'local';
    next.snapshot = { kind: 'backup', path: 'backups/cloud-export-2026-11-06T10-12-00', keptLocal: false, takenAt: new Date().toISOString(), refs: 0 };
    return next;
  });
  const { ctx } = snapshotContext(library, { action: 'restore' });
  await assert.rejects(() => commands.commandSnapshot(ctx), (error) => error.code === 'SNAPSHOT_NOT_RESTORABLE');
  assert.equal(fs.readFileSync(path.join(library.root, 'web/.wrangler/state/v3/d1/marker'), 'utf8'), 'empty-live');
  assert.equal(stateModule.readState(library.root).snapshot.path, 'backups/cloud-export-2026-11-06T10-12-00', 'nothing was changed');
});

test('restore says "already using" only when the paths are the same directory', async () => {
  const library = fakeLibrary();
  const live = path.join(library.root, 'web/.wrangler/state');
  stateDir(live, 'only-copy');
  stateModule.updateState(library.root, (next) => {
    next.mode = 'local';
    next.snapshot = { kind: 'backup', path: 'web/.wrangler/state', keptLocal: false, takenAt: new Date().toISOString(), refs: 1 };
    return next;
  });
  const { ctx, emitter } = snapshotContext(library, { action: 'restore' });
  const result = await commands.commandSnapshot(ctx);
  assert.equal(result.ok, true);
  assert.ok(emitter.events.some((event) => event.event === 'step' && event.status === 'skipped' && /already using/.test(event.message)));
  assert.equal(fs.readFileSync(path.join(live, 'v3/d1/marker'), 'utf8'), 'only-copy', 'nothing moved');
});

test('snapshot delete needs the basename, refuses live, and clears both the directory and the record', async () => {
  const library = fakeLibrary();
  stateDir(path.join(library.root, 'web/.wrangler/state'), 'live');
  const backup = path.join(library.root, 'backups/cloud-pull-2026-11-06T10-12-00');
  stateDir(backup, 'previous');
  stateModule.updateState(library.root, (next) => {
    next.mode = 'local';
    next.snapshot = { kind: 'backup', path: 'backups/cloud-pull-2026-11-06T10-12-00', keptLocal: false, takenAt: new Date().toISOString(), refs: 2 };
    return next;
  });

  const noConfirm = snapshotContext(library, { action: 'delete' });
  await assert.rejects(() => commands.commandSnapshot(noConfirm.ctx), (error) => error.code === 'NEEDS_INPUT' && error.confirm.expected === 'cloud-pull-2026-11-06T10-12-00');
  assert.equal(fs.existsSync(backup), true, 'nothing is deleted without the confirmation');

  const wrong = snapshotContext(library, { action: 'delete', confirm: 'cloud-pull-other' });
  await assert.rejects(() => commands.commandSnapshot(wrong.ctx), (error) => error.code === 'CONFIRM_MISMATCH' && error.data.expected === 'cloud-pull-2026-11-06T10-12-00');
  assert.equal(fs.existsSync(backup), true);

  const separator = snapshotContext(library, { action: 'delete', confirm: 'backups/cloud-pull-2026-11-06T10-12-00' });
  await assert.rejects(() => commands.commandSnapshot(separator.ctx), (error) => error.code === 'CONFIRM_MISMATCH');
  assert.equal(fs.existsSync(backup), true);

  const ok = snapshotContext(library, { action: 'delete', confirm: 'cloud-pull-2026-11-06T10-12-00' });
  const result = await commands.commandSnapshot(ok.ctx);
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(backup), false);
  assert.equal(stateModule.readState(library.root).snapshot, null);

  // And a live record can never be deleted, even with a matching name.
  stateModule.updateState(library.root, (next) => {
    next.snapshot = { kind: 'live', path: null, keptLocal: true, takenAt: new Date().toISOString(), refs: 2 };
    return next;
  });
  const liveDelete = snapshotContext(library, { action: 'delete', confirm: 'state' });
  await assert.rejects(() => commands.commandSnapshot(liveDelete.ctx), (error) => error.code === 'CANNOT_DELETE_LOCAL');
  assert.equal(fs.existsSync(path.join(library.root, 'web/.wrangler/state')), true);
});

test('snapshot delete refuses when the live library is gone, because the backup is the only copy', async () => {
  const library = fakeLibrary();
  const backup = path.join(library.root, 'backups/cloud-pull-2026-11-06T10-12-00');
  stateDir(backup, 'previous');
  stateModule.updateState(library.root, (next) => {
    next.mode = 'local';
    next.snapshot = { kind: 'backup', path: 'backups/cloud-pull-2026-11-06T10-12-00', keptLocal: false, takenAt: new Date().toISOString(), refs: 2 };
    return next;
  });
  const { ctx } = snapshotContext(library, { action: 'delete', confirm: 'cloud-pull-2026-11-06T10-12-00' });
  await assert.rejects(() => commands.commandSnapshot(ctx), (error) => error.code === 'LIVE_MISSING');
  assert.equal(fs.existsSync(backup), true);
});

test('snapshot delete-export works in any mode, needs the basename, and leaves the snapshot alone', async () => {
  const library = fakeLibrary();
  const exported = path.join(library.root, 'backups/cloud-export-2026-11-06T10-12-00');
  fs.mkdirSync(exported, { recursive: true });
  fs.writeFileSync(path.join(exported, 'dump.sql'), '');
  stateModule.updateState(library.root, (next) => {
    next.mode = 'cloud';
    next.snapshot = {
      kind: 'live', path: null, keptLocal: true, takenAt: new Date().toISOString(), refs: 4,
      export: { path: 'backups/cloud-export-2026-11-06T10-12-00', takenAt: new Date().toISOString(), refs: 4, files: 1, bytes: 10 },
    };
    return next;
  });

  const missing = snapshotContext(library, { action: 'delete-export' });
  await assert.rejects(() => commands.commandSnapshot(missing.ctx), (error) => error.code === 'NEEDS_INPUT' && error.confirm.expected === 'cloud-export-2026-11-06T10-12-00');

  const ok = snapshotContext(library, { action: 'delete-export', confirm: 'cloud-export-2026-11-06T10-12-00' });
  const result = await commands.commandSnapshot(ok.ctx);
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(exported), false);
  const after = stateModule.readState(library.root);
  assert.equal(after.mode, 'cloud', 'the mode is untouched');
  assert.equal(after.snapshot.kind, 'live');
  assert.equal(after.snapshot.export, null);

  // Nothing left to delete is NO_EXPORT, not a silent success.
  const again = snapshotContext(library, { action: 'delete-export', confirm: 'cloud-export-2026-11-06T10-12-00' });
  await assert.rejects(() => commands.commandSnapshot(again.ctx), (error) => error.code === 'NO_EXPORT');
});

test('an adopt-empty move records a live snapshot plus a delete-only export', async () => {
  const library = fakeLibrary();
  const model = buildModel({ deployed: true, schema: true, bindings: [{ name: 'DB' }, { name: 'FILES' }, { name: 'OAUTH_KV' }], d1: [{ id: 'legacy-d1', name: 'snip', tables: 6 }], remoteRows: { refs: 0, pages: 0, collections: 0 } });
  const wrangler = fakeWrangler(model);
  const emitter = collectedEmitter();
  const cloudFake = fakeCloud(model);
  emitter.emit.human = (step, action, url, message) => {
    if (step === 'owner') cloudFake.setOwner(true);
    return createEmitter({ json: true, stdout: { write: (line) => { emitter.events.push(JSON.parse(line)); return true; } }, stderr: { write: () => true } }).human(step, action, url, message);
  };
  const ctx = createContext({
    root: library.root,
    dataRoot: library.root,
    flags: { login: 'tester', domain: 'tester', noOpen: true, adoptExisting: true },
    emit: emitter.emit,
    api: fakeApi(model),
    wrangler,
    deps: {
      fetch: cloudFake.fetch,
      library: fakeLibraryModule(model),
      local: LOCAL_FAKE,
      transferOf: (context) => ({ status: async () => ({
        version: '1.1.0', hasOwner: true, ownerId: 'tester',
        counts: { refs: 0, pages: 0, collections: 0 },
        ownerSecretHash: transfer.ownerSecretHash(context.secrets().ownerLinkSecret),
      }) }),
    },
  });
  await commands.commandSetup(ctx);
  const record = stateModule.readState(library.root);
  assert.equal(record.snapshot.kind, 'live');
  assert.equal(record.snapshot.path, null, 'the local library never moved');
  assert.ok(record.snapshot.export && record.snapshot.export.path.startsWith('backups/cloud-export-'), 'the dump is a separate export');
  // The export is not restorable, which is what makes the empty case safe.
  const { ctx: restoreCtx } = snapshotContext(library, { action: 'restore' });
  stateModule.updateState(library.root, (next) => {
    next.snapshot = { ...next.snapshot, kind: 'backup', keptLocal: false, path: next.snapshot.export.path, refs: 0 };
    return next;
  });
  await assert.rejects(() => commands.commandSnapshot(restoreCtx), (error) => error.code === 'SNAPSHOT_NOT_RESTORABLE');
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
    let classifyCalls = 0;
    const baseDeps = { fetch: cloudFake.fetch, library: fakeLibraryModule(model), local: LOCAL_FAKE };
    const ctx = createContext({
      root: model.root,
      dataRoot: model.root,
      flags: { login: 'tester', domain: 'tester', noOpen: true, adoptExisting: scenario === 'adopt-existing' },
      emit: emitter.emit,
      api: fakeApi(model),
      wrangler,
      deps: {
        ...baseDeps,
        classify: (context) => { classifyCalls++; return setup.classifyAccount(context); },
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
    // guard is the only classifier: two passes could disagree about the account.
    assert.ok(classifyCalls <= 1, `${scenario}: the account was classified ${classifyCalls} times`);
  }
});

test('the choice path leaves no resource behind when the caller stops', async () => {
  const model = buildModel({
    deployed: true,
    schema: true,
    bindings: [{ name: 'DB' }, { name: 'FILES' }, { name: 'OAUTH_KV' }],
    d1: [{ id: 'legacy-d1', name: 'snip', tables: 6 }],
    remoteRows: { refs: 1284, pages: 9120, collections: 7 },
  });
  const wrangler = fakeWrangler(model);
  const emitter = collectedEmitter();
  const ctx = createContext({
    root: model.root,
    dataRoot: model.root,
    flags: { login: 'tester', domain: 'tester', noOpen: true },
    emit: emitter.emit,
    api: fakeApi(model),
    wrangler,
    deps: { fetch: fakeCloud(model).fetch, library: fakeLibraryModule(model), local: LOCAL_FAKE },
  });
  await assert.rejects(() => commands.commandSetup(ctx), (error) => error.code === 'NEEDS_INPUT');
  const creates = wrangler.calls.map((call) => call.line).filter((line) => /^(d1 create|kv namespace create|r2 bucket create|deploy|secret|d1 migrations apply)/.test(line));
  assert.deepEqual(creates, [], 'Stop must change nothing');
});

test('import batches are staged to a private file and removed afterwards', async () => {
  const library = fakeLibrary();
  const seen = [];
  const wrangler = {
    bin: '/fake/wrangler.js',
    async run(args) {
      seen.push({ args: [...args] });
      const index = args.indexOf('--file');
      const file = args[index + 1];
      assert.ok(file && file !== '-', 'a real file path is required: --file - is rejected by wrangler');
      assert.equal(fs.existsSync(file), true, 'the batch file must exist while wrangler runs');
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.match(fs.readFileSync(file, 'utf8'), /INSERT INTO/);
      return { ok: true, code: 0, stdout: '', stderr: '' };
    },
  };
  await deploy.importRemote(wrangler, {
    dataRoot: library.root,
    accountId: 'acct',
    statements: ['INSERT INTO "refs" (id) VALUES (\'a\')', 'INSERT INTO "refs" (id) VALUES (\'b\')'],
  });
  assert.equal(seen.length, 1);
  for (const call of seen) {
    const file = call.args[call.args.indexOf('--file') + 1];
    assert.equal(fs.existsSync(file), false, 'the staged file must be removed');
  }
  const leftover = fs.existsSync(path.join(library.root, '.snip/sql')) ? fs.readdirSync(path.join(library.root, '.snip/sql')) : [];
  assert.deepEqual(leftover, []);
});

test('a streamed upload sends duplex: half, as Node fetch requires', async () => {
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push({ url: String(url), duplex: options.duplex, method: options.method });
    const chunks = [];
    for await (const chunk of options.body) chunks.push(Buffer.from(chunk));
    return new Response(JSON.stringify({ ok: true, size: Buffer.concat(chunks).length }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const client = transfer.createTransfer({ url: PROVIDED, token: 't', fetchImpl });
  const { Readable } = require('node:stream');
  await client.put(SYNTHETIC.fileKey(4, 'a.png'), Readable.from([Buffer.from('x')]), { size: 1 });
  assert.equal(seen[0].duplex, 'half');
  // A web ReadableStream (what a local GET returns) must get it too.
  const web = new Response(Buffer.from('hello')).body;
  await client.put(SYNTHETIC.fileKey(4, 'b.png'), web, { size: 5 });
  assert.equal(seen[1].duplex, 'half');
});

test('facts survive a resumed run, where preflight is skipped', async () => {
  const library = fakeLibrary();
  const emitter = collectedEmitter();
  let queries = 0;
  const ctx = createContext({
    root: library.root,
    dataRoot: library.root,
    flags: {},
    emit: emitter.emit,
    api: {},
    wrangler: { bin: '/x', run: async () => ({ ok: true }) },
    deps: {
      fetch: async () => { throw new Error('no network'); },
      local: LOCAL_FAKE,
      deploy: {
        ...deploy,
        localQuery: async (_wrangler, options) => {
          queries++;
          assert.ok(options.config, 'the local config must be discovered, not stashed by a skipped step');
          return [{ rows: 3 }];
        },
      },
    },
  });
  // No preflight ran: the facts must still be derivable.
  const first = await ctx.libraryFacts();
  assert.equal(first.empty, false);
  assert.match(first.localConfig, /web\/wrangler\.jsonc$/);
  assert.equal(ctx.work.localConfig, first.localConfig);
  // Cached: one query per run, not one per step.
  await ctx.libraryFacts();
  assert.equal(queries, 1);

  // A step that skips when the library is empty sees the same answer.
  const emptyCtx = createContext({
    root: library.root,
    dataRoot: library.root,
    flags: {},
    emit: emitter.emit,
    api: {},
    wrangler: { bin: '/x', run: async () => ({ ok: true }) },
    deps: {
      local: LOCAL_FAKE,
      deploy: { ...deploy, localQuery: async () => [{ rows: 0 }] },
    },
  });
  assert.equal((await emptyCtx.libraryFacts()).empty, true);
});

test('SQLite internals are never compared across a copy', () => {
  const dump = "INSERT INTO \"refs\" (id) VALUES ('a');\nINSERT INTO \"sqlite_sequence\" (name, seq) VALUES ('refs', 7);\n";
  const counts = lib.countsFromDump(dump);
  assert.deepEqual(Object.keys(counts).sort(), ['refs', 'sqlite_sequence']);
  // The copy merges only real library tables into the manifest.
  const tables = { refs: 1 };
  for (const [table, count] of Object.entries(counts)) {
    if (/^(sqlite_|_cf_|_mf_)/.test(table)) continue;
    if (!(table in tables)) tables[table] = count;
  }
  assert.deepEqual(tables, { refs: 1 });
});

test('--no-open is honoured, and dashed flags reach steps in camelCase', () => {
  const { flags, positional } = cli.parseArgs(['setup', '--no-open', '--adopt-existing', '--capture-env', 'separate', '--data-root', '/tmp/x']);
  cli.normalizeFlags(flags);
  assert.deepEqual(positional, ['setup']);
  assert.equal(flags.noOpen, true);
  assert.equal(flags.adoptExisting, true);
  assert.equal(flags.captureEnv, 'separate');
  assert.equal(flags.dataRoot, '/tmp/x');
  // A dashless command must still mean setup.
  assert.deepEqual(cli.parseArgs([]).positional, []);
});

test('--no-handoff is parsed and survives normalization', () => {
  const { flags } = cli.parseArgs(['owner', 'link', '--no-handoff']);
  assert.equal(flags['no-handoff'], true, 'the dashed name is accepted, so the CLI does not reject it');
  cli.normalizeFlags(flags);
  // The steps read camelCase. A flag that normalizes to nothing is silently
  // lost, which is exactly the failure this guards: port 0 or a ten-minute wait.
  assert.equal(flags.noHandoff, true);
  assert.equal(cli.parseArgs(['owner', 'link', '--no-handoff=false']).flags['no-handoff'], false);
  assert.equal(cli.parseArgs(['owner', 'link']).flags['no-handoff'], undefined, 'absent stays absent');
});

test('the owner step never opens a browser with --no-open', async () => {
  const library = fakeLibrary();
  stateModule.setMode(library.root, 'enabling');
  let opened = 0;
  const emitter = collectedEmitter();
  const cloudFake = fakeCloud(buildModel({ hasOwner: false }));
  const model = buildModel({ hasOwner: false });
  cloudFake.setOwner(true);
  void model;
  const ctx = createContext({
    root: library.root,
    dataRoot: library.root,
    flags: { noOpen: true },
    emit: emitter.emit,
    api: {},
    wrangler: { bin: '/x', run: async () => ({ ok: true }) },
    deps: {
      fetch: cloudFake.fetch,
      local: LOCAL_FAKE,
      transferOf: () => ({ status: async () => ({ hasOwner: true, counts: {} }) }),
    },
  });
  ctx.openUrl = async () => { opened++; return { opened: true }; };
  stateModule.updateState(library.root, (next) => {
    next.cloud = { url: PROVIDED, ownerId: 'tester', accountId: 'acct' };
    return next;
  });
  stateModule.writeSecrets(library.root, { ownerLinkSecret: 'a'.repeat(64), captureToken: 'b'.repeat(64), transferToken: 'c'.repeat(64) });
  await setup.ownerStep().run(ctx);
  assert.equal(opened, 0, 'a browser must not be opened when --no-open is set');
});

test('re-enabling after detach adopts the detached copy instead of re-importing', async () => {
  const library = fakeLibrary();
  const liveRefs = path.join(library.root, 'web/.wrangler/state');
  fs.mkdirSync(liveRefs, { recursive: true });
  // This Mac's own detached install: same account, same worker, same URL.
  stateModule.updateState(library.root, (next) => {
    next.mode = 'local';
    next.cloud = {
      url: PROVIDED, accountId: 'acct_0123456789', workerName: 'snip',
      d1: { name: 'snip', id: 'd1-own' }, kv: { name: 'OAUTH_KV', id: 'kv-own' }, bucket: 'snip-files',
      detachedAt: '2026-11-06T10:00:00.000Z', ownerId: 'tester',
    };
    return next;
  });
  const model = buildModel({ deployed: true, schema: true, bindings: [{ name: 'DB' }, { name: 'FILES' }, { name: 'OAUTH_KV' }], d1: [{ id: 'd1-own', name: 'snip', tables: 6 }], hasOwner: true });
  const emitter = collectedEmitter();
  const cloudFake = fakeCloud(model);
  const wrangler = fakeWrangler(model);
  const ctx = createContext({
    root: library.root,
    dataRoot: library.root,
    flags: { login: 'tester', domain: 'tester', noOpen: true },
    emit: emitter.emit,
    api: fakeApi(model),
    wrangler,
    deps: {
      fetch: cloudFake.fetch,
      library: fakeLibraryModule(model),
      local: LOCAL_FAKE,
      transferOf: (context) => ({ status: async () => ({
        version: '1.1.0', hasOwner: true, counts: { refs: 99, pages: 5, collections: 2 },
        ownerSecretHash: transfer.ownerSecretHash(context.secrets().ownerLinkSecret),
      }) }),
    },
  });
  await commands.commandSetup(ctx);
  const state = stateModule.readState(library.root);
  assert.equal(state.mode, 'cloud');
  assert.equal(state.cloud.adoptedFrom, 'detached');
  assert.equal(state.cloud.move.reason, 'detached');
  assert.equal(state.cloud.detachedAt, null, 're-enabling clears the detach mark');
  assert.equal(wrangler.calls.some((call) => call.args[0] === 'd1' && call.args[1] === 'export'), false, 'no copy is made');
  assert.equal(cloudFake.calls.some((call) => call.route.startsWith('PUT /transfer/file/')), false, 'nothing is uploaded');
});

test('a new enable starts a clean journal; an interrupted run keeps it', () => {
  const dir = tempDir();
  const first = stateModule.beginEnabling(dir);
  assert.equal(first.mode, 'enabling');
  stateModule.journalStep(dir, 'deploy', 'done');
  stateModule.journalStep(dir, 'import', 'failed');
  // A second invocation while still `enabling` is a resume: journal intact.
  stateModule.beginEnabling(dir);
  assert.equal(stateModule.readState(dir).steps.length, 2);
  // Going back to local and enabling again is a new run: nothing is claimed done.
  stateModule.setMode(dir, 'local');
  const third = stateModule.beginEnabling(dir);
  assert.equal(third.mode, 'enabling');
  assert.deepEqual(third.steps, []);
});

test('a skipped guard still lets a later invocation skip the copy it decided against', async () => {
  const library = fakeLibrary();
  const snapshotDir = path.join(library.root, 'backups/cloud-move-test');
  fs.mkdirSync(snapshotDir, { recursive: true });
  fs.writeFileSync(path.join(snapshotDir, 'dump.sql'), '');
  fs.writeFileSync(path.join(snapshotDir, 'manifest.json'), JSON.stringify({ tables: {} }));
  fs.writeFileSync(path.join(snapshotDir, 'files.json'), JSON.stringify({ keys: [], excluded: [] }));
  stateModule.beginEnabling(library.root);
  for (const id of ['preflight', 'cloudflare-auth', 'account', 'url', 'r2', 'guard']) stateModule.journalStep(library.root, id, 'done');
  stateModule.updateState(library.root, (next) => {
    next.cloud = {
      url: PROVIDED, accountId: 'acct', workerName: 'snip', outcome: 'adopt-existing', adoptedFrom: 'legacy',
      adoptedAt: '2026-11-06T09:00:00.000Z', move: { status: 'skipped', reason: 'adopted-existing' },
      d1: { name: 'snip', id: 'd1' }, kv: { name: 'OAUTH_KV', id: 'kv' }, bucket: 'snip-files',
    };
    next.snapshot = { path: 'backups/cloud-move-test', keptLocal: true };
    return next;
  });
  const emitter = collectedEmitter();
  const model = buildModel({ deployed: true });
  const wrangler = fakeWrangler(model);
  const ctx = createContext({
    root: library.root,
    dataRoot: library.root,
    flags: { noOpen: true },
    emit: emitter.emit,
    api: fakeApi(model),
    wrangler,
    deps: {
      fetch: async () => { throw new Error('no network in this test'); },
      local: LOCAL_FAKE,
      transferOf: (context) => ({ status: async () => ({
        version: '1.1.0', hasOwner: true, counts: { refs: 5, pages: 2, collections: 1 },
        ownerSecretHash: transfer.ownerSecretHash(context.secrets().ownerLinkSecret),
      }) }),
    },
  });
  await commands.commandSetup(ctx);
  const skipped = emitter.events.filter((event) => event.event === 'step' && event.status === 'skipped').map((event) => event.step);
  for (const id of ['quiesce', 'release', 'export', 'import']) assert.ok(skipped.includes(id), `${id} must skip even though guard never ran`);
  assert.equal(wrangler.calls.some((call) => call.args[0] === 'd1' && call.args[1] === 'export'), false);
});

test('step messages name an adopted library, not an empty one', async () => {
  const library = fakeLibrary();
  const state = stateModule.beginEnabling(library.root);
  void state;
  stateModule.updateState(library.root, (next) => {
    next.cloud = { url: PROVIDED, accountId: 'acct', workerName: 'snip', outcome: 'adopt-existing', adoptedFrom: 'legacy', move: { status: 'skipped' }, d1: { name: 'snip', id: 'd1' }, kv: { name: 'OAUTH_KV', id: 'kv' }, bucket: 'snip-files' };
    return next;
  });
  const emitter = collectedEmitter();
  const ctx = createContext({ root: library.root, dataRoot: library.root, flags: {}, emit: emitter.emit, api: {}, wrangler: { bin: '/x', run: async () => ({ ok: true }) }, deps: { local: LOCAL_FAKE, deploy: { ...deploy, localQuery: async () => [{ rows: 4 }] } } });
  const step = setup.setupSteps().find((entry) => entry.id === 'export');
  assert.equal(await step.skip(ctx), true);
  assert.match(step.skipMessage(ctx), /existing cloud library/);
});

test('a library of only uploaded images or boards is not empty, so the move copies it', async () => {
  // A board of sticky notes alone is a collections row with nothing in refs or images.
  for (const [table, rows, empty] of [['images', 3, false], ['collections', 1, false], ['images', 0, true]]) {
    const library = fakeLibrary();
    stateModule.beginEnabling(library.root);
    const localQuery = async (_wrangler, options) => [{ rows: new RegExp(`FROM ${table}\\b`).test(options.sql) ? rows : 0 }];
    const ctx = createContext({ root: library.root, dataRoot: library.root, flags: {}, emit: collectedEmitter().emit, api: {}, wrangler: { bin: '/x', run: async () => ({ ok: true }) }, deps: { local: LOCAL_FAKE, deploy: { ...deploy, localQuery } } });
    assert.equal((await ctx.libraryFacts()).empty, empty, `${rows} ${table}`);
  }
});

test('a cloud library holding only a board is adopted as existing, not empty', async () => {
  const model = buildModel({
    deployed: true,
    schema: true,
    bindings: [{ name: 'DB' }, { name: 'FILES' }, { name: 'OAUTH_KV' }],
    d1: [{ id: 'legacy-d1', name: 'snip', tables: 6 }],
    remoteRows: { refs: 0, pages: 0, collections: 1 },
  });
  const ctx = {
    cloud: { accountId: 'acct', url: null },
    api: fakeApi(model),
    wrangler: fakeWrangler(model),
    deps: { cloud: { listD1: async () => [{ id: 'legacy-d1', name: 'snip' }], listKv: async () => [] } },
    state: () => ({}),
    dataRoot: model.root,
  };
  const facts = await setup.classifyAccount(ctx);
  assert.equal(facts.outcome, 'adopt-existing');
  model.remoteRows.collections = 0;
  assert.equal((await setup.classifyAccount(ctx)).outcome, 'adopt-empty');
});

test('imports drop SQLite internals a fresh database does not have', () => {
  const statements = [
    'PRAGMA defer_foreign_keys=TRUE;',
    "INSERT INTO \"refs\" (id) VALUES ('a')",
    "INSERT INTO \"sqlite_sequence\" (name, seq) VALUES ('refs', 7)",
    "DELETE FROM \"_cf_METADATA\"",
    "INSERT INTO \"owners\" (id) VALUES ('c')",
    "INSERT INTO \"d1_migrations\" (id, name) VALUES (1, '0001_init.sql')",
    "INSERT INTO \"sessions\" (id) VALUES ('b')",
  ];
  assert.deepEqual(deploy.libraryStatements(statements), [
    "INSERT INTO \"refs\" (id) VALUES ('a')",
    "INSERT INTO \"owners\" (id) VALUES ('c')",
    "INSERT INTO \"sessions\" (id) VALUES ('b')",
  ]);
});

test('the engine reads the library identity the app uses, not a stale config', () => {
  const { root, dataRoot } = fakeLibrary();
  const saved = path.join(dataRoot, '.snip/storage-identities.json');
  fs.mkdirSync(path.dirname(saved), { recursive: true });
  fs.writeFileSync(saved, JSON.stringify({
    version: 1,
    d1_databases: [{ binding: 'DB', database_name: 'snip', database_id: 'LOCAL-ONLY' }],
    r2_buckets: [{ binding: 'FILES', bucket_name: 'snip-files' }],
    kv_namespaces: [{ binding: 'OAUTH_KV', id: 'KV-LOCAL' }],
    vars: { PUBLIC_URL: 'http://127.0.0.1:5199' },
  }));
  const config = libraryConfig({ root, dataRoot });
  assert.equal(config, path.join(dataRoot, '.snip/wrangler-library.json'));
  const written = JSON.parse(fs.readFileSync(config, 'utf8'));
  assert.equal(written.d1_databases[0].database_id, 'LOCAL-ONLY');
  assert.equal(written.kv_namespaces[0].id, 'KV-LOCAL');
  assert.match(written.d1_databases[0].migrations_dir, /web\/migrations$/);
});

test('without a storage snapshot the config on disk is the identity, and nothing is written', () => {
  const { root, dataRoot } = fakeLibrary();
  assert.equal(libraryConfig({ root, dataRoot }), path.join(dataRoot, 'web/wrangler.jsonc'));
  assert.equal(fs.existsSync(path.join(dataRoot, '.snip/wrangler-library.json')), false);
});

test('a legacy export record cannot be restored or deleted as a library', async () => {
  const library = fakeLibrary();
  stateDir(path.join(library.root, 'web/.wrangler/state'), 'live');
  const exported = path.join(library.root, 'backups/cloud-move-2026-11-06T10-12-00');
  fs.mkdirSync(exported, { recursive: true });
  fs.writeFileSync(path.join(exported, 'dump.sql'), '');
  fs.writeFileSync(path.join(exported, 'files.json'), '{"keys":[]}\n');
  stateModule.updateState(library.root, (next) => {
    next.mode = 'cloud';
    next.snapshot = { path: 'backups/cloud-move-2026-11-06T10-12-00', takenAt: new Date().toISOString(), refs: 0 };
    return next;
  });
  const restore = snapshotContext(library, { action: 'restore' });
  await assert.rejects(() => commands.commandSnapshot(restore.ctx), (error) => error.code === 'NOT_A_BACKUP');
  const del = snapshotContext(library, { action: 'delete', confirm: 'cloud-move-2026-11-06T10-12-00' });
  await assert.rejects(() => commands.commandSnapshot(del.ctx), (error) => error.code === 'NOT_A_BACKUP');
  // It is still delete-only, through the export command.
  const exportedDelete = snapshotContext(library, { action: 'delete-export', confirm: 'cloud-move-2026-11-06T10-12-00' });
  const result = await commands.commandSnapshot(exportedDelete.ctx);
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(exported), false);
  assert.equal(stateModule.readState(library.root).snapshot, null, 'a snapshot that was only an export becomes null');
});

test('a second snapshot delete is NO_SNAPSHOT, not a journaled success', async () => {
  const library = fakeLibrary();
  stateDir(path.join(library.root, 'web/.wrangler/state'), 'live');
  const backup = path.join(library.root, 'backups/cloud-pull-2026-11-06T10-12-00');
  stateDir(backup, 'previous');
  stateModule.updateState(library.root, (next) => {
    next.mode = 'local';
    next.snapshot = { kind: 'backup', path: 'backups/cloud-pull-2026-11-06T10-12-00', keptLocal: false, takenAt: new Date().toISOString(), refs: 2 };
    return next;
  });
  const first = snapshotContext(library, { action: 'delete', confirm: 'cloud-pull-2026-11-06T10-12-00' });
  await commands.commandSnapshot(first.ctx);
  const second = snapshotContext(library, { action: 'delete', confirm: 'cloud-pull-2026-11-06T10-12-00' });
  await assert.rejects(() => commands.commandSnapshot(second.ctx), (error) => error.code === 'NO_SNAPSHOT');
});

test('owner link on a bare CLI does not wait when an owner already exists', async () => {
  const library = fakeLibrary();
  stateModule.writeSecrets(library.root, { version: 1, ownerLinkSecret: crypto.randomBytes(32).toString('hex'), captureToken: 'c' });
  stateModule.updateState(library.root, (next) => {
    next.mode = 'cloud';
    next.cloud = { url: PROVIDED, accountId: 'acct', ownerId: 'tester' };
    return next;
  });
  const emitter = collectedEmitter();
  const ctx = createContext({
    root: library.root, dataRoot: library.root, flags: { ownerAction: 'link', noOpen: true }, emit: emitter.emit, api: {},
    wrangler: { bin: '/x', run: async () => ({ ok: true }) },
    deps: {
      fetch: async () => { throw new Error('no network'); },
      transferOf: () => ({ status: async () => ({ hasOwner: true, ownerId: 'tester' }) }),
    },
  });
  const result = await commands.commandOwner(ctx);
  assert.equal(result.ok, true);
  assert.match(result.message, /Sign-in link: https:\/\/snip\.tester\.workers\.dev\/auth\/owner\?t=/);
  const open = emitter.events.find((event) => event.event === 'step' && event.step === 'owner-open' && event.status === 'ok');
  assert.match(open.message, /open it in the browser/);
  assert.equal(emitter.events.some((event) => event.event === 'session'), false, 'a bare CLI has no handoff');
});

/** The port an owner link hands its session to, read back out of the signed payload. */
function ownerLinkPort(link) {
  const payload = new URL(link).searchParams.get('t').split('.')[0];
  return Number(payload.split('|').pop());
}

function ownerLibrary({ ownerId = 'tester' } = {}) {
  const library = fakeLibrary();
  stateModule.writeSecrets(library.root, { version: 1, ownerLinkSecret: crypto.randomBytes(32).toString('hex'), captureToken: 'c' });
  stateModule.updateState(library.root, (next) => {
    next.mode = 'cloud';
    next.cloud = { url: PROVIDED, accountId: 'acct', ownerId };
    return next;
  });
  return library;
}

test('owner link --no-handoff mints a port-0 link and ends at the mint', async () => {
  const library = ownerLibrary();
  const emitter = collectedEmitter();
  const opened = [];
  const ctx = createContext({
    root: library.root, dataRoot: library.root, flags: { ownerAction: 'link', managed: true, noHandoff: true }, emit: emitter.emit, api: {},
    wrangler: { bin: '/x', run: async () => ({ ok: true }) },
    deps: {
      // Neither call may happen: the run has nothing to wait for.
      sleep: async () => { throw new Error('the command must not wait'); },
      transferOf: () => ({ status: async () => { throw new Error('the command must not poll'); } }),
    },
  });
  ctx.openUrl = async (url) => { opened.push(url); return { opened: true }; };

  const result = await commands.commandOwner(ctx);

  assert.equal(result.ok, true);
  const human = emitter.events.find((event) => event.event === 'human' && event.step === 'owner-open');
  assert.ok(human, 'the link is emitted even without --no-open');
  assert.equal(ownerLinkPort(human.url), 0, 'another device gets a port-0 link, not this Mac\'s loopback');
  assert.equal(opened.length, 0, 'the browser that needs the link is not this one');
  const mint = emitter.events.find((event) => event.event === 'step' && event.step === 'owner-mint' && event.status === 'ok');
  assert.equal(mint.data.url, human.url, 'the step carries the same URL as the human action, at data.url');
  const open = emitter.events.find((event) => event.event === 'step' && event.step === 'owner-open' && event.status === 'ok');
  assert.match(open.message, /Link ready/);
  assert.doesNotMatch(open.message, /signed in/i, 'this run never observes the other browser signing in');
  assert.equal(emitter.events.some((event) => event.event === 'session'), false, 'there is no session for this Mac to receive');
});

test('owner link --managed still hands off when --no-handoff is absent', async () => {
  const library = ownerLibrary();
  const emitter = collectedEmitter();
  const ctx = createContext({
    root: library.root, dataRoot: library.root, flags: { ownerAction: 'link', noOpen: true, managed: true }, emit: emitter.emit, api: {},
    wrangler: { bin: '/x', run: async () => ({ ok: true }) },
    deps: { transferOf: () => ({ status: async () => ({ hasOwner: true, ownerId: 'tester' }) }) },
  });

  const pending = commands.commandOwner(ctx).then((value) => value, (error) => ({ error }));
  let link = null;
  for (let attempt = 0; attempt < 200 && !link; attempt++) {
    const human = emitter.events.find((event) => event.event === 'human' && event.step === 'owner-open');
    if (human) link = human.url;
    else await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(link, 'the link is emitted before the run waits on the token');
  const port = ownerLinkPort(link);
  assert.ok(port > 0, 'the app\'s own link still carries a live loopback port');
  const stored = await fetch(`http://127.0.0.1:${port}/store`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'session-value' }) });
  assert.equal(stored.status, 200);

  const settled = await Promise.race([pending, new Promise((resolve) => setTimeout(() => resolve('timeout'), 5000))]);
  if (settled === 'timeout') ctx.cancel();
  assert.notEqual(settled, 'timeout', 'the token finishes the command instead of waiting out the link');
  assert.equal(settled.ok, true);
  const session = emitter.events.find((event) => event.event === 'session');
  assert.equal(session.token, 'session-value');
  const open = emitter.events.find((event) => event.event === 'step' && event.step === 'owner-open' && event.status === 'ok');
  assert.equal(open.message, 'Signed in');
});

test('setup ignores --no-handoff: its owner step is how this Mac signs itself in', async () => {
  const model = buildModel({ hasOwner: false });
  const ports = [];
  const { events } = await runSetup(model, { managed: true, noHandoff: true }, {
    onHuman: ({ step, url }) => {
      if (step !== 'owner') return;
      const port = ownerLinkPort(url);
      ports.push(port);
      if (port > 0) {
        fetch(`http://127.0.0.1:${port}/store`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'app-session' }) }).catch(() => {});
      }
    },
  });
  assert.deepEqual(ports.length, 1);
  assert.ok(ports[0] > 0, 'the setup link keeps its handoff, so the app can receive the session');
  const session = events.find((event) => event.event === 'session');
  assert.ok(session, 'the app is signed in by its own handoff');
  assert.equal(session.token, 'app-session');
});

test('owner link waits for the first owner, then reports Signed in', async () => {
  const library = fakeLibrary();
  stateModule.writeSecrets(library.root, { version: 1, ownerLinkSecret: crypto.randomBytes(32).toString('hex'), captureToken: 'c' });
  stateModule.updateState(library.root, (next) => {
    next.mode = 'cloud';
    next.cloud = { url: PROVIDED, accountId: 'acct' };
    return next;
  });
  let hasOwner = false;
  let ticks = 0;
  const emitter = collectedEmitter();
  const ctx = createContext({
    root: library.root, dataRoot: library.root, flags: { ownerAction: 'link', noOpen: true }, emit: emitter.emit, api: {},
    wrangler: { bin: '/x', run: async () => ({ ok: true }) },
    deps: {
      fetch: async () => { throw new Error('no network'); },
      sleep: async () => { ticks++; hasOwner = true; },
      transferOf: () => ({ status: async () => ({ hasOwner }) }),
    },
  });
  const result = await commands.commandOwner(ctx);
  assert.equal(result.ok, true);
  assert.equal(ticks, 1, 'it polls until the Worker reports an owner');
  const open = emitter.events.find((event) => event.event === 'step' && event.step === 'owner-open' && event.status === 'ok');
  assert.equal(open.message, 'Signed in');
});

test('status is offline, and status --check is the only form that goes to the network', async () => {
  const library = fakeLibrary();
  stateModule.setMode(library.root, 'local');
  let calls = 0;
  const emitter = collectedEmitter();
  const make = (check) => createContext({
    root: library.root, dataRoot: library.root, flags: { check }, emit: emitter.emit, api: {},
    wrangler: { bin: '/x', run: async () => ({ ok: true }) },
    deps: {
      fetch: async () => { calls++; return new Response('ok'); },
      local: { ...LOCAL_FAKE, reachable: async () => true },
    },
  });
  const offline = await commands.commandStatus(make(false));
  assert.equal(calls, 0, 'status never reaches the network');
  assert.equal(offline.data.online, false);
  assert.equal(offline.data.state.mode, 'local');

  const checked = await commands.commandStatus(make(true), { check: true });
  assert.equal(checked.data.online, true);
  assert.equal(checked.data.checks.local.reachable, true);
});

test('status --check fails when the active surface does not answer', async () => {
  const library = fakeLibrary();
  stateModule.setMode(library.root, 'local');
  const emitter = collectedEmitter();
  const ctx = createContext({
    root: library.root, dataRoot: library.root, flags: { check: true }, emit: emitter.emit, api: {},
    wrangler: { bin: '/x', run: async () => ({ ok: true }) },
    deps: { fetch: async () => { throw new Error('no network'); }, local: { ...LOCAL_FAKE, reachable: async () => false } },
  });
  await assert.rejects(() => commands.commandStatus(ctx, { check: true }), (error) => error.code === 'LOCAL_UNREACHABLE');
});

test('pull keeps the replaced library as a backup with real counts read through a Worker', async () => {
  const library = fakeLibrary();
  stateModule.setMode(library.root, 'cloud');
  const live = path.join(library.root, 'web/.wrangler/state');
  stateDir(live, 'previous');
  const stagedRoot = path.join(library.root, 'backups/pull-test');
  const stagedState = path.join(stagedRoot, 'state');
  stateDir(stagedState, 'cloud-copy');
  const seen = [];
  const emitter = collectedEmitter();
  const ctx = createContext({
    root: library.root, dataRoot: library.root, flags: {}, emit: emitter.emit, api: {},
    wrangler: { bin: '/x', run: async () => ({ ok: true }) },
    deps: {
      fetch: async () => { throw new Error('no network'); },
      library: {
        async withLocalWorker(options, fn) {
          seen.push(options.persist);
          return fn({
            transfer: {
              async status() { return { counts: { refs: 9, pages: 4 } }; },
              async manifest() { return { keys: [{ key: 'a', size: 10 }, { key: 'b', size: 5 }] }; },
            },
            async dispose() {},
          });
        },
        libraryConfig: ({ dataRoot }) => path.join(dataRoot, 'web/wrangler.jsonc'),
      },
    },
  });
  const swap = commands.pullSteps({ stagedRoot, stagedState }).find((step) => step.id === 'pull-swap');
  await swap.run(ctx);
  assert.equal(await swap.verify(ctx), true, 'verify passes when the copy is live and the backup is on disk');
  assert.equal(fs.readFileSync(path.join(live, 'v3/d1/marker'), 'utf8'), 'cloud-copy');
  const record = stateModule.readState(library.root);
  assert.equal(record.mode, 'local');
  assert.equal(record.snapshot.kind, 'backup');
  assert.match(record.snapshot.path, /^backups\/cloud-pull-/);
  assert.equal(record.snapshot.keptLocal, false);
  assert.equal(record.snapshot.refs, 9, 'counts come from the Worker, never 0');
  assert.equal(record.snapshot.files, 2);
  assert.equal(record.snapshot.bytes, 15);
  assert.deepEqual(seen, [path.join(library.root, record.snapshot.path)], 'the Worker reads the renamed directory');
  assert.equal(fs.readFileSync(path.join(library.root, record.snapshot.path, 'v3/d1/marker'), 'utf8'), 'previous');
});

test('pull-finish points capture at the local Worker with the local capture token', async () => {
  const library = fakeLibrary();
  stateModule.setMode(library.root, 'cloud');
  stateModule.writeSecrets(library.root, { version: 1, ownerLinkSecret: 'a'.repeat(64), captureToken: 'cloud-token' });
  fs.mkdirSync(path.join(library.root, 'capture'), { recursive: true });
  fs.writeFileSync(path.join(library.root, 'capture/.env'), 'SNIP_URL=https://snip.example.workers.dev\nCAPTURE_TOKEN=cloud-token\n');
  const ctx = createContext({
    root: library.root, dataRoot: library.root, flags: {}, emit: collectedEmitter().emit, api: {},
    wrangler: { bin: '/x', run: async () => ({ ok: true }) },
    deps: { fetch: async () => { throw new Error('no network'); }, deploy: { configExists: () => false } },
  });
  const finish = commands.pullSteps({ stagedRoot: '/unused', stagedState: '/unused' }).find((step) => step.id === 'pull-finish');
  await finish.run(ctx);
  const env = fs.readFileSync(path.join(library.root, 'capture/.env'), 'utf8');
  assert.match(env, /^SNIP_URL=http:\/\/localhost:5199$/m);
  assert.match(env, /^CAPTURE_TOKEN=y$/m, 'the local Worker checks its own .dev.vars token');
  assert.equal(stateModule.readState(library.root).mode, 'local');
});

test('a retried pull downloads files again into its new staged library', async () => {
  const steps = commands.pullSteps({ stagedRoot: '/b/pull-2', stagedState: '/b/pull-2/state' });
  const files = steps.find((step) => step.id === 'pull-files');
  const work = { pullStagedState: '/b/pull-2/state' };
  const ctx = { work, setWork(patch) { Object.assign(work, patch); } };
  assert.equal(await files.verify(ctx), false, 'a journal entry from an earlier staged library does not count');
  work.pullFilesState = '/b/pull-1/state';
  assert.equal(await files.verify(ctx), false);
  work.pullFilesState = '/b/pull-2/state';
  assert.equal(await files.verify(ctx), true);
});

test('quiesce does not need the local API when Snip is not running', async () => {
  const quiesce = setup.setupSteps().find((step) => step.id === 'quiesce');
  let saved = null;
  const calls = [];
  const ctx = {
    libraryFacts: async () => ({ empty: false, localOrigin: 'http://localhost:5199' }),
    state: () => ({}),
    checkCancel() {},
    setPausedForMove(ids) { saved = ids; },
    deps: {
      now: () => 0,
      sleep: async () => {},
      local: {
        reachable: async () => false,
        createLocalApi() { calls.push('api'); throw new Error('LOCAL_API_UNREACHABLE'); },
      },
    },
  };
  const result = await quiesce.run(ctx);
  assert.deepEqual(calls, [], 'a stopped server is never called');
  assert.deepEqual(saved, []);
  assert.match(result.message, /Nothing was capturing/);
  assert.equal(await quiesce.verify(ctx), true);
});

test('pull puts the previous library back when its counts cannot be read', async () => {
  const library = fakeLibrary();
  stateModule.setMode(library.root, 'cloud');
  const live = path.join(library.root, 'web/.wrangler/state');
  stateDir(live, 'previous');
  const stagedRoot = path.join(library.root, 'backups/pull-test');
  const stagedState = path.join(stagedRoot, 'state');
  stateDir(stagedState, 'cloud-copy');
  const emitter = collectedEmitter();
  const ctx = createContext({
    root: library.root, dataRoot: library.root, flags: {}, emit: emitter.emit, api: {},
    wrangler: { bin: '/x', run: async () => ({ ok: true }) },
    deps: {
      fetch: async () => { throw new Error('no network'); },
      library: {
        async withLocalWorker() { throw new Error('cannot open'); },
        libraryConfig: ({ dataRoot }) => path.join(dataRoot, 'web/wrangler.jsonc'),
      },
    },
  });
  const swap = commands.pullSteps({ stagedRoot, stagedState }).find((step) => step.id === 'pull-swap');
  await assert.rejects(() => swap.run(ctx), (error) => error.code === 'PULL_COUNTS_FAILED');
  assert.equal(fs.readFileSync(path.join(live, 'v3/d1/marker'), 'utf8'), 'previous', 'the previous library is back in place');
  assert.equal(stateModule.readState(library.root).snapshot, null, 'no record was written');
  assert.deepEqual(fs.readdirSync(path.join(library.root, 'backups')).filter((name) => name.startsWith('cloud-pull-')), []);
});

test('pull with no previous library records no snapshot at all', async () => {
  const library = fakeLibrary();
  stateModule.setMode(library.root, 'cloud');
  const stagedRoot = path.join(library.root, 'backups/pull-test');
  const stagedState = path.join(stagedRoot, 'state');
  stateDir(stagedState, 'cloud-copy');
  const emitter = collectedEmitter();
  const ctx = createContext({
    root: library.root, dataRoot: library.root, flags: {}, emit: emitter.emit, api: {},
    wrangler: { bin: '/x', run: async () => ({ ok: true }) },
    deps: { fetch: async () => { throw new Error('no network'); }, library: { async withLocalWorker() { throw new Error('must not be called'); }, libraryConfig: () => null } },
  });
  const swap = commands.pullSteps({ stagedRoot, stagedState }).find((step) => step.id === 'pull-swap');
  await swap.run(ctx);
  assert.equal(stateModule.readState(library.root).snapshot, null);
  assert.equal(fs.existsSync(path.join(library.root, 'web/.wrangler/state/v3/d1/marker')), true);
});

test('the snapshot command runs the contract step ids, in order', async () => {
  const library = fakeLibrary();
  stateDir(path.join(library.root, 'web/.wrangler/state'), 'live');
  const backup = path.join(library.root, 'backups/cloud-pull-2026-11-06T10-12-00');
  stateDir(backup, 'previous');
  stateModule.updateState(library.root, (next) => {
    next.mode = 'local';
    next.snapshot = { kind: 'backup', path: 'backups/cloud-pull-2026-11-06T10-12-00', keptLocal: false, takenAt: new Date().toISOString(), refs: 2 };
    return next;
  });
  for (const [action, expected] of [
    ['restore', ['snapshot-preflight', 'snapshot-restore', 'snapshot-finish']],
    ['delete', ['snapshot-preflight', 'snapshot-delete', 'snapshot-finish']],
    ['delete-export', ['snapshot-preflight', 'snapshot-delete-export', 'snapshot-finish']],
  ]) {
    stateModule.updateState(library.root, (next) => {
      next.snapshot = {
        kind: 'backup', path: 'backups/cloud-pull-2026-11-06T10-12-00', keptLocal: false, takenAt: new Date().toISOString(), refs: 2,
        export: { path: 'backups/cloud-export-x', takenAt: new Date().toISOString(), refs: 2 },
      };
      return next;
    });
    fs.mkdirSync(backup, { recursive: true });
    stateDir(backup, 'previous');
    fs.mkdirSync(path.join(library.root, 'backups/cloud-export-x'), { recursive: true });
    const { ctx, emitter } = snapshotContext(library, { action, confirm: action === 'restore' ? undefined : action === 'delete' ? 'cloud-pull-2026-11-06T10-12-00' : 'cloud-export-x' });
    await commands.commandSnapshot(ctx);
    const started = emitter.events.filter((event) => event.event === 'step' && event.status === 'started').map((event) => event.step);
    assert.deepEqual(started, expected, `${action} runs the documented steps`);
  }
});

test('delete-resources verifies every artifact and clears the install record', async () => {
  const library = fakeLibrary();
  stateModule.setMode(library.root, 'cloud');
  stateModule.updateState(library.root, (next) => {
    next.cloud = { url: PROVIDED, accountId: 'acct', workerName: 'snip', d1: { name: 'snip', id: 'd1' }, kv: { name: 'OAUTH_KV', id: 'kv' }, bucket: 'snip-files' };
    return next;
  });
  const emitter = collectedEmitter();
  const fakeCloudModule = {
    listD1: async () => [],
    listKv: async () => [],
    listBuckets: async () => [],
    deleteSecret: async () => {},
  };
  const ctx = createContext({
    root: library.root, dataRoot: library.root, flags: { confirm: 'snip.tester.workers.dev' }, emit: emitter.emit,
    api: { workerExists: async () => false },
    wrangler: { bin: '/x', run: async () => ({ ok: true, stdout: '', stderr: '' }) },
    deps: { fetch: async () => { throw new Error('no network'); }, cloud: fakeCloudModule },
  });
  const result = await commands.commandDeleteResources(ctx);
  assert.equal(result.ok, true);
  const record = stateModule.readState(library.root);
  assert.equal(record.mode, 'local');
  assert.equal(record.cloud.deletedAt !== undefined, true);
  assert.equal(record.cloud.url, undefined, 'no stale url is left to re-install from');
  assert.equal(record.cloud.d1, undefined);

  // A surviving database is a failed delete, not a success.
  const library2 = fakeLibrary();
  stateModule.setMode(library2.root, 'cloud');
  stateModule.updateState(library2.root, (next) => {
    next.cloud = { url: PROVIDED, accountId: 'acct', workerName: 'snip', d1: { name: 'snip', id: 'd1' }, bucket: 'snip-files' };
    return next;
  });
  const survivor = createContext({
    root: library2.root, dataRoot: library2.root, flags: { confirm: 'snip.tester.workers.dev' }, emit: emitter.emit,
    api: { workerExists: async () => false },
    wrangler: { bin: '/x', run: async () => ({ ok: true, stdout: '', stderr: '' }) },
    deps: { fetch: async () => { throw new Error('no network'); }, cloud: { ...fakeCloudModule, listD1: async () => [{ id: 'd1', name: 'snip' }] } },
  });
  await assert.rejects(() => commands.commandDeleteResources(survivor), (error) => error.code === 'DELETE_INCOMPLETE' && error.data.leftover.includes('database'));
  assert.equal(stateModule.readState(library2.root).cloud.url, PROVIDED, 'the record stays until everything is gone');
});

/** A pull-verify context that records which tables verify actually compares. */
function pullVerifyContext({ library, stagedState, manifestValue, dump, counts, localCounts = counts }) {
  const queried = [];
  const tableOf = (sql) => (sql.match(/FROM "([A-Za-z0-9_]+)"/) || [])[1];
  const emitter = collectedEmitter();
  const ctx = createContext({
    root: library.root,
    dataRoot: library.root,
    flags: {},
    emit: emitter.emit,
    api: {},
    wrangler: { bin: '/x', run: async () => ({ ok: true }) },
    deps: {
      fetch: async () => { throw new Error('no network'); },
      deploy: {
        ...deploy,
        // The quoted identifier only appears in a per-table digest, so the
        // "is the library empty" count does not pollute the recording.
        remoteQuery: async (_wrangler, options) => {
          const table = tableOf(options.sql);
          if (table) queried.push(`remote:${table}`);
          return [{ rows: counts[table] || 0, sig: counts[table] || 0 }];
        },
        localQuery: async (_wrangler, options) => {
          const table = tableOf(options.sql);
          if (table) queried.push(`local:${table}`);
          return [{ rows: localCounts[table] || 0, sig: localCounts[table] || 0 }];
        },
      },
      library: {
        async withLocalWorker(_options, fn) {
          return fn({
            transfer: { async head() { return 10; } },
            async dispose() {},
          });
        },
        libraryConfig: ({ dataRoot }) => path.join(dataRoot, 'web/wrangler.jsonc'),
      },
      local: { ...LOCAL_FAKE, localOrigin: () => 'http://localhost:5199' },
    },
  });
  stateModule.updateState(library.root, (next) => {
    next.mode = 'cloud';
    next.cloud = { url: PROVIDED, accountId: 'acct' };
    return next;
  });
  ctx.reload();
  fs.mkdirSync(path.dirname(stagedState), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(stagedState), 'dump.sql'), dump);
  ctx.setWork({ pullManifest: manifestValue });
  const verify = commands.pullSteps({ stagedRoot: path.dirname(stagedState), stagedState }).find((step) => step.id === 'pull-verify');
  return { ctx, verify, queried };
}

const DUMP_WITH_LEDGER = [
  'INSERT INTO "refs" (id, url) VALUES (\'a\', \'https://a.test\');',
  'INSERT INTO "pages" (id) VALUES (\'p\');',
  'INSERT INTO "d1_migrations" (id, name) VALUES (1, \'0001_init.sql\'), (2, \'0002_x.sql\');',
  'INSERT INTO "owner_nonces" (nonce) VALUES (\'n\');',
].join('\n');

test('pull-verify skips every table the manifest excludes', async () => {
  const { root } = fakeLibrary();
  const stagedState = path.join(root, 'backups/pull-test/state');
  // The cloud ledger says 10 migrations, the staged copy has 12 after applying
  // migrations locally. Comparing them would fail a correct pull.
  const { ctx, verify, queried } = pullVerifyContext({
    library: { root },
    stagedState,
    manifestValue: {
      tables: { refs: 1, pages: 1, d1_migrations: 10, owner_nonces: 0 },
      excluded: ['d1_migrations', 'owner_nonces'],
      keys: [{ key: SYNTHETIC.fileKey(5, 'shot.png'), size: 10 }],
    },
    dump: DUMP_WITH_LEDGER,
    counts: { refs: 1, pages: 1, d1_migrations: 10, owner_nonces: 1 },
    localCounts: { refs: 1, pages: 1, d1_migrations: 12, owner_nonces: 1 },
  });
  await verify.run(ctx);
  assert.deepEqual(queried, ['remote:refs', 'local:refs', 'remote:pages', 'local:pages'], 'excluded tables are never queried');
});

test('an older Worker with no excluded list still verifies with a shorter migrations ledger', async () => {
  const { root } = fakeLibrary();
  const stagedState = path.join(root, 'backups/pull-old/state');
  // An older Worker reports no `excluded` and no d1_migrations row at all. The
  // engine must not require either: it compares what the manifest says was
  // copied, and nothing else.
  const { ctx, verify, queried } = pullVerifyContext({
    library: { root },
    stagedState,
    manifestValue: {
      tables: { refs: 1, pages: 1 },
      keys: [{ key: SYNTHETIC.fileKey(5, 'shot.png'), size: 10 }],
    },
    dump: DUMP_WITH_LEDGER,
    counts: { refs: 1, pages: 1 },
  });
  await verify.run(ctx);
  assert.deepEqual(queried, ['remote:refs', 'local:refs', 'remote:pages', 'local:pages']);
  assert.equal(ctx.work.pullVerified.keys, 1);
});

test('a newer Worker that excludes a table the engine has never heard of still verifies', async () => {
  const { root } = fakeLibrary();
  const stagedState = path.join(root, 'backups/pull-new/state');
  const { ctx, verify, queried } = pullVerifyContext({
    library: { root },
    stagedState,
    manifestValue: {
      tables: { refs: 1, future_table: 4 },
      excluded: ['future_table'],
      keys: [{ key: SYNTHETIC.fileKey(5, 'shot.png'), size: 10 }],
    },
    dump: DUMP_WITH_LEDGER,
    counts: { refs: 1, future_table: 4 },
  });
  await verify.run(ctx);
  assert.deepEqual(queried, ['remote:refs', 'local:refs']);
});

test('pull-verify fails when two zeros would otherwise pass for a copy', async () => {
  const { root } = fakeLibrary();
  const stagedState = path.join(root, 'backups/pull-empty/state');
  const { ctx, verify } = pullVerifyContext({
    library: { root },
    stagedState,
    manifestValue: { tables: { refs: 3 }, excluded: ['d1_migrations'], keys: [] },
    dump: DUMP_WITH_LEDGER,
    counts: { refs: 0 },
    localCounts: { refs: 3 },
  });
  await assert.rejects(() => verify.run(ctx), (error) => error.code === 'VERIFY_COUNT_MISMATCH');
});

test('setup verify skips an excluded ledger and compares what the manifest copied', async () => {
  const { root } = fakeLibrary();
  const directory = path.join(root, 'backups/cloud-export-2026-11-06T10-12-00');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'dump.sql'), DUMP_WITH_LEDGER);
  // The cloud has 10 migrations, the local dump holds a longer ledger: an
  // excluded table must not be compared, or a correct move fails.
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ tables: { refs: 1, pages: 1, d1_migrations: 10 } }));
  fs.writeFileSync(path.join(directory, 'files.json'), JSON.stringify({ keys: [{ key: SYNTHETIC.fileKey(5, 'shot.png'), size: 10, contentType: 'image/png' }], excluded: ['d1_migrations'] }));
  stateModule.setMode(root, 'cloud');
  stateModule.updateState(root, (next) => {
    next.cloud = { url: PROVIDED, accountId: 'acct', lastVerifiedAt: 'x' };
    next.snapshot = { kind: 'live', path: null, keptLocal: true, takenAt: new Date().toISOString(), refs: 1, export: { path: 'backups/cloud-export-2026-11-06T10-12-00', takenAt: new Date().toISOString(), refs: 1 } };
    return next;
  });
  stateModule.writeSecrets(root, { version: 1, ownerLinkSecret: crypto.randomBytes(32).toString('hex'), captureToken: 'c', transferToken: crypto.randomBytes(32).toString('hex') });
  const queried = [];
  const tableOf = (sql) => (sql.match(/FROM "([A-Za-z0-9_]+)"/) || [])[1];
  const emitter = collectedEmitter();
  const ctx = createContext({
    root, dataRoot: root, flags: {}, emit: emitter.emit, api: {},
    wrangler: { bin: '/x', run: async () => ({ ok: true }) },
    deps: {
      // The only network call this step makes is the manifest, over the
      // transfer client the context builds from deps.fetch.
      fetch: async () => new Response(JSON.stringify({ tables: { refs: 1, pages: 1 }, keys: [{ key: SYNTHETIC.fileKey(5, 'shot.png'), size: 10 }] }), { status: 200, headers: { 'content-type': 'application/json' } }),
      local: { ...LOCAL_FAKE, localOrigin: () => null },
      library: { libraryConfig: ({ dataRoot }) => path.join(dataRoot, 'web/wrangler.jsonc'), async withLocalWorker() { throw new Error('not used'); } },
      deploy: {
        ...deploy,
        remoteQuery: async (_w, options) => { const t = tableOf(options.sql); if (t) queried.push(t); return [{ rows: 1, sig: 1 }]; },
        localQuery: async (_w, options) => {
          const t = tableOf(options.sql);
          if (!t) return [{ rows: 0 }];
          return [{ rows: 1, sig: 1 }];
        },
      },
    },
  });
  ctx.reload();
  const verify = setup.setupSteps().find((step) => step.id === 'verify');
  await verify.run(ctx);
  assert.deepEqual(queried.sort(), ['pages', 'refs'], 'the migrations ledger is never compared');
});

test('deploy waits for the transfer secret to go live before judging the deploy', async () => {
  const library = fakeLibrary();
  stateModule.setMode(library.root, 'cloud');
  stateModule.updateState(library.root, (next) => {
    next.cloud = { url: PROVIDED, accountId: 'acct', workerName: 'snip', d1: { name: 'snip', id: 'd1' }, kv: { name: 'OAUTH_KV', id: 'kv' }, bucket: 'snip-files', workerVersion: '1.1.0' };
    return next;
  });
  const emitter = collectedEmitter();
  let attempts = 0;
  const ctx = createContext({
    root: library.root, dataRoot: library.root, flags: {}, emit: emitter.emit, api: {},
    wrangler: { bin: '/x', run: async () => ({ ok: true, stdout: '', stderr: '' }) },
    deps: {
      fetch: async () => { throw new Error('no network'); },
      sleep: async () => {},
      cloud: { ...require('../provision/cloud.cjs'), putSecrets: async () => {}, deleteSecret: async () => {} },
      deploy: {
        ...deploy,
        configExists: () => true,
        runtimeProblem: () => null,
        applyMigrations: async () => ({ ok: true }),
        prepareDeployLayout: () => ({}),
        deployWorker: async () => ({ ok: true }),
        bundleHash: () => 'hash',
      },
      // The first two reads land before the edge serves the new secret.
      transferOf: () => ({ status: async () => { attempts++; return attempts < 3 ? Promise.reject(new Error('401')) : { version: '1.1.3' }; } }),
    },
  });
  ctx.reload();
  const result = await commands.commandDeploy(ctx);
  assert.equal(result.ok, true);
  assert.equal(attempts, 3, 'it polls instead of failing on the first 401');
  const record = stateModule.readState(library.root).cloud;
  assert.equal(record.workerVersion, '1.1.3', 'the record takes the version the Worker reported');
});

test('deploy still fails when the Worker never answers its status route', async () => {
  const library = fakeLibrary();
  stateModule.setMode(library.root, 'cloud');
  stateModule.updateState(library.root, (next) => {
    next.cloud = { url: PROVIDED, accountId: 'acct', d1: { name: 'snip', id: 'd1' }, kv: { name: 'OAUTH_KV', id: 'kv' }, bucket: 'snip-files' };
    return next;
  });
  const emitter = collectedEmitter();
  const ctx = createContext({
    root: library.root, dataRoot: library.root, flags: {}, emit: emitter.emit, api: {},
    wrangler: { bin: '/x', run: async () => ({ ok: true, stdout: '', stderr: '' }) },
    deps: {
      fetch: async () => { throw new Error('no network'); },
      sleep: async () => {},
      cloud: { ...require('../provision/cloud.cjs'), putSecrets: async () => {}, deleteSecret: async () => {} },
      deploy: { ...deploy, configExists: () => true, runtimeProblem: () => null, applyMigrations: async () => ({ ok: true }), prepareDeployLayout: () => ({}), deployWorker: async () => ({ ok: true }), bundleHash: () => 'hash' },
      transferOf: () => ({ status: async () => { throw new Error('401'); } }),
    },
  });
  ctx.reload();
  await assert.rejects(() => commands.commandDeploy(ctx), (error) => error.code === 'DEPLOY_VERIFY_FAILED' && error.retryable === true);
});

test('every deploy uploads the bundle again instead of replaying a journaled run', async () => {
  const library = fakeLibrary();
  stateModule.setMode(library.root, 'cloud');
  stateModule.updateState(library.root, (next) => {
    next.cloud = { url: PROVIDED, accountId: 'acct', d1: { name: 'snip', id: 'd1' }, kv: { name: 'OAUTH_KV', id: 'kv' }, bucket: 'snip-files', workerVersion: '1.1.2' };
    // A finished earlier deploy in the journal.
    next.steps = [
      { id: 'deploy-preflight', status: 'done', at: new Date().toISOString(), detail: '' },
      { id: 'deploy-schema', status: 'done', at: new Date().toISOString(), detail: '' },
      { id: 'deploy-worker', status: 'done', at: new Date().toISOString(), detail: '' },
      { id: 'deploy-verify', status: 'done', at: new Date().toISOString(), detail: '' },
    ];
    return next;
  });
  let uploads = 0;
  let migrations = 0;
  const emitter = collectedEmitter();
  const ctx = createContext({
    root: library.root, dataRoot: library.root, flags: {}, emit: emitter.emit, api: {},
    wrangler: { bin: '/x', run: async () => ({ ok: true, stdout: '', stderr: '' }) },
    deps: {
      fetch: async () => { throw new Error('no network'); },
      sleep: async () => {},
      cloud: { ...require('../provision/cloud.cjs'), putSecrets: async () => {}, deleteSecret: async () => {} },
      deploy: {
        ...deploy,
        configExists: () => true,
        runtimeProblem: () => null,
        applyMigrations: async () => { migrations++; return { ok: true }; },
        prepareDeployLayout: () => ({}),
        deployWorker: async () => { uploads++; return { ok: true }; },
        bundleHash: () => 'hash',
      },
      transferOf: () => ({ status: async () => ({ version: '1.1.3' }) }),
    },
  });
  ctx.reload();
  const result = await commands.commandDeploy(ctx);
  assert.equal(result.ok, true);
  assert.equal(uploads, 1, 'the bundle is uploaded even though the journal says it was done');
  assert.equal(migrations, 1, 'migrations are re-applied too');
  const started = emitter.events.filter((event) => event.event === 'step' && event.status === 'started').map((event) => event.step);
  assert.deepEqual(started, ['deploy-preflight', 'deploy-schema', 'deploy-worker', 'deploy-verify']);
  assert.equal(stateModule.readState(library.root).cloud.workerVersion, '1.1.3');
});

// ---------- transient Cloudflare failures ----------

const transientOutput = (code) => ({ ok: false, code: 1, stdout: '', stderr: `✘ [ERROR] A request to the Cloudflare API failed. [code: ${code}]` });
const serviceDown = () => ({ ok: false, code: 1, stdout: '', stderr: '✘ [ERROR] HTTP status 503: Service Unavailable' });

function recordingSleep() {
  const delays = [];
  return { delays, sleep: async (ms) => { delays.push(ms); } };
}

test('an HTTP 5xx, a 429, an edge code and a network error are transient; auth and permission are not', () => {
  const at = (text) => deploy.transientReason({ ok: false, stdout: '', stderr: text });
  assert.match(at(transientOutput(7403).stderr), /7403/);
  assert.match(at('[code: 10013] Could not route to /accounts/x/d1'), /10013/);
  assert.equal(at('HTTP status 502: Bad Gateway'), 'HTTP 502');
  assert.equal(at('✘ [ERROR] 503 Service Unavailable'), 'HTTP 503');
  assert.equal(at('✘ [ERROR] 500 Internal Server Error'), 'HTTP 500');
  assert.equal(at('429 Too Many Requests'), 'HTTP 429');
  assert.equal(at('error: read ETIMEDOUT'), 'a network error');
  // The user has to change something: never retried, never called temporary.
  assert.equal(at('You are not authenticated. Please run `wrangler login`.'), null);
  assert.equal(at('[code: 10000] Authentication error'), null);
  assert.equal(at('HTTP 403 Forbidden'), null);
  assert.equal(at('You do not have permission to edit this Worker'), null);
  assert.equal(at('[code: 10042] R2 must be enabled'), null);
  // 7403 reports itself as "not authorized" and is still transient; the same
  // words without the code are a permission refusal.
  assert.match(at('[code: 7403] account not valid or not authorized'), /7403/);
  assert.equal(at('account not valid or not authorized'), null);
});

test('migrations, deploy and secret writes retry a transient failure, then succeed', async () => {
  const library = fakeLibrary();
  const configDir = path.join(library.root, 'cloud/snip');
  fs.mkdirSync(configDir, { recursive: true });

  const migrations = recordingSleep();
  let migrationCalls = 0;
  const migrationResult = await deploy.applyMigrations(
    { bin: '/x', run: async () => (++migrationCalls <= 2 ? transientOutput(7403) : { ok: true, code: 0, stdout: 'No migrations to apply', stderr: '' }) },
    { dataRoot: library.root, accountId: 'acct', remote: true, retry: retryOf({ deps: { sleep: migrations.sleep }, emit: { log: () => {} } }) },
  );
  assert.equal(migrationResult.ok, true);
  assert.equal(migrationCalls, 3, 'two transient failures, then the real answer');
  assert.deepEqual(migrations.delays, [800, 2500], 'backoff between attempts');

  const upload = recordingSleep();
  let deployCalls = 0;
  await deploy.deployWorker(
    { bin: '/x', run: async () => (++deployCalls <= 1 ? serviceDown() : { ok: true, code: 0, stdout: 'Deployed', stderr: '' }) },
    { dataRoot: library.root, accountId: 'acct', retry: retryOf({ deps: { sleep: upload.sleep }, emit: { log: () => {} } }) },
  );
  assert.equal(deployCalls, 2);
  assert.deepEqual(upload.delays, [800]);

  const secretWrite = recordingSleep();
  let secretCalls = 0;
  const put = await cloudModule.putSecrets(
    { bin: '/x', run: async () => (++secretCalls <= 1 ? transientOutput(10013) : { ok: true, code: 0, stdout: '', stderr: '' }) },
    { dataRoot: library.root, accountId: 'acct', secrets: { SESSION_SECRET: 's' }, retry: retryOf({ deps: { sleep: secretWrite.sleep }, emit: { log: () => {} } }) },
  );
  assert.deepEqual(put.names, ['SESSION_SECRET']);
  assert.equal(secretCalls, 2);
});

test('a transient failure that outlasts the retries is retryable, with a plain message', async () => {
  const library = fakeLibrary();
  const clock = recordingSleep();
  let attempts = 0;
  await assert.rejects(
    () => deploy.applyMigrations(
      { bin: '/x', run: async () => { attempts++; return serviceDown(); } },
      { dataRoot: library.root, accountId: 'acct', remote: true, retry: retryOf({ deps: { sleep: clock.sleep }, emit: { log: () => {} } }) },
    ),
    (error) => {
      assert.equal(error.code, 'CLOUDFLARE_TEMPORARY');
      assert.equal(error.message, 'Cloudflare had a temporary problem, try again.');
      assert.equal(error.retryable, true, 'an agent may run the same command again');
      assert.equal(error.data.attempts, 4);
      assert.equal(error.data.reason, 'HTTP 503');
      return true;
    },
  );
  assert.equal(attempts, 4, 'a few attempts, not an endless loop');
  assert.deepEqual(clock.delays, [800, 2500, 6000], 'backoff grows');
});

test('7403 names the wrong-account possibility, since no retry can fix that', async () => {
  const library = fakeLibrary();
  const clock = recordingSleep();
  let attempts = 0;
  await assert.rejects(
    () => deploy.applyMigrations(
      { bin: '/x', run: async () => { attempts++; return transientOutput(7403); } },
      { dataRoot: library.root, accountId: 'acct', remote: true, retry: retryOf({ deps: { sleep: clock.sleep }, emit: { log: () => {} } }) },
    ),
    (error) => {
      assert.equal(error.code, 'CLOUDFLARE_TEMPORARY');
      assert.equal(error.message, 'Cloudflare refused the request. Try again; if it keeps happening, check that you\'re signed in to the Cloudflare account that owns this Snip.');
      assert.equal(error.retryable, true, 'still worth one more try: it is usually the edge');
      assert.equal(error.data.reason, 'Cloudflare code 7403');
      assert.equal(error.data.ambiguousAccount, true);
      assert.equal(error.data.attempts, 4);
      assert.match(error.hint, /wrangler whoami/, 'the hint names the check that settles it');
      return true;
    },
  );
  assert.equal(attempts, 4);

  // Every other transient reason keeps the plain wording: only 7403 has a
  // second, non-transient meaning to warn about.
  const others = [
    ['a 5xx', serviceDown],
    ['a 429', () => ({ ok: false, code: 1, stdout: '', stderr: '429 Too Many Requests' })],
    ['a dropped connection', () => ({ ok: false, code: 1, stdout: '', stderr: 'read ECONNRESET' })],
  ];
  for (const [label, fail] of others) {
    const slept = recordingSleep();
    await assert.rejects(
      () => deploy.deployWorker(
        { bin: '/x', run: async () => fail() },
        { dataRoot: library.root, accountId: 'acct', retry: retryOf({ deps: { sleep: slept.sleep }, emit: { log: () => {} } }) },
      ),
      (error) => {
        assert.equal(error.message, 'Cloudflare had a temporary problem, try again.', `${label} keeps the plain message`);
        assert.equal(error.data.ambiguousAccount, undefined, `${label} is not about the account`);
        assert.equal(error.retryable, true);
        return true;
      },
    );
    assert.deepEqual(slept.delays, [800, 2500, 6000], `${label} still backs off`);
  }
});

test('an auth or permission failure is never retried', async () => {
  const library = fakeLibrary();
  const never = { sleep: async () => { throw new Error('a permanent failure must not wait'); } };
  let authCalls = 0;
  await assert.rejects(
    () => deploy.deployWorker(
      { bin: '/x', run: async () => { authCalls++; return { ok: false, code: 1, stdout: '', stderr: 'You are not authenticated. Please run `wrangler login`.' }; } },
      { dataRoot: library.root, accountId: 'acct', retry: never },
    ),
    (error) => error.code === 'AUTH_REQUIRED' && error.retryable !== true,
  );
  assert.equal(authCalls, 1);

  let permissionCalls = 0;
  await assert.rejects(
    () => cloudModule.putSecrets(
      { bin: '/x', run: async () => { permissionCalls++; return { ok: false, code: 1, stdout: '', stderr: 'HTTP 403 Forbidden: you do not have permission' }; } },
      { dataRoot: library.root, accountId: 'acct', secrets: { SESSION_SECRET: 's' }, retry: never },
    ),
    (error) => error.code === 'SECRET_PUT_FAILED' && error.retryable !== true,
  );
  assert.equal(permissionCalls, 1);
});

test('a create is never retried, because a second database cannot be undone', async () => {
  let calls = 0;
  await assert.rejects(
    () => cloudModule.createD1({ bin: '/x', run: async () => { calls++; return serviceDown(); } }, { accountId: 'acct' }),
    (error) => error.code === 'D1_CREATE_FAILED',
  );
  assert.equal(calls, 1, 'one attempt: a retried create could leave an orphan behind');
});

test('deploy rides out a Cloudflare hiccup and says so once', async () => {
  const library = fakeLibrary();
  stateModule.setMode(library.root, 'cloud');
  stateModule.updateState(library.root, (next) => {
    next.cloud = { url: PROVIDED, accountId: 'acct', d1: { name: 'snip', id: 'd1' }, kv: { name: 'OAUTH_KV', id: 'kv' }, bucket: 'snip-files', workerVersion: '1.1.3' };
    return next;
  });
  const emitter = collectedEmitter();
  const clock = recordingSleep();
  let deploys = 0;
  const ctx = createContext({
    root: library.root, dataRoot: library.root, flags: {}, emit: emitter.emit, api: {},
    wrangler: {
      bin: '/x',
      run: async (args) => {
        if (args[0] === 'deploy' && ++deploys <= 1) return transientOutput(7403);
        return { ok: true, code: 0, stdout: '', stderr: '' };
      },
    },
    deps: {
      fetch: async () => { throw new Error('no network'); },
      sleep: clock.sleep,
      cloud: cloudModule,
      deploy: { ...deploy, configExists: () => true, runtimeProblem: () => null, prepareDeployLayout: () => ({}) },
      transferOf: () => ({ status: async () => ({ version: '1.1.4' }) }),
    },
  });
  ctx.reload();
  const result = await commands.commandDeploy(ctx);
  assert.equal(result.ok, true);
  assert.equal(deploys, 2, 'the deploy was retried inside its step');
  const warning = emitter.events.find((event) => event.event === 'log' && event.level === 'warn');
  assert.match(warning.message, /Cloudflare had a temporary problem \(Cloudflare code 7403\)/);
  assert.match(warning.message, /retrying in 1s \(attempt 2 of 4\)/);
});

test('a deploy that stays broken reports retryable in the CLI result', async () => {
  const library = fakeLibrary();
  const vars = path.join(library.root, 'web/.dev.vars');
  fs.writeFileSync(vars, 'PUBLIC_URL=http://127.0.0.1:1\n');
  const lines = [];
  const io = { stdout: { write: (line) => { lines.push(line); return true; } }, stderr: { write: () => true } };
  const result = await cli.main(['status', '--check', '--root', library.root, '--data-root', library.root, '--json'], io);
  assert.equal(result.code, 1);
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.event, 'result');
  assert.equal(last.ok, false);
  assert.equal(last.data.code, 'LOCAL_UNREACHABLE');
  assert.equal(last.retryable, true, 'a step failure that names itself retryable now says so');
});

test('setup --resume behaves exactly like setup', async () => {
  // `--resume` is accepted for compatibility but never read: every step
  // re-verifies, so a run always resumes where the last one stopped. The two
  // invocations must therefore be indistinguishable, not merely both successful.
  // Created ids and timestamps are generated per run, so they are normalized;
  // every decision, message and count is compared as-is.
  const normalize = (value) => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, normalize(inner)]));
    }
    if (typeof value === 'string') {
      return value
        .replace(/\b[0-9a-f]{32,}\b/g, '<id>')
        .replace(/\d{4}-\d{2}-\d{2}T[\d:.-]+Z/g, '<ts>');
    }
    return value;
  };
  const summary = (outcome) => normalize({
    result: { ok: outcome.result.ok, code: outcome.result.code, mode: outcome.result.mode, data: outcome.result.data },
    steps: outcome.events
      .filter((event) => event.event === 'step')
      .map((event) => `${event.step}:${event.status}:${event.message}`),
    state: (({ mode, cloud, snapshot, transfer, steps }) => ({
      mode,
      cloud: { url: cloud.url, accountId: cloud.accountId, d1: cloud.d1?.name, kv: cloud.kv?.name, bucket: cloud.bucket, move: { status: cloud.move?.status, reason: cloud.move?.reason } },
      snapshot: snapshot && { kind: snapshot.kind, path: snapshot.path, refs: snapshot.refs, files: snapshot.files, bytes: snapshot.bytes, hasExport: Boolean(snapshot.export) },
      transfer: transfer && { keys: transfer.keys, tables: transfer.tables },
      steps: steps.map((step) => `${step.id}:${step.status}`),
    }))(stateModule.readState(outcome.model.root)),
  });

  const plain = summary(await runSetup(buildModel()));
  const resumed = summary(await runSetup(buildModel(), { resume: true }));
  assert.deepEqual(resumed.steps, plain.steps, 'every step reports the same outcome');
  assert.deepEqual(resumed.state, plain.state, 'the recorded state is identical');
  assert.deepEqual(resumed.result, plain.result);
  assert.equal(plain.result.ok, true);
  assert.equal(plain.state.mode, 'cloud');
});

test('the help lists snapshot restore once, scoped to a pull backup, and explains --resume', () => {
  const help = cli.helpText();
  const restore = help.split('\n').filter((line) => /^\s+snapshot restore\b/.test(line));
  assert.equal(restore.length, 1, 'restore is listed exactly once');
  assert.match(restore[0], /pull/, 'and says which backup it switches back to');
  assert.match(help, /snapshot delete .*--confirm/);
  assert.match(help, /snapshot delete-export .*--confirm/);
  assert.match(help, /--resume is optional; setup always resumes where it stopped\./);
  // The retired pre-cloud snapshot wording must not survive anywhere.
  assert.doesNotMatch(help, /pre-cloud snapshot/);
});

test('the help explains --no-handoff as the other-browser form', () => {
  const help = cli.helpText();
  assert.match(help, /--adopt-existing --no-handoff --confirm/, 'the flag is listed with the others');
  assert.match(help, /--no-handoff is for `owner link`/);
  assert.match(help, /another browser or/);
  assert.match(help, /`setup` always uses the handoff/);
});
