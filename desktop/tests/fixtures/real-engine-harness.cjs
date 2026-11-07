#!/usr/bin/env node
'use strict';
// Runs the REAL provisioning engine against a fake Cloudflare, for the Settings
// smoke and for local demos. Nothing here touches Cloudflare or the network:
// `createContext` takes the API and wrangler clients by injection by design
// (desktop/provision/context.cjs), which is what the engine's own tests use.
//
// Point SNIP_CLOUD_ENGINE at this file. It accepts the same flags as cli.cjs and
// emits the same NDJSON, so Electron cannot tell the difference.
//
// The fake account persists in <dataRoot>/.harness/account.json, because Electron
// starts one process per command and the account must look stable across them.

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const argv = process.argv.slice(2);
const command = argv[0];
const subcommand = argv[1] && !argv[1].startsWith('--') ? argv[1] : null;

function flag(name) {
  const equals = argv.find((arg) => arg.startsWith(`--${name}=`));
  if (equals) return equals.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

const root = flag('root') ?? path.resolve(__dirname, '../../..');
const dataRoot = flag('data-root') ?? root;
const profile = process.env.SNIP_HARNESS_PROFILE ?? 'copy';
const empty = profile === 'empty';

const engine = require(path.join(root, 'desktop/provision/emit.cjs'));
const state = require(path.join(root, 'desktop/provision/state.cjs'));
const commands = require(path.join(root, 'desktop/provision/commands.cjs'));
const { createContext } = require(path.join(root, 'desktop/provision/context.cjs'));
const { NeedsInputError, StepError, ChoiceRequired } = require(path.join(root, 'desktop/provision/engine.cjs'));
// The Worker exposes this hash so the engine can detect a drift instead of guessing.
const { ownerSecretHash } = require(path.join(root, 'desktop/provision/transfer.cjs'));

const emit = engine.createEmitter({ json: true, command: command === 'snapshot' ? 'snapshot' : command });
const harnessDir = path.join(dataRoot, '.harness');
const accountFile = path.join(harnessDir, 'account.json');

const LIBRARY = empty
  ? { refs: 0, pages: 0, animations: 0, collections: 0, reference_collections: 0, page_collections: 0 }
  : { refs: 2, pages: 3, animations: 1, collections: 1, reference_collections: 2, page_collections: 1 };

const crypto = require('node:crypto');

/** Cloudflare returns UUIDs, and the engine's parser requires that shape. */
const uuid = () => crypto.randomUUID();

function readAccount() {
  try {
    return JSON.parse(fs.readFileSync(accountFile, 'utf8'));
  } catch {
    return {
      accountId: 'acct_harness_0001',
      subdomain: 'snip-harness',
      d1: [],
      kv: [],
      r2: [],
      secrets: {},
      secretNames: [],
      deployed: false,
      migrationsApplied: false,
      owner: false,
      objects: {},
      uploaded: [],
    };
  }
}
function writeAccount(account) {
  fs.mkdirSync(harnessDir, { recursive: true, mode: 0o700 });
  const temp = `${accountFile}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(account, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, accountFile);
}

const account = readAccount();
const cloudUrl = `https://snip.${account.subdomain}.workers.dev`;

// ---------- wrangler ----------
const wrangler = {
  bin: 'fake-wrangler',
  root,
  async run(args) {
    const line = args.join(' ');
    const json = (value) => ({ ok: true, code: 0, stdout: JSON.stringify(value), stderr: '', output: '' });
    const text = (value, ok = true) => ({ ok, code: ok ? 0 : 1, stdout: value, stderr: ok ? '' : value, output: value });
    if (args[0] === 'whoami') return json({ loggedIn: true, email: 'harness@example.com', accounts: [{ id: account.accountId, name: 'Harness Account' }] });
    if (line === 'd1 list --json') return json(account.d1.map((db) => ({ uuid: db.id, name: db.name, num_tables: db.tables || 0 })));
    if (args[0] === 'd1' && args[1] === 'create') {
      const db = { id: uuid(), name: args[2], tables: 0 };
      account.d1.push(db);
      writeAccount(account);
      return text(`database_id = "${db.id}"`);
    }
    if (line === 'kv namespace list') return json(account.kv.map((ns) => ({ id: ns.id, title: ns.title })));
    if (args[0] === 'kv' && args[1] === 'namespace' && args[2] === 'create') {
      const ns = { id: crypto.randomBytes(16).toString('hex'), title: args[3] };
      account.kv.push(ns);
      writeAccount(account);
      return text(`id = "${ns.id}"`);
    }
    if (line === 'r2 bucket list') return text(account.r2.map((bucket) => `name: ${bucket.name}`).join('\n'));
    if (args[0] === 'r2' && args[1] === 'bucket' && args[2] === 'create') {
      account.r2.push({ name: args[3] });
      writeAccount(account);
      return text(`Created bucket '${args[3]}'`);
    }
    if (args[0] === 'secret' && args[1] === 'list') return json(account.secretNames.map((name) => ({ name })));
    if (args[0] === 'secret' && args[1] === 'bulk') {
      const values = JSON.parse(fs.readFileSync(args[2], 'utf8'));
      Object.assign(account.secrets, values);
      account.secretNames = [...new Set([...account.secretNames, ...Object.keys(values)])];
      writeAccount(account);
      return text('Successfully uploaded secrets');
    }
    if (args[0] === 'secret' && args[1] === 'delete') {
      delete account.secrets[args[2]];
      account.secretNames = account.secretNames.filter((name) => name !== args[2]);
      writeAccount(account);
      return text(`Deleted secret ${args[2]}`);
    }
    if (args[0] === 'd1' && args[1] === 'migrations' && args[2] === 'apply') {
      account.migrationsApplied = true;
      writeAccount(account);
      return text('Applied migrations');
    }
    if (args[0] === 'd1' && args[1] === 'migrations' && args[2] === 'list') return text(account.migrationsApplied ? 'No migrations to apply!' : 'Migrations to be applied:\n0001_init.sql');
    if (args[0] === 'deploy') {
      account.deployed = true;
      writeAccount(account);
      return text('Uploaded snip (1.1 sec)');
    }
    if (args[0] === 'd1' && args[1] === 'export') {
      const output = args[args.indexOf('--output') + 1];
      const lines = [];
      for (const [table, rows] of Object.entries(LIBRARY)) {
        for (let index = 0; index < rows; index++) lines.push(`INSERT INTO "${table}" (id) VALUES ('${table}-${index}');`);
      }
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, `${lines.join('\n')}\n`);
      return text('Export complete');
    }
    if (args[0] === 'd1' && args[1] === 'execute') {
      const query = args[args.indexOf('--command') + 1] || '';
      if (/^\s*DELETE/i.test(query)) return json([{ success: true, results: [], meta: {} }]);
      const table = (query.match(/FROM\s+"?([A-Za-z0-9_]+)"?/i) || [])[1];
      return json([{ success: true, results: [{ rows: table ? LIBRARY[table] ?? 0 : 0 }], meta: {} }]);
    }
    if (args[0] === 'login') return text('Successfully logged in');
    return text(`harness has no wrangler for: ${line}`, false);
  },
  calls: [],
};

// ---------- Cloudflare REST ----------
const schemaTables = ['refs', 'pages', 'animations', 'collections', 'reference_collections', 'page_collections', 'd1_migrations', 'worker_presence'];
const api = {
  async memberships() {
    return [{ id: account.accountId, name: 'Harness Account' }];
  },
  async subdomain() {
    return account.subdomain;
  },
  async workerExists() {
    return Boolean(account.deployed);
  },
  async worker() {
    return account.deployed ? { id: 'snip' } : null;
  },
  async workerSettings() {
    return { bindings: [] };
  },
  async d1Query(_accountId, _databaseId, sql) {
    if (/sqlite_master/i.test(sql)) return (account.deployed ? schemaTables : []).map((name) => ({ name }));
    const table = (sql.match(/FROM\s+"?([A-Za-z0-9_]+)"?/i) || [])[1];
    return [{ rows: table ? LIBRARY[table] ?? 0 : 0 }];
  },
};

// ---------- the deployed Worker's /transfer and /agent surface ----------
const jsonResponse = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
async function fetchImpl(url, options = {}) {
  const target = new URL(String(url));
  const method = options.method || 'GET';
  const auth = String((options.headers && (options.headers.authorization || options.headers.Authorization)) || '').replace(/^Bearer\s+/i, '');
  if (target.origin !== new URL(cloudUrl).origin) throw new Error(`harness refuses host ${target.origin}`);
  // A GET: the engine proves the capture token functionally after writing secrets.
  if (`${method} ${target.pathname}` === 'GET /agent/ping') {
    const ok = Boolean(auth) && auth === account.secrets.CAPTURE_TOKEN;
    return jsonResponse(ok ? 200 : 401, { ok });
  }
  if (!account.secrets.TRANSFER_TOKEN || auth !== account.secrets.TRANSFER_TOKEN) return jsonResponse(404, { error: 'not found' });
  const counts = { refs: LIBRARY.refs, pages: LIBRARY.pages, animations: LIBRARY.animations, collections: LIBRARY.collections };
  if (`${method} ${target.pathname}` === 'GET /transfer/status') {
    return jsonResponse(200, { version: '1.1.2', hasOwner: account.owner, ownerId: account.owner ? 'harness' : null, counts, ownerSecretHash: ownerSecretHash(account.secrets.OWNER_LINK_SECRET || '') });
  }
  if (`${method} ${target.pathname}` === 'GET /transfer/manifest') {
    const keys = Object.entries(account.objects).map(([key, body]) => ({ key, size: Buffer.byteLength(body), contentType: 'image/png' }));
    return jsonResponse(200, { version: 1, tables: { ...LIBRARY }, keys, totalBytes: keys.reduce((sum, entry) => sum + entry.size, 0), version_: '1.1.2' });
  }
  if (`${method} ${target.pathname}` === 'POST /transfer/resume') {
    const body = JSON.parse(options.body || '{}');
    return jsonResponse(200, { resumed: (body.ids || []).length, skipped: 0 });
  }
  if (target.pathname.startsWith('/transfer/file/')) {
    const key = decodeURIComponent(target.pathname.slice('/transfer/file/'.length));
    if (method === 'HEAD') {
      const size = Buffer.byteLength(account.objects[key] ?? '');
      return new Response(null, { status: account.objects[key] !== undefined ? 200 : 404, headers: { 'content-length': String(size) } });
    }
    if (method === 'PUT') {
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
      } else if (body != null) chunks.push(Buffer.from(body));
      const buffer = Buffer.concat(chunks);
      if (account.objects[key] !== undefined && !target.searchParams.get('overwrite')) return jsonResponse(409, { error: 'exists' });
      account.objects[key] = buffer.toString('utf8');
      account.uploaded.push(key);
      writeAccount(account);
      return jsonResponse(200, { ok: true, size: buffer.length });
    }
    if (account.objects[key] === undefined) return jsonResponse(404, { error: 'not found' });
    return new Response(account.objects[key], { status: 200, headers: { 'content-type': 'image/png' } });
  }
  return jsonResponse(404, { error: 'not found' });
}

// The real local module does the file reading; only the "is a server listening"
// parts are faked, because the harness runs with no local Snip.
const realLocal = require(path.join(root, 'desktop/provision/local.cjs'));
const local = {
  ...realLocal,
  async reachable() {
    return false;
  },
  localOrigin() {
    return 'http://127.0.0.1:9';
  },
  createLocalApi() {
    return {
      async listReferences() {
        return [];
      },
      async pauseReference() {
        return { ok: false, status: 409 };
      },
      async agent() {
        return { activity: 'idle' };
      },
    };
  },
};

// Only the Worker start is replaced. Everything else — reading the library config,
// the persist dir, storage identities — is the real module, so preflight and export
// see the same files a real library has.
const realLibrary = require(path.join(root, 'desktop/provision/library.cjs'));
const libraryModule = {
  ...realLibrary,
  async withLocalWorker(_options, fn) {
    // A real library with references also has objects; the engine refuses a copy of
    // counts without files (EXPORT_EMPTY), so seed one screenshot per reference.
    if (LIBRARY.refs > 0 && Object.keys(account.objects).length === 0) {
      for (let index = 0; index < LIBRARY.refs; index++) {
        account.objects[`refs/harness${String(index).padStart(8, '0')}/attempt/desktop.png`] = `screenshot-${index}`;
      }
      writeAccount(account);
    }
    const manifest = {
      version: 1,
      tables: { ...LIBRARY },
      keys: Object.keys(account.objects).map((key) => ({ key, size: Buffer.byteLength(account.objects[key]), contentType: 'image/png' })),
      totalBytes: 0,
    };
    return fn({
      url: 'http://127.0.0.1:59999',
      transfer: {
        // The swap reads the directory it moved aside through this surface, so it
        // must answer like a Worker on a real library, not like an empty one.
        async status() {
          return { version: '1.1.2', hasOwner: true, ownerId: 'harness', counts: { refs: LIBRARY.refs, pages: LIBRARY.pages, animations: LIBRARY.animations, collections: LIBRARY.collections } };
        },
        async manifest() {
          return manifest;
        },
        async get(key) {
          const body = account.objects[key] ?? Buffer.alloc(4, 120).toString('utf8');
          return new Response(body, { status: 200, headers: { 'content-type': 'image/png' } });
        },
        async head(key) {
          return account.objects[key] === undefined ? null : Buffer.byteLength(account.objects[key]);
        },
        async put(key, body) {
          const chunks = [];
          if (body && typeof body.getReader === 'function') {
            const reader = body.getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              chunks.push(Buffer.from(value));
            }
          }
          account.objects[key] = Buffer.concat(chunks).toString('utf8');
          writeAccount(account);
          return { ok: true };
        },
      },
      async dispose() {},
    });
  },
};

function buildContext() {
  // The owner step's link opens in a browser and hands the session back to the
  // loopback listener the engine started. Nothing opens a browser here, so this
  // plays the browser's part: read the port out of the link, then POST the session
  // to /store exactly as the handoff page does.
  const baseEmit = emit;
  const wrapped = Object.assign(Object.create(baseEmit), baseEmit);
  wrapped.human = (step, action, url, message) => {
    if (step === 'owner') {
      account.owner = true;
      writeAccount(account);
      completeOwnerLink(url);
    }
    return baseEmit.human(step, action, url, message);
  };
  return createContext({
    root,
    dataRoot,
    flags: {
      root,
      'data-root': dataRoot,
      login: flag('login') ?? 'harness',
      domain: flag('domain') ?? account.subdomain,
      account: flag('account') ?? account.accountId,
      confirm: flag('confirm'),
      // The CLI stores the positional subcommand here; commands read it from flags.
      snapshotAction: subcommand ?? undefined,
      ownerAction: command === 'owner' ? subcommand ?? undefined : undefined,
      'capture-env': flag('capture-env') ?? 'keep',
      noOpen: true,
      managed: true,
      // The real flag parser maps `--no-handoff` to this; the harness builds its own
      // flags, so it has to read the argument too or `owner link` would open a loopback
      // for a link that is meant for another device (contracts v3.22 §1.4.2).
      noHandoff: argv.includes('--no-handoff'),
      adoptExisting: argv.includes('--adopt-existing'),
    },
    emit: wrapped,
    api,
    wrangler,
    deps: {
      fetch: fetchImpl,
      local,
      library: libraryModule,
      classify: (context) => require(path.join(root, 'desktop/provision/setup.cjs')).classifyAccount(context),
    },
  });
}

/** The browser half of the owner-link handoff: payload|ownerId|exp|nonce|port. */
function completeOwnerLink(link) {
  let port = 0;
  try {
    const token = new URL(link).searchParams.get('t') ?? '';
    const portField = token.split('.')[0].split('|')[4];
    port = Number(portField);
  } catch {}
  if (!Number.isInteger(port) || port <= 0) return;
  // The page reads location.hash and POSTs it; give the listener a moment to bind.
  setTimeout(() => {
    const body = JSON.stringify({ token: 'harness-session-token' });
    const request = http.request(
      { host: '127.0.0.1', port, path: '/store', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
      (response) => response.resume(),
    );
    request.on('error', () => {});
    request.end(body);
  }, 150);
}

async function main() {
  if (command === 'status') {
    emit.result({ ok: true, code: 'OK', mode: state.readState(dataRoot).mode, data: state.readState(dataRoot) });
    return;
  }
  const ctx = buildContext();
  try {
    let result;
    if (command === 'setup') result = await commands.commandSetup(ctx);
    else if (command === 'pull') result = await commands.commandPull(ctx);
    else if (command === 'detach') result = await commands.commandDetach(ctx);
    else if (command === 'snapshot') result = await commands.commandSnapshot(ctx);
    else if (command === 'delete-resources') result = await commands.commandDeleteResources(ctx);
    else if (command === 'abort') result = await commands.commandAbort(ctx);
    else if (command === 'owner') result = await commands.commandOwner(ctx);
    else if (command === 'deploy') result = await commands.commandDeploy(ctx);
    else if (command === 'migrate') result = await commands.commandMigrate(ctx);
    else throw new StepError('USAGE', `The harness does not run ${command}.`);
    const mode = state.readState(dataRoot).mode;
    emit.result({ ...(result || {}), ok: true, code: 'OK', mode });
  } catch (error) {
    const current = state.readState(dataRoot);
    if (error instanceof NeedsInputError || error.code === 'NEEDS_INPUT') {
      if (error instanceof ChoiceRequired) {
        emit.choice({ step: 'guard', ...error.choice, resumeWith: error.resumeWith });
      } else {
        emit.needsInput(error.keys ?? []);
      }
      emit.result({ ok: false, code: 'NEEDS_INPUT', mode: current.mode, data: error instanceof ChoiceRequired ? { choice: error.choice.id } : { needs: (error.keys ?? []).map((entry) => entry.key) } });
      process.exitCode = 2;
      return;
    }
    emit.log('error', error.message || String(error));
    if (process.env.SNIP_HARNESS_TRACE) emit.log('info', String(error.stack || '').slice(0, 1500));
    if (error.hint) emit.log('warn', error.hint);
    const code = error.code === 'LOCKED' ? 'LOCKED' : error.code === 'UNSUPPORTED' ? 'UNSUPPORTED' : 'FAILED';
    emit.result({ ok: false, code, mode: current.mode, data: { code: error.code, message: error.message, hint: error.hint, step: error.step } });
    process.exitCode = code === 'UNSUPPORTED' ? 4 : code === 'LOCKED' ? 3 : 1;
  }
}

main().catch((error) => {
  emit.log('error', error.message || String(error));
  emit.result({ ok: false, code: 'FAILED', mode: 'local' });
  process.exitCode = 1;
});
