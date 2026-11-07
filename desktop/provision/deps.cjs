'use strict';
// External dependencies the engine shells out to: wrangler and the Cloudflare
// REST API. Both are injected, so every test runs without a live call.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { StepError } = require('./engine.cjs');

const ANSI = /\x1b\[[0-9;]*m/g;

function stripAnsi(text) {
  return String(text || '').replace(ANSI, '');
}

/** Wrangler sometimes prints warnings before JSON; take the first complete JSON value. */
function parseJsonLoose(text) {
  const clean = stripAnsi(text).trim();
  if (!clean) return null;
  try { return JSON.parse(clean); } catch {}
  const starts = [clean.indexOf('['), clean.indexOf('{')].filter((index) => index >= 0);
  if (!starts.length) return null;
  const start = Math.min(...starts);
  const end = Math.max(clean.lastIndexOf(']'), clean.lastIndexOf('}'));
  if (end <= start) return null;
  try { return JSON.parse(clean.slice(start, end + 1)); } catch { return null; }
}

function wranglerBin(root) {
  const candidates = [
    path.join(root, 'node_modules/wrangler/bin/wrangler.js'),
    path.join(root, 'web/node_modules/wrangler/bin/wrangler.js'),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
}

const BASE_ENV = {
  CI: 'true',
  WRANGLER_SEND_METRICS: 'false',
  WRANGLER_WRITE_LOGS: 'false',
  NO_COLOR: '1',
  FORCE_COLOR: '0',
};

function mergeEnv(base, extra = {}) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  return merged;
}

/**
 * A wrangler runner. `spawnImpl` mirrors node:child_process.spawn enough to be
 * faked in tests. Resolves to { ok, code, stdout, stderr, timedOut }.
 */
function createWrangler({ root, nodePath = process.execPath, env = {}, spawnImpl = spawn, timeoutMs = 15 * 60 * 1000 } = {}) {
  const bin = wranglerBin(root);

  async function run(args, options = {}) {
    if (!bin) {
      throw new StepError('NO_WRANGLER', 'Wrangler is not installed in this build.', {
        hint: 'A source checkout needs `npm ci`; a released app should ship wrangler in its runtime.',
      });
    }
    const child = spawnImpl(nodePath, [bin, ...args], {
      cwd: options.cwd || root,
      env: mergeEnv({ ...process.env, ...BASE_ENV, ...env }, options.env),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const limit = options.timeoutMs || timeoutMs;
    const timer = limit ? setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch {} }, limit) : null;
    if (timer && typeof timer.unref === 'function') timer.unref();
    if (child.stdout) child.stdout.on('data', (chunk) => {
      const text = String(chunk);
      stdout += text;
      if (options.onStdout) options.onStdout(text);
    });
    if (child.stderr) child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      stderr += text;
      if (options.onStderr) options.onStderr(text);
    });
    if (options.input !== undefined && child.stdin) {
      child.stdin.end(options.input);
    } else if (child.stdin) {
      child.stdin.end();
    }
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode, signal) => resolve(exitCode === null ? (signal ? 1 : 0) : exitCode));
    }).finally(() => { if (timer) clearTimeout(timer); });
    return { ok: code === 0 && !timedOut, code, stdout, stderr, timedOut, output: `${stdout}${stderr}` };
  }

  return { bin, run, root };
}

/** Where wrangler keeps its OAuth session on this platform. */
function wranglerConfigDir(platform = process.platform, env = process.env) {
  if (env.WRANGLER_CONFIG_DIR) return env.WRANGLER_CONFIG_DIR;
  if (platform === 'darwin') return path.join(os.homedir(), 'Library/Preferences/.wrangler/config');
  if (platform === 'win32') return path.join(env.APPDATA || path.join(os.homedir(), 'AppData/Roaming'), '.wrangler/config');
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), '.wrangler/config');
}

function readTomlValue(text, key) {
  const match = String(text).match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm'));
  return match ? match[1] : null;
}

/**
 * The token wrangler already holds. Prefers CLOUDFLARE_API_TOKEN; otherwise the
 * OAuth token wrangler writes after `wrangler whoami`/`login`. Never logged.
 */
function readWranglerToken({ env = process.env, platform = process.platform, configDir } = {}) {
  if (env.CLOUDFLARE_API_TOKEN) return { token: env.CLOUDFLARE_API_TOKEN, source: 'env', expiresAt: null };
  const dir = configDir || wranglerConfigDir(platform, env);
  const file = path.join(dir, `${env.CLOUDFLARE_PROFILE || 'default'}.toml`);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new StepError('AUTH_TOKEN_MISSING', 'No Cloudflare sign-in was found.', {
      hint: 'Run `npx wrangler login` (or set CLOUDFLARE_API_TOKEN), then try again.',
    });
  }
  const token = readTomlValue(text, 'oauth_token');
  if (!token) {
    throw new StepError('AUTH_TOKEN_MISSING', 'No Cloudflare sign-in was found.', {
      hint: 'Run `npx wrangler login` (or set CLOUDFLARE_API_TOKEN), then try again.',
    });
  }
  const expiresAt = readTomlValue(text, 'expiration_time');
  if (expiresAt && Number.isFinite(Date.parse(expiresAt)) && Date.parse(expiresAt) < Date.now() + 30_000) {
    throw new StepError('AUTH_TOKEN_EXPIRED', 'Your Cloudflare sign-in has expired.', {
      hint: 'Run `npx wrangler whoami` to refresh it, then try again.',
    });
  }
  return { token, source: 'wrangler', expiresAt };
}

class ApiError extends StepError {
  constructor(code, message, { status = null, hint = null, data = null } = {}) {
    super(code, message, { hint, data });
    this.status = status;
  }
}

/**
 * Minimal Cloudflare API client. Only the endpoints provisioning needs, all
 * read-only, so a fake fetch covers every test.
 */
function createApi({ fetchImpl = fetch, token = readWranglerToken, base = 'https://api.cloudflare.com/client/v4', timeoutMs = 30_000 } = {}) {
  async function request(pathname, options = {}) {
    let tokenValue;
    try {
      tokenValue = typeof token === 'function' ? token().token : token;
    } catch (error) {
      throw error;
    }
    let response;
    try {
      response = await fetchImpl(`${base}${pathname}`, {
        method: options.method || 'GET',
        headers: {
          authorization: `Bearer ${tokenValue}`,
          'content-type': 'application/json',
          ...(options.headers || {}),
        },
        body: options.body,
        signal: AbortSignal.timeout(options.timeoutMs || timeoutMs),
      });
    } catch (error) {
      throw new ApiError('NETWORK', 'Could not reach Cloudflare.', { hint: 'Check this Mac’s internet connection, then try again.', data: { cause: error.message } });
    }
    let body = null;
    const text = await response.text();
    if (text) {
      try { body = JSON.parse(text); } catch { body = null; }
    }
    return { status: response.status, ok: response.ok, body };
  }

  async function memberships() {
    const result = await request('/memberships?per_page=50');
    if (result.status === 401 || result.status === 403) {
      throw new ApiError('AUTH_TOKEN_EXPIRED', 'Cloudflare rejected the saved sign-in.', {
        status: result.status,
        hint: 'Run `npx wrangler login` again, then retry.',
      });
    }
    if (!result.ok) throw new ApiError('CLOUDFLARE_API', `Cloudflare returned ${result.status} while listing accounts.`, { status: result.status });
    const memberships = (result.body && result.body.result) || [];
    return memberships
      .filter((entry) => entry && entry.account && (!entry.status || entry.status === 'accepted'))
      .map((entry) => ({ id: entry.account.id, name: entry.account.name }));
  }

  async function subdomain(accountId) {
    const result = await request(`/accounts/${encodeURIComponent(accountId)}/workers/subdomain`);
    if (result.status === 404) return null;
    if (!result.ok) throw new ApiError('CLOUDFLARE_API', `Cloudflare returned ${result.status} while reading the workers.dev subdomain.`, { status: result.status });
    const value = result.body && result.body.result && result.body.result.subdomain;
    return typeof value === 'string' && value ? value : null;
  }

  /** true / false, or throws. Reads the script list entry for `name`. */
  async function workerExists(accountId, name) {
    const result = await request(`/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(name)}`);
    if (result.status === 200) return true;
    if (result.status === 404) return false;
    throw new ApiError('CLOUDFLARE_API', `Cloudflare returned ${result.status} while checking for the Worker.`, { status: result.status });
  }

  /** Raw script metadata, or null when absent. */
  async function worker(accountId, name) {
    const result = await request(`/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(name)}`);
    if (result.status === 404) return null;
    if (!result.ok) throw new ApiError('CLOUDFLARE_API', `Cloudflare returned ${result.status} while checking for the Worker.`, { status: result.status });
    return result.body && result.body.result;
  }

  /** A Worker's script settings, including its bindings. */
  async function workerSettings(accountId, name) {
    const result = await request(`/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(name)}/settings`);
    if (result.status === 404) return { bindings: [] };
    if (!result.ok) throw new ApiError('CLOUDFLARE_API', `Cloudflare returned ${result.status} while reading the Worker bindings.`, { status: result.status });
    const value = (result.body && result.body.result) || {};
    return { bindings: Array.isArray(value.bindings) ? value.bindings : [] };
  }

  /** Run one read-only SQL statement against a D1 database. */
  async function d1Query(accountId, databaseId, sql) {
    const result = await request(`/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`, {
      method: 'POST',
      body: JSON.stringify({ sql }),
    });
    if (result.status === 404) throw new ApiError('D1_NOT_FOUND', 'That database does not exist in this account.', { status: 404, retryable: false });
    if (!result.ok) throw new ApiError('CLOUDFLARE_API', `Cloudflare returned ${result.status} while reading the database.`, { status: result.status });
    const first = Array.isArray(result.body && result.body.result) ? result.body.result[0] : null;
    return (first && (first.results || [])) || [];
  }

  return { d1Query, memberships, request, subdomain, worker, workerExists, workerSettings };
}

module.exports = {
  ApiError,
  createApi,
  createWrangler,
  mergeEnv,
  parseJsonLoose,
  readTomlValue,
  readWranglerToken,
  stripAnsi,
  wranglerBin,
  wranglerConfigDir,
};
