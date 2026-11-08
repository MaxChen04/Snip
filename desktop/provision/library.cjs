'use strict';
// One helper for local library data, used by export and by pull.
//
// The engine never parses Miniflare's on-disk layout and never uses
// getPlatformProxy for library data: that resolves a different layout and can
// report an empty library on a directory that holds data, which would make an
// empty copy look "verified". Instead a short-lived Worker is started with the
// app's own wrangler and the app's exact persist path, and every object is read
// through the real FILES binding via /transfer/*.

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { StepError } = require('./engine.cjs');
const { createTransfer } = require('./transfer.cjs');
const { randomSecret } = require('./lib.cjs');
const local = require('./local.cjs');

// The fields that decide which local database, bucket and namespace a library
// is. `local-server.cjs` overlays exactly these onto the runtime config so the
// app always opens the same storage, and the engine must resolve them the same
// way: the built bundle only carries placeholders, and a config edited after
// first launch would otherwise send the engine to a different, empty database.
const IDENTITY_FIELDS = {
  d1_databases: ['binding', 'database_name', 'database_id', 'preview_database_id', 'migrations_table'],
  r2_buckets: ['binding', 'bucket_name', 'preview_bucket_name', 'jurisdiction'],
  kv_namespaces: ['binding', 'id', 'preview_id'],
};

function identityError(message) {
  return new StepError('STORAGE_IDENTITY', 'Snip could not tell which local database and files belong to this library.', {
    hint: message || 'Restore this library’s original web/wrangler.jsonc or its storage identity record, then try again.',
  });
}

/** Same selection as `local-server.cjs`: one entry per binding, by binding name. */
function selectIdentities(config, runtimeConfig) {
  const result = {};
  for (const [type, fields] of Object.entries(IDENTITY_FIELDS)) {
    const required = runtimeConfig[type] || [];
    const entries = config[type];
    if (!Array.isArray(required) || !Array.isArray(entries)) throw identityError();
    result[type] = required.map((target) => {
      if (!target || typeof target.binding !== 'string') throw identityError();
      const matches = entries.filter((entry) => entry && entry.binding === target.binding);
      if (matches.length !== 1) throw identityError();
      const item = matches[0];
      if (item.remote === true || target.remote === true) {
        throw identityError('This project uses remote Cloudflare storage, so its library cannot be read from this Mac.');
      }
      const selected = {};
      for (const key of fields) {
        if (item[key] === undefined) continue;
        if (typeof item[key] !== 'string' || !item[key].trim()) throw identityError();
        selected[key] = item[key];
      }
      return selected;
    });
  }
  return result;
}

function libraryVars(config) {
  const vars = {};
  for (const key of ['ALLOWED_GITHUB_LOGINS', 'PUBLIC_URL', 'DEV_LOGIN']) {
    const value = config.vars && config.vars[key];
    if (typeof value === 'string') vars[key] = value;
  }
  return vars;
}

/**
 * The storage identity this library actually uses. `local-server.cjs` snapshots
 * it to `.snip/storage-identities.json` on first launch and overlays it onto the
 * runtime config, so the app keeps opening the same database when the config on
 * disk changes. The engine resolves it the same way: reading a config that no
 * longer names the library's storage returns an empty database, and an empty
 * read is the failure mode that makes a broken copy look verified.
 */
function storageIdentity(dataRoot, readConfig, runtimeConfig = null) {
  const saved = path.join(dataRoot, '.snip/storage-identities.json');
  let text = null;
  try {
    text = fs.readFileSync(saved, 'utf8');
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw identityError();
  }
  if (text !== null) {
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw identityError(); }
    if (!parsed || parsed.version !== 1) throw identityError();
    return { identities: selectIdentities(parsed, runtimeConfig || parsed), vars: libraryVars(parsed), source: saved };
  }
  const config = local.localConfig(dataRoot);
  if (!config) return null;
  const parsed = readConfig({ config });
  return { identities: selectIdentities(parsed, runtimeConfig || parsed), vars: libraryVars(parsed), source: config };
}

/** Overlay a library's storage identity onto the config the Worker will run with. */
function withLibraryIdentity(config, dataRoot, readConfig) {
  const identity = storageIdentity(dataRoot, readConfig, config);
  if (!identity) return config;
  for (const [type, entries] of Object.entries(identity.identities)) {
    const byBinding = new Map(entries.map((item) => [item.binding, item]));
    config[type] = (config[type] || []).map((item) => {
      const updated = { ...item };
      for (const field of IDENTITY_FIELDS[type]) delete updated[field];
      return { ...updated, ...byBinding.get(item.binding) };
    });
  }
  config.vars = { ...(config.vars || {}), ...identity.vars };
  return config;
}

/**
 * The config `wrangler d1` commands should use. They take a path, not a config
 * object, so when the app's snapshot is the authority the resolved identity is
 * written to a private derived file; otherwise the config on disk already names
 * this library and is returned unchanged. `.snip/` holds engine state, never
 * user data, so writing here changes nothing the user can see.
 */
function libraryConfig({ root, dataRoot }) {
  const raw = local.localConfig(dataRoot);
  let saved = null;
  try {
    saved = JSON.parse(fs.readFileSync(path.join(dataRoot, '.snip/storage-identities.json'), 'utf8'));
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw identityError();
    // Not started through the app yet: the config on disk is the identity.
    return raw;
  }
  if (!saved || saved.version !== 1) throw identityError();
  const identity = selectIdentities(saved, saved);
  const databases = (identity.d1_databases || []).map((entry) => ({ ...entry, migrations_dir: path.join(root, 'web/migrations') }));
  const config = {
    name: 'snip-local',
    compatibility_date: '2026-10-01',
    d1_databases: databases,
    r2_buckets: identity.r2_buckets || [],
    kv_namespaces: identity.kv_namespaces || [],
    vars: libraryVars(saved),
  };
  const directory = path.join(dataRoot, '.snip');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, 'wrangler-library.json');
  const temporary = `${target}.${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
  return target;
}

function freePort() {
  const net = require('node:net');
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const persistDir = (dataRoot) => path.join(dataRoot, 'web/.wrangler/state');

function wranglerFromRoot(root) {
  const localRequire = createRequire(path.join(root, 'package.json'));
  try {
    return localRequire('wrangler');
  } catch {
    throw new StepError('NO_WRANGLER', 'Wrangler is not installed in this build.', {
      hint: 'A source checkout needs `npm ci`; a released app should include its runtime.',
    });
  }
}

function workerConfigPath(root, dataRoot) {
  const built = path.join(root, 'web/dist/snip/wrangler.json');
  if (fs.existsSync(built)) return built;
  const local = path.join(dataRoot, 'web/wrangler.local.jsonc');
  if (fs.existsSync(local)) return local;
  const tracked = path.join(dataRoot, 'web/wrangler.jsonc');
  return fs.existsSync(tracked) ? tracked : built;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate, { timeoutMs = 30_000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await sleep(intervalMs);
  }
  throw last || new Error('Timed out.');
}

/**
 * Start a temporary Worker on the library's persist dir and return a handle with
 * a transfer client, the manifest and a dispose(). `token` is only ever an
 * in-memory var on this Worker; it is never written to .dev.vars.
 */
async function localWorker({ root, dataRoot, token, release = false, log = () => {}, retries = 3, retryDelayMs = 500, wrangler = null, persist = null, ownerLinkSecret = null } = {}) {
  if (!token) throw new Error('localWorker requires a token.');
  const api = wrangler || wranglerFromRoot(root);
  const configPath = workerConfigPath(root, dataRoot);
  if (!fs.existsSync(configPath)) {
    throw new StepError('NO_BUILD', 'This Snip build has no Worker bundle to read the library with.', {
      hint: 'Rebuild the web app, or reinstall Snip.',
    });
  }
  if (release) {
    // Keep every cache outside the signed, read-only bundle.
    process.env.MINIFLARE_CACHE_DIR = path.join(dataRoot, '.cache/miniflare');
    process.env.WRANGLER_CACHE_DIR = path.join(dataRoot, '.cache/wrangler');
  }

  // A probed port, not 0: PUBLIC_URL must name the origin this Worker serves,
  // and the OAuth provider rejects a placeholder host.
  const port = await freePort();
  let worker = null;
  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const config = api.unstable_readConfig({ config: configPath });
      // Same storage the app itself opens, even if the config on disk changed
      // after first launch. Without this the Worker can read an empty database
      // and report an empty library that then passes every count check.
      withLibraryIdentity(config, dataRoot, api.unstable_readConfig);
      // The transfer surface needs its bearer and an owner hash, and PUBLIC_URL
      // must be a canonical lowercase origin (the built config still holds the
      // placeholder). All of it is in memory on a Worker that lives for seconds.
      config.vars = {
        ...(config.vars || {}),
        PUBLIC_URL: `http://127.0.0.1:${port}`,
        TRANSFER_TOKEN: token,
        OWNER_LINK_SECRET: ownerLinkSecret || randomSecret(),
      };
      // startWorker resolves a relative `main`/`assets.directory` from the
      // process cwd, not from the config file, so make both absolute here.
      if (config.assets && config.assets.directory && !path.isAbsolute(config.assets.directory)) {
        config.assets = { ...config.assets, directory: path.resolve(path.dirname(configPath), config.assets.directory) };
      }
      if (config.main && !path.isAbsolute(config.main)) config.main = path.resolve(path.dirname(configPath), config.main);
      // No .dev.vars: /transfer/* needs no DEV_LOGIN, and reading the app's live
      // configuration would couple this Worker to it.
      config.userConfigPath = null;
      worker = await api.unstable_startWorker({
        config,
        dev: {
          remote: false,
          watch: false,
          inspector: false,
          logLevel: 'warn',
          server: { hostname: '127.0.0.1', port },
          persist: persist || persistDir(dataRoot),
        },
      });
      const url = (await worker.url).origin;
      const transfer = createTransfer({ url, token });
      // Readiness is "the Worker answers at all". A 500 means the Worker is up
      // but this library has no schema yet; the caller decides what that means.
      await waitUntil(async () => {
        const response = await fetch(`${url}/transfer/status`, {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(3000),
        });
        return response.status > 0;
      }, { timeoutMs: 30_000 });
      // The manifest is what every caller actually reads, so prove it works here
      // rather than failing halfway through a copy.
      await transfer.manifest();
      log(`Library opened on ${url}`);
      let disposed = false;
      const dispose = async () => {
        if (disposed) return;
        disposed = true;
        try { await worker.dispose(); } catch {}
      };
      return { url, transfer, dispose, worker, configPath };
    } catch (error) {
      lastError = error;
      if (worker) {
        try { await worker.dispose(); } catch {}
        worker = null;
      }
      if (attempt < retries) await sleep(retryDelayMs);
    }
  }
  const locked = /lock|EBUSY|SQLITE_BUSY|already open/i.test(`${lastError && (lastError.code || '')} ${lastError && lastError.message}`);
  throw new StepError(locked ? 'EXPORT_LOCKED' : 'LOCAL_WORKER_FAILED', locked
    ? 'Another Snip process still has this library open.'
    : 'The library could not be opened for copying.', {
    hint: 'Quit Snip (or stop `npm run dev`), then run the same command again. Completed steps are skipped.',
    data: { cause: lastError ? lastError.message : null },
  });
}

async function withLocalWorker(options, fn) {
  const handle = await localWorker(options);
  try {
    return await fn(handle);
  } finally {
    await handle.dispose();
  }
}

module.exports = { freePort, libraryConfig, libraryVars, localWorker, persistDir, selectIdentities, storageIdentity, withLibraryIdentity, workerConfigPath, withLocalWorker, wranglerFromRoot };
