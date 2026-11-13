// Rehearse release migration histories through the installed Wrangler and local D1.
// No credentials, hosted resources, or real library are used. Run after npm ci:
//   node qa/migration-history.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'web/migrations');
const wrangler = path.join(root, 'node_modules/wrangler/bin/wrangler.js');
const files = fs.readdirSync(source).filter(name => name.endsWith('.sql')).sort();
const base = files.filter(name => Number.parseInt(name, 10) <= 15);
const feature58 = '0016_page_text.sql';
const feature60 = '0017_style_parts.sql';
const hardening = ['0016_stale_reclaims.sql', '0017_board_item_z.sql', '0018_capture_lease.sql', '0019_page_warnings.sql', '0020_agent_refused.sql'];
for (const name of [...hardening, feature58, feature60]) assert.ok(files.includes(name), `Missing migration: ${name}`);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'snip-migration-history-'));
const results = [];

function rehearsal(label, initial) {
  const dir = path.join(temporary, label);
  const migrations = path.join(dir, 'migrations');
  fs.mkdirSync(migrations, { recursive: true });
  const config = path.join(dir, 'wrangler.json');
  fs.writeFileSync(config, JSON.stringify({
    name: 'snip-migration-history', compatibility_date: '2025-01-01',
    d1_databases: [{ binding: 'DB', database_name: 'snip-migration-history', database_id: '00000000-0000-0000-0000-000000000001', migrations_dir: './migrations' }],
  }));
  const copy = names => names.forEach(name => fs.copyFileSync(path.join(source, name), path.join(migrations, name)));
  function run(args, expectFailure = false) {
    const result = spawnSync(process.execPath, [wrangler, ...args, '--local', '--config', config, '--persist-to', path.join(dir, 'state')], {
      cwd: dir, encoding: 'utf8', timeout: 90_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, CI: 'true', NO_COLOR: '1', WRANGLER_SEND_METRICS: 'false', XDG_CONFIG_HOME: path.join(temporary, 'config'), WRANGLER_LOG_PATH: path.join(temporary, 'wrangler.log') },
    });
    if (result.error) throw result.error;
    const output = `${result.stdout}\n${result.stderr}`;
    if (expectFailure) assert.notEqual(result.status, 0, `${label}: renamed migration unexpectedly succeeded`);
    else assert.equal(result.status, 0, `${label}: Wrangler failed\n${output}`);
    return expectFailure ? output : result.stdout;
  }
  const apply = () => run(['d1', 'migrations', 'apply', 'DB']);
  function query(sql) {
    const output = run(['d1', 'execute', 'DB', '--command', sql, '--json']);
    return JSON.parse(output.trim())[0].results;
  }
  function seed() {
    query(`INSERT INTO refs (id,url,domain,mode,status,created_at,updated_at,notes) VALUES ('proof-ref','https://example.invalid/','example.invalid','single','ready','2026-11-13','2026-11-13','keep this note');
      INSERT INTO pages (id,reference_id,url,path,title,created_at,sections_json) VALUES ('proof-page','proof-ref','https://example.invalid/','/','Keep this page','2026-11-13','[{"kind":"hero","label":"Hero proof"}]');`);
  }
  if (initial !== null) {
    copy(base);
    apply();
    seed();
    copy(initial);
    apply();
  }
  copy(files);
  apply();
  if (initial === null) {
    seed();
    query("INSERT INTO page_text (page_id,reference_id,sections) VALUES ('proof-page','proof-ref','hero: Hero proof')");
  }
  const before = query('SELECT id,name,applied_at FROM d1_migrations ORDER BY id');
  assert.deepEqual(before.map(row => row.name).sort(), files, `${label}: full filenames are recorded exactly once`);
  apply();
  assert.deepEqual(query('SELECT id,name,applied_at FROM d1_migrations ORDER BY id'), before, `${label}: repeat apply must not replay anything`);
  const rows = query("SELECT r.notes,p.title,p.styles_summary_json,t.sections FROM refs r JOIN pages p ON p.reference_id=r.id JOIN page_text t ON t.page_id=p.id WHERE r.id='proof-ref'");
  assert.deepEqual(rows, [{ notes: 'keep this note', title: 'Keep this page', styles_summary_json: null, sections: 'hero: Hero proof' }]);
  assert.deepEqual(query('PRAGMA foreign_key_check'), []);
  // D1 rejects SQLite's PRAGMA integrity_check; check the supported foreign-key
  // assertion and preserved rows/schema above rather than claiming that check ran.
  const result = { history: label, migrations: before.length, repeatedApply: 'no-op', preservedLibrary: true, foreignKeyViolations: 0 };
  if (label === 'pr58_and_pr60') {
    const aliases = [[feature58, '0021_page_text.sql'], [feature60, '0022_style_parts.sql']];
    for (const [oldName, newName] of aliases) fs.renameSync(path.join(migrations, oldName), path.join(migrations, newName));
    const failure = run(['d1', 'migrations', 'apply', 'DB'], true);
    assert.match(failure, /already exists|duplicate column/i);
    for (const [oldName, newName] of aliases) fs.renameSync(path.join(migrations, newName), path.join(migrations, oldName));
    assert.deepEqual(query('SELECT id,name,applied_at FROM d1_migrations ORDER BY id'), before);
    result.renamingAppliedMigrations = 'fails as expected; recorded filenames preserved';
  }
  results.push(result);
  console.error(`${label}: passed`);
}

try {
  rehearsal('fresh', null);
  rehearsal('hardening_first', hardening);
  rehearsal('pr58_first', [feature58]);
  rehearsal('pr60_first', [feature60]);
  rehearsal('pr58_and_pr60', [feature58, feature60]);
  console.log(JSON.stringify({ engine: 'Wrangler local D1 (not hosted D1)', wrangler: JSON.parse(fs.readFileSync(path.join(root, 'node_modules/wrangler/package.json'))).version, results }, null, 2));
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
