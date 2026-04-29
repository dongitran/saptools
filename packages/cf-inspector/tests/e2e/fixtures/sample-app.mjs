// Tiny fixture used by the e2e suite. Not linted on purpose — kept as a plain
// JavaScript file so the inspector can attach to it without TypeScript build steps.

let counter = 0;

function handle(payload) {
  const user = { id: payload.id, name: payload.name };
  const accumulator = ['begin'];
  for (let i = 0; i < 3; i += 1) {
    accumulator.push(`step-${i}`);
  }
  // Marker line that the e2e suite breaks on.
  counter += 1;
  return { user, counter, accumulator };
}

setInterval(() => {
  const result = handle({ id: counter + 1, name: `sample-${(counter + 1).toString()}` });
  if (process.env['SAMPLE_VERBOSE'] === '1') {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
}, 200);

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

process.stdout.write('sample-app ready\n');
