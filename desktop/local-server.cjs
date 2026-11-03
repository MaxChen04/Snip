// Run the built Worker and its assets with the same local bindings as Wrangler dev.
const path = require('node:path');
const { createRequire } = require('node:module');

async function main() {
  const root = path.resolve(process.argv[2] || '');
  const port = Number(process.argv[3]);
  if (!process.argv[2] || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('Expected a project root and a valid port.');
  }

  const web = path.join(root, 'web');
  const { unstable_readConfig, unstable_startWorker } = createRequire(path.join(root, 'package.json'))('wrangler');
  const config = unstable_readConfig({ config: path.join(web, 'dist/snip/wrangler.json') });
  // The generated config owns paths to the built Worker and assets. Wrangler uses
  // userConfigPath separately for .dev.vars and .env lookup, so keep that lookup
  // anchored to the original project config (including Wrangler's precedence).
  config.userConfigPath = path.join(web, 'wrangler.jsonc');

  let worker;
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      if (worker) await worker.dispose();
      process.exit(0);
    } catch {
      process.exit(1);
    }
  };
  process.on('SIGTERM', stop);
  process.on('message', (message) => {
    if (message && message.type === 'snip:stop') void stop();
  });
  process.on('disconnect', stop);

  worker = await unstable_startWorker({
    config,
    dev: {
      remote: false,
      watch: false,
      inspector: false,
      logLevel: 'warn',
      server: { hostname: 'localhost', port },
      persist: path.join(web, '.wrangler/state'),
    },
  });
  const url = await worker.url;
  if (!stopping && process.send) process.send({ type: 'snip:web-ready', url: url.origin });
}

main().catch(() => {
  const message = 'Local server failed to start. Check the built assets and Wrangler configuration.';
  if (process.send && process.connected) {
    process.send({ type: 'snip:web-error', message }, () => process.exit(1));
  } else {
    console.error(message);
    process.exit(1);
  }
});
