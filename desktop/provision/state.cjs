'use strict';
// cloud.json is the engine's journal and the app's mode record. One writer, one
// atomic write per change, and unknown fields survive every rewrite so a newer
// app can add fields without this engine dropping them.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const LOCK_STALE_MS = 15 * 60 * 1000;
const MODES = new Set(['local', 'enabling', 'cloud', 'disabling']);
const STEP_STATUSES = new Set(['done', 'skipped', 'failed', 'waiting']);

class StateError extends Error {
  constructor(code, message, hint) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

const profileDir = (dataRoot) => path.join(dataRoot, '.snip');
const statePath = (dataRoot) => path.join(profileDir(dataRoot), 'cloud.json');
const lockPath = (dataRoot) => path.join(profileDir(dataRoot), 'cloud.lock');
const secretsPath = (dataRoot) => path.join(profileDir(dataRoot), 'cloud-secrets.json');

function emptyState() {
  return {
    version: 1,
    mode: 'local',
    library: { id: null },
    cloud: null,
    snapshot: null,
    transfer: null,
    steps: [],
    error: null,
  };
}

function randomId() {
  return crypto.randomBytes(8).toString('hex');
}

/** Read cloud.json. A missing file is a local library, not an error. */
function readState(dataRoot) {
  let text;
  try {
    text = fs.readFileSync(statePath(dataRoot), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return emptyState();
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new StateError('STATE_INVALID', 'The cloud setup journal is damaged.', `Inspect ${statePath(dataRoot)} and run \`abort\` if setup was interrupted.`);
  }
  if (!parsed || typeof parsed !== 'object' || parsed.version !== 1) {
    throw new StateError('STATE_UNSUPPORTED', 'This library records a cloud setup version this Snip does not understand.', 'Update Snip, then try again.');
  }
  const state = { ...emptyState(), ...parsed };
  if (!MODES.has(state.mode)) state.mode = 'local';
  if (!Array.isArray(state.steps)) state.steps = [];
  if (!state.library || typeof state.library !== 'object') state.library = { id: null };
  return state;
}

function fsyncDir(dir) {
  let fd;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch {
    // Directory fsync is not available on every platform; the rename is still atomic.
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Write JSON 0600 through a temp file, fsync and rename. */
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${crypto.randomBytes(12).toString('hex')}`;
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, file);
    fsyncDir(path.dirname(file));
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch {}
  }
}

function writeState(dataRoot, state) {
  writeJsonAtomic(statePath(dataRoot), state);
  return state;
}

/** Read, mutate, write. The mutator receives the object read from disk, so unknown fields persist. */
function updateState(dataRoot, mutate) {
  const current = readState(dataRoot);
  const next = mutate(current) || current;
  return writeState(dataRoot, next);
}

function setMode(dataRoot, mode) {
  if (!MODES.has(mode)) throw new StateError('STATE_INVALID', `Unknown mode ${mode}.`);
  return updateState(dataRoot, (state) => { state.mode = mode; return state; });
}

/**
 * Record intent before the first mutation. Refuses to start over a healthy
 * cloud install; an interrupted `enabling` is resumed instead.
 *
 * A new run starts from a clean step journal: the previous run's `done` steps
 * describe a different operation, and replaying them would skip provisioning
 * this time. Only an interrupted run (already `enabling`) keeps its journal.
 */
function beginEnabling(dataRoot) {
  return updateState(dataRoot, (state) => {
    if (state.mode === 'cloud') throw new StateError('ALREADY_CLOUD', 'This library is already using the cloud.', 'Run `status` to see it, or `pull` to copy it back.');
    if (state.mode === 'disabling') throw new StateError('BUSY_MODE', 'A copy-back is in progress.', 'Let it finish or run `abort` first.');
    if (!state.library.id) state.library.id = randomId();
    if (state.mode !== 'enabling') {
      state.steps = [];
      state.pausedForMove = [];
      state.transfer = null;
      if (state.cloud) {
        // Keep what the account already holds (ids, url, detachedAt) so guard
        // can recognise this Mac's own install, but drop the last run's outcome.
        const { outcome, move, ...kept } = state.cloud;
        state.cloud = kept;
      }
    }
    state.mode = 'enabling';
    state.error = null;
    return state;
  });
}

function journalStep(dataRoot, id, status, detail = '') {
  if (!STEP_STATUSES.has(status)) throw new StateError('STATE_INVALID', `Unknown step status ${status}.`);
  return updateState(dataRoot, (state) => {
    const at = new Date().toISOString();
    const entry = { id, status, at, detail };
    const index = state.steps.findIndex((step) => step && step.id === id);
    if (index >= 0) state.steps[index] = { ...state.steps[index], ...entry };
    else state.steps.push(entry);
    if (status !== 'failed') state.error = null;
    return state;
  });
}

function journalBulk(dataRoot, entries) {
  return updateState(dataRoot, (state) => {
    for (const { id, status, detail = '' } of entries) {
      const at = new Date().toISOString();
      const index = state.steps.findIndex((step) => step && step.id === id);
      const entry = { id, status, at, detail };
      if (index >= 0) state.steps[index] = { ...state.steps[index], ...entry };
      else state.steps.push(entry);
    }
    return state;
  });
}

function recordError(dataRoot, error) {
  return updateState(dataRoot, (state) => {
    state.error = {
      step: error.step || null,
      code: error.code || 'FAILED',
      message: error.message,
      hint: error.hint || null,
      at: new Date().toISOString(),
    };
    return state;
  });
}

function clearError(dataRoot) {
  return updateState(dataRoot, (state) => { state.error = null; return state; });
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

class LockedError extends StateError {
  constructor(holder) {
    super('LOCKED', 'Another Snip process is already setting up cloud.', 'Wait for it to finish, or run `abort` if it is stuck.');
    this.holder = holder || null;
  }
}

/** Take the exclusive cloud lock. A dead process or a 15-minute-old lock may be reclaimed once. */
function acquireLock(dataRoot, { command = 'setup', now = Date.now(), pid = process.pid, host = os.hostname() } = {}) {
  fs.mkdirSync(profileDir(dataRoot), { recursive: true, mode: 0o700 });
  const file = lockPath(dataRoot);
  const record = { v: 1, pid, startedAt: now, command, host };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });
      return { path: file, record, release() { releaseLock(file, record); } };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let holder = null;
      try { holder = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
      const stale = !holder || holder.v !== 1 || !Number.isFinite(holder.startedAt) || now - holder.startedAt > LOCK_STALE_MS || !pidAlive(holder.pid);
      if (!stale || attempt === 1) throw new LockedError(holder);
      try { fs.unlinkSync(file); } catch {}
    }
  }
  throw new LockedError();
}

function releaseLock(file, record) {
  try {
    const holder = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (holder.pid === record.pid && holder.startedAt === record.startedAt) fs.unlinkSync(file);
  } catch {}
}

function readLock(dataRoot) {
  try { return JSON.parse(fs.readFileSync(lockPath(dataRoot), 'utf8')); } catch { return null; }
}

/** Locally generated Worker secrets. Kept out of cloud.json, which the renderer reads. */
function readSecrets(dataRoot) {
  try {
    const parsed = JSON.parse(fs.readFileSync(secretsPath(dataRoot), 'utf8'));
    return parsed && parsed.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

function writeSecrets(dataRoot, secrets) {
  const value = { version: 1, ...secrets };
  writeJsonAtomic(secretsPath(dataRoot), value);
  return value;
}

module.exports = {
  LOCK_STALE_MS,
  LockedError,
  StateError,
  acquireLock,
  beginEnabling,
  clearError,
  emptyState,
  journalBulk,
  journalStep,
  lockPath,
  pidAlive,
  profileDir,
  readLock,
  readSecrets,
  readState,
  recordError,
  releaseLock,
  secretsPath,
  setMode,
  statePath,
  updateState,
  writeJsonAtomic,
  writeSecrets,
  writeState,
};
