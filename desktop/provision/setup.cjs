'use strict';
// The enable-cloud steps, in contract order:
//   preflight cloudflare-auth account url r2 resources guard config schema
//   deploy secrets quiesce export release import verify owner finish
//
// Every step's `verify` is read-only and answers "is this already true?", so a
// resumed run skips what it already accomplished. The guard refuses a foreign
// Snip before anything is created, and again before anything is deployed.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { CancelledError, ChoiceRequired, NeedsInputError, StepError } = require('./engine.cjs');
const lib = require('./lib.cjs');
const {
  BUCKET_NAME,
  D1_NAME,
  KV_NAME,
  WORKER_NAME,
  canonicalOrigin,
  captureEnvText,
  columnsFromDump,
  countsFromDump,
  digestOf,
  digestSql,
  publicUrlFrom,
  randomSecret,
  splitSqlStatements,
} = require('./lib.cjs');
const cloud = require('./cloud.cjs');
const snapshotModule = require('./snapshot.cjs');
const deploy = require('./deploy.cjs');
const local = require('./local.cjs');
const { isGzipKey, mintOwnerLink, ownerSecretHash, startLoopback } = require('./transfer.cjs');
// context.cjs loads this module lazily, so this is never a cycle at load time.
const { retryOf } = require('./context.cjs');

// guard runs before resources: classification is read-only, so it must be able
// to refuse a foreign Worker without creating a single resource first.
const ENABLE_STEPS = [
  'preflight', 'cloudflare-auth', 'account', 'url', 'r2', 'guard', 'resources', 'config',
  'schema', 'deploy', 'secrets', 'quiesce', 'release', 'export', 'import', 'verify', 'owner', 'finish',
];

const EMPTY_LIBRARY_STEPS = new Set(['quiesce', 'export', 'release', 'import', 'verify']);

function guessLogin(root) {
  try {
    const result = require('node:child_process').spawnSync('git', ['config', 'github.user'], { cwd: root, encoding: 'utf8' });
    if (result.status === 0) return (result.stdout || '').trim() || null;
  } catch {}
  return null;
}

function bundleHash(dataRoot) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(path.join(dataRoot, 'cloud/snip/index.js'))).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Classify what is already in the Cloudflare account (contracts §1.10).
 * Outcomes: fresh | resume | adopt-empty | adopt-existing | foreign.
 *
 * "Looks like Snip" if ANY of:
 *   L-A its D1 has the Snip schema (refs, pages, animations, collections),
 *   L-B the Worker binds DB, FILES and OAUTH_KV,
 *   L-C this Mac's web/wrangler.deploy.jsonc names that URL or those ids.
 */
async function classifyAccount(ctx) {
  const accountId = ctx.cloud.accountId;
  const worker = await ctx.api.worker(accountId, WORKER_NAME);
  const databases = await ctx.deps.cloud.listD1(ctx.wrangler, { accountId });
  const database = databases.find((entry) => entry.name === D1_NAME) || null;
  const state = ctx.state();
  const record = state.cloud || {};

  const base = { worker: Boolean(worker), database, counts: { refs: 0, pages: 0, collections: 0 } };
  if (!worker && !database) return { ...base, outcome: 'fresh' };

  // Our own recorded install. `workerName` is only written once this engine has
  // classified and taken ownership, so a fresh run in a foreign account cannot
  // mistake the account/URL it just recorded for an earlier install.
  const sameAccount = record.accountId === accountId;
  const sameD1 = Boolean(database && record.d1 && record.d1.id === database.id);
  const sameUrl = Boolean(record.url && ctx.cloud.url && record.url === ctx.cloud.url);
  const recorded = record.workerName === WORKER_NAME;
  if (recorded && sameAccount && (sameD1 || sameUrl)) return { ...base, outcome: 'resume' };

  // L-C: a legacy deploy config on this Mac naming this install. It is local
  // evidence, so it is accepted only when it names something the account
  // actually has: the same database, the same KV namespace, or the same origin.
  const legacy = readLegacyDeployConfig(ctx.dataRoot);
  const namespaces = legacy && legacy.kv ? await ctx.deps.cloud.listKv(ctx.wrangler, { accountId }).catch(() => []) : [];
  const legacyMatches = Boolean(legacy && (
    (legacy.d1 && database && legacy.d1 === database.id)
    || (legacy.kv && namespaces.some((entry) => entry.id === legacy.kv))
    || (legacy.url && ctx.cloud.url && legacy.url === ctx.cloud.url)
  ));

  let tableNames = [];
  if (database) {
    tableNames = await ctx.api.d1Query(accountId, database.id, "SELECT name FROM sqlite_master WHERE type = 'table'").then((rows) => rows.map((row) => String(row.name))).catch(() => []);
  }
  const hasSchema = ['refs', 'pages', 'animations', 'collections'].every((name) => tableNames.includes(name));
  const bindings = worker ? await ctx.api.workerSettings(accountId, WORKER_NAME).then((settings) => settings.bindings).catch(() => []) : [];
  const bindingNames = new Set(bindings.map((entry) => entry.name));
  const hasBindings = ['DB', 'FILES', 'OAUTH_KV'].every((name) => bindingNames.has(name));

  if (!hasSchema && !hasBindings && !legacyMatches) return { ...base, outcome: 'foreign' };

  let counts = { refs: 0, pages: 0, collections: 0, images: 0 };
  if (hasSchema) {
    counts = await cloudCounts(ctx, accountId, database.id).catch(() => ({ refs: 1, pages: 1, collections: 0, images: 0 }));
  }
  // Boards count as content: they hold sticky notes and groups even with nothing saved on them.
  const empty = Number(counts.refs) === 0 && Number(counts.pages) === 0 && Number(counts.images) === 0 && Number(counts.collections) === 0;
  return {
    ...base,
    counts,
    outcome: empty ? 'adopt-empty' : 'adopt-existing',
    url: ctx.cloud.url || (record.url ?? null),
  };
}

async function cloudCounts(ctx, accountId, databaseId) {
  const row = async (table) => {
    const rows = await ctx.api.d1Query(accountId, databaseId, `SELECT COUNT(*) AS rows FROM "${table}"`);
    return Number((rows[0] && rows[0].rows) || 0);
  };
  // A cloud library from before uploaded images has no images table: none there.
  const images = await row('images').catch(() => 0);
  return { refs: await row('refs'), pages: await row('pages'), collections: await row('collections'), images };
}

/** A legacy install's own record: web/wrangler.deploy.jsonc from the old script. */
function readLegacyDeployConfig(dataRoot) {
  for (const candidate of [path.join(dataRoot, 'web/wrangler.deploy.jsonc'), path.join(dataRoot, 'web/wrangler.deploy.json')]) {
    try {
      const text = fs.readFileSync(candidate, 'utf8');
      const values = lib.readValues(text);
      if (values.d1 || values.kv || values.url) return values;
    } catch {}
  }
  return null;
}

function foreignError(ctx, facts) {
  const where = ctx.cloud.url || (facts.database ? `${D1_NAME} in this account` : 'this account');
  return new StepError('FOREIGN_SNIP', `This account has a Worker called \`${WORKER_NAME}\` that is not a Snip library.`, {
    hint: 'Snip keeps one library per account; rename or delete it, or choose another account.',
    retryable: false,
    data: { url: where },
  });
}

function preflightStep() {
  return {
    id: 'preflight',
    title: 'Checking this Mac',
    async run(ctx) {
      const web = path.join(ctx.dataRoot, 'web');
      let isLibrary = false;
      try { isLibrary = fs.statSync(web).isDirectory(); } catch {}
      if (!isLibrary) {
        throw new StepError('NOT_A_LIBRARY', 'This folder is not a Snip library.', { hint: 'Run setup from your Snip library folder, or open Snip and use Settings → Cloud.' });
      }
      if (!ctx.wrangler.bin) {
        throw new StepError('NO_WRANGLER', 'Wrangler is not installed in this build.', { hint: 'A source checkout needs `npm ci`; a released app should include its runtime.' });
      }
      const problem = ctx.deps.deploy.runtimeProblem(ctx.root);
      if (problem) throw new StepError('NO_BUILD', problem.message, { hint: problem.hint });

      const origin = ctx.deps.local.localOrigin(ctx.dataRoot);
      const running = await ctx.deps.local.reachable(origin);
      if (running && !ctx.flags.managed) {
        throw new StepError('LOCAL_SERVER_RUNNING', 'Snip is running. Quit Snip.app (or stop `npm run dev`), then run this again.', {
          hint: 'The library cannot be copied while a server is writing to it.',
          data: { origin },
        });
      }

      // Is there anything to copy at all? A failed read means "not empty": the
      // empty path is the one that skips the safety checks, so it must be proven.
      const facts = await ctx.libraryFacts();
      const libraryEmpty = facts.empty === true;

      let freeBytes = null;
      try {
        const stats = fs.statfsSync(ctx.dataRoot);
        freeBytes = Number(stats.bavail) * Number(stats.bsize);
      } catch {}
      if (freeBytes !== null && freeBytes < 500 * 1024 * 1024) {
        throw new StepError('DISK_SPACE', 'This Mac is low on disk space, so the copy cannot be staged safely.', {
          hint: 'Free up at least 1 GB, then try again.',
          data: { freeBytes },
        });
      }
      return {
        message: libraryEmpty ? 'Ready (this library is empty)' : running ? 'Snip is running and will be paused during the copy' : 'Ready',
        detail: JSON.stringify({ origin, managed: Boolean(ctx.flags.managed), freeBytes, libraryEmpty }),
      };
    },
    async verify(ctx) {
      return Boolean(ctx.wrangler.bin) && !ctx.deps.deploy.runtimeProblem(ctx.root);
    },
  };
}

function authStep() {
  return {
    id: 'cloudflare-auth',
    title: 'Signing in to Cloudflare',
    async run(ctx) {
      let status = await ctx.deps.cloud.whoami(ctx.wrangler);
      if (status.loggedIn) return { message: `Signed in${status.email ? ` as ${status.email}` : ''}`, detail: status.email || '' };
      if (ctx.flags.check) {
        throw new StepError('AUTH_REQUIRED', 'Cloudflare is not signed in.', { hint: 'Run `npx wrangler login`, then try again.' });
      }
      ctx.emit.human('cloudflare-auth', 'open_url', 'https://dash.cloudflare.com/login', 'Sign in to Cloudflare in the browser, then allow Wrangler');
      const result = await ctx.deps.cloud.login(ctx.wrangler, {
        onOutput: (text) => {
          const match = String(text).match(/https:\/\/[^\s]+/);
          if (match) ctx.emit.log('info', `If the browser did not open, visit ${match[0]}`);
        },
      });
      ctx.checkCancel();
      status = await ctx.deps.cloud.whoami(ctx.wrangler);
      if (!status.loggedIn) {
        throw new StepError('AUTH_FAILED', 'Cloudflare sign-in did not finish.', { hint: 'Run `npx wrangler login` in a terminal, then run setup again.', data: { output: String(result.stdout || '').slice(-400) } });
      }
      return { message: `Signed in${status.email ? ` as ${status.email}` : ''}`, detail: status.email || '' };
    },
    async verify(ctx) {
      const status = await ctx.deps.cloud.whoami(ctx.wrangler);
      return status.loggedIn;
    },
  };
}

function accountStep() {
  return {
    id: 'account',
    title: 'Choosing a Cloudflare account',
    async run(ctx) {
      const memberships = await ctx.api.memberships();
      if (!memberships.length) {
        throw new StepError('NOT_AN_ACCOUNT', 'This Cloudflare sign-in has no accounts.', { hint: 'Create a Cloudflare account, or sign in with one that has an account.' });
      }
      const requested = ctx.flags.account;
      let chosen = null;
      if (requested) {
        chosen = memberships.find((entry) => entry.id === requested);
        if (!chosen) throw new StepError('ACCOUNT_NOT_FOUND', 'That Cloudflare account is not available to this sign-in.', { hint: 'Run `status` to see the accounts, then pass `--account` again.' });
      } else if (memberships.length === 1) {
        chosen = memberships[0];
      } else {
        throw new NeedsInputError([{
          key: 'account',
          label: `Cloudflare account (${memberships.map((entry) => `${entry.name} ${entry.id.slice(0, 8)}…`).join(', ')})`,
          secret: false,
          options: memberships.map((entry) => ({ value: entry.id, label: entry.name })),
        }]);
      }
      ctx.setCloud({ accountId: chosen.id, accountName: chosen.name });
      return { message: chosen.name, detail: chosen.id };
    },
    async verify(ctx) {
      return Boolean(ctx.cloud.accountId) && Boolean(ctx.state().cloud && ctx.state().cloud.accountId === ctx.cloud.accountId);
    },
  };
}

function urlStep() {
  return {
    id: 'url',
    title: 'Finding the Worker URL',
    async run(ctx) {
      const accountId = ctx.cloud.accountId;
      const subdomain = await ctx.api.subdomain(accountId);
      ctx.setCloud({ subdomain: subdomain || null });
      if (ctx.flags.domain) {
        const url = publicUrlFrom(ctx.flags.domain, WORKER_NAME);
        ctx.setCloud({ url: canonicalOrigin(url), domainSource: 'flag' });
      } else if (subdomain) {
        ctx.setCloud({ url: canonicalOrigin(publicUrlFrom(subdomain, WORKER_NAME)), domainSource: 'subdomain' });
      } else {
        throw new NeedsInputError([{ key: 'domain', label: 'Your workers.dev subdomain or a domain for this Snip', secret: false }]);
      }
      return { message: ctx.cloud.url };
    },
    async verify(ctx) {
      return Boolean(ctx.cloud.url) && Boolean(ctx.state().cloud && ctx.state().cloud.url === ctx.cloud.url);
    },
  };
}

function r2Step() {
  return {
    id: 'r2',
    title: 'Checking R2',
    async run(ctx) {
      const accountId = ctx.cloud.accountId;
      const started = ctx.deps.now();
      for (;;) {
        ctx.checkCancel();
        let buckets;
        try {
          buckets = await ctx.deps.cloud.listBuckets(ctx.wrangler, { accountId });
        } catch (error) {
          if (error.code !== 'R2_NOT_ENABLED') throw error;
          if (ctx.deps.now() - started > 10 * 60_000) {
            throw new StepError('R2_NOT_ENABLED', 'R2 is still turned off on this Cloudflare account.', {
              hint: 'Enable R2 in the Cloudflare dashboard (R2 → Get started), then run setup again. Everything already done is kept.',
            });
          }
          ctx.emit.step('r2', 'waiting', 'Waiting for R2 to be enabled in Cloudflare');
          ctx.emit.human('r2', 'enable_r2', 'https://dash.cloudflare.com/?to=/:account/r2/overview', 'Enable R2 in the browser, then come back');
          await ctx.deps.sleep(5000);
          continue;
        }
        ctx.setCloud({ r2Enabled: true, buckets: buckets.map((entry) => entry.name) });
        return { message: 'R2 is ready', detail: JSON.stringify({ buckets: buckets.length }) };
      }
    },
    async verify(ctx) {
      try {
        await ctx.deps.cloud.listBuckets(ctx.wrangler, { accountId: ctx.cloud.accountId });
        return true;
      } catch {
        return false;
      }
    },
  };
}

function resourcesStep() {
  return {
    id: 'resources',
    title: 'Creating storage',
    async run(ctx) {
      const accountId = ctx.cloud.accountId;
      // guard is the only classifier (invariant 19). Resources consumes the
      // outcome guard persisted in cloud.json, because guard may have been
      // verified-and-skipped on this invocation. The assert can only refuse.
      const outcome = (ctx.state().cloud || {}).outcome;
      if (!outcome) {
        throw new StepError('GUARD_MISSING', 'The account was never classified.', {
          hint: 'Run setup again; the guard step runs before anything is created.',
          retryable: true,
        });
      }
      if (outcome === 'foreign') throw foreignError(ctx, { database: null });

      const databases = await ctx.deps.cloud.listD1(ctx.wrangler, { accountId });
      let database = databases.find((entry) => entry.name === D1_NAME) || null;
      const created = {};
      if (!database) {
        database = await ctx.deps.cloud.createD1(ctx.wrangler, { accountId });
        created.d1 = { name: D1_NAME, id: database.id };
      }

      const namespaces = await ctx.deps.cloud.listKv(ctx.wrangler, { accountId });
      let namespace = namespaces.find((entry) => entry.title === KV_NAME) || null;
      if (!namespace) {
        namespace = await ctx.deps.cloud.createKv(ctx.wrangler, { accountId });
        created.kv = { name: KV_NAME, id: namespace.id };
      }

      const buckets = await ctx.deps.cloud.listBuckets(ctx.wrangler, { accountId });
      let bucket = buckets.some((entry) => entry.name === BUCKET_NAME) ? null : null;
      if (!buckets.some((entry) => entry.name === BUCKET_NAME)) {
        await ctx.deps.cloud.createBucket(ctx.wrangler, { accountId });
        created.bucket = BUCKET_NAME;
      }
      bucket = BUCKET_NAME;

      // `created` is the abort scope: abort may delete only what this run made.
      ctx.setCloud({ d1: { name: D1_NAME, id: database.id }, kv: { name: KV_NAME, id: namespace.id }, bucket, created });
      return { message: 'Database, key-value store and bucket ready', detail: JSON.stringify({ d1: database.id, kv: namespace.id }) };
    },
    async verify(ctx) {
      const record = ctx.state().cloud || {};
      return Boolean(record.d1 && record.d1.id && record.kv && record.kv.id && record.bucket);
    },
  };
}

function guardStep() {
  return {
    id: 'guard',
    title: 'Checking this Cloudflare account',
    async run(ctx) {
      // guard is the only classifier: it runs once, records the outcome in
      // work.classification for the later steps, and names the install.
      const facts = await ctx.deps.classify(ctx);
      ctx.setWork({ classification: facts });
      if (facts.outcome === 'foreign') throw foreignError(ctx, facts);
      // Persist the decision: a later invocation may skip this step entirely,
      // and resources/verify/secrets must still know what was decided.
      ctx.setCloud({ outcome: facts.outcome });

      if (facts.outcome === 'adopt-existing') {
        if (!ctx.flags.adoptExisting) {
          throw new ChoiceRequired({
            id: 'existing-library',
            message: 'This Cloudflare account already has a Snip library.',
            data: { url: facts.url, counts: facts.counts },
            options: [
              {
                id: 'adopt-existing',
                label: 'Use that library',
                detail: 'Switches this Mac to it. Your local library is kept and is not copied.',
                command: 'npm run setup:cloudflare -- setup --adopt-existing',
              },
              { id: 'stop', label: 'Stop', detail: 'Changes nothing.' },
            ],
            resumeWith: '--adopt-existing',
          });
        }
        // Take option 1: adopt the existing library, copy nothing.
        ctx.setWork({ adopted: 'existing' });
        ctx.setCloud({
          adoptedAt: new Date().toISOString(),
          adoptedFrom: 'legacy',
          adoptedLibrary: facts.counts,
          move: { status: 'skipped', reason: 'adopted-existing' },
        });
        await recordLiveSnapshot(ctx);
      } else if (facts.outcome === 'adopt-empty') {
        ctx.setWork({ adopted: 'empty' });
        ctx.setCloud({ adoptedAt: new Date().toISOString(), adoptedFrom: 'legacy', adoptedLibrary: facts.counts });
      } else if (facts.outcome === 'resume' && ctx.cloud.detachedAt) {
        // Re-enabling a detached copy of this Mac's own library. beginEnabling
        // has already set mode `enabling`, so `detachedAt` is what distinguishes
        // this from an interrupted run. The cloud copy is the one that kept
        // running, so it is adopted rather than overwritten by a fresh import;
        // the local library stays exactly where it is.
        ctx.setWork({ adopted: 'existing' });
        ctx.setCloud({
          adoptedAt: new Date().toISOString(),
          adoptedFrom: 'detached',
          adoptedLibrary: facts.counts,
          move: { status: 'skipped', reason: 'detached' },
        });
        await recordLiveSnapshot(ctx);
      }

      const record = ctx.state().cloud || {};
      // Every non-resume outcome is this Mac's install from here on, so a later
      // run recognises it instead of asking again. `resume` already has it.
      if (facts.outcome !== 'resume') ctx.setCloud({ workerName: WORKER_NAME });
      if (!record.workerName) ctx.setCloud({ workerName: WORKER_NAME });
      if (!ctx.cloud.ownerId) ctx.setCloud({ ownerId: ctx.flags.login || guessLogin(ctx.root) || 'owner' });
      // Record what was found, so a resume can recognise its own install.
      ctx.journal('guard', 'done', JSON.stringify({ outcome: facts.outcome, worker: Boolean(facts.worker), d1: facts.database ? facts.database.id : null }));
      return {
        message: facts.outcome === 'fresh'
          ? 'This account is free'
          : ctx.isMoveSkipped()
            ? `Using this Mac’s existing cloud library (${facts.counts.refs} reference${facts.counts.refs === 1 ? '' : 's'})`
          : facts.outcome === 'resume'
            ? 'Continuing this Mac’s own setup'
            : facts.outcome === 'adopt-empty'
              ? 'Adopting this account’s empty Snip'
              : `Using the existing Snip library (${facts.counts.refs} reference${facts.counts.refs === 1 ? '' : 's'})`,
        data: { outcome: facts.outcome },
      };
    },
    async verify(ctx) {
      return Boolean(ctx.state().cloud && ctx.state().cloud.workerName === WORKER_NAME && ctx.cloud.accountId);
    },
  };
}

function configStep() {
  return {
    id: 'config',
    title: 'Preparing the deploy',
    async run(ctx) {
      const state = ctx.state();
      const record = state.cloud || {};
      const login = ctx.flags.login || guessLogin(ctx.root) || record.login || null;
      const ownerId = ctx.cloud.ownerId || record.ownerId || login || 'owner';
      const layout = ctx.deps.deploy.prepareDeployLayout({
        root: ctx.root,
        dataRoot: ctx.dataRoot,
        d1Id: ctx.cloud.d1.id,
        kvId: ctx.cloud.kv.id,
        login: login || undefined,
        url: ctx.cloud.url,
      });
      ctx.setCloud({ ownerId, login: login || null, configPath: layout.file, preparedAt: layout.copiedAt });
      return { message: path.relative(ctx.dataRoot, layout.file), detail: layout.file };
    },
    async verify(ctx) {
      const config = ctx.deps.deploy.readDeployConfig(ctx.dataRoot);
      if (!config) return false;
      const record = ctx.state().cloud || {};
      return Boolean(
        config.d1_databases?.[0]?.database_id === record.d1?.id
        && config.kv_namespaces?.[0]?.id === record.kv?.id
        && config.vars?.PUBLIC_URL === record.url
        && config.main === 'index.js'
        && config.assets?.directory === '../client',
      );
    },
  };
}

function schemaStep() {
  return {
    id: 'schema',
    title: 'Applying database migrations',
    async run(ctx) {
      const result = await ctx.deps.deploy.applyMigrations(ctx.wrangler, { dataRoot: ctx.dataRoot, accountId: ctx.cloud.accountId, remote: true, retry: retryOf(ctx) });
      const text = `${result.stdout}${result.stderr}`;
      const applied = (text.match(/Migrations to be applied:/) ? text.split('Migrations to be applied:')[1] : '')
        .split('\n').map((line) => line.trim()).filter((line) => /^\d{4}_/.test(line));
      return { message: applied.length ? `Applied ${applied.length} migration${applied.length === 1 ? '' : 's'}` : 'Database is up to date', detail: applied.join(', ') };
    },
    async verify(ctx) {
      const result = await ctx.deps.deploy.listMigrations(ctx.wrangler, { dataRoot: ctx.dataRoot, accountId: ctx.cloud.accountId, remote: true });
      return result.ok && /No migrations to apply/i.test(`${result.stdout}${result.stderr}`);
    },
  };
}

function deployStep() {
  return {
    id: 'deploy',
    title: 'Deploying Snip',
    async run(ctx) {
      const hash = bundleHash(ctx.dataRoot);
      await ctx.deps.deploy.deployWorker(ctx.wrangler, { dataRoot: ctx.dataRoot, accountId: ctx.cloud.accountId, retry: retryOf(ctx) });
      const exists = await ctx.api.workerExists(ctx.cloud.accountId, WORKER_NAME);
      if (!exists) {
        throw new StepError('DEPLOY_MISSING', 'The deploy finished but the Worker was not found.', { hint: 'Run setup again; finished steps are skipped.' });
      }
      ctx.setCloud({ bundleHash: hash, lastDeployedAt: new Date().toISOString() });
      return { message: `Live at ${ctx.cloud.url}` };
    },
    async verify(ctx) {
      const record = ctx.state().cloud || {};
      if (!record.bundleHash || record.bundleHash !== bundleHash(ctx.dataRoot)) return false;
      try {
        return await ctx.api.workerExists(ctx.cloud.accountId, WORKER_NAME);
      } catch {
        return false;
      }
    },
  };
}

function secretsStep() {
  return {
    id: 'secrets',
    title: 'Saving Worker secrets',
    async run(ctx) {
      const accountId = ctx.cloud.accountId;
      const existing = new Set(await ctx.deps.cloud.listSecrets(ctx.wrangler, { dataRoot: ctx.dataRoot, accountId }));
      const stored = ctx.secrets() || {};
      const adopted = Boolean((ctx.state().cloud || {}).adoptedFrom);
      const next = { ...stored };
      // Adoption rules (§1.10): never overwrite SESSION_SECRET (it would log every
      // browser out), always rotate CAPTURE_TOKEN (its only holder is the capture
      // agent this run rewrites), and keep OWNER_LINK_SECRET and GitHub when present.
      if (!next.captureToken || adopted) next.captureToken = randomSecret();
      if (!next.ownerLinkSecret) next.ownerLinkSecret = randomSecret();
      const values = {};
      if (!existing.has('SESSION_SECRET')) values.SESSION_SECRET = randomSecret();
      if (adopted || !existing.has('CAPTURE_TOKEN')) values.CAPTURE_TOKEN = next.captureToken;
      // An owner secret can only be kept if this Mac has a copy to match it;
      // a Worker secret cannot be read back. Without a local copy the legacy
      // value is unusable, so it is replaced (owner links are new in this design,
      // so a legacy install has nothing to preserve).
      if (!existing.has('OWNER_LINK_SECRET') || !stored.ownerLinkSecret) values.OWNER_LINK_SECRET = next.ownerLinkSecret;
      if (Object.keys(values).length) await ctx.deps.cloud.putSecrets(ctx.wrangler, { dataRoot: ctx.dataRoot, accountId, secrets: values, retry: retryOf(ctx) });
      ctx.saveSecrets(next);

      // TRANSFER_TOKEN is the engine's only cloud credential; it is set here and
      // deleted by finish.
      const transferToken = ctx.transferToken() || randomSecret();
      await ctx.deps.cloud.putSecrets(ctx.wrangler, { dataRoot: ctx.dataRoot, accountId, secrets: { TRANSFER_TOKEN: transferToken }, retry: retryOf(ctx) });
      ctx.setTransferToken(transferToken);

      const names = ['SESSION_SECRET', 'CAPTURE_TOKEN', 'OWNER_LINK_SECRET', 'TRANSFER_TOKEN'];
      const proof = {};
      // Functional proof that the deployed Worker reads the values it was given.
      // `/agent/ping` is a GET; a 426 there would mean the protocol header is
      // missing, which is also a failure of this check.
      try {
        const ping = await ctx.deps.fetch(new URL('/agent/ping', ctx.cloud.url), {
          method: 'GET',
          headers: { authorization: `Bearer ${next.captureToken}`, 'x-snip-capture-protocol': '3' },
          signal: AbortSignal.timeout(15000),
        });
        proof.captureToken = ping.ok;
        if (!ping.ok) throw new StepError('SECRET_VERIFY_FAILED', 'The deployed Snip did not accept its capture token.', { hint: 'Run setup again; the secrets are re-applied.' });
      } catch (error) {
        if (error instanceof StepError) throw error;
        ctx.emit.log('warn', `Could not reach ${ctx.cloud.url} yet (${error.message}); the secret check will run again on the next step.`);
        proof.captureToken = null;
      }
      // A secret write is not instantly live at the edge, so the first status
      // request right after `secret bulk` can still 404. Poll rather than
      // declaring a good deploy broken. The run's transfer client comes from
      // the injectable factory so a resumed run and a test both keep working.
      const status = await ctx.waitForTransferStatus();
      // One version constant lives in the Worker; record exactly what this deploy
      // reported so later checks compare against a record, not an engine constant.
      if (!status) {
        throw new StepError('VERSION_UNREADABLE', 'The deployed Snip did not report a version.', {
          hint: 'Check the Worker in the Cloudflare dashboard, then run setup again.',
        });
      }
      proof.ownerLinkSecret = status.ownerSecretHash === ownerSecretHash(next.ownerLinkSecret);
      if (proof.ownerLinkSecret === false) {
        ctx.saveSecrets({ ...next });
        throw new StepError('SECRET_DRIFT', 'The deployed Worker is using a different owner secret than this Mac.', { hint: 'Run `owner rotate` to replace it.' });
      }
      ctx.setCloud({ secretsAt: new Date().toISOString(), workerVersion: status.version });
      return { message: names.join(', '), detail: JSON.stringify(proof) };
    },
    async verify(ctx) {
      const record = ctx.state().cloud || {};
      const stored = ctx.secrets();
      if (!record.secretsAt || !stored || !stored.ownerLinkSecret || !stored.captureToken) return false;
      const names = new Set(await ctx.deps.cloud.listSecrets(ctx.wrangler, { dataRoot: ctx.dataRoot, accountId: ctx.cloud.accountId }));
      return ['SESSION_SECRET', 'CAPTURE_TOKEN', 'OWNER_LINK_SECRET'].every((name) => names.has(name));
    },
  };
}

function quiesceStep() {
  return {
    id: 'quiesce',
    title: 'Pausing captures',
    skip: async (ctx) => (await ctx.libraryFacts()).empty === true || ctx.isMoveSkipped(),
    skipMessage: (ctx) => ctx.isMoveSkipped() ? 'Using the existing cloud library; nothing is paused' : 'This library is empty, so there is nothing to pause',
    async run(ctx) {
      const { localOrigin: origin } = await ctx.libraryFacts();
      const paused = new Set(ctx.state().pausedForMove || []);
      // With Snip quit (which an unmanaged run asks for) nothing can be capturing, and the
      // queued references are copied as queued, so there is no API to pause through.
      const api = origin && (await ctx.deps.local.reachable(origin)) ? ctx.deps.local.createLocalApi(origin) : null;
      if (api) {
        for (const status of ['queued', 'capturing']) {
          for (const reference of await api.listReferences(status)) {
            ctx.checkCancel();
            const result = await api.pauseReference(reference.id);
            if (result.ok) paused.add(reference.id);
          }
        }
        const deadline = ctx.deps.now() + 60_000;
        for (;;) {
          ctx.checkCancel();
          const agent = await api.agent().catch(() => null);
          const busy = agent && agent.activity === 'busy';
          if (!busy || ctx.deps.now() > deadline) break;
          await ctx.deps.sleep(1000);
        }
      }
      ctx.setPausedForMove([...paused]);
      return { message: paused.size ? `Paused ${paused.size} capture${paused.size === 1 ? '' : 's'}` : 'Nothing was capturing', detail: JSON.stringify({ paused: [...paused] }) };
    },
    async verify(ctx) {
      const { localOrigin: origin } = await ctx.libraryFacts();
      if (!origin || !(await ctx.deps.local.reachable(origin))) return true;
      const agent = await ctx.deps.local.createLocalApi(origin).agent().catch(() => null);
      return !agent || agent.activity !== 'busy';
    },
  };
}

/**
 * This Mac's own library, kept exactly where it is. Nothing was copied, so it is
 * `live` with no path: detach is the action, and restore or delete are refused.
 * Only the reference count is read (a local D1 query); the bucket needs a Worker
 * and the app may be running, so files and bytes stay unknown rather than 0.
 */
async function recordLiveSnapshot(ctx) {
  let refs = null;
  try {
    const facts = await ctx.libraryFacts();
    if (facts.localConfig) {
      const rows = await ctx.deps.deploy.localQuery(ctx.wrangler, {
        dataRoot: ctx.dataRoot,
        sql: 'SELECT COUNT(*) AS rows FROM refs',
        config: facts.localConfig,
        persistTo: ctx.deps.local.localStatePath(ctx.dataRoot),
      });
      refs = Number((rows[0] && rows[0].rows) || 0);
    }
  } catch {
    refs = null;
  }
  const takenAt = new Date().toISOString();
  ctx.save((next) => {
    next.snapshot = { kind: 'live', path: null, keptLocal: true, takenAt, ...(refs === null ? {} : { refs }) };
    return next;
  });
}

function exportStep() {
  return {
    id: 'export',
    title: 'Copying the library snapshot',
    skip: async (ctx) => (await ctx.libraryFacts()).empty === true || ctx.isMoveSkipped(),
    skipMessage: (ctx) => ctx.isMoveSkipped() ? 'Using the existing cloud library; nothing is copied' : 'This library is empty, so there is nothing to copy',
    async run(ctx) {
      // Export runs after release, so this Worker is the only one on the persist
      // directory. It reads the bucket through the real FILES binding; the D1
      // dump comes from wrangler against the same directory.
      const directory = path.join(ctx.dataRoot, 'backups', `cloud-export-${new Date().toISOString().replace(/[:.]/g, '-')}`);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const dump = path.join(directory, 'dump.sql');
      await ctx.deps.deploy.exportLocal(ctx.wrangler, {
        dataRoot: ctx.dataRoot,
        output: dump,
        config: (await ctx.libraryFacts()).localConfig,
      });

      const token = ctx.transferToken() || randomSecret();
      ctx.setTransferToken(token);
      const exported = await ctx.deps.library.withLocalWorker({ root: ctx.root, dataRoot: ctx.dataRoot, token, release: ctx.release === true, log: (line) => ctx.emit.log('info', line) }, async (handle) => {
        const manifest = await handle.transfer.manifest();
        const sql = fs.readFileSync(dump, 'utf8');
        const tables = { ...(manifest.tables || {}) };
        const counts = countsFromDump(sql);
        for (const [table, count] of Object.entries(counts)) {
          // The dump mentions SQLite internals (`sqlite_sequence`) that carry no
          // library meaning and legitimately differ between two databases.
          if (/^(sqlite_|_cf_|_mf_)/.test(table)) continue;
          if (!(table in tables)) tables[table] = count;
        }
        const keys = (manifest.keys || []).map((entry) => ({
          key: entry.key,
          size: Number(entry.size) || 0,
          contentType: entry.contentType || 'application/octet-stream',
        }));
        // An empty manifest next to real references is a broken read, not an
        // empty library: never let two zeros pass for a verified copy.
        if ((Number(tables.refs) || 0) > 0 && keys.length === 0) {
          throw new StepError('EXPORT_EMPTY', 'This library has references but no files, so the copy would be incomplete.', {
            hint: 'Run `npm run doctor` to check the library, then run setup again. Nothing was changed.',
            data: { refs: tables.refs, keys: 0 },
          });
        }
        const columns = columnsFromDump(sql);
        // Tables the Worker excludes from a copy (single-use nonces, challenges)
        // are never compared: they are per-device and short-lived.
        const excluded = Array.isArray(manifest.excluded) ? manifest.excluded.filter((name) => typeof name === 'string') : [];
        fs.writeFileSync(path.join(directory, 'files.json'), `${JSON.stringify({ keys, excluded })}\n`, { mode: 0o600 });
        return { tables, keys, columns, excluded, totalBytes: keys.reduce((sum, entry) => sum + entry.size, 0) };
      });
      fs.writeFileSync(path.join(directory, 'manifest.json'), `${JSON.stringify({ takenAt: new Date().toISOString(), tables: exported.tables, keys: exported.keys.length, bytes: exported.totalBytes }, null, 2)}\n`, { mode: 0o600 });
      ctx.setWork({ library: { ...exported, directory } });
      const at = new Date().toISOString();
      const counts = {
        refs: exported.tables.refs || 0,
        files: exported.keys.length,
        bytes: exported.totalBytes,
      };
      ctx.save((next) => {
        // The local library never moved, so there is nothing to restore: it is
        // `live`. The dump is a separate, delete-only export (contracts §1.11).
        next.snapshot = { kind: 'live', path: null, keptLocal: true, takenAt: at, ...counts };
        next.snapshot.export = { path: path.relative(ctx.dataRoot, directory), takenAt: at, ...counts };
        return next;
      });
      return {
        message: `${exported.keys.length} file${exported.keys.length === 1 ? '' : 's'}, ${exported.tables.refs || 0} reference${(exported.tables.refs || 0) === 1 ? '' : 's'}`,
        detail: path.relative(ctx.dataRoot, directory),
      };
    },
    async verify(ctx) {
      const exported = snapshotOf(ctx);
      if (!exported) return false;
      return fs.existsSync(path.join(ctx.dataRoot, exported.path, 'dump.sql')) && fs.existsSync(path.join(ctx.dataRoot, exported.path, 'files.json'));
    },
  };
}

/** The export directory of this install, or null. Never an export-shaped `path`. */
function snapshotOf(ctx) {
  const snapshot = ctx.state().snapshot;
  return snapshotModule.exportOf(snapshot);
}

function releaseStep() {
  return {
    id: 'release',
    title: 'Waiting for the local server to stop',
    skip: async (ctx) => (await ctx.libraryFacts()).empty === true || ctx.isMoveSkipped(),
    skipMessage: (ctx) => ctx.isMoveSkipped() ? 'Using the existing cloud library; the local server stays up' : 'This library is empty, so nothing holds the library open',
    async run(ctx) {
      const { localOrigin: origin } = await ctx.libraryFacts();
      if (!origin) return { message: 'Nothing is serving this library' };
      const deadline = ctx.deps.now() + 30_000;
      while (ctx.deps.now() < deadline) {
        ctx.checkCancel();
        if (!(await ctx.deps.local.reachable(origin))) return { message: `Stopped ${new URL(origin).host}` };
        await ctx.deps.sleep(500);
      }
      throw new StepError('LOCAL_SERVER_STILL_RUNNING', 'The local server is still running, so the library cannot be released.', {
        hint: 'Quit Snip.app, then run the same command again. Everything provisioned so far is kept and the run resumes at this step.',
        data: { origin },
      });
    },
    async verify(ctx) {
      const { localOrigin: origin } = await ctx.libraryFacts();
      return !origin || !(await ctx.deps.local.reachable(origin));
    },
  };
}

function importStep() {
  return {
    id: 'import',
    title: 'Copying the library to Cloudflare',
    skip: async (ctx) => (await ctx.libraryFacts()).empty === true || ctx.isMoveSkipped(),
    skipMessage: (ctx) => ctx.isMoveSkipped() ? 'Using the existing cloud library; nothing is uploaded' : 'This library is empty, so there is nothing to upload',
    async run(ctx) {
      const record = ctx.state().cloud || {};
      const exported = snapshotOf(ctx);
      if (!exported) throw new StepError('IMPORT_FAILED', 'There is no export to copy.', { hint: 'Run setup again; the export step runs before this one.' });
      const directory = path.join(ctx.dataRoot, exported.path);
      const dump = path.join(directory, 'dump.sql');
      const files = JSON.parse(fs.readFileSync(path.join(directory, 'files.json'), 'utf8')).keys || [];
      const statements = splitSqlStatements(fs.readFileSync(dump, 'utf8'));
      const tables = Object.keys(snapshotTables(exported, directory));

      // A Worker older than 1.4.0 accepts gzipped pages but serves their raw bytes, so its HTML and CSS views would be
      // garbage. Ask before writing anything. This guards copies made by this engine; an older app cannot be changed.
      const compressed = files.filter((entry) => isGzipKey(entry.key)).length;
      if (compressed) {
        const remote = await ctx.transfer().status();
        if (remote && !(Array.isArray(remote.reads) && remote.reads.includes('gzip'))) {
          throw new StepError('DESTINATION_TOO_OLD', `The cloud Snip runs Worker ${remote.version || 'of an unknown version'}, which can’t read the ${compressed} compressed page file${compressed === 1 ? '' : 's'} in this library.`, {
            hint: 'Deploy this version of Snip to it (`npm run setup:cloudflare -- deploy`), then run setup again. Nothing was copied.',
            data: { version: remote.version || null, compressed },
          });
        }
      }

      // The remote is fresh (guard proved it). A resumed import truncates and
      // re-runs, so a half-applied dump is never left behind.
      const resumed = (ctx.state().steps || []).some((step) => step.id === 'import' && step.status === 'failed');
      if (resumed && tables.length) {
        await ctx.deps.deploy.remoteQuery(ctx.wrangler, {
          dataRoot: ctx.dataRoot,
          accountId: ctx.cloud.accountId,
          sql: tables.map((table) => `DELETE FROM "${table}"`).join(';') + ';',
        }).catch(() => {});
      }

      await ctx.deps.deploy.importRemote(ctx.wrangler, {
        dataRoot: ctx.dataRoot,
        accountId: ctx.cloud.accountId,
        statements,
        onBatch: ({ index, total }) => ctx.emit.log('info', `Database batch ${index}/${total}`),
      });

      const transfer = ctx.transfer();
      // Sizes come from one bucket listing. A HEAD is not usable for this: the
      // edge strips content-length from a bodyless response, so every object
      // would look empty.
      const remote = await transfer.manifest();
      const existing = new Map((remote.keys || []).map((entry) => [entry.key, Number(entry.size) || 0]));
      let uploaded = 0;
      let skipped = 0;
      const queue = [...files];
      const token = ctx.transferToken() || randomSecret();
      ctx.setTransferToken(token);
      await ctx.deps.library.withLocalWorker({ root: ctx.root, dataRoot: ctx.dataRoot, token, release: ctx.release === true, log: (line) => ctx.emit.log('info', line) }, async (handle) => {
        const deliver = async () => {
          for (;;) {
            ctx.checkCancel();
            const entry = queue.shift();
            if (!entry) return;
            if (existing.get(entry.key) === entry.size) {
              skipped++;
              continue;
            }
            const response = await handle.transfer.get(entry.key);
            if (!response) {
              throw new StepError('IMPORT_FILE_MISSING', 'A file in the snapshot could not be read from the library.', {
                data: { key: entry.key },
              });
            }
            // Stream straight through; never buffer a capture in memory.
            await transfer.put(entry.key, response.body, { size: entry.size, overwrite: true, contentType: entry.contentType });
            uploaded++;
          }
        };
        await Promise.all(Array.from({ length: Math.min(6, Math.max(1, files.length)) }, deliver));
      });

      return {
        message: `${uploaded} file${uploaded === 1 ? '' : 's'} uploaded${skipped ? `, ${skipped} already there` : ''}`,
        detail: JSON.stringify({ uploaded, skipped, statements: statements.length }),
      };
    },
    async verify(ctx) {
      const exported = snapshotOf(ctx);
      if (!exported) return false;
      const remote = await ctx.transfer().status().catch(() => null);
      if (!remote || !remote.counts) return false;
      const local = snapshotTables(exported, path.join(ctx.dataRoot, exported.path));
      return Number(remote.counts.refs || 0) === Number(local.refs || 0);
    },
  };
}

/** Tables recorded in the snapshot manifest. */
function snapshotTables(snapshot, directory) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
    return manifest.tables || {};
  } catch {
    return {};
  }
}

/** Tables the Worker said are not part of a copy. */
/** The tables the Worker said it copies as schema only, with its documented default. */
function snapshotExcluded(directory) {
  try {
    const files = JSON.parse(fs.readFileSync(path.join(directory, 'files.json'), 'utf8'));
    return lib.excludedTables(files.excluded);
  } catch {
    return lib.excludedTables(undefined);
  }
}

function verifyStep() {
  return {
    id: 'verify',
    title: 'Checking the copy',
    // An adopted library was not copied, so it is still checked below; an empty
    // local library has nothing to compare.
    skip: async (ctx) => (await ctx.libraryFacts()).empty === true && !ctx.isMoveSkipped(),
    skipMessage: () => 'This library is empty, so there is nothing to check',
    async run(ctx) {
      const record = ctx.state().cloud || {};
      if (ctx.isMoveSkipped()) {
        // No copy was made, so there is nothing to compare: check the adopted
        // library is reachable and readable, and record its real counts.
        const status = await ctx.deps.transferOf(ctx).status().catch(() => null);
        if (!status || !status.counts) {
          throw new StepError('VERIFY_UNREACHABLE', 'The existing cloud library did not answer.', {
            hint: 'Open its URL in a browser to check it, then run setup again.',
            data: { url: record.url },
          });
        }
        ctx.save((next) => {
          next.transfer = { tables: status.counts, keys: 0, bytes: 0, verifiedAt: new Date().toISOString() };
          next.cloud = { ...(next.cloud || {}), lastVerifiedAt: new Date().toISOString() };
          return next;
        });
        return {
          message: `adopted · ${status.counts.refs} reference${Number(status.counts.refs) === 1 ? '' : 's'}`,
          data: { adopted: true, counts: status.counts },
        };
      }

      const exported = snapshotOf(ctx);
      if (!exported) throw new StepError('EXPORT_MISSING', 'This install has no export to check.', { hint: 'Run setup again.' });
      const directory = path.join(ctx.dataRoot, exported.path);
      const files = JSON.parse(fs.readFileSync(path.join(directory, 'files.json'), 'utf8')).keys || [];
      const dump = path.join(directory, 'dump.sql');
      const columns = columnsFromDump(fs.readFileSync(dump, 'utf8'));
      // Compare only what the manifest says holds rows: an excluded table is
      // skipped by name, and nothing is required to be listed, so a newer Worker
      // can add or drop an exclusion without an engine change.
      const tables = lib.comparableTables(snapshotTables(exported, directory), snapshotExcluded(directory));

      const remotePerTable = {};
      const localPerTable = {};
      for (const table of tables) {
        const sql = digestSql(table, columns[table] || []);
        const remoteRow = (await ctx.deps.deploy.remoteQuery(ctx.wrangler, { dataRoot: ctx.dataRoot, accountId: ctx.cloud.accountId, sql }))[0] || {};
        const localRow = (await ctx.deps.deploy.localQuery(ctx.wrangler, {
          dataRoot: ctx.dataRoot,
          sql,
          config: (await ctx.libraryFacts()).localConfig,
          persistTo: ctx.deps.local.localStatePath(ctx.dataRoot),
        }))[0] || {};
        remotePerTable[table] = { rows: Number(remoteRow.rows) || 0, sig: Number(remoteRow.sig) || 0 };
        localPerTable[table] = { rows: Number(localRow.rows) || 0, sig: Number(localRow.sig) || 0 };
        if (remotePerTable[table].rows !== localPerTable[table].rows) {
          throw new StepError('VERIFY_COUNT_MISMATCH', `The cloud copy of ${table} has a different number of rows.`, {
            hint: 'Run setup again; the copy is re-imported from the snapshot.',
            data: { table, local: localPerTable[table].rows, remote: remotePerTable[table].rows },
          });
        }
      }
      const digest = digestOf(remotePerTable);
      if (digest !== digestOf(localPerTable)) {
        throw new StepError('VERIFY_DIGEST_MISMATCH', 'The cloud copy does not match the local library.', {
          hint: 'Run setup again; the copy is re-imported from the snapshot.',
          data: { digest, localDigest: digestOf(localPerTable) },
        });
      }

      // An empty remote manifest next to real rows is a broken copy, not a
      // successful one; this is the same guard export applies locally.
      const remoteManifest = (tables.includes('refs') ? (await ctx.deps.deploy.remoteQuery(ctx.wrangler, {
        dataRoot: ctx.dataRoot,
        accountId: ctx.cloud.accountId,
        sql: 'SELECT COUNT(*) AS rows FROM refs',
      }))[0] : null) || null;

      const transfer = ctx.transfer();
      const manifest = await transfer.manifest();
      const remoteSizes = new Map((manifest.keys || []).map((entry) => [entry.key, Number(entry.size) || 0]));
      let present = 0;
      const missing = [];
      for (const entry of files) {
        const size = remoteSizes.has(entry.key) ? remoteSizes.get(entry.key) : null;
        if (size === null) missing.push(entry.key);
        else if (size !== entry.size) {
          throw new StepError('VERIFY_SIZE_MISMATCH', 'A file in the cloud copy has a different size.', { data: { key: entry.key, local: entry.size, remote: size } });
        } else present++;
      }
      if (missing.length) {
        throw new StepError('VERIFY_FILES_MISSING', `${missing.length} file${missing.length === 1 ? '' : 's'} did not arrive in the cloud copy.`, {
          hint: 'Run setup again; missing files are uploaded without redoing the rest.',
          data: { missing: missing.slice(0, 10) },
        });
      }
      if (remoteManifest && Number(remoteManifest.rows) > 0 && present === 0) {
        throw new StepError('EXPORT_EMPTY', 'This library has references but no files, so the copy is incomplete.', {
          hint: 'Run `npm run doctor` to check the library, then run setup again.',
          data: { refs: Number(remoteManifest.rows), keys: 0 },
        });
      }

      const counted = snapshotTables(exported, directory);
      const entries = Object.values(counted).reduce((sum, count) => sum + (Number(count) || 0), 0);
      ctx.save((next) => {
        next.transfer = {
          tables: counted,
          keys: present,
          bytes: files.reduce((sum, entry) => sum + entry.size, 0),
          digest,
          verifiedAt: new Date().toISOString(),
        };
        next.cloud = { ...(next.cloud || {}), lastVerifiedAt: new Date().toISOString() };
        return next;
      });
      return {
        message: `${entries} row${entries === 1 ? '' : 's'}, ${present} file${present === 1 ? '' : 's'}, all verified`,
        detail: digest,
        data: { digest, tables: counted, keys: present },
      };
    },
    async verify(ctx) {
      return Boolean(ctx.state().transfer && ctx.state().transfer.verifiedAt);
    },
  };
}

function ownerStep() {
  return {
    id: 'owner',
    title: 'Signing this Mac in',
    async run(ctx) {
      const stored = ctx.secrets() || {};
      if (!stored.ownerLinkSecret) throw new StepError('SECRET_MISSING', 'The owner sign-in secret is missing.', { hint: 'Run `owner rotate` to replace it.' });
      const transfer = ctx.deps.transferOf(ctx);
      const status = await transfer.status().catch(() => null);
      if (status && status.hasOwner) return { message: `Owner ${status.ownerId || 'owner'} is already set up` };

      const loopback = ctx.flags.managed ? startLoopback({ timeoutMs: 10 * 60_000 }) : null;
      let port = 0;
      if (loopback) {
        try { port = await loopback.listening; } catch (error) {
          throw new StepError('LOOPBACK_FAILED', 'Could not open the local sign-in handoff.', { hint: 'Try setup again.', data: { cause: error.message } });
        }
      }
      const ownerId = ctx.cloud.ownerId || 'owner';
      const minted = mintOwnerLink({ secret: stored.ownerLinkSecret, url: ctx.cloud.url, ownerId, port });
      ctx.setCloud({ ownerId, ownerLinkMintedAt: new Date().toISOString() });

      ctx.emit.human('owner', 'open_url', minted.link, 'Sign in to your Snip in the browser, then come back');
      if (!ctx.flags.noOpen && !ctx.flags['no-open']) await ctx.openUrl(minted.link).catch(() => {});

      if (loopback) {
        try {
          const token = await Promise.race([
            loopback.token,
            new Promise((_, reject) => { ctx.onCancel(() => reject(new CancelledError())); }),
          ]);
          ctx.emit.session(token, ctx.cloud.url);
        } finally {
          loopback.close();
        }
      } else {
        // No app: the browser completes the sign-in. Poll until the Worker reports an owner.
        const deadline = ctx.deps.now() + 10 * 60_000;
        for (;;) {
          ctx.checkCancel();
          const now = await transfer.status().catch(() => null);
          if (now && now.hasOwner) break;
          if (ctx.deps.now() > deadline) {
            throw new StepError('OWNER_LINK_TIMEOUT', 'The sign-in link was not completed in time.', { hint: 'Run `owner link` to mint a fresh one.' });
          }
          ctx.emit.step('owner', 'waiting', 'Waiting for the browser sign-in');
          await ctx.deps.sleep(3000);
        }
      }
      const after = await transfer.status().catch(() => null);
      if (after && !after.hasOwner) {
        ctx.emit.log('warn', 'The Worker does not report an owner yet. You can finish sign-in later with `owner link`.');
      }
      return { message: 'Signed in' };
    },
    async verify(ctx) {
      const status = await ctx.deps.transferOf(ctx).status().catch(() => null);
      return Boolean(status && status.hasOwner);
    },
  };
}

function finishStep() {
  return {
    id: 'finish',
    title: 'Finishing setup',
    async run(ctx) {
      // Resume before the token is deleted; a failure here is a warning, never a
      // failed move, because the copy itself is already verified.
      const paused = ctx.state().pausedForMove || [];
      if (paused.length) {
        try {
          const result = await ctx.transfer().resume(paused);
          ctx.emit.log('info', `Resumed ${Number(result.resumed || 0)} capture${Number(result.resumed || 0) === 1 ? '' : 's'}`);
        } catch (error) {
          ctx.emit.log('warn', `Could not resume paused captures (${error.message}). Resume them from the cloud library.`);
        }
      }
      ctx.setPausedForMove([]);

      // Contract order: resume → clear pausedForMove → mode cloud → retarget
      // capture → finish ok → delete TRANSFER_TOKEN → result.
      const transferRecord = ctx.state().transfer || null;
      const previousMove = (ctx.state().cloud || {}).move || null;
      ctx.save((next) => {
        next.mode = 'cloud';
        next.cloud = { ...(next.cloud || {}), detachedAt: null, lastVerifiedAt: new Date().toISOString() };
        // `move` says what actually happened, so Settings never has to infer it
        // from a missing count. An adoption recorded its own reason earlier.
        if (!previousMove || previousMove.status === 'completed') {
          const empty = !transferRecord;
          next.move = {
            status: empty ? 'empty' : 'completed',
            reason: null,
            at: new Date().toISOString(),
            refs: transferRecord ? Number((transferRecord.tables || {}).refs || 0) : 0,
            files: transferRecord ? Number(transferRecord.keys || 0) : 0,
            bytes: transferRecord ? Number(transferRecord.bytes || 0) : 0,
          };
        }
        next.error = null;
        return next;
      });

      const captureEnv = ctx.captureEnvText();
      const captureDir = path.join(ctx.dataRoot, 'capture');
      fs.mkdirSync(captureDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(captureDir, '.env.cloud'), captureEnv, { mode: 0o600 });
      if (ctx.captureEnvMode() === 'replace') {
        const target = path.join(captureDir, '.env');
        const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
        fs.writeFileSync(target, captureEnvText(existing, { url: ctx.cloud.url, token: (ctx.secrets() || {}).captureToken }), { mode: 0o600 });
      }
      return { message: `Snip is live at ${ctx.cloud.url}` };
    },
    async verify(ctx) {
      const state = ctx.state();
      return state.mode === 'cloud';
    },
  };
}

function setupSteps() {
  return [
    preflightStep(),
    authStep(),
    accountStep(),
    urlStep(),
    r2Step(),
    guardStep(),
    resourcesStep(),
    configStep(),
    schemaStep(),
    deployStep(),
    secretsStep(),
    quiesceStep(),
    releaseStep(),
    exportStep(),
    importStep(),
    verifyStep(),
    ownerStep(),
    finishStep(),
  ];
}

module.exports = { EMPTY_LIBRARY_STEPS, ENABLE_STEPS, classifyAccount, bundleHash, finishStep, guessLogin, ownerStep, preflightStep, readLegacyDeployConfig, setupSteps, ownerSecretHash };
