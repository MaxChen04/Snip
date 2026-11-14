'use strict';
// One event stream for both front ends. With --json every stdout line is NDJSON
// and human text goes to stderr; without it the same events render as a plain
// terminal transcript. Nothing here ever writes a secret.

function createEmitter({ json = false, stdout = process.stdout, stderr = process.stderr, command = 'setup' } = {}) {
  const write = (line) => stdout.write(`${line}\n`);
  const note = (line) => stderr.write(`${line}\n`);

  const send = (event) => {
    if (json) write(JSON.stringify({ v: 1, ...event }));
  };

  function step(stepId, status, message, extra = {}) {
    if (json) {
      send({ event: 'step', command, step: stepId, status, message, ...extra });
      return;
    }
    if (status === 'started') {
      const progress = extra.progress ? `${extra.progress.done + 1}/${extra.progress.total} ` : '';
      write(`\x1b[1m›\x1b[0m ${progress}${message}`);
    } else if (status === 'skipped') {
      if (message) write(`  \x1b[2m· ${message}\x1b[0m`);
    } else if (status === 'ok') {
      if (message) write(`  \x1b[32m✓\x1b[0m ${message}`);
    } else if (status === 'waiting') {
      write(`  \x1b[33m…\x1b[0m ${message}`);
    } else if (status === 'failed') {
      note(`  \x1b[31m✗\x1b[0m ${message}`);
    }
  }

  function log(level, message) {
    if (json) {
      send({ event: 'log', level, message });
      return;
    }
    const prefix = level === 'error' ? '\x1b[31m✗\x1b[0m' : level === 'warn' ? '\x1b[33m!\x1b[0m' : '\x1b[2m·\x1b[0m';
    note(`${prefix} ${message}`);
  }

  function human(stepId, action, url, message) {
    if (json) {
      send({ event: 'human', step: stepId, action, url: url || null, message });
      return;
    }
    write(`\n\x1b[1m${message}\x1b[0m${url ? `\n  ${url}` : ''}\n`);
  }

  function needsInput(keys) {
    if (json) {
      send({ event: 'needs_input', keys });
      return;
    }
    note('\nMore information is needed:');
    for (const key of keys) note(`  ${key.label}${key.secret ? ' (secret)' : ''}${key.key ? ` — pass --${key.key}` : ''}`);
  }

  /** A terminal decision with consequences; never answered by a default. */
  function choice({ step, id, message, data = {}, options = [] }) {
    if (json) {
      send({ event: 'choice', step, id, message, data, options });
      return;
    }
    write(`\n\x1b[1m${message}\x1b[0m`);
    for (const option of options) {
      const command = option.command ? `  (${option.command})` : '';
      write(`  • ${option.label}${option.detail ? ` — ${option.detail}` : ''}${command}`);
    }
    write('');
  }

  function session(token, url) {
    // Only the JSON front end receives a session; the human path prints nothing
    // beyond what human() already showed, and the token is never written to a log.
    if (json) send({ event: 'session', token, url });
    else write('  \x1b[32m✓\x1b[0m Signed in.');
  }

  function result({ ok, code, mode, data = {}, message = '', retryable }) {
    if (json) {
      const event = { event: 'result', ok, code, mode: mode || null, data };
      if (!ok && retryable !== undefined) event.retryable = retryable;
      // The sentence for a failure that has no failed step to carry it (a refusal, a lock).
      if (!ok && message) event.message = message;
      send(event);
      return;
    }
    if (ok) {
      write(`\n\x1b[32m✓\x1b[0m ${message || 'Done.'}`);
    } else {
      note(`\n\x1b[31m✗\x1b[0m ${message || 'Failed.'}`);
    }
  }

  return { command, choice, event: send, human, log, needsInput, result, session, step };
}

module.exports = { createEmitter };
