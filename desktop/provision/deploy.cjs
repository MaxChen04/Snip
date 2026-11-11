'use strict';
// The deploy layout (contracts §5.1) and the wrangler commands that act on it.
// Nothing is ever written into the runtime: the built Worker, client assets and
// migrations are copied into <dataRoot>/cloud on every deploy so a new bundle is
// never shadowed by a stale copy.

const fs = require('node:fs');
const path = require('node:path');
const { StepError } = require('./engine.cjs');
const { patchDeployConfig, readRatelimits, readTriggers, BUCKET_NAME } = require('./lib.cjs');

const cloudDir = (dataRoot) => path.join(dataRoot, 'cloud');
const configPath = (dataRoot) => path.join(cloudDir(dataRoot), 'snip/wrangler.json');
/** The config the local app opens its own library with (never the cloud one). */
function localConfigPath(dataRoot) {
  const local = path.join(dataRoot, 'web/wrangler.local.jsonc');
  if (fs.existsSync(local)) return local;
  return path.join(dataRoot, 'web/wrangler.jsonc');
}

function runtimeSources(root) {
  return {
    snip: path.join(root, 'web/dist/snip'),
    client: path.join(root, 'web/dist/client'),
    migrations: path.join(root, 'web/migrations'),
  };
}

function existsDir(target) {
  try { return fs.statSync(target).isDirectory(); } catch { return false; }
}

/** Which of the three runtime inputs are present. */
function inspectRuntime(root) {
  const sources = runtimeSources(root);
  return {
    ...sources,
    snip: existsDir(sources.snip),
    client: existsDir(sources.client),
    migrations: existsDir(sources.migrations),
  };
}

/** Release builds pass the runtime; a source checkout passes the repo root. */
function runtimeProblem(root) {
  const found = inspectRuntime(root);
  const missing = [];
  if (!found.snip) missing.push('web/dist/snip');
  if (!found.client) missing.push('web/dist/client');
  if (!found.migrations) missing.push('web/migrations');
  if (!missing.length) return null;
  return { missing, message: `This Snip build is missing ${missing.join(', ')}.`, hint: 'A source build needs `npm run build -w web`; reinstall the app for a release build.' };
}

function replaceDir(from, to) {
  // Overwrite, never merge: a stale file from an older bundle must not survive.
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
  fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
}

/**
 * Copy the prebuilt bundle into the library and write the patched config.
 * Returns { dir, config, copied }.
 */
function prepareDeployLayout({ root, dataRoot, d1Id, kvId, login, url, now = new Date() }) {
  const sources = runtimeSources(root);
  for (const [key, dir] of Object.entries(sources)) {
    if (!existsDir(dir)) throw new StepError('NO_BUILD', `This Snip build is missing ${path.relative(root, dir)}.`, { hint: 'Rebuild the web app, or reinstall Snip.' });
  }
  const cloud = cloudDir(dataRoot);
  fs.mkdirSync(cloud, { recursive: true, mode: 0o700 });
  replaceDir(sources.snip, path.join(cloud, 'snip'));
  replaceDir(sources.client, path.join(cloud, 'client'));
  replaceDir(sources.migrations, path.join(cloud, 'migrations'));

  const file = configPath(dataRoot);
  let built;
  try {
    built = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new StepError('BAD_CONFIG', 'The built Worker config could not be read.', { hint: 'Reinstall Snip; the bundled build is incomplete.', data: { cause: error.message } });
  }
  let template = '';
  try { template = fs.readFileSync(path.join(root, 'web/wrangler.jsonc'), 'utf8'); } catch { /* no template in this build */ }
  const patched = patchDeployConfig(built, { d1Id, kvId, login, url, migrations: '../migrations', ratelimits: readRatelimits(template), triggers: readTriggers(template) });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(patched, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
  return { dir: cloud, file, config: patched, copiedAt: now.toISOString() };
}

/** Read the patched config back, for status and for deploy/migrate commands. */
function readDeployConfig(dataRoot) {
  try {
    return JSON.parse(fs.readFileSync(configPath(dataRoot), 'utf8'));
  } catch {
    return null;
  }
}

function configExists(dataRoot) {
  try { return fs.statSync(configPath(dataRoot)).isFile(); } catch { return false; }
}

// ---------- wrangler commands ----------

function failureMessage(result, fallback) {
  const text = `${result.stderr || ''}\n${result.stdout || ''}`;
  const meaningful = text.split('\n').map((line) => line.trim()).filter((line) => line && !/^\s*$/.test(line)).slice(-6).join('\n');
  return meaningful || fallback;
}

function classifyWranglerFailure(result, { authHint = true } = {}) {
  const text = `${result.stdout || ''}${result.stderr || ''}`;
  if (/not authenticated|not logged in|please run [`']?wrangler login|authentication error|10000/i.test(text)) {
    return new StepError('AUTH_REQUIRED', 'Cloudflare needs you to sign in again.', { hint: 'Run `npx wrangler login`, then try again.' });
  }
  if (/must be enabled|enable r2|r2.*not enabled|10042/i.test(text)) {
    return new StepError('R2_NOT_ENABLED', 'R2 is not enabled on this Cloudflare account.', { hint: 'Enable R2 once in the Cloudflare dashboard, then try again.' });
  }
  void authHint;
  return null;
}

// ---------- transient Cloudflare failures ----------
//
// Load, replication lag and edge-level hiccups answer with a 5xx, a 429 or one of
// these API codes, and the identical request works seconds later. They say
// nothing about this install, so retrying is right; a sign-in or permission
// failure is not, because no amount of waiting grants access.

/** Codes proven transient on a live account; 7403 reports itself as "not authorized". */
const TRANSIENT_API_CODES = [7403, 10013];
const AUTH_OR_PERMISSION = /authentication error|not authenticated|not logged in|wrangler login|permission|not authorized|unauthorized|forbidden|access denied|\b10000\b|\b40[13]\b/i;
const NETWORK_FAILURE = /\b(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|EPIPE)\b|socket hang up|fetch failed|network is unreachable|timed out/i;
// "HTTP status 502", "status code 500", "HTTP 503": a status number after the
// word that introduces it, never a bare number that could be part of a filename.
const HTTP_STATUS = /\b(?:http|status)(?:\s+(?:status|code))?\s*[:=]?\s*(429|5\d\d)\b/i;
const HTTP_REASON = /\b(429|5\d\d)\b\s*(?:too many requests|internal server error|bad gateway|service unavailable|gateway time-?out)\b/i;

/** Why a failed wrangler run is worth retrying, or null when it is not. */
function transientReason(result) {
  const text = `${result.stdout || ''}${result.stderr || ''}`;
  if (!text) return null;
  for (const code of TRANSIENT_API_CODES) {
    if (new RegExp(`\\b${code}\\b`).test(text)) return `Cloudflare code ${code}`;
  }
  // Auth and permission failures are final, and they are checked before the
  // HTTP status because a 5xx response can still carry a permission message.
  if (classifyWranglerFailure(result)) return null;
  if (AUTH_OR_PERMISSION.test(text)) return null;
  const status = text.match(HTTP_STATUS) || text.match(HTTP_REASON);
  if (status) return `HTTP ${status[1]}`;
  if (/\b429\b|too many requests|rate limit/i.test(text)) return 'HTTP 429';
  if (/internal server error|service unavailable|bad gateway|gateway time-?out/i.test(text)) return 'a Cloudflare 5xx';
  if (NETWORK_FAILURE.test(text)) return 'a network error';
  return null;
}

const RETRY_ATTEMPTS = 4;
const RETRY_DELAYS_MS = [800, 2500, 6000];

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run one wrangler command, retrying only a transient Cloudflare failure.
 * Only idempotent operations use this: `deploy`, `d1 migrations apply` and
 * `secret bulk`. A repeated `d1 create` could leave an orphan, so it never is.
 * A permanent failure is returned untouched, so the caller's classifier still
 * names it.
 */
async function runTransient(wrangler, args, options, retry = {}) {
  const attempts = retry.attempts || RETRY_ATTEMPTS;
  const delays = retry.delaysMs || RETRY_DELAYS_MS;
  const sleep = retry.sleep || defaultSleep;
  let result = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    result = await wrangler.run(args, options);
    if (result.ok) return result;
    const reason = transientReason(result);
    if (!reason) return result;
    if (attempt === attempts) return { ...result, transient: { reason, attempts } };
    const delayMs = delays[Math.min(attempt - 1, delays.length - 1)];
    if (retry.onRetry) {
      try { retry.onRetry({ attempt, attempts, reason, delayMs }); } catch { /* a progress line never fails a step */ }
    }
    await sleep(delayMs);
  }
  return result;
}

/**
 * The failure after the last retry: plain, and explicitly worth trying again.
 *
 * 7403 is the one code that can mean two different things. It is usually the
 * edge refusing a request it will accept a moment later, but Cloudflare also
 * answers it for a request made against the wrong account, and no retry fixes
 * that. Since this is the message the user sees after the retries are spent,
 * it names both possibilities rather than blaming Cloudflare alone.
 */
function transientError(result, fallback) {
  const transient = result.transient || {};
  const reason = transient.reason || 'a temporary Cloudflare error';
  const ambiguousAccount = /\b7403\b/.test(reason);
  const message = ambiguousAccount
    ? 'Cloudflare refused the request. Try again; if it keeps happening, check that you\'re signed in to the Cloudflare account that owns this Snip.'
    : 'Cloudflare had a temporary problem, try again.';
  const hint = ambiguousAccount
    ? 'Run `npx wrangler whoami` to see which account you are signed in to; the database and bucket must be the ones this Snip was set up with.'
    : 'Nothing is wrong with this Mac or this library; run the same command again in a minute.';
  return new StepError('CLOUDFLARE_TEMPORARY', message, {
    hint,
    retryable: true,
    data: {
      reason,
      attempts: transient.attempts || 1,
      ...(ambiguousAccount ? { ambiguousAccount: true } : {}),
      output: failureMessage(result, fallback),
    },
  });
}

async function deployWorker(wrangler, { dataRoot, accountId, onOutput, retry }) {
  const file = configPath(dataRoot);
  const result = await runTransient(wrangler, ['deploy', '--config', file], {
    cwd: path.dirname(file),
    env: { CLOUDFLARE_ACCOUNT_ID: accountId },
    onStdout: onOutput,
    onStderr: onOutput,
  }, retry);
  if (!result.ok) {
    const known = classifyWranglerFailure(result);
    if (known) throw known;
    if (result.transient) throw transientError(result, 'wrangler deploy exited non-zero');
    throw new StepError('DEPLOY_FAILED', 'The Worker deploy failed.', {
      hint: 'Fix the Cloudflare error above, then run the same command again. Completed steps are skipped.',
      data: { output: failureMessage(result, 'wrangler deploy exited non-zero') },
    });
  }
  return result;
}

async function dryRunDeploy(wrangler, { dataRoot, accountId, outdir }) {
  const file = configPath(dataRoot);
  const args = ['deploy', '--config', file, '--dry-run'];
  if (outdir) args.push('--outdir', outdir);
  return wrangler.run(args, { cwd: path.dirname(file), env: { CLOUDFLARE_ACCOUNT_ID: accountId } });
}

async function applyMigrations(wrangler, { dataRoot, accountId, remote = true, local = false, persistTo, config, retry }) {
  const file = config || configPath(dataRoot);
  const args = ['d1', 'migrations', 'apply', 'DB', '--config', file];
  if (remote) args.push('--remote');
  if (local) args.push('--local');
  if (persistTo) args.push('--persist-to', persistTo);
  // A local apply talks to a bundled Miniflare, not Cloudflare, so there is
  // nothing transient to wait out and a SQL error must keep its own message.
  const options = { cwd: path.dirname(file), env: { CLOUDFLARE_ACCOUNT_ID: accountId } };
  const result = remote ? await runTransient(wrangler, args, options, retry || {}) : await wrangler.run(args, options);
  if (!result.ok) {
    const known = classifyWranglerFailure(result);
    if (known) throw known;
    if (result.transient) throw transientError(result, 'wrangler d1 migrations apply exited non-zero');
    throw new StepError('MIGRATE_FAILED', 'The database migration failed.', {
      hint: 'Fix the error above, then run the same command again. Migrations are additive and safe to re-run.',
      data: { output: failureMessage(result, 'wrangler d1 migrations apply exited non-zero') },
    });
  }
  return result;
}

async function listMigrations(wrangler, { dataRoot, accountId, remote = true }) {
  const file = configPath(dataRoot);
  const args = ['d1', 'migrations', 'list', 'DB', '--config', file, remote ? '--remote' : '--local'];
  return wrangler.run(args, { cwd: path.dirname(file), env: { CLOUDFLARE_ACCOUNT_ID: accountId } });
}

/**
 * Run SQL against the cloud database and return its rows. Used for digests and
 * for the pre-deploy schema check, never for row-level copies.
 */
async function remoteQuery(wrangler, { dataRoot, accountId, sql, database = 'DB' }) {
  const file = configPath(dataRoot);
  const result = await wrangler.run(['d1', 'execute', database, '--config', file, '--remote', '--json', '--command', sql], {
    cwd: path.dirname(file),
    env: { CLOUDFLARE_ACCOUNT_ID: accountId },
    timeoutMs: 5 * 60_000,
  });
  if (!result.ok) {
    const known = classifyWranglerFailure(result);
    if (known) throw known;
    throw new StepError('QUERY_FAILED', 'A query against the cloud database failed.', { data: { output: failureMessage(result, 'wrangler d1 execute exited non-zero') } });
  }
  const parsed = require('./deps.cjs').parseJsonLoose(result.stdout);
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  return (first && (first.results || [])) || [];
}

/** Run SQL against the local database and return its rows (read-only digest checks). */
async function localQuery(wrangler, { dataRoot, sql, config, persistTo }) {
  const args = ['d1', 'execute', 'DB', '--local', '--json', '--command', sql];
  if (config) args.push('--config', config);
  if (persistTo) args.push('--persist-to', persistTo);
  const result = await wrangler.run(args, { cwd: dataRoot });
  if (!result.ok) {
    throw new StepError('QUERY_FAILED', 'A query against the local database failed.', { data: { output: failureMessage(result, 'wrangler d1 execute exited non-zero') } });
  }
  const parsed = require('./deps.cjs').parseJsonLoose(result.stdout);
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  return (first && (first.results || [])) || [];
}

/**
 * Dump the local database to a file. `wrangler d1 export` has no --persist-to,
 * so it always reads <cwd>/web/.wrangler/state, which is exactly where the app
 * keeps this library's local state.
 */
async function exportLocal(wrangler, { dataRoot, output, config }) {
  const args = ['d1', 'export', 'DB', '--local', '--no-schema', '--output', output];
  if (config) args.push('--config', config);
  const result = await wrangler.run(args, { cwd: path.join(dataRoot, 'web') });
  if (!result.ok) {
    const known = classifyWranglerFailure(result);
    if (known) throw known;
    throw new StepError('EXPORT_FAILED', 'The local database could not be exported.', { data: { output: failureMessage(result, 'wrangler d1 export exited non-zero') } });
  }
  return output;
}


/**
 * A dump carries bookkeeping the destination already has or never had:
 * `sqlite_sequence` does not exist in a fresh database, and the migration
 * ledger is written by applying migrations first. Replaying either aborts the
 * whole batch on a missing table or a primary-key clash, so those rows are
 * dropped at import. Everything else the move copies is imported verbatim.
 */
function libraryStatements(statements) {
  return statements.filter((statement) => {
    const match = statement.match(/^\s*(?:INSERT\s+INTO|DELETE\s+FROM|UPDATE)\s+"?([A-Za-z0-9_]+)"?/i);
    if (!match) return false;
    const table = match[1];
    if (/^(sqlite_|_cf_|_mf_|__)/i.test(table)) return false;
    return table !== 'd1_migrations';
  });
}

/**
 * Write one batch to a private file and return its path. `wrangler d1 execute`
 * has no stdin form (`--file -` is rejected as an unknown argument), so every
 * batch goes through a 0600 file under the library's profile that is always
 * removed again.
 */
function stageBatch(dataRoot, index, sql) {
  const dir = path.join(dataRoot, '.snip/sql');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `batch-${process.pid}-${index}.sql`);
  fs.writeFileSync(file, sql, { mode: 0o600 });
  return file;
}

/** Load a dump into the remote database. Batched; each batch is one request. */
async function importRemote(wrangler, { dataRoot, accountId, statements, batchBytes = 900_000, onBatch }) {
  const file = configPath(dataRoot);
  const { batchStatements } = require('./lib.cjs');
  const batches = batchStatements(libraryStatements(statements), batchBytes);
  const staged = [];
  try {
    for (let index = 0; index < batches.length; index++) {
      const sql = `${batches[index].join(';\n')};`;
      const batchFile = stageBatch(dataRoot, index, sql);
      staged.push(batchFile);
      const result = await wrangler.run(['d1', 'execute', 'DB', '--config', file, '--remote', '--file', batchFile], {
        cwd: path.dirname(file),
        env: { CLOUDFLARE_ACCOUNT_ID: accountId },
        timeoutMs: 10 * 60_000,
      });
      if (!result.ok) {
        const known = classifyWranglerFailure(result);
        if (known) throw known;
        throw new StepError('IMPORT_FAILED', 'Loading the library into the cloud database failed.', {
          hint: 'Run the same command again: the import restarts from a truncated database, so a partial import is never left behind.',
          data: { batch: index + 1, batches: batches.length, output: failureMessage(result, 'wrangler d1 execute exited non-zero') },
        });
      }
      if (onBatch) onBatch({ index: index + 1, total: batches.length });
    }
  } finally {
    for (const batchFile of staged) { try { fs.unlinkSync(batchFile); } catch {} }
  }
  return { batches: batches.length };
}

/**
 * Load statements into a local database under `persistTo`. Used by `pull` to
 * build a staged library that is verified before it replaces anything.
 */
async function importLocal(wrangler, { dataRoot, persistTo, statements, config }) {
  const { batchStatements } = require('./lib.cjs');
  const batches = batchStatements(libraryStatements(statements));
  const defaultConfig = config || configPath(dataRoot);
  for (let index = 0; index < batches.length; index++) {
    const sql = `${batches[index].join(';\n')};`;
    const batchFile = stageBatch(dataRoot, index, sql);
    const args = ['d1', 'execute', 'DB', '--local', '--config', defaultConfig, '--file', batchFile, '--persist-to', persistTo];
    const result = await wrangler.run(args, { cwd: dataRoot, timeoutMs: 10 * 60_000 }).finally(() => { try { fs.unlinkSync(batchFile); } catch {} });
    if (!result.ok) {
      throw new StepError('IMPORT_FAILED', 'Loading the library into the new local database failed.', {
        hint: 'Run `pull` again; the staged copy is replaced, never half-used.',
        data: { batch: index + 1, batches: batches.length, output: failureMessage(result, 'wrangler d1 execute exited non-zero') },
      });
    }
  }
  return { batches: batches.length };
}

module.exports = {
  applyMigrations,
  libraryStatements,
  bucketName: BUCKET_NAME,
  classifyWranglerFailure,
  cloudDir,
  configExists,
  configPath,
  deployWorker,
  dryRunDeploy,
  exportLocal,
  importLocal,
  importRemote,
  inspectRuntime,
  listMigrations,
  localConfigPath,
  localQuery,
  prepareDeployLayout,
  readDeployConfig,
  remoteQuery,
  runTransient,
  runtimeProblem,
  runtimeSources,
  transientError,
  transientReason,
};
