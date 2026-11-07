'use strict';
// Cloudflare resources: find-or-create for D1, KV and R2, the worker/subdomain
// reads the guard needs, and the secret commands. Every mutation is explicit and
// only ever touches the three resources Snip owns.

const fs = require('node:fs');
const path = require('node:path');
const { StepError } = require('./engine.cjs');
const { parseJsonLoose } = require('./deps.cjs');
const { BUCKET_NAME, D1_NAME, KV_NAME, WORKER_NAME, parseCreatedId } = require('./lib.cjs');
const { classifyWranglerFailure, runTransient, transientError } = require('./deploy.cjs');

function wranglerFailure(result, code, message, hint) {
  const known = classifyWranglerFailure(result);
  return known || new StepError(code, message, { hint, data: { output: `${result.stderr || ''}${result.stdout || ''}`.trim().slice(-800) } });
}

async function listD1(wrangler, { accountId }) {
  const result = await wrangler.run(['d1', 'list', '--json'], { env: { CLOUDFLARE_ACCOUNT_ID: accountId } });
  if (!result.ok) throw wranglerFailure(result, 'D1_LIST_FAILED', 'Could not list D1 databases.', 'Check the Cloudflare sign-in, then try again.');
  const parsed = parseJsonLoose(result.stdout);
  if (!Array.isArray(parsed)) throw new StepError('D1_LIST_FAILED', 'Cloudflare returned an unexpected D1 list.', { hint: 'Update Snip, then try again.' });
  return parsed.map((entry) => ({ id: entry.uuid || entry.id, name: entry.name, tables: Number(entry.num_tables) || 0 }));
}

async function createD1(wrangler, { accountId }) {
  const result = await wrangler.run(['d1', 'create', D1_NAME], { env: { CLOUDFLARE_ACCOUNT_ID: accountId } });
  const id = parseCreatedId(`${result.stdout}${result.stderr}`, 'database_id');
  if (!result.ok || !id) throw wranglerFailure(result, 'D1_CREATE_FAILED', 'Could not create the Snip database.', 'Check the Cloudflare sign-in, then try again.');
  return { id, name: D1_NAME };
}

async function listKv(wrangler, { accountId }) {
  // This wrangler version's `kv namespace list` has no --json flag; it prints a
  // JSON array after its preamble either way.
  const result = await wrangler.run(['kv', 'namespace', 'list'], { env: { CLOUDFLARE_ACCOUNT_ID: accountId } });
  if (!result.ok) throw wranglerFailure(result, 'KV_LIST_FAILED', 'Could not list KV namespaces.', 'Check the Cloudflare sign-in, then try again.');
  const parsed = parseJsonLoose(result.stdout);
  if (!Array.isArray(parsed)) throw new StepError('KV_LIST_FAILED', 'Cloudflare returned an unexpected KV list.', { hint: 'Update Snip, then try again.' });
  return parsed.map((entry) => ({ id: entry.id, title: entry.title || entry.name }));
}

async function createKv(wrangler, { accountId }) {
  const result = await wrangler.run(['kv', 'namespace', 'create', KV_NAME], { env: { CLOUDFLARE_ACCOUNT_ID: accountId } });
  const id = parseCreatedId(`${result.stdout}${result.stderr}`, 'id');
  if (!result.ok || !id) throw wranglerFailure(result, 'KV_CREATE_FAILED', 'Could not create the Snip KV namespace.', 'Check the Cloudflare sign-in, then try again.');
  return { id, name: KV_NAME };
}

/** R2 must be enabled by the account owner once; this reports that state distinctly. */
async function listBuckets(wrangler, { accountId }) {
  const result = await wrangler.run(['r2', 'bucket', 'list'], { env: { CLOUDFLARE_ACCOUNT_ID: accountId } });
  const text = `${result.stdout}${result.stderr}`;
  if (!result.ok) {
    if (/enable r2|r2.*not enabled|must be enabled|10042|no subscription/i.test(text)) {
      throw new StepError('R2_NOT_ENABLED', 'R2 is turned off on this Cloudflare account.', {
        hint: 'Enable R2 once in the Cloudflare dashboard (R2 → Get started), then come back. It is a one-time card check.',
      });
    }
    throw wranglerFailure(result, 'R2_LIST_FAILED', 'Could not list R2 buckets.', 'Check the Cloudflare sign-in, then try again.');
  }
  const parsed = parseJsonLoose(result.stdout);
  if (Array.isArray(parsed)) return parsed.map((entry) => (typeof entry === 'string' ? { name: entry } : { name: entry.name || entry.bucket_name }));
  const names = [...text.matchAll(/^\s*name:\s*(\S+)/gm)].map((match) => ({ name: match[1] }));
  if (names.length) return names;
  if (/\bsnip-files\b/.test(text)) return [{ name: BUCKET_NAME }];
  return [];
}

async function createBucket(wrangler, { accountId }) {
  const result = await wrangler.run(['r2', 'bucket', 'create', BUCKET_NAME], { env: { CLOUDFLARE_ACCOUNT_ID: accountId } });
  const text = `${result.stdout}${result.stderr}`;
  if (!result.ok && !/already exists|already owned by you/i.test(text)) {
    throw wranglerFailure(result, 'R2_CREATE_FAILED', 'Could not create the Snip storage bucket.', 'Enable R2 in the Cloudflare dashboard, then try again.');
  }
  return { name: BUCKET_NAME };
}

async function whoami(wrangler) {
  const result = await wrangler.run(['whoami', '--json'], { timeoutMs: 60_000 });
  if (!result.ok) return { loggedIn: false, accounts: [], email: null };
  const parsed = parseJsonLoose(result.stdout);
  if (!parsed || typeof parsed !== 'object') return { loggedIn: false, accounts: [], email: null };
  return {
    loggedIn: parsed.loggedIn !== false && Boolean(parsed.email || (parsed.accounts || []).length),
    accounts: (parsed.accounts || []).map((entry) => ({ id: entry.id, name: entry.name })),
    email: parsed.email || null,
  };
}

async function login(wrangler, { onOutput } = {}) {
  // The parent opens the browser when it owns the process; the CLI passes
  // --browser so the URL is printed and any browser can complete it.
  const result = await wrangler.run(['login', '--browser=false', '--callback-port', '8976'], { onStdout: onOutput, onStderr: onOutput, timeoutMs: 10 * 60_000 });
  if (!result.ok) {
    throw new StepError('AUTH_FAILED', 'Cloudflare sign-in did not finish.', {
      hint: 'Run `npx wrangler login` in a terminal, then run setup again.',
      data: { output: `${result.stdout}${result.stderr}`.trim().slice(-500) },
    });
  }
  return result;
}

async function listSecrets(wrangler, { dataRoot, accountId }) {
  const { configPath } = require('./deploy.cjs');
  const file = configPath(dataRoot);
  const result = await wrangler.run(['secret', 'list', '--config', file, '--format', 'json'], { cwd: path.dirname(file), env: { CLOUDFLARE_ACCOUNT_ID: accountId } });
  if (!result.ok) {
    // The Worker may not exist yet; that is not a failure at this point.
    if (/not found|does not exist|10007/i.test(`${result.stdout}${result.stderr}`)) return [];
    throw wranglerFailure(result, 'SECRET_LIST_FAILED', 'Could not read the Worker secrets.', 'Check the Cloudflare sign-in, then try again.');
  }
  const parsed = parseJsonLoose(result.stdout);
  if (!Array.isArray(parsed)) return [];
  return parsed.map((entry) => (typeof entry === 'string' ? entry : entry.name)).filter(Boolean);
}

/** Put several secrets in one request, from a 0600 temp file that is always removed. */
async function putSecrets(wrangler, { dataRoot, accountId, secrets, retry }) {
  const names = Object.keys(secrets);
  if (!names.length) return { names: [] };
  const { configPath } = require('./deploy.cjs');
  const dir = path.dirname(configPath(dataRoot));
  const temp = path.join(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'snip-secrets-')), 'secrets.json');
  try {
    fs.writeFileSync(temp, JSON.stringify(secrets), { mode: 0o600 });
    // Writing the same secret twice is harmless, so a transient failure is retried.
    const result = await runTransient(wrangler, ['secret', 'bulk', temp, '--config', configPath(dataRoot)], { cwd: dir, env: { CLOUDFLARE_ACCOUNT_ID: accountId } }, retry);
    if (!result.ok) {
      if (result.transient) throw transientError(result, 'wrangler secret bulk exited non-zero');
      throw wranglerFailure(result, 'SECRET_PUT_FAILED', 'Could not save the Worker secrets.', 'Check the Cloudflare sign-in, then try again.');
    }
  } finally {
    fs.rmSync(path.dirname(temp), { recursive: true, force: true });
  }
  // The names are public; the values never leave this function.
  return { names };
}

async function deleteSecret(wrangler, { dataRoot, accountId, name }) {
  const { configPath } = require('./deploy.cjs');
  const result = await wrangler.run(['secret', 'delete', name, '--config', configPath(dataRoot)], {
    cwd: path.dirname(configPath(dataRoot)),
    env: { CLOUDFLARE_ACCOUNT_ID: accountId },
  });
  if (!result.ok && !/not found|does not exist|10007/i.test(`${result.stdout}${result.stderr}`)) {
    throw wranglerFailure(result, 'SECRET_DELETE_FAILED', `Could not delete the ${name} secret.`, 'Run the same command again to finish.');
  }
  return { name };
}

module.exports = {
  createBucket,
  createD1,
  createKv,
  deleteSecret,
  listBuckets,
  listD1,
  listKv,
  listSecrets,
  login,
  putSecrets,
  whoami,
  workerName: WORKER_NAME,
};
