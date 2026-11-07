'use strict';
// The engine context shared by every command, and the command that runs setup.
// The context owns the journal writes, the lock, cancellation and the transfer
// client, so steps only describe what to do.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { CancelledError, NeedsInputError, StepError, runSteps } = require('./engine.cjs');
const state = require('./state.cjs');
const { createWrangler } = require('./deps.cjs');
const { createTransfer } = require('./transfer.cjs');

function createContext({ root, dataRoot, flags = {}, emit, api, wrangler, release = false, lock = null, deps = {} }) {
  let current = state.readState(dataRoot);
  const work = {};
  const cancels = new Set();
  let cancelled = false;
  let transferToken = null;

  const save = (mutate) => {
    current = state.updateState(dataRoot, mutate);
    return current;
  };

  // cloud is a live view of state.cloud; setCloud merges and persists it.
  const cloud = new Proxy({}, {
    get(_target, key) { return (current.cloud || {})[key]; },
    set(_target, key, value) {
      save((next) => { next.cloud = { ...(next.cloud || {}), [key]: value }; return next; });
      return true;
    },
    has(_target, key) { return key in (current.cloud || {}); },
    ownKeys() { return Reflect.ownKeys(current.cloud || {}); },
    getOwnPropertyDescriptor(_target, key) { return { configurable: true, enumerable: true, value: (current.cloud || {})[key] }; },
  });

  const ctx = {
    root,
    dataRoot,
    flags,
    release,
    emit,
    api,
    wrangler,
    lock,
    cloud,
    work,
    // Injectable externals. Every default is the real module; tests replace whole
    // modules, so no step ever needs a live Cloudflare call.
    deps: {
      cloud: require('./cloud.cjs'),
      deploy: require('./deploy.cjs'),
      local: require('./local.cjs'),
      library: require('./library.cjs'),
      fetch: (...args) => fetch(...args),
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      transferOf: (context) => context.transfer(),
      classify: (context) => require('./setup.cjs').classifyAccount(context),
      ...deps,
    },
    state: () => current,
    reload() { current = state.readState(dataRoot); return current; },
    save,
    setCloud(patch) {
      save((next) => { next.cloud = { ...(next.cloud || {}), ...patch }; return next; });
      return current.cloud;
    },
    setWork(patch) { Object.assign(work, patch); },
    runningStep: null,
    setCurrentStep(id) { ctx.runningStep = id; },
    journal(id, status, detail = '') { current = state.journalStep(dataRoot, id, status, detail); return current; },
    stepStatus(id) {
      const step = (current.steps || []).find((entry) => entry && entry.id === id);
      return step ? step.status : null;
    },
    recordError(error) { current = state.recordError(dataRoot, error); return current; },
    setPausedForMove(ids) { save((next) => { next.pausedForMove = [...ids]; return next; }); },
    secrets: () => state.readSecrets(dataRoot),
    saveSecrets(secrets) { state.writeSecrets(dataRoot, secrets); },
    transferToken: () => transferToken || (state.readSecrets(dataRoot) || {}).transferToken || null,
    setTransferToken(token) {
      transferToken = token;
      const stored = state.readSecrets(dataRoot) || {};
      state.writeSecrets(dataRoot, { ...stored, transferToken: token });
    },
    clearTransferToken() {
      transferToken = null;
      const stored = state.readSecrets(dataRoot) || {};
      delete stored.transferToken;
      state.writeSecrets(dataRoot, stored);
    },
    transfer() {
      const token = ctx.transferToken();
      if (!token) {
        throw new StepError('TRANSFER_TOKEN_MISSING', 'This install has no transfer credential.', {
          hint: 'Run setup again; the credential is created when the Worker is deployed.',
        });
      }
      return createTransfer({ url: current.cloud && current.cloud.url, token, fetchImpl: ctx.deps.fetch });
    },
    captureEnvMode() {
      if (flags.captureEnv) return flags.captureEnv;
      return flags.managed ? 'replace' : 'keep';
    },
    captureEnvText() {
      const stored = ctx.secrets() || {};
      return `SNIP_URL=${current.cloud.url}\nCAPTURE_TOKEN=${stored.captureToken || ''}\n`;
    },
    async openUrl(url) {
      if (flags.noOpen) return { opened: false };
      const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
      try {
        const { spawn } = require('node:child_process');
        const child = spawn(command, [url], { stdio: 'ignore', detached: true });
        child.unref();
        return { opened: true };
      } catch (error) {
        return { opened: false, error: error.message };
      }
    },
    checkCancel() {
      if (cancelled) throw new CancelledError();
    },
    onCancel(fn) {
      cancels.add(fn);
      return () => cancels.delete(fn);
    },
    cancel() {
      cancelled = true;
      for (const fn of cancels) {
        try { fn(); } catch {}
      }
      cancels.clear();
    },
    get cancelled() { return cancelled; },
  };
  return ctx;
}

/** Mark the run `enabling` before any mutation, then run the steps. */
async function runSetup(ctx, steps) {
  const { beginEnabling } = state;
  const before = ctx.state();
  if (before.mode === 'cloud') {
    throw new StepError('ALREADY_CLOUD', 'This library is already using the cloud.', { hint: 'Run `pull` to copy it back, or `status` to see it.' });
  }
  if (before.mode !== 'enabling') beginEnabling(ctx.dataRoot);
  else if (!ctx.reload().cloud) beginEnabling(ctx.dataRoot);
  ctx.reload();
  const result = await runSteps(steps, ctx);
  return result;
}

function pendingStepIds(all, done) {
  const finished = new Set((done || []).filter((step) => step && (step.status === 'done' || step.status === 'skipped')).map((step) => step.id));
  return all.filter((id) => !finished.has(id));
}

module.exports = { createContext, pendingStepIds, runSetup };
