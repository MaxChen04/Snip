'use strict';
// The commands behind the CLI: setup, pull, deploy, migrate, detach,
// delete-resources, snapshot, abort, owner. Each builds its steps, runs them
// through the same runner, and returns { ok, code, mode, data }.

const fs = require('node:fs');
const path = require('node:path');
const { CancelledError, NeedsInputError, StepError, runSteps } = require('./engine.cjs');
const state = require('./state.cjs');
const cloud = require('./cloud.cjs');
const deploy = require('./deploy.cjs');
const local = require('./local.cjs');
const { localWorker, withLocalWorker } = require('./library.cjs');
const { randomSecret, splitSqlStatements, canonicalOrigin, captureEnvText } = require('./lib.cjs');
const { mintOwnerLink, ownerSecretHash, startLoopback } = require('./transfer.cjs');
const { createContext } = require('./context.cjs');
const setupSteps = require('./setup.cjs');
const snapshotModule = require('./snapshot.cjs');

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
  const transferRecord = ctx.state().transfer || null;
  const data = {
    url: record.url,
    accountId: record.accountId,
    refs: (transferRecord && transferRecord.tables && transferRecord.tables.refs) || (snapshot && snapshot.refs) || 0,
    files: (transferRecord && transferRecord.keys) || (snapshot && snapshot.files) || 0,
    bytes: (transferRecord && transferRecord.bytes) || (snapshot && snapshot.bytes) || 0,
    ownerId: record.ownerId || null,
  };
  return { ok: true, code: 'OK', mode: 'cloud', data, message: `Snip is live at ${record.url}` };
}

// ---------- pull ----------

async function commandPull(ctx) {
  ctx.reload();
  const record = requireCloud(ctx);
  if (!record.accountId) throw new StepError('NOT_PROVISIONED', 'This cloud install is incomplete.', { hint: 'Run `setup` again, or use Settings → Cloud.' });

  const stagedRoot = path.join(ctx.dataRoot, 'backups', `pull-${NOW().replace(/[:.]/g, '-')}`);
  const stagedState = path.join(stagedRoot, 'state');
  // pull mints its own transfer token: setup deletes it at the end of a move,
  // so a detached install holds no credential until a pull needs one.
  if (!ctx.transferToken()) {
    if (!deploy.configExists(ctx.dataRoot)) {
      throw new StepError('TRANSFER_TOKEN_MISSING', 'This Mac has no cloud deploy configuration to pull with.', {
        hint: 'Run `setup` once from this library, then `pull`.',
      });
    }
    const minted = randomSecret();
    await cloud.putSecrets(ctx.wrangler, { dataRoot: ctx.dataRoot, accountId: record.accountId, secrets: { TRANSFER_TOKEN: minted } });
    ctx.setTransferToken(minted);
    // A secret write is not instantly live at the edge; wait for the new token
    // to answer instead of reporting the library as closed.
    const deadline = Date.now() + 30_000;
    let ready = false;
    while (!ready && Date.now() < deadline) {
      ctx.checkCancel();
      ready = Boolean(await ctx.transfer().status().catch(() => null));
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    if (!ready) {
      throw new StepError('TRANSFER_DISABLED', 'The cloud library did not accept the new transfer credential.', {
        hint: 'Deploy the latest Snip Worker from Settings, then run `pull` again.',
      });
    }
  }
  const steps = pullSteps({ stagedRoot, stagedState });
  await runSteps(steps, ctx);
  ctx.reload();
  return {
    ok: true,
    code: 'OK',
    mode: 'local',
    data: { stagedRoot: path.relative(ctx.dataRoot, stagedRoot), keptAt: ctx.state().snapshot?.path || null },
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
      // The checks are cheap and must run again on a resumed pull, so the mark
      // lives in this invocation's work, never in the step journal.
      ctx.setWork({ pullPreflight: true });
      return { message: 'Ready' };
    },
    async verify(ctx) { return Boolean(ctx.work.pullPreflight); },
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
      // The staged copy must land under the identity the local app itself opens:
      // the cloud deploy config names a different database id, so importing with
      // it would leave the swapped-in data in a file the app never reads.
      const localConfig = (await ctx.libraryFacts()).localConfig || deploy.localConfigPath(ctx.dataRoot);
      await ctx.deps.deploy.applyMigrations(ctx.wrangler, { dataRoot: ctx.dataRoot, accountId: record.accountId, remote: false, local: true, persistTo: stagedState, config: localConfig });
      const { importLocal } = require('./deploy.cjs');
      await ctx.deps.deploy.importLocal(ctx.wrangler, { dataRoot: ctx.dataRoot, persistTo: stagedState, statements, tables, config: localConfig });
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
      // The manifest read by `pull-manifest`, from this run or an earlier one.
      const source = ctx.work.pullManifest || manifest.value || {};
      const reported = source.tables || {};
      const dump = path.join(path.dirname(stagedState), 'dump.sql');
      const columns = require('./lib.cjs').columnsFromDump(fs.readFileSync(dump, 'utf8'));
      const localConfig = (await ctx.libraryFacts()).localConfig || deploy.localConfigPath(ctx.dataRoot);
      // The manifest's `excluded` is computed by the Worker from its own
      // database, so it shrinks and grows with the Worker. Every name in it is
      // skipped, and nothing is required to be listed: a table the manifest
      // never mentions is simply not part of the copy to check. The default set
      // covers an older Worker that sends no `excluded` at all (contracts §4.5).
      const tables = require('./lib.cjs').comparableTables(reported, source.excluded);
      const remotePerTable = {};
      const localPerTable = {};
      for (const table of tables) {
        const sql = require('./lib.cjs').digestSql(table, columns[table] || []);
        const remoteRow = (await ctx.deps.deploy.remoteQuery(ctx.wrangler, { dataRoot: ctx.dataRoot, accountId: record.accountId, sql }))[0] || {};
        const localRow = (await ctx.deps.deploy.localQuery(ctx.wrangler, { dataRoot: ctx.dataRoot, sql, config: localConfig, persistTo: stagedState }))[0] || {};
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
      const keys = Array.isArray(source.keys) ? source.keys : (manifest.keys || []);
      if (Number(reported.refs || 0) > 0 && keys.length === 0) {
        throw new StepError('EXPORT_EMPTY', 'The cloud library reports references but no files.', { hint: 'Check the cloud library in a browser, then run `pull` again.' });
      }
      // One worker for the whole check: starting one per key would take minutes.
      const present = await ctx.deps.library.withLocalWorker({ root: ctx.root, dataRoot: ctx.dataRoot, token: randomSecret(), persist: stagedState, log: () => {} }, async (handle) => {
        let seen = 0;
        for (const entry of keys) {
          ctx.checkCancel();
          const response = await handle.transfer.head(entry.key);
          if (response === null) {
            throw new StepError('VERIFY_FILES_MISSING', 'A file did not arrive in the downloaded copy.', { data: { key: entry.key } });
          }
          seen++;
        }
        return seen;
      });
      ctx.setWork({ pullVerified: { digest: remoteDigest, keys: present, tables: reported } });
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
      const previous = path.join(ctx.dataRoot, 'backups', `cloud-pull-${NOW().replace(/[:.]/g, '-')}`);
      const hadLocal = fs.existsSync(live);
      if (hadLocal) {
        fs.mkdirSync(path.dirname(previous), { recursive: true, mode: 0o700 });
        try {
          fs.renameSync(live, previous);
        } catch (error) {
          throw new StepError('PULL_SWAP_FAILED', 'The current library could not be moved aside, so nothing was changed.', {
            hint: 'Quit Snip, then run `pull` again.',
            data: { cause: error.message },
          });
        }
      }
      fs.mkdirSync(path.dirname(live), { recursive: true, mode: 0o700 });
      try {
        fs.renameSync(stagedState, live);
      } catch (error) {
        if (hadLocal) { try { fs.renameSync(previous, live); } catch {} }
        throw new StepError('PULL_SWAP_FAILED', 'The downloaded library could not replace the current one.', { hint: 'Nothing else was changed; your previous library is at its original path.' , data: { cause: error.message } });
      }

      // The directory just moved aside is a complete state dir, so it is a real
      // "Switch back to previous library" backup. Its counts are read through a
      // Worker on that persist: a row claiming zero references is a lie the user
      // cannot check, and an empty read is exactly what a wrong identity looks
      // like. If the counts cannot be read, the backup is moved back and the
      // pull fails rather than recording something untrue.
      let counts = null;
      if (hadLocal) {
        try {
          const token = randomSecret();
          counts = await snapshotModule.stateCounts({
            library: ctx.deps.library,
            root: ctx.root,
            dataRoot: ctx.dataRoot,
            persist: previous,
            token,
            log: (line) => ctx.emit.log('info', line),
          });
        } catch (error) {
          try { fs.rmSync(live, { recursive: true, force: true }); } catch {}
          try { fs.renameSync(previous, live); } catch {}
          throw new StepError('PULL_COUNTS_FAILED', 'The previous library could not be read, so it was put back.', {
            hint: 'Quit Snip and run `pull` again. Nothing was changed.',
            data: { cause: error.message },
          });
        }
      }

      ctx.save((next) => {
        next.snapshot = hadLocal
          ? { kind: 'backup', path: path.relative(ctx.dataRoot, previous), keptLocal: false, takenAt: NOW(), ...counts }
          : null;
        next.cloud = { ...(next.cloud || {}), detachedAt: NOW(), lastVerifiedAt: NOW() };
        next.mode = 'local';
        return next;
      });
      return { message: hadLocal ? `Previous library kept at ${path.relative(ctx.dataRoot, previous)}` : 'Library switched' };
    },
    // Both halves must be true: the cloud copy is live, and the library it
    // replaced is still on disk under the backup the record names.
    async verify(ctx) {
      const live = local.localStatePath(ctx.dataRoot);
      if (!fs.existsSync(live)) return false;
      const snapshot = ctx.state().snapshot;
      if (!snapshot) return true;
      return snapshot.kind === 'backup' && Boolean(snapshot.path) && fs.existsSync(path.join(ctx.dataRoot, snapshot.path));
    },
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
        await ctx2.deps.deploy.applyMigrations(ctx2.wrangler, { dataRoot: ctx2.dataRoot, accountId: record.accountId, remote: true });
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
        await ctx2.deps.deploy.applyMigrations(ctx2.wrangler, { dataRoot: ctx2.dataRoot, accountId: record.accountId, remote: true });
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
  const steps = [
    {
      id: 'delete-preflight',
      title: 'Checking the confirmation',
      async run(ctx2) {
        // Same interlock as the snapshot commands, keyed on the host the row
        // shows. Missing → exit 2; different → exit 1; nothing deleted either way.
        snapshotModule.requireConfirm(ctx2, { recordPath: record.url, command: 'delete-resources' });
        return { message: `Deleting ${record.url}` };
      },
      // No verify: a stale record and a fresh --confirm must be re-checked on
      // every invocation rather than skipped as "already done".
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
      title: 'Checking everything is gone',
      async run(ctx2) {
        // Every artifact, not just the Worker, and only then the record. A
        // delete that reports success while a database survives is the same
        // class of lie as a snapshot delete that clears a row and keeps the dir.
        const worker = await ctx2.api.workerExists(record.accountId, record.workerName || 'snip');
        if (worker) throw new StepError('DELETE_INCOMPLETE', 'The Worker is still present.', { hint: 'Run `delete-resources` again.' });
        // A listing that fails is not evidence of absence: an unverifiable
        // delete is reported as unverified, never as done.
        const listed = async (list, what) => list(ctx2.wrangler, { accountId: record.accountId }).catch((error) => {
          throw new StepError('DELETE_UNVERIFIED', `Cloudflare did not answer while checking that the ${what} was deleted.`, {
            hint: 'Run `delete-resources` again. Nothing was changed.',
            data: { cause: error && error.message },
          });
        });
        const leftover = [];
        if (record.d1 && record.d1.id) {
          const databases = await listed(ctx2.deps.cloud.listD1, 'database');
          if (databases.some((entry) => entry.id === record.d1.id || entry.name === record.d1.name)) leftover.push('database');
        }
        if (record.kv && record.kv.id) {
          const namespaces = await listed(ctx2.deps.cloud.listKv, 'key-value store');
          if (namespaces.some((entry) => entry.id === record.kv.id)) leftover.push('key-value store');
        }
        if (record.bucket) {
          const buckets = await listed(ctx2.deps.cloud.listBuckets, 'storage bucket');
          if (buckets.some((entry) => entry.name === record.bucket)) leftover.push('storage bucket');
        }
        if (leftover.length) {
          throw new StepError('DELETE_INCOMPLETE', `The ${leftover.join(', ')} could not be deleted.`, {
            hint: 'Remove them in the Cloudflare dashboard, then run `delete-resources` again.',
            data: { leftover },
          });
        }
        ctx2.save((next) => {
          // The install is gone, so only the account and the date stay: leaving
          // the old ids behind would let a later guard mistake a deleted Snip
          // for one that is still installable.
          next.cloud = { accountId: record.accountId, deletedAt: NOW() };
          next.mode = 'local';
          next.snapshot = next.snapshot || null;
          next.steps = [];
          next.error = null;
          return next;
        });
        return { message: 'Cloud resources are gone; this Mac keeps its local library' };
      },
      async verify(ctx2) {
        const cloud = ctx2.state().cloud || {};
        return Boolean(cloud.deletedAt) && !cloud.url && !cloud.d1 && !cloud.kv && !cloud.bucket;
      },
    },
  ];
  await require('./engine.cjs').runSteps(steps, ctx, { journal: false });
  return { ok: true, code: 'OK', mode: 'local', data: { url: record.url }, message: `Deleted ${record.url}` };
}

async function commandSnapshot(ctx) {
  ctx.reload();
  const action = ctx.flags.snapshotAction;
  if (!['restore', 'delete', 'delete-export'].includes(action)) {
    throw new StepError('BAD_COMMAND', 'Choose `snapshot restore`, `snapshot delete` or `snapshot delete-export`.');
  }
  const current = () => ctx.state().snapshot || null;

  /**
   * Every refusal lives here, before anything is touched, and it refuses by
   * shape rather than by name: an export recorded as a backup is not restorable
   * even when a live library exists, because the live library is a different
   * directory and "already using it" would be a lie.
   */
  const preflight = {
    id: 'snapshot-preflight',
    title: 'Checking this Mac',
    async run(ctx2) {
      const record = current();
      if (action === 'delete-export') {
        const exported = snapshotModule.exportOf(record);
        if (!exported || !exported.path) {
          throw new StepError('NO_EXPORT', 'This Mac has no portable export to delete.', { hint: 'Nothing was changed.' });
        }
        snapshotModule.requireConfirm(ctx2, { recordPath: exported.path, command: 'snapshot delete-export' });
        return { message: 'Export found' };
      }
      if (!record) throw new StepError('NO_SNAPSHOT', 'This Mac has no snapshot of its pre-cloud library.', { hint: 'Nothing to restore or delete.' });
      const directory = record.path ? path.join(ctx2.dataRoot, record.path) : null;
      // A record written before the model had kinds points at setup's dump. It is
      // delete-only backup files, and calling it "this Mac's own library" would
      // be false, so it gets its own honest refusal.
      if (!record.kind && directory && fs.existsSync(directory) && !snapshotModule.isStateShaped(directory)) {
        throw new StepError('NOT_A_BACKUP', 'These are this Mac’s backup files, not a library that can be swapped in.', {
          hint: 'Delete them with `snapshot delete-export --confirm <name>`. Nothing was changed.',
          data: { path: record.path },
        });
      }
      if (record.kind === 'live' || record.keptLocal === true || !record.path) {
        throw new StepError(action === 'restore' ? 'KEPT_LOCAL' : 'CANNOT_DELETE_LOCAL', action === 'restore'
          ? 'Your library is still on this Mac, so there is nothing to restore.'
          : 'This Mac’s own library is not a snapshot, so it cannot be deleted.', {
          hint: action === 'restore' ? 'Use “Switch back to it”, which runs `detach`.' : 'Nothing was changed.',
        });
      }
      if (!fs.existsSync(directory)) {
        throw new StepError('SNAPSHOT_MISSING', 'The snapshot directory is missing.', { hint: 'Nothing can be restored from it.' });
      }
      if (action === 'restore' && !snapshotModule.isStateShaped(directory)) {
        throw new StepError('SNAPSHOT_NOT_RESTORABLE', 'This snapshot is not a complete library, so it cannot be swapped in.', {
          hint: 'It holds a database dump or a partial copy. Enable cloud again and use `pull` to bring the full library back.',
          data: { path: record.path },
        });
      }
      if (action === 'delete') {
        snapshotModule.requireConfirm(ctx2, { recordPath: record.path, command: 'snapshot delete' });
        if (!fs.existsSync(local.localStatePath(ctx2.dataRoot))) {
          // The backup is the only copy left; deleting it would lose the library.
          throw new StepError('LIVE_MISSING', 'This Mac’s live library is missing, so its only complete copy is this backup.', {
            hint: 'Restore it first, then delete it. Nothing was changed.',
          });
        }
      }
      return { message: 'Snapshot found' };
    },
    // No verify: these are refusals, and a stale record plus a fresh --confirm
    // must be re-checked on every invocation, not skipped as "already done".
  };

  const restoreStep = {
    id: 'snapshot-restore',
    title: 'Switching back to the previous library',
    // Only reachable for a real backup, and only when it is not already live.
    async skip(ctx2) {
      const record = current();
      if (!record || !record.path) return false;
      const directory = path.join(ctx2.dataRoot, record.path);
      const live = local.localStatePath(ctx2.dataRoot);
      return fs.existsSync(directory) && snapshotModule.sameDirectory(directory, live);
    },
    skipMessage: () => 'This Mac is already using that library',
    async run(ctx2) {
      const record = current();
      restoreStep.source = record.path;
      const directory = path.join(ctx2.dataRoot, record.path);
      const live = local.localStatePath(ctx2.dataRoot);
      const displaced = path.join(ctx2.dataRoot, 'backups', `replaced-${NOW().replace(/[:.]/g, '-')}`);
      const hadLive = fs.existsSync(live);
      if (hadLive) {
        fs.mkdirSync(path.dirname(displaced), { recursive: true, mode: 0o700 });
        try {
          fs.renameSync(live, displaced);
        } catch (error) {
          throw new StepError('SNAPSHOT_RESTORE_FAILED', 'The current library could not be moved aside, so nothing was changed.', {
            hint: 'Quit Snip, then run the same command again.',
            data: { cause: error.message },
          });
        }
      }
      fs.mkdirSync(path.dirname(live), { recursive: true, mode: 0o700 });
      try {
        fs.renameSync(directory, live);
      } catch (error) {
        if (hadLive) { try { fs.renameSync(displaced, live); } catch {} }
        throw new StepError('SNAPSHOT_RESTORE_FAILED', 'The snapshot could not be restored.', { hint: 'Nothing else was changed.', data: { cause: error.message } });
      }
      // The displaced library becomes the new backup, so a mistaken restore can
      // be undone by restoring again. Its counts are read, never assumed.
      let counts = null;
      if (hadLive) {
        try {
          counts = await snapshotModule.stateCounts({
            library: ctx2.deps.library,
            root: ctx2.root,
            dataRoot: ctx2.dataRoot,
            persist: displaced,
            token: randomSecret(),
            log: (line) => ctx2.emit.log('info', line),
          });
        } catch (error) {
          ctx2.emit.log('warn', 'The library it replaced could not be counted; it is kept as the backup and can still be restored.');
        }
      }
      ctx2.save((next) => {
        next.snapshot = hadLive
          ? { kind: 'backup', path: path.relative(ctx2.dataRoot, displaced), keptLocal: false, takenAt: NOW(), ...(counts || {}) }
          : null;
        next.error = null;
        return next;
      });
      return { message: hadLive ? `Restored · the library it replaced is at ${path.relative(ctx2.dataRoot, displaced)}` : 'Restored' };
    },
    // A verify that passes when nothing moved is the bug this replaces: the
    // library that was restored from must no longer be at its old location.
    async verify(ctx2) {
      const live = local.localStatePath(ctx2.dataRoot);
      if (!fs.existsSync(live)) return false;
      if (restoreStep.source && fs.existsSync(path.join(ctx2.dataRoot, restoreStep.source))) return false;
      const record = current();
      if (!record) return true;
      return record.kind === 'backup' && Boolean(record.path) && fs.existsSync(path.join(ctx2.dataRoot, record.path));
    },
  };

  const deleteStep = {
    id: 'snapshot-delete',
    title: 'Deleting the previous library',
    async run(ctx2) {
      const record = current();
      deleteStep.path = record.path;
      fs.rmSync(path.join(ctx2.dataRoot, record.path), { recursive: true, force: true });
      ctx2.save((next) => { next.snapshot = null; next.error = null; return next; });
      return { message: 'Previous library deleted' };
    },
    // The artifact must be gone *and* the record cleared: a delete that only
    // clears the row leaves the directory behind with nothing pointing at it.
    async verify(ctx2) {
      if (current()) return false;
      return deleteStep.path ? !fs.existsSync(path.join(ctx2.dataRoot, deleteStep.path)) : true;
    },
  };

  const deleteExportStep = {
    id: 'snapshot-delete-export',
    title: 'Deleting the backup files',
    async run(ctx2) {
      const exported = snapshotModule.exportOf(current());
      deleteExportStep.path = exported.path;
      fs.rmSync(path.join(ctx2.dataRoot, exported.path), { recursive: true, force: true });
      ctx2.save((next) => {
        // Only the export goes: the snapshot row and the live library are
        // untouched, and an install with no snapshot stays without one. A
        // record from before the model had kinds *was* the export, so it goes
        // too rather than being left pointing at a directory that no longer
        // exists.
        if (next.snapshot && !next.snapshot.kind && !next.snapshot.export) next.snapshot = null;
        else if (next.snapshot) next.snapshot = { ...next.snapshot, export: null };
        next.error = null;
        return next;
      });
      return { message: 'Backup files deleted' };
    },
    async verify(ctx2) {
      const exported = snapshotModule.exportOf(current());
      if (exported) return false;
      return deleteExportStep.path ? !fs.existsSync(path.join(ctx2.dataRoot, deleteExportStep.path)) : true;
    },
  };

  const step = action === 'restore' ? restoreStep : action === 'delete' ? deleteStep : deleteExportStep;
  const finish = {
    id: 'snapshot-finish',
    title: 'Finishing',
    async run(ctx2) {
      ctx2.save((next) => { next.error = null; return next; });
      return { message: ctx2.state().mode === 'local' ? 'Done' : 'Done' };
    },
    async verify() { return true; },
  };
  const steps = [preflight, step, finish];
  await require('./engine.cjs').runSteps(steps, ctx, { journal: false });
  const message = action === 'restore' ? 'Switched back to the previous library' : action === 'delete' ? 'Previous library deleted' : 'Backup files deleted';
  return { ok: true, code: 'OK', mode: ctx.state().mode, data: { action }, message };
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
      id: 'owner-rotate',
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
    // The secret and the link are per-invocation; a resumed `owner link` always
    // mints a fresh one rather than reporting an earlier run's success.
  });
  steps.push({
    id: 'owner-mint',
    title: 'Creating a sign-in link',
    async run(ctx2) {
      // `--managed` means the Electron app is driving and can receive the
      // session over its loopback; on a bare CLI the browser keeps the cookie,
      // so the link carries port 0 and no handoff is attempted.
      let loopback = null;
      let port = 0;
      if (ctx2.flags.managed) {
        loopback = startLoopback({ timeoutMs: 10 * 60_000 });
        try { port = await loopback.listening; } catch (error) {
          throw new StepError('LOOPBACK_FAILED', 'Could not open the local sign-in handoff.', { hint: 'Try again.', data: { cause: error.message } });
        }
      }
      const stored = ctx2.secrets();
      const minted = mintOwnerLink({ secret: stored.ownerLinkSecret, url: record.url, ownerId: record.ownerId || 'owner', port });
      ctx2.setWork({ ownerLink: minted.link, ownerLoopback: loopback });
      return { message: 'Link ready', data: { url: minted.link } };
    },
    async verify() { return true; },
  });
  steps.push({
    id: 'owner-open',
    title: 'Signing in',
    async run(ctx2) {
      const link = ctx2.work.ownerLink;
      const loopback = ctx2.work.ownerLoopback || null;
      ctx2.emit.human('owner-open', 'open_url', link, 'Sign in to your Snip in the browser');
      if (!ctx2.flags.noOpen && ctx2.openUrl) await ctx2.openUrl(link).catch(() => {});
      try {
        if (loopback) {
          const token = await Promise.race([
            loopback.token,
            new Promise((_, reject) => { ctx2.onCancel(() => reject(new CancelledError())); }),
          ]);
          ctx2.emit.session(token, record.url);
          return { message: 'Signed in' };
        }
        const transfer = ctx2.deps.transferOf(ctx2);
        const before = await transfer.status().catch(() => null);
        if (before && before.hasOwner) {
          // A new device cannot be observed from the Worker, so this reports
          // exactly what happened: the link is ready and the browser holds it.
          return { message: 'Link ready; open it in the browser to sign this device in' };
        }
        // No owner yet: this link is the thing that creates one, so wait.
        const deadline = ctx2.deps.now() + 10 * 60_000;
        for (;;) {
          ctx2.checkCancel();
          const status = await transfer.status().catch(() => null);
          if (status && status.hasOwner) return { message: 'Signed in' };
          if (ctx2.deps.now() > deadline) {
            throw new StepError('OWNER_LINK_TIMEOUT', 'The sign-in link was not completed in time.', { hint: 'Run `owner link` to mint a fresh one.' });
          }
          ctx2.emit.step('owner-open', 'waiting', 'Waiting for the browser sign-in');
          await ctx2.deps.sleep(3000);
        }
      } finally {
        if (loopback) loopback.close();
      }
    },
    async verify() { return true; },
  });
  await require('./engine.cjs').runSteps(steps, ctx, { journal: false });
  return {
    ok: true,
    code: 'OK',
    mode: ctx.state().mode,
    data: { url: ctx.work.ownerLink, cloudUrl: record.url },
    message: ctx.work.ownerLink ? `Sign-in link: ${ctx.work.ownerLink}` : 'Link created',
  };
}

// ---------- status ----------

/**
 * `status` reads cloud.json and nothing else: no Cloudflare call, no Worker, no
 * lock, so it works offline and for an agent that only needs to know the mode.
 * `--check` is the one form that goes to the network, and then it says which
 * surface answered.
 */
async function commandStatus(ctx, { check = false } = {}) {
  const snapshot = ctx.state();
  const data = {
    state: snapshot,
    cloudDir: deploy.cloudDir(ctx.dataRoot),
    runtime: deploy.inspectRuntime(ctx.root),
    online: Boolean(check),
  };
  if (check) {
    const localOrigin = ctx.deps.local.localOrigin(ctx.dataRoot);
    const cloudUrl = snapshot.cloud && snapshot.cloud.url ? snapshot.cloud.url : null;
    const checks = {};
    if (localOrigin) checks.local = { url: localOrigin, reachable: await ctx.deps.local.reachable(localOrigin) };
    if (cloudUrl) checks.cloud = await reachableOrigin(ctx, cloudUrl);
    data.checks = checks;
    const active = snapshot.mode === 'cloud' ? checks.cloud : snapshot.mode === 'enabling' ? checks.cloud || checks.local : checks.local;
    if (active && active.reachable === false) {
      const which = snapshot.mode === 'cloud' || snapshot.mode === 'enabling' ? 'cloud' : 'local';
      throw new StepError(which === 'cloud' ? 'CLOUD_UNREACHABLE' : 'LOCAL_UNREACHABLE', which === 'cloud'
        ? 'The cloud library did not answer.'
        : 'The local library did not answer.', {
        hint: which === 'cloud' ? 'Check the URL in a browser, then run `status --check` again.' : 'Start Snip, then run `status --check` again.',
        retryable: true,
        data: { checks },
      });
    }
  }
  return {
    ok: true,
    code: 'OK',
    mode: snapshot.mode,
    data,
    message: `mode: ${snapshot.mode}${snapshot.cloud ? ` · ${snapshot.cloud.url}` : ''}`,
    text: `${JSON.stringify(snapshot, null, 2)}\n`,
  };
}

/** Any HTTP answer below 500 means the Worker is up; 401 is the normal one. */
async function reachableOrigin(ctx, origin) {
  try {
    const response = await ctx.deps.fetch(origin, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(8000) });
    return { url: origin, reachable: response.status < 500, status: response.status };
  } catch (error) {
    return { url: origin, reachable: false, status: null, cause: error.message };
  }
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
  pullSteps,
  requireCloud,
};
