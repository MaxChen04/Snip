'use strict';
// The step runner: verify-then-skip, journal, cancellation, and one failure shape.
//
// A step is { id, title, run(ctx), verify(ctx), skip?(ctx) }.
//   run    mutates; returns optional data for the ok event.
//   verify never mutates and answers "is this step already satisfied?".
//   skip   says the step does not apply to this library (empty library, no owner).
// Completed steps are re-verified on resume; a step that no longer verifies runs again.

class NeedsInputError extends Error {
  constructor(keys, message = 'More information is needed.') {
    super(message);
    this.code = 'NEEDS_INPUT';
    this.keys = keys;
  }
}

class StepError extends Error {
  constructor(code, message, { hint = null, data = null, step = null, retryable } = {}) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.data = data;
    this.step = step;
    // Preflight refusals say whether running the same command again could help.
    if (retryable !== undefined) this.retryable = retryable;
  }
}

/** A terminal decision the caller must make: emit `choice`, then exit 2. */
class ChoiceRequired extends Error {
  constructor({ id, message, data = {}, options = [], resumeWith }) {
    super(message);
    this.code = 'NEEDS_INPUT';
    this.choice = { id, message, data, options };
    this.resumeWith = resumeWith;
  }
}

/**
 * A destructive command run without naming its target. Exit 2 and name the exact
 * value and command; the engine never prompts and nothing is mutated.
 */
class ConfirmRequired extends Error {
  constructor({ expected, command, message = 'This command needs the name of what it will delete.' }) {
    super(message);
    this.code = 'NEEDS_INPUT';
    this.confirm = { expected, command };
  }
}

class CancelledError extends Error {
  constructor() {
    super('Cancelled.');
    this.code = 'CANCELLED';
  }
}

function stepTitle(step) {
  return step.title || step.id;
}

/**
 * Run steps in order. `ctx` supplies emit, state access, cancellation and deps.
 * Throws NeedsInputError, StepError or CancelledError; the command layer turns
 * those into a result event and an exit code.
 */
async function runSteps(steps, ctx, { journal = true } = {}) {
  const total = steps.length;
  // One-shot commands (owner, snapshot, delete-resources) pass journal:false:
  // their steps describe this invocation, and a stale "done" row must never turn
  // a second `snapshot delete` into a success for an artifact that is gone.
  const record = (id, status, detail) => { if (journal) ctx.journal(id, status, detail); };
  let completed = 0;
  for (let index = 0; index < total; index++) {
    ctx.checkCancel();
    const step = steps[index];
    const title = stepTitle(step);
    const progress = { done: index, total };
    ctx.emit.step(step.id, 'started', title, { progress });
    ctx.setCurrentStep(step.id);

    if (step.skip) {
      let skipped = false;
      try { skipped = await step.skip(ctx); } catch { skipped = false; }
      if (skipped) {
        const reason = (typeof step.skipMessage === 'function' && step.skipMessage(ctx)) || 'Not needed for this library';
        record(step.id, 'skipped', reason);
        ctx.emit.step(step.id, 'skipped', reason, { progress: { done: index + 1, total } });
        completed = index + 1;
        continue;
      }
    }

    const journaled = journal && (ctx.stepStatus(step.id) === 'done' || ctx.stepStatus(step.id) === 'skipped');
    if (journaled && step.verify) {
      let verified = false;
      try { verified = await step.verify(ctx); } catch { verified = false; }
      if (verified) {
        record(step.id, 'done', 'Verified an earlier run');
        ctx.emit.step(step.id, 'skipped', 'Already done', { progress: { done: index + 1, total } });
        completed = index + 1;
        continue;
      }
    }

    let data = {};
    try {
      data = (await step.run(ctx)) || {};
    } catch (error) {
      if (error instanceof NeedsInputError || error instanceof CancelledError || error instanceof ChoiceRequired || error instanceof ConfirmRequired) throw error;
      const failure = error instanceof StepError
        ? error
        : new StepError('STEP_FAILED', error && error.message ? error.message : `${title} failed.`, { hint: error && error.hint });
      failure.step = failure.step || step.id;
      record(step.id, 'failed', failure.message);
      ctx.emit.step(step.id, 'failed', failure.message, { progress: { done: index, total }, data: failure.data || {} });
      throw failure;
    }

    if (step.verify) {
      let verified = true;
      try { verified = await step.verify(ctx); } catch { verified = false; }
      if (!verified) {
        const failure = new StepError('VERIFY_FAILED', `${title} did not take effect.`, {
          hint: 'Fix the cause and run the same command again; completed steps are skipped.',
          step: step.id,
        });
        record(step.id, 'failed', failure.message);
        ctx.emit.step(step.id, 'failed', failure.message, { progress: { done: index, total } });
        throw failure;
      }
    }

    record(step.id, 'done', (data && data.detail) || '');
    ctx.emit.step(step.id, 'ok', (data && data.message) || title, { progress: { done: index + 1, total }, data });
    completed = index + 1;
  }
  return { completed, total };
}

module.exports = { CancelledError, ChoiceRequired, ConfirmRequired, NeedsInputError, StepError, runSteps, stepTitle };
