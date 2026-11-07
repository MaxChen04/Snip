'use strict';
// The deploy layout (contracts §5.1) and the wrangler commands that act on it.
// Nothing is ever written into the runtime: the built Worker, client assets and
// migrations are copied into <dataRoot>/cloud on every deploy so a new bundle is
// never shadowed by a stale copy.

const fs = require('node:fs');
const path = require('node:path');
const { StepError } = require('./engine.cjs');
const { patchDeployConfig, BUCKET_NAME } = require('./lib.cjs');

const cloudDir = (dataRoot) => path.join(dataRoot, 'cloud');
const configPath = (dataRoot) => path.join(cloudDir(dataRoot), 'snip/wrangler.json');

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
  const patched = patchDeployConfig(built, { d1Id, kvId, login, url, migrations: '../migrations' });
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

async function deployWorker(wrangler, { dataRoot, accountId, onOutput }) {
  const file = configPath(dataRoot);
  const result = await wrangler.run(['deploy', '--config', file], {
    cwd: path.dirname(file),
    env: { CLOUDFLARE_ACCOUNT_ID: accountId },
    onStdout: onOutput,
    onStderr: onOutput,
  });
  if (!result.ok) {
    const known = classifyWranglerFailure(result);
    if (known) throw known;
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

async function applyMigrations(wrangler, { dataRoot, accountId, remote = true, local = false, persistTo }) {
  const file = configPath(dataRoot);
  const args = ['d1', 'migrations', 'apply', 'DB', '--config', file];
  if (remote) args.push('--remote');
  if (local) args.push('--local');
  if (persistTo) args.push('--persist-to', persistTo);
  const result = await wrangler.run(args, { cwd: path.dirname(file), env: { CLOUDFLARE_ACCOUNT_ID: accountId } });
  if (!result.ok) {
    const known = classifyWranglerFailure(result);
    if (known) throw known;
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
  const batches = batchStatements(statements, batchBytes);
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
  const batches = batchStatements(statements);
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
  localQuery,
  prepareDeployLayout,
  readDeployConfig,
  remoteQuery,
  runtimeProblem,
  runtimeSources,
};
