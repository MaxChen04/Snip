'use strict';
// Recovery regressions for the provisioning engine (setup, abort, pull). Each test
// asserts the CORRECT behaviour of an interrupted or re-run command, so it fails
// today and passes once the matching bug is fixed. The helpers below are a copy of
// the ones in provision.test.cjs (that file runs its tests on require, so it cannot
// be imported), extended with fault injection (`model.intercept`) and the wrangler
// delete commands abort needs. No live Cloudflare call is possible here.

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

const madeDirs = [];
// Every temp directory a test makes here is removed once the file's tests have run.
test.after(() => {
  for (const dir of madeDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = 'snip-provision-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  madeDirs.push(dir);
  return dir;
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
    if (model.intercept) {
      const hit = await model.intercept(args, line);
      if (hit) return hit;
    }
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
    // Delete commands, as real wrangler behaves: a namespace is addressed by id (or by
    // a binding in a config), never by a bare binding name with no config.
    if (args[0] === 'd1' && args[1] === 'delete') {
      const before = model.d1.length;
      model.d1 = model.d1.filter((db) => db.name !== args[2]);
      return before === model.d1.length ? text('database not found', false) : text('Deleted');
    }
    if (args[0] === 'kv' && args[1] === 'namespace' && args[2] === 'delete') {
      const hit = model.kv.find((ns) => args.some((arg) => String(arg).includes(ns.id)));
      if (!hit) return text('Missing required argument: namespace-id', false);
      model.kv = model.kv.filter((ns) => ns !== hit);
      return text('Deleted');
    }
    if (args[0] === 'r2' && args[1] === 'bucket' && args[2] === 'delete') {
      model.r2 = model.r2.filter((bucket) => bucket.name !== args[3]);
      return text('Deleted');
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
        version: model.workerVersion || '1.1.0',
        ...(model.reads ? { reads: model.reads } : {}),
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
  const wrangler = options.wrangler || fakeWrangler(model);
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

function stateDir(base, marker) {
  fs.mkdirSync(path.join(base, 'v3/d1'), { recursive: true });
  fs.writeFileSync(path.join(base, 'v3/d1/marker'), marker);
}

/** Run `setup` once and return the outcome instead of throwing, so a test can rerun it. */
async function attemptSetup(model, flags = {}, options = {}) {
  const emitter = collectedEmitter();
  const cloudFake = options.cloud || fakeCloud(model);
  const wrangler = options.wrangler || fakeWrangler(model);
  const ctx = createContext({
    root: model.root,
    dataRoot: model.root,
    flags: { login: 'tester', domain: 'tester', noOpen: true, ...flags },
    emit: emitter.emit,
    api: fakeApi(model),
    wrangler,
    deps: {
      fetch: options.fetch || cloudFake.fetch,
      library: options.library || fakeLibraryModule(model),
      local: options.local || LOCAL_FAKE,
    },
  });
  const originalHuman = emitter.emit.human;
  emitter.emit.human = (step, action, url, message) => {
    if (step === 'owner') cloudFake.setOwner(true);
    return originalHuman(step, action, url, message);
  };
  if (options.beforeRun) options.beforeRun(ctx);
  let result = null;
  let error = null;
  try {
    result = await commands.commandSetup(ctx);
  } catch (caught) {
    error = caught;
  }
  return { result, error, ctx, events: emitter.events, wrangler, cloud: cloudFake, model };
}

/** A fresh context over the same library, for the command that follows an interrupted setup. */
function laterContext(model, wrangler, { flags = {}, deps = {} } = {}) {
  const emitter = collectedEmitter();
  const ctx = createContext({
    root: model.root,
    dataRoot: model.root,
    flags,
    emit: emitter.emit,
    api: fakeApi(model),
    wrangler,
    deps: { fetch: fakeCloud(model).fetch, library: fakeLibraryModule(model), local: LOCAL_FAKE, ...deps },
  });
  return { ctx, events: emitter.events };
}

const failed = (text) => ({ ok: false, code: 1, stdout: text, stderr: text, output: text });

// ---------------------------------------------------------------------------
// 1. Setup wedges on the capture token
// ---------------------------------------------------------------------------
test('BUG 1: a setup killed between the cloud secret write and the local save can be rerun', async () => {
  const model = buildModel();
  const wrangler = fakeWrangler(model);

  // Run 1: the Worker secrets are written (putSecrets), then the process dies before
  // the local copy is saved (saveSecrets). Dying is modelled by saveSecrets throwing.
  const first = await attemptSetup(model, {}, {
    wrangler,
    beforeRun: (ctx) => { ctx.saveSecrets = () => { throw new Error('process killed before the local save'); }; },
  });
  assert.ok(first.error, 'harness check: run 1 must be interrupted');
  assert.match(String(model.secretValues.CAPTURE_TOKEN || ''), /^[0-9a-f]{64}$/, 'harness check: the cloud now holds a CAPTURE_TOKEN');
  const localAfterCrash = stateModule.readSecrets(model.root) || {};
  assert.ok(!localAfterCrash.captureToken, 'harness check: this Mac never saved the token the cloud holds');

  // Run 2: the same command again. Correct behaviour is that it recovers: the cloud
  // CAPTURE_TOKEN is rewritten to match this Mac's, so /agent/ping accepts it.
  const second = await attemptSetup(model, {}, { wrangler });
  assert.equal(second.error, null, `rerun must succeed, but it failed with ${second.error && second.error.code}: ${second.error && second.error.message}`);
  assert.equal(second.result.ok, true);
  const local = stateModule.readSecrets(model.root) || {};
  assert.equal(model.secretValues.CAPTURE_TOKEN, local.captureToken, 'the cloud and this Mac agree on the capture token');
});

// ---------------------------------------------------------------------------
// 2. Abort cannot see half-created resources
// ---------------------------------------------------------------------------
test('BUG 2: abort deletes the database a setup created before the KV create failed', async () => {
  const model = buildModel();
  const wrangler = fakeWrangler(model);
  model.intercept = async (args) => (args[0] === 'kv' && args[1] === 'namespace' && args[2] === 'create' ? failed('kv create exploded') : null);

  const first = await attemptSetup(model, {}, { wrangler });
  assert.ok(first.error, 'harness check: setup must fail while creating the KV namespace');
  assert.equal(first.error.code, 'KV_CREATE_FAILED');
  assert.equal(model.d1.length, 1, 'harness check: the database was created before the failure');
  assert.equal(stateModule.readState(model.root).mode, 'enabling');

  const { ctx } = laterContext(model, wrangler);
  const result = await commands.commandAbort(ctx);
  assert.equal(result.ok, true);
  assert.deepEqual(model.d1, [], 'abort must delete the database this run created; it is now orphaned in the account');
  assert.ok(wrangler.calls.some((call) => call.args[0] === 'd1' && call.args[1] === 'delete'), 'abort issued a d1 delete');
});

// ---------------------------------------------------------------------------
// 3. Abort's KV delete is malformed
// ---------------------------------------------------------------------------
test('BUG 3: abort deletes the KV namespace by the id this run created', async () => {
  const model = buildModel();
  const wrangler = fakeWrangler(model);
  // Everything is created; the run then dies at deploy, so `created` is persisted.
  model.intercept = async (args) => (args[0] === 'deploy' ? failed('deploy exploded: bad bundle') : null);

  const first = await attemptSetup(model, {}, { wrangler });
  assert.ok(first.error, 'harness check: setup must fail at deploy');
  assert.equal(model.kv.length, 1, 'harness check: a KV namespace was created');
  const kvId = model.kv[0].id;
  assert.equal(stateModule.readState(model.root).cloud.created.kv.id, kvId, 'harness check: the run recorded what it created');

  const { ctx } = laterContext(model, wrangler);
  const before = wrangler.calls.length;
  const result = await commands.commandAbort(ctx);
  assert.equal(result.ok, true);
  const kvDelete = wrangler.calls.slice(before).find((call) => call.args[0] === 'kv' && call.args[1] === 'namespace' && call.args[2] === 'delete');
  assert.ok(kvDelete, 'abort issued a kv namespace delete');
  assert.ok(kvDelete.args.some((arg) => String(arg).includes(kvId)), `the delete must name the created namespace id; it ran: wrangler ${kvDelete.line}`);
  assert.deepEqual(model.kv, [], 'the created namespace is gone');
});

// ---------------------------------------------------------------------------
// 4. Abort drops the paused-capture list without resuming
// ---------------------------------------------------------------------------
test('BUG 4: abort resumes the local captures that setup paused', async () => {
  const model = buildModel();
  const wrangler = fakeWrangler(model);
  const localOrigin = 'http://127.0.0.1:5199';
  const requests = [];
  let serverUp = true;
  // The local Snip server: two queued captures, pause and resume answer 200.
  const localFetch = async (url, options = {}) => {
    const target = new URL(String(url));
    const method = options.method || 'GET';
    requests.push(`${method} ${target.pathname}${target.search}`);
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (method === 'GET' && target.pathname === '/api/references') {
      return json({ items: target.searchParams.get('status') === 'queued' ? [{ id: 'ref-1' }, { id: 'ref-2' }] : [] });
    }
    if (method === 'GET' && target.pathname === '/api/agent') {
      // Setup's quiesce is over once the agent has been polled: Snip is then quit.
      serverUp = false;
      return json({ activity: 'idle' });
    }
    return json({});
  };
  const cloudFake = fakeCloud(model);
  const routedFetch = (url, options) => (new URL(String(url)).origin === localOrigin ? localFetch(url, options) : cloudFake.fetch(url, options));
  const local = {
    ...realLocal,
    localOrigin: () => localOrigin,
    reachable: async () => serverUp,
    createLocalApi: (origin, options = {}) => realLocal.createLocalApi(origin, { ...options, fetchImpl: localFetch }),
  };
  // The export then fails (references but no files), which leaves setup interrupted.
  const library = fakeLibraryModule({ ...model, manifest: { version: 1, tables: { ...LIBRARY }, keys: [], totalBytes: 0 } });

  // --managed: the app runs setup with Snip still up and the engine asks it to quiesce.
  const first = await attemptSetup(model, { managed: true }, { wrangler, cloud: cloudFake, fetch: routedFetch, local, library });
  assert.ok(first.error, 'harness check: setup must be interrupted after quiesce');
  assert.equal(first.error.code, 'EXPORT_EMPTY');
  const interrupted = stateModule.readState(model.root);
  assert.deepEqual(interrupted.pausedForMove, ['ref-1', 'ref-2'], 'harness check: setup paused both captures');
  assert.ok(requests.includes('POST /api/references/ref-1/pause'), 'harness check: pause went over the local API');

  // The person restarts Snip, then aborts.
  serverUp = true;
  requests.length = 0;
  const { ctx } = laterContext(model, wrangler, { deps: { fetch: routedFetch, local } });
  const result = await commands.commandAbort(ctx);
  assert.equal(result.ok, true);
  assert.equal(stateModule.readState(model.root).mode, 'local');
  const resumed = requests.filter((entry) => entry.startsWith('POST /api/references/') && entry.endsWith('/resume'));
  assert.deepEqual(resumed.sort(), ['POST /api/references/ref-1/resume', 'POST /api/references/ref-2/resume'], `abort must resume what setup paused; local requests during abort: ${JSON.stringify(requests)}`);
});

// ---------------------------------------------------------------------------
// 5. A resumed setup silently ignores a changed --account
// ---------------------------------------------------------------------------
test('BUG 5: rerunning setup with a different --account refuses and says to abort first', async () => {
  const memberships = [{ id: 'acct_A_000000', name: 'Account A' }, { id: 'acct_B_000000', name: 'Account B' }];
  const model = buildModel({ memberships });
  const wrangler = fakeWrangler(model);
  // Run 1 chooses account A, then dies at the R2 check.
  model.intercept = async (args, line) => (line === 'r2 bucket list' ? failed('r2 list exploded') : null);
  const first = await attemptSetup(model, { account: 'acct_A_000000' }, { wrangler });
  assert.ok(first.error, 'harness check: run 1 must fail after the account was chosen');
  assert.equal(stateModule.readState(model.root).cloud.accountId, 'acct_A_000000');

  // Run 2: the person now says account B.
  model.intercept = null;
  const second = await attemptSetup(model, { account: 'acct_B_000000' }, { wrangler });
  const record = stateModule.readState(model.root);
  assert.ok(
    second.error,
    `the rerun must refuse a changed --account; instead it ended ${second.result && second.result.code} and carried on with account ${record.cloud && record.cloud.accountId}`,
  );
  assert.match(`${second.error.message} ${second.error.hint || ''}`, /abort/i, 'the error tells the person to abort first');
  assert.equal(record.cloud.accountId, 'acct_A_000000', 'the stored account is not silently switched either');
});

// ---------------------------------------------------------------------------
// 9. pull's library swap renames before recording intent
// ---------------------------------------------------------------------------
test('BUG 9: after a crash between the two swap renames, a rerun still records the pre-pull library as the backup', async () => {
  const library = fakeLibrary();
  stateModule.setMode(library.root, 'cloud');
  const live = path.join(library.root, 'web/.wrangler/state');
  stateDir(live, 'pre-pull-library');
  const fakeLib = {
    async withLocalWorker(options, fn) {
      return fn({
        transfer: {
          async status() { return { counts: { refs: 9, pages: 4 } }; },
          async manifest() { return { keys: [{ key: 'a', size: 10 }] }; },
        },
        async dispose() {},
      });
    },
    libraryConfig: ({ dataRoot }) => path.join(dataRoot, 'web/wrangler.jsonc'),
  };
  const makeCtx = () => createContext({
    root: library.root, dataRoot: library.root, flags: {}, emit: collectedEmitter().emit, api: {},
    wrangler: { bin: '/x', run: async () => ({ ok: true }) },
    deps: { fetch: async () => { throw new Error('no network'); }, library: fakeLib },
  });

  // Pull attempt 1: renames live -> backups/cloud-pull-*, then the process dies on the
  // second rename (staged -> live). A dead process rolls nothing back, so every rename
  // after the crash point also fails until the "restart" below.
  const stagedRoot1 = path.join(library.root, 'backups/pull-1');
  const stagedState1 = path.join(stagedRoot1, 'state');
  stateDir(stagedState1, 'cloud-copy');
  const realRename = fs.renameSync;
  let renames = 0;
  let dead = false;
  fs.renameSync = (from, to) => {
    renames++;
    if (dead || renames === 2) { dead = true; throw new Error('process died mid-swap'); }
    return realRename(from, to);
  };
  try {
    const swap1 = commands.pullSteps({ stagedRoot: stagedRoot1, stagedState: stagedState1 }).find((step) => step.id === 'pull-swap');
    await assert.rejects(() => swap1.run(makeCtx()));
  } finally {
    fs.renameSync = realRename;
  }
  const moved = fs.readdirSync(path.join(library.root, 'backups')).filter((name) => name.startsWith('cloud-pull-'));
  assert.equal(moved.length, 1, 'harness check: the live library was moved aside to backups/cloud-pull-*');
  assert.equal(fs.existsSync(live), false, 'harness check: nothing is live at the crash point');
  assert.equal(fs.readFileSync(path.join(library.root, 'backups', moved[0], 'v3/d1/marker'), 'utf8'), 'pre-pull-library');

  // Pull attempt 2 (after restart): a fresh staged copy, then the swap again.
  const stagedRoot2 = path.join(library.root, 'backups/pull-2');
  const stagedState2 = path.join(stagedRoot2, 'state');
  stateDir(stagedState2, 'cloud-copy');
  const swap2 = commands.pullSteps({ stagedRoot: stagedRoot2, stagedState: stagedState2 }).find((step) => step.id === 'pull-swap');
  await swap2.run(makeCtx());

  const record = stateModule.readState(library.root);
  assert.equal(fs.readFileSync(path.join(live, 'v3/d1/marker'), 'utf8'), 'cloud-copy', 'the cloud copy is live');
  assert.ok(record.snapshot, 'the pre-pull library is still recorded as the snapshot; it is otherwise an orphaned directory nothing points at');
  assert.equal(record.snapshot.kind, 'backup');
  assert.match(record.snapshot.path, /^backups\/cloud-pull-/);
  assert.equal(fs.readFileSync(path.join(library.root, record.snapshot.path, 'v3/d1/marker'), 'utf8'), 'pre-pull-library');
});

test('a new setup run does not inherit an earlier run\'s abort scope', () => {
  const library = fakeLibrary();
  // A finished install that was detached: its record still says what that run created.
  stateModule.updateState(library.root, (state) => {
    state.cloud = { accountId: 'acct', url: PROVIDED, d1: { name: 'snip', id: 'live-d1' }, created: { d1: { name: 'snip', id: 'live-d1' }, bucket: 'snip-files' } };
    return state;
  });
  const next = stateModule.beginEnabling(library.root);
  assert.equal(next.cloud.created, undefined, 'abort of the new run must not delete the live library an earlier run created');
  assert.equal(next.cloud.d1.id, 'live-d1', 'the ids guard recognises are kept');
});
