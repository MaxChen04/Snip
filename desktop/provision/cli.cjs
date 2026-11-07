#!/usr/bin/env node
'use strict';
// The provisioning engine's front door.
//
//   node desktop/provision/cli.cjs <command> [flags]
//
// Commands: setup | pull | deploy | migrate | status | detach |
//           delete-resources | snapshot <restore|delete|delete-export> | abort |
//           owner <link|rotate>
//
// Flags: --root --data-root --json --yes --check --resume --login --domain
//        --account --capture-env --no-open --managed --confirm
//
// Exit codes: 0 ok · 1 failed · 2 needs_input · 3 locked · 4 unsupported.
// The engine never reads stdin: missing input is exit 2 plus `needs_input`.

const fs = require('node:fs');
const path = require('node:path');

const { createEmitter } = require('./emit.cjs');
const state = require('./state.cjs');
const { CancelledError, ChoiceRequired, ConfirmRequired, NeedsInputError, StepError } = require('./engine.cjs');
const { createApi, createWrangler } = require('./deps.cjs');
const { createContext } = require('./context.cjs');

const COMMANDS = new Set(['setup', 'pull', 'deploy', 'migrate', 'status', 'detach', 'delete-resources', 'snapshot', 'abort', 'owner']);
const VALUE_FLAGS = new Set(['root', 'data-root', 'login', 'domain', 'account', 'capture-env', 'confirm']);
// `resume` is accepted and deliberately never read: every step re-verifies, so a
// run always resumes where the last one stopped and the flag cannot change that.
// The desktop app and the docs spell `setup --resume`, so it must stay accepted.
const BOOLEAN_FLAGS = new Set(['json', 'yes', 'check', 'resume', 'no-open', 'managed', 'adopt-existing', 'no-handoff', 'help', 'version']);

const EXIT = { OK: 0, FAILED: 1, NEEDS_INPUT: 2, LOCKED: 3, UNSUPPORTED: 4, CANCELLED: 1 };

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.code = 'USAGE';
  }
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const [rawName, inline] = arg.slice(2).split('=', 2);
    const name = rawName;
    if (VALUE_FLAGS.has(name)) {
      const value = inline !== undefined ? inline : argv[++index];
      if (value === undefined) throw new UsageError(`--${name} needs a value.`);
      flags[name] = value;
      continue;
    }
    if (BOOLEAN_FLAGS.has(name)) {
      flags[name] = inline === undefined ? true : !['false', '0', 'no'].includes(inline);
      continue;
    }
    throw new UsageError(`Unknown option --${name}.`);
  }
  return { flags, positional };
}

function normalizeFlags(flags) {
  if (flags['data-root'] === undefined && flags.root !== undefined) flags['data-root'] = flags.root;
  // Steps read camelCase; the flags arrive dashed. Keep both so the documented
  // spelling works and nothing has to remember which one a step uses.
  const camel = { 'data-root': 'dataRoot', 'no-open': 'noOpen', 'adopt-existing': 'adoptExisting', 'capture-env': 'captureEnv', 'no-handoff': 'noHandoff' };
  for (const [dashed, name] of Object.entries(camel)) {
    if (flags[dashed] !== undefined) flags[name] = flags[dashed];
  }
  if (flags['capture-env'] && !['replace', 'separate', 'keep'].includes(flags['capture-env'])) {
    throw new UsageError('--capture-env must be replace, separate or keep.');
  }
  return flags;
}

function defaultRoot() {
  // cli.cjs lives at <root>/desktop/provision/cli.cjs.
  return path.resolve(__dirname, '../..');
}

function helpText() {
  return [
    'Snip cloud setup',
    '',
    'Usage: node desktop/provision/cli.cjs <command> [flags]',
    '',
    'Commands:',
    '  setup                Enable cloud: provision, deploy and copy this library',
    '  setup --check        Preflight only; nothing is changed',
    '  pull                 Copy the cloud library back to this Mac',
    '  deploy               Deploy the built Worker with the saved config',
    '  migrate              Apply pending migrations to the cloud database',
    '  status               Print the cloud state (see --json)',
    '  detach               Go back to local; the cloud library stays live',
    '  delete-resources     Delete the cloud Worker, database, KV and bucket',
    '  snapshot restore     Switch back to the library a `pull` replaced',
    '  snapshot delete      Delete that previous library (needs --confirm <name>)',
    '  snapshot delete-export  Delete setup\'s portable backup files (needs --confirm <name>)',
    '  abort                Clean up an interrupted setup',
    '  owner link           Mint and open a sign-in link',
    '  owner rotate         Replace the owner secret and mint a new sign-in link',
    '',
    'Flags: --root --data-root --json --yes --check --resume --login --domain',
    '       --account --capture-env <replace|separate|keep> --no-open --managed',
    '       --adopt-existing --no-handoff --confirm <basename|host>',
    '',
    '--resume is optional; setup always resumes where it stopped.',
    '',
    '--no-handoff is for `owner link` when the link is for another browser or',
    'device: the link carries port 0, no handoff is attempted, and the command',
    'ends as soon as the link is minted. `setup` always uses the handoff.',
  ].join('\n');
}

/** Exit 2 payload: what is missing and how to supply it. */
function needsInputResult(error) {
  return {
    export: { event: 'needs_input', keys: error.keys || [] },
    result: { ok: false, code: 'NEEDS_INPUT', mode: null, data: { keys: error.keys || [] }, message: error.message },
    code: 2,
  };
}

// Every preflight refusal is exit 4 with its own code (§1.3).
const UNSUPPORTED_CODES = new Set(['NOT_A_LIBRARY', 'NO_NODE', 'NO_WRANGLER', 'NO_BUILD', 'BAD_CONFIG', 'NOT_AN_ACCOUNT', 'LOCAL_SERVER_RUNNING', 'UNSUPPORTED_PLATFORM', 'FOREIGN_SNIP']);
// Only these two can succeed by simply running the same command again.
const RETRYABLE = new Set(['NOT_AN_ACCOUNT', 'LOCAL_SERVER_RUNNING']);

function exitCodeFor(error) {
  if (error instanceof NeedsInputError || error instanceof ChoiceRequired || error instanceof ConfirmRequired) return 2;
  if (error instanceof state.LockedError || error.code === 'LOCKED') return 3;
  if (error instanceof CancelledError || error.code === 'CANCELLED') return 1;
  if (UNSUPPORTED_CODES.has(error.code)) return 4;
  return 1;
}

function retryableFor(error) {
  if (typeof error.retryable === 'boolean') return error.retryable;
  return RETRYABLE.has(error.code);
}

async function main(argv, io = {}) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    const emit = createEmitter({ json: argv.includes('--json'), stdout: io.stdout, stderr: io.stderr });
    emit.result({ ok: false, code: 'USAGE', mode: null, data: {}, message: error.message });
    return { code: 1 };
  }
  const flags = normalizeFlags(parsed.flags);
  if (flags.help) {
    (io.stdout || process.stdout).write(`${helpText()}\n`);
    return { code: 0 };
  }
  let command = parsed.positional[0] || 'setup';
  if (command === 'help') {
    (io.stdout || process.stdout).write(`${helpText()}\n`);
    return { code: 0 };
  }
  if (!COMMANDS.has(command)) {
    (io.stderr || process.stderr).write(`Unknown command ${command}.\n\n${helpText()}\n`);
    return { code: 1 };
  }
  const sub = parsed.positional[1] || null;
  if (command === 'snapshot') flags.snapshotAction = sub;
  if (command === 'owner') flags.ownerAction = sub;

  const json = Boolean(flags.json);
  // With --json, stdout belongs to the event stream and nothing else. Wrangler's
  // own progress lines ("[wrangler:info] …", ANSI banners) are written straight
  // to process.stdout by libraries, so in JSON mode they are routed to stderr;
  // the emitter keeps the real stream.
  const target = io.stdout || process.stdout;
  const realStdoutWrite = target.write.bind(target);
  const stdout = { write: (chunk) => realStdoutWrite(chunk) };
  const originalStdoutWrite = process.stdout.write;
  const redirectStdout = json && !io.stdout;
  if (redirectStdout) {
    process.stdout.write = (chunk, encoding, callback) => process.stderr.write(chunk, encoding, callback);
  }
  const emit = createEmitter({ json, stdout, stderr: io.stderr || process.stderr, command });
  const root = path.resolve(flags.root || defaultRoot());
  const dataRoot = path.resolve(flags['data-root'] || root);

  // --check and status never take the lock: they are read-only.
  const takesLock = !['status'].includes(command) && !(command === 'setup' && flags.check);
  let lock = null;
  let ctx = null;
  const onSignal = () => { if (ctx) ctx.cancel(); };
  try {
    if (takesLock) {
      try {
        lock = state.acquireLock(dataRoot, { command });
      } catch (error) {
        if (error.code !== 'LOCKED') throw error;
        emit.result({ ok: false, code: 'LOCKED', mode: null, data: { holder: error.holder || null }, message: error.message, retryable: true });
        return { code: 3 };
      }
    }

    const wrangler = createWrangler({ root, nodePath: process.execPath, env: process.env });
    const api = createApi({});
    ctx = createContext({ root, dataRoot, flags, emit, api, wrangler, lock, release: false });
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);

    const commands = require('./commands.cjs');
    let outcome;
    switch (command) {
      case 'setup': outcome = await commands.commandSetup(ctx); break;
      case 'pull': outcome = await commands.commandPull(ctx); break;
      case 'deploy': outcome = await commands.commandDeploy(ctx); break;
      case 'migrate': outcome = await commands.commandMigrate(ctx); break;
      case 'detach': outcome = await commands.commandDetach(ctx); break;
      case 'delete-resources': outcome = await commands.commandDeleteResources(ctx); break;
      case 'snapshot': outcome = await commands.commandSnapshot(ctx); break;
      case 'abort': outcome = await commands.commandAbort(ctx); break;
      case 'owner': outcome = await commands.commandOwner(ctx); break;
      case 'status': outcome = await commands.commandStatus(ctx, { check: Boolean(flags.check) }); break;
      default: throw new UsageError(`Unknown command ${command}.`);
    }

    ctx.reload();
    const mode = ctx.state().mode;
    // status prints the state itself in human mode; JSON mode emits the result event only.
    if (command === 'status' && !json) (io.stdout || process.stdout).write(outcome.text || '');
    emit.result({ ok: true, code: outcome.code || 'OK', mode: outcome.mode || mode, data: outcome.data || {}, message: outcome.message || '' });
    return { code: EXIT[outcome.code || 'OK'] || 0, outcome };
  } catch (error) {
    if (error instanceof ChoiceRequired) {
      // Terminal by design: a decision with consequences is never inferred.
      emit.choice({ step: error.choice.step || 'guard', ...error.choice });
      emit.result({
        ok: false,
        code: 'NEEDS_INPUT',
        mode: null,
        data: { choice: error.choice.id, resumeWith: error.resumeWith },
        message: error.message,
        retryable: true,
      });
      return { code: 2 };
    }
    if (error instanceof ConfirmRequired) {
      // A destructive command without its target name: exit 2 with the value
      // and the exact command to run. Nothing was mutated.
      emit.result({
        ok: false,
        code: 'NEEDS_INPUT',
        mode: null,
        data: { needs: 'confirm', expected: error.confirm.expected, command: error.confirm.command },
        message: error.message,
        retryable: true,
      });
      return { code: 2 };
    }
    if (error instanceof NeedsInputError) {
      emit.needsInput(error.keys || []);
      emit.result({ ok: false, code: 'NEEDS_INPUT', mode: null, data: { keys: error.keys || [] }, message: error.message, retryable: true });
      return needsInputResult(error);
    }
    if (error instanceof CancelledError || error.code === 'CANCELLED') {
      emit.result({ ok: false, code: 'CANCELLED', mode: null, data: {}, message: 'Cancelled. Everything completed so far is kept.', retryable: true });
      return { code: 1 };
    }
    if (error instanceof state.LockedError || error.code === 'LOCKED') {
      emit.result({ ok: false, code: 'LOCKED', mode: null, data: { holder: error.holder || null }, message: error.message, retryable: true });
      return { code: 3 };
    }
    const code = exitCodeFor(error);
    if (code !== 2) {
      try {
        if (ctx) {
          ctx.recordError({
            step: error.step || null,
            code: error.code || 'FAILED',
            message: error.message,
            hint: error.hint || null,
          });
        }
      } catch {}
      if (error.hint) emit.log('error', error.hint);
    }
    const specific = error.code || 'FAILED';
    emit.result({
      ok: false,
      code: code === 4 ? specific : 'FAILED',
      mode: null,
      // The specific code names the failure; `code` stays inside the contract's set.
      data: { code: specific, ...(error.data || {}) },
      message: error.message,
      retryable: code === 4 ? retryableFor(error) : false,
    });
    return { code };
  } finally {
    if (redirectStdout) process.stdout.write = originalStdoutWrite;
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    try { if (lock) lock.release(); } catch {}
  }
}

module.exports = { COMMANDS, EXIT, exitCodeFor, helpText, main, normalizeFlags, parseArgs, retryableFor };

if (require.main === module) {
  main(process.argv.slice(2))
    .then(({ code }) => { process.exitCode = code; })
    .catch((error) => {
      process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    });
}
