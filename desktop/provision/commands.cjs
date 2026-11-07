'use strict';
// The commands behind the CLI: setup, pull, deploy, migrate, detach,
// delete-resources, snapshot, abort, owner. Each builds its steps, runs them
// through the same runner, and returns { ok, code, mode, data }.

const fs = require('node:fs');
const path = require('node:path');
const { CancelledError, NeedsInputError, StepError } = require('./engine.cjs');
const state = require('./state.cjs');
const cloud = require('./cloud.cjs');
const deploy = require('./deploy.cjs');
const local = require('./local.cjs');
const { localWorker, withLocalWorker } = require('./library.cjs');
const { randomSecret, splitSqlStatements, canonicalOrigin, captureEnvText } = require('./lib.cjs');
const { mintOwnerLink, ownerSecretHash } = require('./transfer.cjs');
const { createContext } = require('./context.cjs');
const setupSteps = require('./setup.cjs');

const NOW = () => new Date().toISOString();

function requireCloud(ctx) {
  const record = ctx.state().cloud;
  if (!record || !record.url) {
    throw new StepError('NOT_PROVISIONED', 'This library has no cloud install.', { hint: 'Run `setup` first, or open Settings → Cloud in Snip.' });
  }
  return record;
}

// ---------- setup ----------

async function commandSetup(ctx, { steps = setupSteps.setupSteps() } = {}) {
  ctx.reload();
  const initial = ctx.state();
  if (ctx.flags.check) {
    const preflight = steps[0];
    ctx.emit.step(preflight.id, 'started', preflight.title, { progress: { done: 0, total: steps.length } });
    ctx.setWork({ libraryEmpty: false, localOrigin: local.localOrigin(ctx.dataRoot), localConfig: local.localConfig(ctx.dataRoot) });
    try {
      const data = (await preflight.run(ctx)) || {};
      ctx.emit.step(preflight.id, 'ok', data.message || 'Ready', { progress: { done: 1, total: steps.length }, data });
    } catch (error) {
      ctx.journal(preflight.id, 'failed', error.message);
      ctx.emit.step(preflight.id, 'failed', error.message, { data: error.data || {} });
      throw error;
    }
    return {
      ok: true,
      code: 'OK',
      mode: initial.mode,
      data: {
        mode: initial.mode,
        ready: true,
        pending: steps.slice(1).map((step) => step.id),
        libraryEmpty: ctx.work.libraryEmpty,
      },
    };
  }

  const { runSetup } = require('./context.cjs');
  await runSetup(ctx, steps);
  ctx.reload();
  // Contract order: finish ok → delete TRANSFER_TOKEN → result. The token has no
  // purpose after the transfer, and losing it costs nothing (a later pull mints one).
  const finished = ctx.state().cloud || {};
  if (finished.accountId && deploy.configExists(ctx.dataRoot)) {
    try { await cloud.deleteSecret(ctx.wrangler, { dataRoot: ctx.dataRoot, accountId: finished.accountId, name: 'TRANSFER_TOKEN' }); } catch {}
  }
  ctx.clearTransferToken();
  const record = ctx.state().cloud || {};
  const snapshot = ctx.state().snapshot || null;
  const transfer = record.transfer || null;
  const data = {
    url: record.url,
    accountId: record.accountId,
    refs: (transfer && transfer.tables && transfer.tables.refs) || (snapshot && snapshot.refs) || 0,
    files: (transfer && transfer.keys) || (snapshot && snapshot.files) || 0,
    bytes: (transfer && transfer.bytes) || (snapshot && snapshot.bytes) || 0,
    ownerId: record.ownerId || null,
  };
  return { ok: true, code: 'OK', mode: 'cloud', data, message: `Snip is live at ${record.url}` };
}

// ---------- pull ----------

async function commandPull(ctx) {
  ctx.reload();
  const record = requireCloud(ctx);
  if (!record.accountId) throw new StepError('NOT_PROVISIONED', 'This cloud install is incomplete.', { hint: 'Run `setup` again, or use Settings → Cloud.' });
  const token = ctx.transferToken() || ctx.secrets()?.transferToken;
  if (!token) {
    throw new StepError('TRANSFER_TOKEN_MISSING', 'This Mac no longer holds the transfer credential for its cloud library.', {
      hint: 'Run `owner rotate` from the Mac that set the library up, or enable cloud again.',
    });
  }

  const stagedRoot = path.join(ctx.dataRoot, 'backups', `pull-${NOW().replace(/[:.]/g, '-')}`);
  const stagedState = path.join(stagedRoot, 'state');
  // pull mints its own transfer token; finish deleted the setup one.
  if (!ctx.transferToken() && deploy.configExists(ctx.dataRoot)) {
    const minted = randomSecret();
    await cloud.putSecrets(ctx.wrangler, { dataRoot: ctx.dataRoot, accountId: record.accountId, secrets: { TRANSFER_TOKEN: minted } });
    ctx.setTransferToken(minted);
  }
  const steps = pullSteps({ stagedRoot, stagedState });
  await runSteps(steps, ctx);
  ctx.reload();
  return {
    ok: true,
    code: 'OK',
    mode: 'local',
    data: { stagedRoot: path.relative(ctx.dataRoot, stagedRoot), keptAt: ctx.state().cloud?.snapshot?.path || null },
    message: 'The cloud library was copied back to this Mac.',
  };
}

function pullSteps({ stagedRoot, stagedState }) {
  const ctxHolder = {};
  const manifest = { value: null, dump: null, keys: null };
  const preflight = {
    id: 'pull-preflight',
    title: 'Checking this Mac',
    async run(ctx) {
      ctxHolder.ctx = ctx;
      const record = requireCloud(ctx);
      if (ctx.state().mode !== 'cloud') {
        throw new StepError('NOT_CLOUD', 'This Mac is not using its cloud library.', {
          hint: record.detachedAt ? 'The cloud copy is detached; open it from Settings, or enable cloud again.' : 'Run `status` to see the current mode.',
        });
      }
      const origin = local.localOrigin(ctx.dataRoot);
      if (await local.reachable(origin)) {
        throw new StepError('LOCAL_SERVER_RUNNING', 'Snip is running. Quit Snip.app (or stop `npm run dev`), then run this again.', { data: { origin } });
      }
      if (deploy.runtimeProblem(ctx.root)) throw new StepError('NO_BUILD', deploy.runtimeProblem(ctx.root).message, { hint: deploy.runtimeProblem(ctx.root).hint });
      fs.mkdirSync(stagedRoot, { recursive: true, mode: 0o700 });
      return { message: 'Ready' };
    },
    async verify() { return true; },
  };

  const manifestStep = {
    id: 'pull-manifest',
    title: 'Reading the cloud library',
    async run(ctx) {
      const record = requireCloud(ctx);
      const transfer = ctx.transfer();
      const remote = await transfer.manifest();
      manifest.value = remote;
      manifest.keys = (remote.keys || []).map((entry) => ({ key: entry.key, size: Number(entry.size) || 0, contentType: entry.contentType || 'application/octet-stream' }));
      fs.mkdirSync(stagedRoot, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(stagedRoot, 'manifest.json'), `${JSON.stringify(remote, null, 2)}\n`, { mode: 0o600 });
      ctx.setWork({ pullManifest: remote });
      void record;
      return { message: `${manifest.keys.length} file${manifest.keys.length === 1 ? '' : 's'}, ${(remote.tables && remote.tables.refs) || 0} reference${((remote.tables && remote.tables.refs) || 0) === 1 ? '' : 's'}` };
    },
    async verify(ctx) {
      return Boolean(ctx.work.pullManifest);
    },
  };

  const d1Step = {
    id: 'pull-d1',
    title: 'Downloading the database',
    async run(ctx) {
      const output = path.join(stagedRoot, 'dump.sql');
      const result = await ctx.wrangler.run(['d1', 'export', 'DB', '--remote', '--no-schema', '--output', output, '--config', deploy.configPath(ctx.dataRoot)], {
        cwd: deploy.cloudDir(ctx.dataRoot),
        env: { CLOUDFLARE_ACCOUNT_ID: requireCloud(ctx).accountId },
        timeoutMs: 30 * 60_000,
      });
      if (!result.ok) {
        throw new StepError('PULL_D1_FAILED', 'The cloud database could not be exported.', {
          hint: 'Check the Cloudflare sign-in, then run `pull` again.',
          data: { output: `${result.stdout}${result.stderr}`.trim().slice(-500) },
        });
      }
      manifest.dump = output;
      return { message: 'Database downloaded' };
    },
    async verify() { return manifest.dump ? fs.existsSync(manifest.dump) : false; },
  };

  const stageStep = {
    id: 'pull-stage',
    title: 'Preparing the new library',
    async run(ctx) {
      const record = requireCloud(ctx);
      fs.rmSync(stagedState, { recursive: true, force: true });
      fs.mkdirSync(stagedState, { recursive: true, mode: 0o700 });
      const dump = manifest.dump || path.join(stagedRoot, 'dump.sql');
      const statements = splitSqlStatements(fs.readFileSync(dump, 'utf8'));
      const tables = Object.keys((manifest.value && manifest.value.tables) || {});
      const columns = {};
      for (const statement of statements) {
        void statement;
      }
      void columns;
      await deploy.applyMigrations(ctx.wrangler, { dataRoot: ctx.dataRoot, accountId: record.accountId, remote: false, local: true, persistTo: stagedState });
      const { importLocal } = require('./deploy.cjs');
      await importLocal(ctx.wrangler, { dataRoot: ctx.dataRoot, persistTo: stagedState, statements, tables, config: deploy.configPath(ctx.dataRoot) });
      ctx.setWork({ pullStagedState: stagedState });
      return { message: 'Database loaded into a new library' };
    },
    async verify(ctx) { return Boolean(ctx.work.pullStagedState); },
  };

  void ctxHolder;
  return [
    preflight,
    manifestStep,
    d1Step,
    stageStep,
    pullFilesStep({ stagedState, manifest }),
    pullVerifyStep({ stagedState, manifest }),
    pullSwapStep({ stagedRoot, stagedState }),
    pullFinishStep(),
  ];
}

function pullFilesStep({ stagedState, manifest }) {
  return {
    id: 'pull-files',
    title: 'Downloading files',
    async run(ctx) {
      const keys = manifest.keys || [];
      if (!keys.length) return { message: 'No files to copy' };
      let downloaded = 0;
      const queue = [...keys];
      const transfer = ctx.transfer();
      await withLocalWorker({ root: ctx.root, dataRoot: ctx.dataRoot, token: randomSecret(), persist: stagedState, log: (line) => ctx.emit.log('info', line) }, async (handle) => {
        const work = async () => {
          for (;;) {
            ctx.checkCancel();
            const entry = queue.shift();
            if (!entry) return;
            const existing = await handle.transfer.head(entry.key);
            if (existing !== null && existing === entry.size) continue;
            const response = await transfer.get(entry.key);
            if (!response) throw new StepError('PULL_FILE_MISSING', 'A file listed in the cloud manifest could not be downloaded.', { data: { key: entry.key } });
            await handle.transfer.put(entry.key, response.body, { size: entry.size, overwrite: true, contentType: entry.contentType });
            downloaded++;
          }
        };
        await Promise.all(Array.from({ length: Math.min(6, Math.max(1, keys.length)) }, work));
      });
      return { message: `${downloaded} file${downloaded === 1 ? '' : 's'} downloaded` };
    },
    async verify(ctx) {
      return Boolean(ctx.work.pullStagedState);
    },
  };
}

function pullVerifyStep({ stagedState, manifest }) {
  return {
    id: 'pull-verify',
    title: 'Checking the copy',
    async run(ctx) {
      const record = requireCloud(ctx);
      const tables = (manifest.value && manifest.value.tables) || {};
      const dump = path.join(path.dirname(stagedState), 'dump.sql');
      const columns = require('./lib.cjs').columnsFromDump(fs.readFileSync(dump, 'utf8'));
      const remotePerTable = {};
      const localPerTable = {};
      for (const table of Object.keys(tables)) {
        const sql = require('./lib.cjs').digestSql(table, columns[table] || []);
        const remoteRow = (await deploy.remoteQuery(ctx.wrangler, { dataRoot: ctx.dataRoot, accountId: record.accountId, sql }))[0] || {};
        const localRow = (await deploy.localQuery(ctx.wrangler, { dataRoot: ctx.dataRoot, sql, config: deploy.configPath(ctx.dataRoot), persistTo: stagedState }))[0] || {};
        remotePerTable[table] = { rows: Number(remoteRow.rows) || 0, sig: Number(remoteRow.sig) || 0 };
        localPerTable[table] = { rows: Number(localRow.rows) || 0, sig: Number(localRow.sig) || 0 };
        if (remotePerTable[table].rows !== localPerTable[table].rows) {
          throw new StepError('VERIFY_COUNT_MISMATCH', `The downloaded copy of ${table} has a different number of rows.`, {
            hint: 'Run `pull` again; the staged copy is replaced, never half-used.',
            data: { table, local: localPerTable[table].rows, remote: remotePerTable[table].rows },
          });
        }
      }
      const remoteDigest = require('./lib.cjs').digestOf(remotePerTable);
      if (remoteDigest !== require('./lib.cjs').digestOf(localPerTable)) {
        throw new StepError('VERIFY_DIGEST_MISMATCH', 'The downloaded copy does not match the cloud library.', { hint: 'Run `pull` again.' });
      }
      const keys = manifest.keys || [];
      if (Number(tables.refs || 0) > 0 && keys.length === 0) {
        throw new StepError('EXPORT_EMPTY', 'The cloud library reports references but no files.', { hint: 'Check the cloud library in a browser, then run `pull` again.' });
      }
      let present = 0;
      for (const entry of keys) {
        const response = await withLocalWorker({ root: ctx.root, dataRoot: ctx.dataRoot, token: randomSecret(), persist: stagedState, log: () => {} }, async (handle) => handle.transfer.head(entry.key));
        if (response === null) {
          throw new StepError('VERIFY_FILES_MISSING', 'A file did not arrive in the downloaded copy.', { data: { key: entry.key } });
        }
        present++;
      }
      ctx.setWork({ pullVerified: { digest: remoteDigest, keys: present, tables } });
      return { message: `${present} file${present === 1 ? '' : 's'}, all verified`, detail: remoteDigest };
    },
    async verify(ctx) { return Boolean(ctx.work.pullVerified); },
  };
}

function pullSwapStep({ stagedRoot, stagedState }) {
  return {
    id: 'pull-swap',
    title: 'Switching to the downloaded library',
    async run(ctx) {
      const live = local.localStatePath(ctx.dataRoot);
      const previous = path.join(ctx.dataRoot, 'backups', `cloud-move-${NOW().replace(/[:.]/g, '-')}`);
      const hadLocal = fs.existsSync(live);
      if (hadLocal) {
        fs.mkdirSync(path.dirname(previous), { recursive: true, mode: 0o700 });
        fs.renameSync(live, previous);
      }
      fs.mkdirSync(path.dirname(live), { recursive: true, mode: 0o700 });
      try {
        fs.renameSync(stagedState, live);
      } catch (error) {
        if (hadLocal) { try { fs.renameSync(previous, live); } catch {} }
        throw new StepError('PULL_SWAP_FAILED', 'The downloaded library could not replace the current one.', { hint: 'Nothing else was changed; your previous library is at its original path.' , data: { cause: error.message } });
      }
      const record = ctx.state().cloud || {};
      ctx.save((next) => {
        next.snapshot = hadLocal ? { path: path.relative(ctx.dataRoot, previous), takenAt: NOW(), refs: 0, files: 0, bytes: 0 } : null;
        next.cloud = { ...(next.cloud || {}), detachedAt: NOW(), lastVerifiedAt: NOW() };
        next.mode = 'local';
        return next;
      });
      void record;
      return { message: hadLocal ? `Previous library kept at ${path.relative(ctx.dataRoot, previous)}` : 'Library switched' };
    },
    async verify(ctx) { return fs.existsSync(local.localStatePath(ctx.dataRoot)); },
  };
}

function pullFinishStep() {
  return {
    id: 'pull-finish',
    title: 'Finishing',
    async run(ctx) {
      const record = ctx.state().cloud || {};
      const origin = local.localOrigin(ctx.dataRoot);
      const stored = ctx.secrets() || {};
      if (origin && stored.captureToken) {
        const captureDir = path.join(ctx.dataRoot, 'capture');
        const target = path.join(captureDir, '.env');
        try {
          const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
          fs.writeFileSync(target, captureEnvText(existing, { url: origin, token: stored.captureToken }), { mode: 0o600 });
        } catch {}
      }
      ctx.save((next) => { next.mode = 'local'; next.error = null; return next; });
      // The cloud copy keeps working; only this Mac's transfer credential goes.
      if (record.accountId && deploy.configExists(ctx.dataRoot)) {
        try { await cloud.deleteSecret(ctx.wrangler, { dataRoot: ctx.dataRoot, accountId: record.accountId, name: 'TRANSFER_TOKEN' }); } catch {}
      }
      ctx.clearTransferToken();
      return { message: 'This Mac is using its local library again' };
    },
    async verify(ctx) { return ctx.state().mode === 'local'; },
  };
}

// ---------- deploy / migrate ----------

async function commandDeploy(ctx) {
  ctx.reload();
  const record = requireCloud(ctx);
  const steps = [
    {
      id: 'deploy-preflight',
      title: 'Checking this Mac',
      async run(ctx2) {
        if (!deploy.configExists(ctx2.dataRoot)) {
          throw new StepError('NOT_PROVISIONED', 'This Mac has no cloud deploy configuration yet.', { hint: 'Run `setup` first.' });
        }
        if (deploy.runtimeProblem(ctx2.root)) {
          const problem = deploy.runtimeProblem(ctx2.root);
          throw new StepError('NO_BUILD', problem.message, { hint: problem.hint });
        }
        return { message: 'Ready' };
      },
      async verify() { return true; },
    },
    {
      id: 'deploy-schema',
      title: 'Applying database migrations',
      async run(ctx2) {
        await deploy.applyMigrations(ctx2.wrangler, { dataRoot: ctx2.dataRoot, accountId: record.accountId, remote: true });
        return { message: 'Database is up to date' };
      },
      async verify() { return true; },
    },
    {
      id: 'deploy-worker',
      title: 'Deploying the Worker',
      async run(ctx2) {
        // Refresh the copy first, so a new bundle is never shadowed by a stale one.
        const stored = ctx2.secrets() || {};
        const layout = deploy.prepareDeployLayout({
          root: ctx2.root,
          dataRoot: ctx2.dataRoot,
          d1Id: record.d1 && record.d1.id,
          kvId: record.kv && record.kv.id,
          login: record.login || undefined,
          url: record.url,
        });
        void stored;
        void layout;
        await deploy.deployWorker(ctx2.wrangler, { dataRoot: ctx2.dataRoot, accountId: record.accountId });
        ctx2.setCloud({ lastDeployedAt: NOW(), bundleHash: setupSteps.bundleHash(ctx2.dataRoot) });
        return { message: `Live at ${record.url}` };
      },
      async verify() { return true; },
    },
    {
      id: 'deploy-verify',
      title: 'Checking the deployment',
      async run(ctx2) {
        const token = randomSecret();
        await cloud.putSecrets(ctx2.wrangler, { dataRoot: ctx2.dataRoot, accountId: record.accountId, secrets: { TRANSFER_TOKEN: token } });
        ctx2.setTransferToken(token);
        const status = await ctx2.transfer().status().catch(() => null);
        if (!status) {
          throw new StepError('DEPLOY_VERIFY_FAILED', 'The deployed Worker did not answer its status route.', {
            hint: 'Check the Worker in the Cloudflare dashboard, then run `deploy` again.',
          });
        }
        if (typeof status.version !== 'string' || !status.version) {
          throw new StepError('VERSION_UNREADABLE', 'The deployed Snip did not report a version.', {
            hint: 'Check the Worker in the Cloudflare dashboard, then run `deploy` again.',
          });
        }
        // Compare against the last recorded deploy, never against a local constant.
        const previous = (ctx2.state().cloud || {}).workerVersion || null;
        if (previous && previous !== status.version) {
          ctx2.emit.log('warn', `The deployed Worker reports ${status.version}; this Mac last deployed ${previous}.`);
        }
        ctx2.setCloud({ workerVersion: status.version, lastDeployedAt: NOW() });
        return { message: `Version ${status.version} answered` };
      },
      async verify() { return true; },
    },
  ];
  const result = await require('./engine.cjs').runSteps(steps, ctx);
  ctx.reload();
  return { ok: true, code: 'OK', mode: ctx.state().mode, data: { url: record.url, steps: result.completed }, message: `Deployed ${record.url}` };
}

async function commandMigrate(ctx) {
  ctx.reload();
  const record = requireCloud(ctx);
  const steps = [
    {
      id: 'migrate-preflight',
      title: 'Checking this Mac',
      async run(ctx2) {
        if (!deploy.configExists(ctx2.dataRoot)) throw new StepError('NOT_PROVISIONED', 'This Mac has no cloud deploy configuration yet.', { hint: 'Run `setup` first.' });
        return { message: 'Ready' };
      },
      async verify() { return true; },
    },
    {
      id: 'migrate-apply',
      title: 'Applying database migrations',
      async run(ctx2) {
        await deploy.applyMigrations(ctx2.wrangler, { dataRoot: ctx2.dataRoot, accountId: record.accountId, remote: true });
        return { message: 'Database is up to date' };
      },
      async verify() { return true; },
    },
  ];
  await require('./engine.cjs').runSteps(steps, ctx);
  return { ok: true, code: 'OK', mode: ctx.state().mode, data: {}, message: 'Migrations applied' };
}

// ---------- detach / delete / snapshot ----------

async function commandDetach(ctx) {
  ctx.reload();
  const steps = [
    {
      id: 'detach-preflight',
      title: 'Checking this Mac',
      async run(ctx2) {
        const record = requireCloud(ctx2);
        if (ctx2.state().mode === 'enabling') {
          throw new StepError('ENABLING', 'A setup is in progress, so it cannot be detached yet.', { hint: 'Finish setup, or run `abort` to stop it.' });
        }
        if (ctx2.lock && ctx2.lock.record && ctx2.lock.record.pid !== process.pid) {
          throw new StepError('LOCKED', 'Another Snip process is running.', { hint: 'Wait for it to finish.' });
        }
        if (ctx2.state().mode !== 'cloud') throw new StepError('NOT_CLOUD', 'This Mac is not using its cloud library.', { hint: 'Run `status` to see the current mode.' });
        return { message: `Leaving ${record.url} live for other devices` };
      },
      async verify(ctx2) { return ctx2.state().mode === 'cloud'; },
    },
    {
      id: 'detach-finish',
      title: 'Switching back to the local library',
      async run(ctx2) {
        const record = requireCloud(ctx2);
        ctx2.save((next) => {
          next.mode = 'local';
          next.cloud = { ...(next.cloud || {}), detachedAt: NOW() };
          next.error = null;
          return next;
        });
        return { message: `This Mac is local again. ${record.url} stays live.` };
      },
      async verify(ctx2) { return ctx2.state().mode === 'local' && Boolean(ctx2.state().cloud && ctx2.state().cloud.detachedAt); },
    },
  ];
  await require('./engine.cjs').runSteps(steps, ctx);
  return { ok: true, code: 'OK', mode: 'local', data: { url: (ctx.state().cloud || {}).url }, message: 'Cloud is turned off on this Mac; the cloud library stays live.' };
}

async function commandDeleteResources(ctx) {
  ctx.reload();
  const record = requireCloud(ctx);
  const expected = (() => { try { return new URL(record.url).host; } catch { return null; } })();
  const steps = [
    {
      id: 'delete-preflight',
      title: 'Checking the confirmation',
      async run(ctx2) {
        if (!ctx2.flags.confirm || ctx2.flags.confirm !== expected) {
          throw new StepError('CONFIRM_REQUIRED', `Confirm with --confirm ${expected} to delete this cloud library.`, {
            hint: 'This removes the Worker, database, key-value store and bucket. It cannot be undone.',
            data: { expected },
          });
        }
        return { message: `Deleting ${record.url}` };
      },
      async verify() { return true; },
    },
    {
      id: 'delete-execute',
      title: 'Deleting cloud resources',
      async run(ctx2) {
        const accountId = record.accountId;
        const file = deploy.configPath(ctx2.dataRoot);
        const runs = [];
        runs.push(['delete', record.workerName || 'snip', '--config', file, '--force']);
        if (record.d1 && record.d1.name) runs.push(['d1', 'delete', record.d1.name, '--config', file, '--skip-confirmation']);
        if (record.kv && record.kv.name) runs.push(['kv', 'namespace', 'delete', '--config', file, '--binding', 'OAUTH_KV']);
        for (const args of runs) {
          const result = await ctx2.wrangler.run(args, { cwd: deploy.cloudDir(ctx2.dataRoot), env: { CLOUDFLARE_ACCOUNT_ID: accountId } });
          if (!result.ok && !/not found|does not exist|10007|10090/i.test(`${result.stdout}${result.stderr}`)) {
            throw new StepError('DELETE_FAILED', `Deleting ${args[0]} failed.`, { data: { output: `${result.stdout}${result.stderr}`.trim().slice(-500) } });
          }
        }
        // The bucket is emptied first by the Worker's own lifecycle; delete it last.
        const bucket = await ctx2.wrangler.run(['r2', 'bucket', 'delete', record.bucket || 'snip-files', '--force'], { env: { CLOUDFLARE_ACCOUNT_ID: accountId } });
        if (!bucket.ok && !/not found|does not exist/i.test(`${bucket.stdout}${bucket.stderr}`)) {
          ctx2.emit.log('warn', 'The storage bucket could not be deleted; remove it in the Cloudflare dashboard.');
        }
        return { message: 'Worker, database and key-value store removed' };
      },
      async verify() { return true; },
    },
    {
      id: 'delete-verify',
      title: 'Checking',
      async run(ctx2) {
        const exists = await ctx2.api.workerExists(record.accountId, record.workerName || 'snip');
        if (exists) throw new StepError('DELETE_INCOMPLETE', 'The Worker is still present.', { hint: 'Run `delete-resources` again.' });
        ctx2.save((next) => {
          next.cloud = { ...(next.cloud || {}), deletedAt: NOW() };
          next.mode = 'local';
          next.snapshot = next.snapshot || null;
          return next;
        });
        return { message: 'Cloud resources are gone; this Mac keeps its local library' };
      },
      async verify(ctx2) { return Boolean(ctx2.state().cloud && ctx2.state().cloud.deletedAt); },
    },
  ];
  await require('./engine.cjs').runSteps(steps, ctx);
  return { ok: true, code: 'OK', mode: 'local', data: { url: record.url }, message: `Deleted ${record.url}` };
}

async function commandSnapshot(ctx) {
  ctx.reload();
  const action = ctx.flags.snapshotAction;
  if (!['restore', 'delete'].includes(action)) throw new StepError('BAD_COMMAND', 'Choose `snapshot restore` or `snapshot delete`.');
  const record = ctx.state().snapshot;
  const steps = [
    {
      id: 'snapshot-preflight',
      title: 'Checking this Mac',
      async run(ctx2) {
        if (!record || !record.path) throw new StepError('NO_SNAPSHOT', 'This Mac has no snapshot of its pre-cloud library.', { hint: 'Nothing to restore or delete.' });
        if (action === 'restore' && ctx2.state().mode === 'cloud') {
          throw new StepError('IN_CLOUD', 'This Mac is using its cloud library, so the snapshot cannot be restored over it.', { hint: 'Run `pull` to bring the cloud library back instead.' });
        }
        if (action === 'restore' && !fs.existsSync(path.join(ctx2.dataRoot, record.path))) {
          throw new StepError('SNAPSHOT_MISSING', 'The snapshot directory is missing.', { hint: 'Nothing can be restored from it.' });
        }
        return { message: action === 'restore' ? 'Snapshot found' : 'Snapshot found' };
      },
      async verify() { return true; },
    },
    {
      id: action === 'restore' ? 'snapshot-restore' : 'snapshot-delete',
      title: action === 'restore' ? 'Restoring the snapshot' : 'Deleting the snapshot',
      async run(ctx2) {
        if (action === 'delete') {
          fs.rmSync(path.join(ctx2.dataRoot, record.path), { recursive: true, force: true });
          ctx2.save((next) => { next.snapshot = null; return next; });
          return { message: 'Snapshot deleted' };
        }
        const snapshotState = path.join(ctx2.dataRoot, record.path, 'state');
        const live = local.localStatePath(ctx2.dataRoot);
        if (fs.existsSync(snapshotState)) {
          fs.rmSync(live, { recursive: true, force: true });
          fs.mkdirSync(path.dirname(live), { recursive: true, mode: 0o700 });
          fs.renameSync(snapshotState, live);
        }
        return { message: 'Snapshot restored' };
      },
      async verify(ctx2) {
        if (action === 'delete') return !ctx2.state().snapshot;
        return fs.existsSync(local.localStatePath(ctx2.dataRoot));
      },
    },
    {
      id: 'snapshot-finish',
      title: 'Finishing',
      async run(ctx2) {
        ctx2.save((next) => { next.error = null; return next; });
        return { message: ctx2.state().mode === 'local' ? 'Done' : 'Done' };
      },
      async verify() { return true; },
    },
  ];
  await require('./engine.cjs').runSteps(steps, ctx);
  return { ok: true, code: 'OK', mode: ctx.state().mode, data: { action }, message: action === 'restore' ? 'Snapshot restored' : 'Snapshot deleted' };
}

// ---------- abort ----------

async function commandAbort(ctx) {
  ctx.reload();
  const steps = [
    {
      id: 'abort-preflight',
      title: 'Checking this Mac',
      async run(ctx2) {
        const mode = ctx2.state().mode;
        if (mode === 'cloud') throw new StepError('HEALTHY_CLOUD', 'This Mac is using its cloud library, so there is nothing to abort.', { hint: 'Use `detach` to go back to local, or `delete-resources` to remove it.' });
        if (mode !== 'enabling') throw new StepError('NOTHING_TO_ABORT', 'No setup is in progress.', { hint: 'Nothing was changed.' });
        return { message: 'Cleaning up an interrupted setup' };
      },
      // True only while a setup is actually in progress, so a second `abort`
      // reports that there is nothing to abort instead of silently passing.
      async verify(ctx2) { return ctx2.state().mode === 'enabling'; },
    },
    {
      id: 'abort-cleanup',
      title: 'Cleaning up',
      async run(ctx2) {
        // Only what this run recorded as created. A pre-existing or adopted D1,
        // KV or bucket is never deleted by abort.
        const record = ctx2.state().cloud || {};
        const created = record.created || {};
        const removed = [];
        if (created.bucket) {
          const result = await ctx2.wrangler.run(['r2', 'bucket', 'delete', created.bucket], { env: { CLOUDFLARE_ACCOUNT_ID: record.accountId } });
          if (result.ok) removed.push(`bucket ${created.bucket}`);
          else ctx2.emit.log('warn', `Could not remove the bucket ${created.bucket}; remove it in the Cloudflare dashboard.`);
        }
        if (created.kv && created.kv.id) {
          const result = await ctx2.wrangler.run(['kv', 'namespace', 'delete', '--binding', 'OAUTH_KV'], { env: { CLOUDFLARE_ACCOUNT_ID: record.accountId } });
          if (result.ok) removed.push(`KV ${created.kv.name}`);
          else ctx2.emit.log('warn', `Could not remove the KV namespace ${created.kv.name}; remove it in the Cloudflare dashboard.`);
        }
        if (created.d1 && created.d1.name) {
          const result = await ctx2.wrangler.run(['d1', 'delete', created.d1.name, '--skip-confirmation'], { env: { CLOUDFLARE_ACCOUNT_ID: record.accountId } });
          if (result.ok) removed.push(`database ${created.d1.name}`);
          else ctx2.emit.log('warn', `Could not remove the database ${created.d1.name}; remove it in the Cloudflare dashboard.`);
        }
        ctx2.save((next) => {
          next.mode = 'local';
          next.pausedForMove = [];
          next.error = null;
          if (next.cloud) next.cloud = { ...next.cloud, created: {} };
          return next;
        });
        return { message: removed.length ? `Removed ${removed.join(', ')}` : 'This Mac is local again. Nothing this run created was left behind.' };
      },
      async verify(ctx2) { return ctx2.state().mode === 'local'; },
    },
  ];
  await require('./engine.cjs').runSteps(steps, ctx);
  return { ok: true, code: 'OK', mode: 'local', data: {}, message: 'Setup aborted; this Mac is local.' };
}

// ---------- owner ----------

async function commandOwner(ctx) {
  ctx.reload();
  const action = ctx.flags.ownerAction;
  const record = requireCloud(ctx);
  const steps = [];
  if (action === 'rotate') {
    steps.push({
      id: 'owner-mint',
      title: 'Rotating the owner secret',
      async run(ctx2) {
        const secret = randomSecret();
        const stored = ctx2.secrets() || {};
        await cloud.putSecrets(ctx2.wrangler, {
          dataRoot: ctx2.dataRoot,
          accountId: record.accountId,
          secrets: { OWNER_LINK_SECRET: secret },
        });
        ctx2.saveSecrets({ ...stored, ownerLinkSecret: secret });
        ctx2.setCloud({ ownerSecretRotatedAt: NOW() });
        const status = await ctx2.transfer().status().catch(() => null);
        if (status && status.ownerSecretHash && status.ownerSecretHash !== ownerSecretHash(secret)) {
          throw new StepError('ROTATE_VERIFY_FAILED', 'The Worker did not accept the new owner secret.', { hint: 'Check the deploys secrets are writable, then run `owner rotate` again.' });
        }
        return { message: 'New owner secret saved' };
      },
      async verify() { return true; },
    });
  }
  steps.push({
    id: 'owner-preflight',
    title: 'Checking the cloud library',
    async run(ctx2) {
      const stored = ctx2.secrets() || {};
      if (!stored.ownerLinkSecret) throw new StepError('SECRET_MISSING', 'This Mac holds no owner secret for its cloud library.', { hint: 'Run `owner rotate` to replace it and mint a new link.' });
      return { message: record.url };
    },
    async verify() { return true; },
  });
  steps.push({
    id: 'owner-mint',
    title: 'Creating a sign-in link',
    async run(ctx2) {
      const stored = ctx2.secrets();
      const minted = mintOwnerLink({ secret: stored.ownerLinkSecret, url: record.url, ownerId: record.ownerId || 'owner' });
      ctx2.setWork({ ownerLink: minted.link });
      return { message: 'Link ready', data: { url: minted.link } };
    },
    async verify() { return true; },
  });
  steps.push({
    id: 'owner-open',
    title: 'Opening the link',
    async run(ctx2) {
      const link = ctx2.work.ownerLink;
      ctx2.emit.human('owner-open', 'open_url', link, 'Sign in to your Snip in the browser');
      if (!ctx2.flags.noOpen && ctx2.openUrl) await ctx2.openUrl(link).catch(() => {});
      return { message: link };
    },
    async verify() { return true; },
  });
  await require('./engine.cjs').runSteps(steps, ctx);
  return {
    ok: true,
    code: 'OK',
    mode: ctx.state().mode,
    data: { url: ctx.work.ownerLink, cloudUrl: record.url },
    message: ctx.work.ownerLink ? `Sign-in link: ${ctx.work.ownerLink}` : 'Link created',
  };
}

// ---------- status ----------

function commandStatus(ctx, { offline = true } = {}) {
  const snapshot = ctx.state();
  return {
    ok: true,
    code: 'OK',
    mode: snapshot.mode,
    data: {
      state: snapshot,
      cloudDir: deploy.cloudDir(ctx.dataRoot),
      runtime: deploy.inspectRuntime(ctx.root),
      offline,
    },
    message: `mode: ${snapshot.mode}${snapshot.cloud ? ` · ${snapshot.cloud.url}` : ''}`,
    text: `${JSON.stringify(snapshot, null, 2)}\n`,
  };
}

module.exports = {
  commandAbort,
  commandDeleteResources,
  commandDeploy,
  commandDetach,
  commandMigrate,
  commandOwner,
  commandPull,
  commandSetup,
  commandSnapshot,
  commandStatus,
  createContext,
  requireCloud,
};
