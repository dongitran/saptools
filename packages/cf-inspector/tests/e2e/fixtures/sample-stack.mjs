// Stack-walking fixture used by the e2e suite. Not linted on purpose — kept as
// a plain JavaScript file so the inspector can attach without TypeScript build
// steps.

let tick = 0;
const throwAt = Number.parseInt(process.env['STACK_THROW_AT'] || '0', 10);
const throwCaught = process.env['STACK_THROW_CAUGHT'] === '1';
const throwMode = process.env['STACK_THROW_MODE'] || 'none';

function deeperHelper(state) {
  const tagged = { id: state.id, label: 'deeper', stamp: state.stamp };
  // Marker line for the stack-walking e2e checks.
  return tagged.id;
}

function helper(payload) {
  const wrapped = deeperHelper({ id: payload.id, stamp: `s-${payload.id.toString()}` });
  return wrapped;
}

function entry(payload) {
  const session = { id: payload.id, traceId: `tr-${payload.id.toString()}` };
  if (throwMode === 'uncaught' && tick >= throwAt) {
    throw new Error(`stack-fixture uncaught at tick ${tick.toString()}`);
  }
  if (throwMode === 'caught') {
    try {
      throw new Error('stack-fixture caught failure');
    } catch (caught) {
      void caught;
    }
  }
  if (throwCaught) {
    try {
      throw new Error('stack-fixture caught failure');
    } catch (caught) {
      void caught;
    }
  }
  return helper({ id: session.id });
}

function tickOnce() {
  tick += 1;
  if (throwMode === 'uncaught') {
    // Allow the exception to propagate to the timer; Node will emit
    // 'uncaughtException' which we swallow below to keep the fixture alive.
    const result = entry({ id: tick });
    if (process.env['STACK_VERBOSE'] === '1') {
      process.stdout.write(`${JSON.stringify({ tick, result })}\n`);
    }
    return;
  }
  try {
    const result = entry({ id: tick });
    if (process.env['STACK_VERBOSE'] === '1') {
      process.stdout.write(`${JSON.stringify({ tick, result })}\n`);
    }
  } catch (err) {
    if (process.env['STACK_VERBOSE'] === '1') {
      process.stdout.write(`tick ${tick.toString()} error: ${err && err.message ? err.message : String(err)}\n`);
    }
  }
}

setInterval(tickOnce, 150);

process.on('uncaughtException', (err) => {
  if (process.env['STACK_VERBOSE'] === '1') {
    process.stdout.write(`uncaught: ${err && err.message ? err.message : String(err)}\n`);
  }
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

process.stdout.write('sample-stack ready\n');
