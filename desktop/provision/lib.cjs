'use strict';
// Pure helpers: URL/ID parsing, the deploy config patch, capture env files, SQL
// batching and the verification digest. Nothing here touches the network, the
// filesystem or a process, so it is all directly testable.

const crypto = require('node:crypto');

const PLACEHOLDERS = {
  d1: 'REPLACE_WITH_D1_DATABASE_ID',
  kv: 'REPLACE_WITH_KV_NAMESPACE_ID',
  login: 'your-github-login',
  url: 'https://snip.YOUR-SUBDOMAIN.workers.dev',
};

const WORKER_NAME = 'snip';
const D1_NAME = 'snip';
const KV_NAME = 'OAUTH_KV';
const BUCKET_NAME = 'snip-files';

/** Tables the move copies. Everything user-visible; nothing Miniflare-internal. */
const LIBRARY_TABLES = ['refs', 'pages', 'animations', 'collections', 'reference_collections', 'page_collections'];
/** Per-device or in-flight state that must not be copied or compared across a move. */
const EPHEMERAL_TABLES = new Set(['owner_nonces', 'webauthn_challenges', 'sessions', 'worker_presence', 'capture_cleanup', 'capture_uploads', 'd1_migrations', 'sqlite_sequence']);

/** A workers.dev subdomain, a bare host or a URL, as the Worker's public origin. */
function publicUrlFrom(input, worker = WORKER_NAME) {
  const raw = String(input ?? '').trim().replace(/\/+$/, '');
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return new URL(raw).origin;
  if (raw.includes('.')) return `https://${raw}`;
  return `https://${worker}.${raw}.workers.dev`;
}

/**
 * A public origin for PUBLIC_URL: http(s), no path/query/fragment, and returned
 * in the canonical lowercase form the Worker needs (`new URL` normalizes the
 * host, so `https://Snip.Example.com` becomes `https://snip.example.com`).
 */
function canonicalOrigin(value) {
  if (!value) return null;
  let url;
  try { url = new URL(value); } catch { throw new Error('PUBLIC_URL must be a URL such as https://snip.max.workers.dev.'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('PUBLIC_URL must be an http or https origin.');
  if (url.pathname !== '/' || url.search || url.hash) throw new Error('PUBLIC_URL must be an origin, with no path, query or fragment.');
  if (url.username || url.password) throw new Error('PUBLIC_URL must not include credentials.');
  return url.origin;
}

function originHost(url) {
  try { return new URL(url).host; } catch { return null; }
}

/** The id printed by `wrangler d1 create` or `wrangler kv namespace create`. */
function parseCreatedId(output, key) {
  return String(output || '').match(new RegExp(`"?${key}"?\\s*[:=]\\s*"([0-9a-f-]{20,})"`))?.[1] ?? null;
}

const field = (text, key) => text.match(new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`))?.[1] ?? null;

/** Values in a wrangler.jsonc, or null where it still has a placeholder. */
function readValues(text) {
  const value = (key, placeholder) => {
    const found = field(text, key);
    return found && found !== placeholder && !/YOUR-SUBDOMAIN|REPLACE_WITH/.test(found) ? found : null;
  };
  return {
    d1: value('database_id', PLACEHOLDERS.d1),
    kv: value('id', PLACEHOLDERS.kv),
    login: value('ALLOWED_GITHUB_LOGINS', PLACEHOLDERS.login),
    url: value('PUBLIC_URL', PLACEHOLDERS.url),
  };
}

/**
 * Patch the prebuilt config in place (contracts §5.1). The build emits absolute
 * build-machine paths and a migrations_dir relative to the build tree; both are
 * wrong once the files are copied into the library.
 */
/**
 * The `ratelimits` array from a wrangler.jsonc, or null. Full-line comments are
 * stripped first; the array itself must be plain JSON, as the tracked file keeps it.
 */
function readRatelimits(text) {
  const stripped = String(text || '').split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
  const match = stripped.match(/"ratelimits"\s*:\s*(\[[\s\S]*?\])\s*,?\s*\n/);
  if (!match) return null;
  try {
    const value = JSON.parse(match[1]);
    return Array.isArray(value) && value.length ? value : null;
  } catch {
    return null;
  }
}

/** The `triggers` object from a wrangler.jsonc, or null. The tracked file keeps it on one line. */
function readTriggers(text) {
  const match = String(text || '').match(/^\s*"triggers"\s*:\s*(\{.*\})\s*,?\s*$/m);
  if (!match) return null;
  try {
    const value = JSON.parse(match[1]);
    return Array.isArray(value.crons) && value.crons.length ? value : null;
  } catch {
    return null;
  }
}

function patchDeployConfig(config, { d1Id, kvId, login, url, migrations = '../migrations', ratelimits = null, triggers = null }) {
  const next = JSON.parse(JSON.stringify(config));
  // The same older build has no cron either, and without it retired files are never swept.
  if (!(next.triggers && Array.isArray(next.triggers.crons) && next.triggers.crons.length) && triggers) next.triggers = triggers;
  // A build from an older web/wrangler.local.jsonc has no rate-limit bindings, and the
  // hosted OAuth guards answer 503 without them, so take them from the tracked template.
  if ((!Array.isArray(next.ratelimits) || !next.ratelimits.length) && ratelimits) next.ratelimits = JSON.parse(JSON.stringify(ratelimits));
  delete next.configPath;
  delete next.userConfigPath;
  next.name = WORKER_NAME;
  next.main = 'index.js';
  next.no_bundle = true;
  next.assets = { ...(next.assets || {}), directory: '../client' };
  if (!Array.isArray(next.d1_databases) || !next.d1_databases.length) throw new Error('The built config has no d1_databases entry.');
  next.d1_databases = next.d1_databases.map((entry) => ({
    ...entry,
    database_name: entry.database_name || D1_NAME,
    database_id: d1Id,
    migrations_dir: migrations,
  }));
  if (!Array.isArray(next.kv_namespaces) || !next.kv_namespaces.length) throw new Error('The built config has no kv_namespaces entry.');
  next.kv_namespaces = next.kv_namespaces.map((entry) => ({ ...entry, id: kvId }));
  next.r2_buckets = (next.r2_buckets || []).map((entry) => ({ ...entry, bucket_name: entry.bucket_name || BUCKET_NAME }));
  next.vars = {
    ...(next.vars || {}),
    PUBLIC_URL: url,
    ALLOWED_GITHUB_LOGINS: login || PLACEHOLDERS.login,
  };
  return next;
}

function captureEnvText(existing, { url, token }) {
  const set = (text, key, value) => (new RegExp(`^${key}=.*$`, 'm').test(text)
    ? text.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`)
    : `${text ? `${text.trimEnd()}\n` : ''}${key}=${value}\n`);
  const base = existing && existing.trim() ? existing.trimEnd() : '';
  return set(set(base, 'SNIP_URL', url), 'CAPTURE_TOKEN', token);
}

function randomSecret() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Split a D1 dump into statements. Handles single-quoted strings with doubled
 * quotes, line comments and multi-line statements, which is what
 * `wrangler d1 export --no-schema` emits.
 */
function splitSqlStatements(sql) {
  const statements = [];
  let current = '';
  let i = 0;
  const text = String(sql || '');
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'") {
      current += ch;
      i++;
      while (i < text.length) {
        const next = text[i];
        current += next;
        i++;
        if (next === "'") {
          if (text[i] === "'") { current += text[i]; i++; continue; }
          break;
        }
      }
      continue;
    }
    if (ch === '-' && text[i + 1] === '-') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (ch === ';') {
      const statement = current.trim();
      if (statement) statements.push(statement);
      current = '';
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}

/**
 * Column lists per table, read from the dump's `INSERT INTO "t" (a, b, …)`
 * prefix. That is where `wrangler d1 export --no-schema` names them, so the
 * digest never needs schema access on either side.
 */
function columnsFromDump(sql) {
  const columns = {};
  for (const statement of splitSqlStatements(sql)) {
    const match = statement.match(/^\s*INSERT\s+INTO\s+"?([A-Za-z0-9_]+)"?\s*\(([^)]*)\)/i);
    if (!match) continue;
    const table = match[1];
    if (columns[table]) continue;
    columns[table] = match[2]
      .split(',')
      .map((name) => name.trim().replace(/^"(.*)"$/, '$1').replace(/^`(.*)`$/, '$1'))
      .filter(Boolean);
  }
  return columns;
}

/** Row counts per table from the same dump, for the empty-library guard. */
function countsFromDump(sql) {
  const counts = {};
  for (const statement of splitSqlStatements(sql)) {
    const match = statement.match(/^\s*INSERT\s+INTO\s+"?([A-Za-z0-9_]+)"?/i);
    if (match) counts[match[1]] = (counts[match[1]] || 0) + 1;
  }
  return counts;
}

/** Group statements into batches under a byte budget, never splitting a statement. */
function batchStatements(statements, maxBytes = 900_000, maxStatements = 500) {
  const batches = [];
  let current = [];
  let bytes = 0;
  for (const statement of statements) {
    const size = Buffer.byteLength(statement) + 2;
    if (current.length && (bytes + size > maxBytes || current.length >= maxStatements)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(statement);
    bytes += size;
  }
  if (current.length) batches.push(current);
  return batches;
}

/**
 * Tables the move copies, discovered from the local schema so tables added by a
 * newer Worker move too. Only ephemeral bookkeeping is skipped.
 */
function libraryTablesFrom(names) {
  return [...new Set(names)]
    .filter((name) => typeof name === 'string' && name && !EPHEMERAL_TABLES.has(name) && !name.startsWith('sqlite_') && !name.startsWith('_cf_') && !/^(_mf_|__)/.test(name))
    .sort();
}

/**
 * One SQL statement per table that summarizes its rows without returning them:
 * COUNT(*), plus a length signature built from every column with `quote()` so
 * NULL and text values cannot collide. Deterministic on local and remote D1.
 */
function digestSql(table, columns) {
  const ident = `"${String(table).replace(/"/g, '""')}"`;
  const parts = columns.map((column) => `coalesce(quote("${String(column).replace(/"/g, '""')}"),'')`);
  const expression = parts.length ? parts.join("||char(30)||") : "''";
  return `SELECT COUNT(*) AS rows, coalesce(SUM(LENGTH(${expression})),0) AS sig FROM ${ident}`;
}

/**
 * Tables a manifest says are copied as schema but not as rows. The Worker
 * computes this from its own database, so the list changes with the Worker: an
 * older one may name fewer tables, or none at all. When it is absent the
 * documented default applies (contracts §4.5), which is exactly the set that
 * differs on its own after any copy and would fail a correct move.
 */
const DEFAULT_EXCLUDED = ['owner_nonces', 'webauthn_challenges'];

function excludedTables(excluded) {
  const names = Array.isArray(excluded) ? excluded.filter((name) => typeof name === 'string' && name) : [];
  return new Set(names.length ? names : DEFAULT_EXCLUDED);
}

/** Compare only tables the manifest actually copied: never require one to exist. */
function comparableTables(tables, excluded) {
  const skip = excluded instanceof Set ? excluded : excludedTables(excluded);
  return Object.keys(tables || {})
    .filter((table) => !skip.has(table))
    // Defensive: SQLite internals are never part of a library.
    .filter((table) => !/^(sqlite_|_cf_|_mf_)/.test(table));
}

function digestOf(perTable) {
  const hash = crypto.createHash('sha256');
  for (const table of Object.keys(perTable).sort()) {
    const entry = perTable[table] || {};
    hash.update(`${table}:${Number(entry.rows) || 0}:${Number(entry.sig) || 0}\n`);
  }
  return `snip-digest-v1:${hash.digest('hex')}`;
}

/** Check the `{ key, size }` entries a copy should hold against a bucket listing of what it does hold. */
function compareFiles(expected, listed) {
  const sizes = new Map((listed || []).map((entry) => [entry.key, Number(entry.size) || 0]));
  const missing = [];
  let mismatch = null;
  for (const entry of expected) {
    const size = Number(entry.size) || 0;
    if (!sizes.has(entry.key)) missing.push(entry.key);
    else if (!mismatch && sizes.get(entry.key) !== size) mismatch = { key: entry.key, expected: size, actual: sizes.get(entry.key) };
  }
  return { missing, mismatch, present: expected.length - missing.length };
}

module.exports = {
  BUCKET_NAME,
  D1_NAME,
  DEFAULT_EXCLUDED,
  EPHEMERAL_TABLES,
  KV_NAME,
  LIBRARY_TABLES,
  PLACEHOLDERS,
  WORKER_NAME,
  batchStatements,
  canonicalOrigin,
  captureEnvText,
  columnsFromDump,
  comparableTables,
  compareFiles,
  countsFromDump,
  digestOf,
  digestSql,
  excludedTables,
  libraryTablesFrom,
  originHost,
  parseCreatedId,
  patchDeployConfig,
  readRatelimits,
  readTriggers,
  publicUrlFrom,
  randomSecret,
  readValues,
  splitSqlStatements,
};
