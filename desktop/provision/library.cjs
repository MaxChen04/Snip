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

module.exports = { freePort, localWorker, persistDir, workerConfigPath, withLocalWorker, wranglerFromRoot };
