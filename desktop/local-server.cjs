// Run the built Worker and its assets with the same local bindings as Wrangler dev.
const path = require('node:path');
const { createRequire } = require('node:module');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');

// Wrangler and workerd must remain in the service process group. The service
// sweeps that group when this launcher exits or the user forces it to stop.
function runWrangler(root, args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false', WRANGLER_WRITE_LOGS: 'false' },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let output = '', settled = false;
    const terminate = () => {
      child.kill('SIGKILL');
    };
    const timeout = setTimeout(terminate, 90000);
    signal.addEventListener('abort', terminate, { once: true });
    if (signal.aborted) terminate();
    child.stdout.on('data', chunk => { if (output.length < 1024 * 1024) output += chunk; });
    function done(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener('abort', terminate);
      if (error) reject(error); else resolve(output);
    }
    child.on('error', done);
    // A failing CLI may leave descendants holding stdout open. Let the launcher
    // exit so Service can sweep its process group instead of waiting on pipes.
    child.on('exit', code => { if (code !== 0 || signal.aborted) done(new Error('Migration command failed.')); });
    child.on('close', code => done(code === 0 && !signal.aborted ? null : new Error('Migration command failed.')));
  });
}

async function pruneBackups(backups) {
  const entries = await fs.readdir(backups, { withFileTypes: true });
  const successful = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('d1-')) continue;
    const directory = path.join(backups, entry.name);
    try {
      const marker = JSON.parse(await fs.readFile(path.join(directory, 'snip-backup.json'), 'utf8'));
      if (marker.owner === 'snip-d1-backup-v1' && marker.status === 'complete' && Number.isFinite(marker.time)) successful.push({ directory, time: marker.time });
    } catch { /* Never prune unmarked or incomplete backups. */ }
  }
  successful.sort((a, b) => b.time - a.time);
  for (const old of successful.slice(3)) await fs.rm(old.directory, { recursive: true, force: true });
}

async function migrate(root, dataRoot, signal) {
  const persist = path.join(dataRoot, 'web/.wrangler/state');
  const d1 = path.join(persist, 'v3/d1');
  const backups = path.join(dataRoot, 'backups');
  let backup;
  try {
    const cli = path.join(root, 'node_modules/wrangler/bin/wrangler.js');
    const common = ['snip', '--local', '--config', path.join(root, 'web/wrangler.jsonc'), '--persist-to', persist];
    const list = await runWrangler(root, [cli, 'd1', 'migrations', 'list', ...common], signal);
    if (list.includes('No migrations to apply!')) return;
    if (!list.includes('Migrations to be applied:')) throw new Error('Unrecognized migration list.');
    if (signal.aborted) throw new Error('Migration cancelled.');
    const hasD1 = await fs.access(d1).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
    if (hasD1) {
      await fs.mkdir(backups, { recursive: true, mode: 0o700 });
      backup = await fs.mkdtemp(path.join(backups, 'd1-'));
      await fs.writeFile(path.join(backup, 'snip-backup.json'), JSON.stringify({ owner: 'snip-d1-backup-v1', status: 'incomplete', time: Date.now() }), { mode: 0o600 });
      await fs.cp(d1, path.join(backup, 'd1'), { recursive: true });
    }
    if (signal.aborted) throw new Error('Migration cancelled.');
    await runWrangler(root, [cli, 'd1', 'migrations', 'apply', ...common], signal);
    if (backup) {
      await fs.writeFile(path.join(backup, 'snip-backup.json'), JSON.stringify({ owner: 'snip-d1-backup-v1', status: 'complete', time: Date.now() }), { mode: 0o600 });
      await pruneBackups(backups);
    }
  } catch {
    const error = new Error('Library migration failed.');
    error.userMessage = backup
      ? `The library upgrade failed. A backup is at ${backup}. Keep it for manual recovery before retrying.`
      : `The library upgrade failed before a backup was made. Check ${backups} for earlier backups before retrying.`;
    throw error;
  }
}

let stopping = false;
async function main() {
  const root = path.resolve(process.argv[2] || '');
  const port = Number(process.argv[3]);
  if (!process.argv[2] || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('Expected a project root and a valid port.');
  }

  const web = path.join(root, 'web');
  const dataRoot = path.resolve(process.argv[4] || root);
  const dataWeb = path.join(dataRoot, 'web');
  if (process.argv[5] === 'release') {
    // Miniflare otherwise fetches and writes synthetic request.cf metadata under
    // the current working directory, which is inside the signed application.
    process.env.CLOUDFLARE_CF_FETCH_ENABLED = 'false';
    // Keep any other Miniflare/Wrangler cache outside the immutable bundle too.
    process.env.MINIFLARE_CACHE_DIR = path.join(dataRoot, '.cache/miniflare');
    process.env.WRANGLER_CACHE_DIR = path.join(dataRoot, '.cache/wrangler');
  }
  let worker, startup;
  const controller = new AbortController();
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    controller.abort();
    try {
      if (startup) await startup.catch(() => {});
      if (worker) await worker.dispose();
      process.exit(0);
    } catch { process.exit(1); }
  };
  process.on('SIGTERM', stop);
  process.on('message', message => { if (message && message.type === 'snip:stop') void stop(); });
  process.on('disconnect', stop);
  if (process.argv[5] === 'release') {
    startup = migrate(root, dataRoot, controller.signal);
    await startup;
    startup = null;
    if (stopping) return;
  }
  const { unstable_readConfig, unstable_startWorker } = createRequire(path.join(root, 'package.json'))('wrangler');
  const config = unstable_readConfig({ config: path.join(web, 'dist/snip/wrangler.json') });
  // The generated config owns paths to the built Worker and assets. Wrangler uses
  // userConfigPath separately for .dev.vars and .env lookup, so keep that lookup
  // anchored to the original project config (including Wrangler's precedence).
  config.userConfigPath = path.join(dataWeb, 'wrangler.jsonc');

  startup = unstable_startWorker({
    config,
    dev: {
      remote: false,
      watch: false,
      inspector: false,
      logLevel: 'warn',
      server: { hostname: 'localhost', port },
      persist: path.join(dataWeb, '.wrangler/state'),
    },
  });
  worker = await startup;
  startup = null;
  const url = await worker.url;
  if (!stopping && process.send) process.send({ type: 'snip:web-ready', url: url.origin });
}

main().catch(error => {
  if (stopping) return;
  const message = error.userMessage || 'Local server failed to start. Check the built assets and Wrangler configuration.';
  if (process.send && process.connected) {
    process.send({ type: 'snip:web-error', message }, () => process.exit(1));
  } else {
    console.error(message);
    process.exit(1);
  }
});
