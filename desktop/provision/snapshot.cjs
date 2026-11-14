'use strict';
// The snapshot model (contracts §1.11). There are exactly two kinds:
//
//   live   — the local library never moved. `path` is null, and nothing may
//            restore or delete it: detach is the way back.
//   backup — the state dir `pull` replaced, which can be swapped back in.
//
// `export` is setup's portable dump + manifest. It is delete-only: it cannot
// reconstruct the bucket, so the UI must never offer to restore from it.
//
// Every operation here refuses rather than guessing. A restore that returns
// "already using it" when the live library is a different directory is the bug
// this module exists to make impossible.

const fs = require('node:fs');
const path = require('node:path');
const { ConfirmRequired, StepError } = require('./engine.cjs');

/** A directory that can replace `<dataRoot>/web/.wrangler/state` directly. */
function isStateShaped(directory) {
  try {
    if (!fs.statSync(directory).isDirectory()) return false;
  } catch {
    return false;
  }
  if (fs.existsSync(path.join(directory, 'v3'))) return true;
  try {
    const d1 = path.join(directory, 'd1');
    return fs.statSync(d1).isDirectory() && fs.readdirSync(d1).length > 0;
  } catch {
    return false;
  }
}

/** `--confirm` is the basename of the artifact, with any trailing separator stripped. */
function confirmTarget(recordPath) {
  if (!recordPath) return null;
  return path.basename(path.join(String(recordPath), '.'));
}

function rerunCommand(command, expected) {
  return `npm run setup:cloudflare -- ${command} --confirm ${expected}`;
}

/**
 * The stale-record interlock. Missing → exit 2 with the value and the exact
 * command; different → exit 1 and no mutation. A value containing a separator is
 * a mismatch by definition: it names a path, not the row the user saw.
 */
function requireConfirm(ctx, { recordPath, command }) {
  const expected = confirmTarget(recordPath);
  if (!expected) throw new StepError('NO_SNAPSHOT', 'There is nothing to delete.', { hint: 'Nothing was changed.' });
  const received = ctx.flags.confirm;
  if (received === undefined || received === null || received === '') {
    throw new ConfirmRequired({ expected, command: rerunCommand(command, expected) });
  }
  if (typeof received !== 'string' || /[\\/]/.test(received) || received !== expected) {
    throw new StepError('CONFIRM_MISMATCH', 'The confirmation does not name the item being deleted.', {
      hint: `Run the command again with --confirm ${expected}. Nothing was changed.`,
      data: { expected, received: String(received), command: rerunCommand(command, expected) },
    });
  }
  return expected;
}

/** The export directory of a record, including one written before v3.11. */
function exportOf(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  if (snapshot.export && snapshot.export.path) return snapshot.export;
  // An older engine recorded the dump directory as `path` with no kind. It is
  // read by shape, never by name: only a non-state-shaped path is an export.
  // An explicit `export: null` means it was deleted, so there is no fallback.
  if (snapshot.export === undefined && !snapshot.kind && snapshot.path) return { path: snapshot.path, takenAt: snapshot.takenAt || null };
  return null;
}

/** True when two paths name the same directory (symlinks and `..` resolved). */
function sameDirectory(a, b) {
  if (!a || !b) return false;
  const real = (value) => {
    try { return fs.realpathSync(value); } catch { return path.resolve(value); }
  };
  return real(a) === real(b);
}

/**
 * Read a state dir's real counts through a Worker, so a row never claims zero.
 * `library` is the injectable module from the context, not a direct require, so
 * tests never start a real Worker.
 */
async function stateCounts({ library, root, dataRoot, persist, token, log = () => {} }) {
  const withLocalWorker = library.withLocalWorker;
  return withLocalWorker({ root, dataRoot, persist, token, log }, async (handle) => {
    const status = await handle.transfer.status();
    const manifest = await handle.transfer.manifest();
    return {
      refs: Number((status && status.counts && status.counts.refs) || 0),
      pages: Number((status && status.counts && status.counts.pages) || 0),
      files: Array.isArray(manifest && manifest.keys) ? manifest.keys.length : 0,
      bytes: Array.isArray(manifest && manifest.keys) ? manifest.keys.reduce((sum, entry) => sum + (Number(entry.size) || 0), 0) : 0,
    };
  });
}

module.exports = { confirmTarget, exportOf, isStateShaped, rerunCommand, requireConfirm, sameDirectory, stateCounts };
