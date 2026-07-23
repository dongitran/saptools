// This fixture executes debugger-relevant code only after an external stdin
// trigger, so readiness tests do not rely on guessed delays.

let triggerCount = 0;

function runBreakpointTrigger() {
  const triggerState = { count: triggerCount };
  triggerCount += 1; // cf-inspector-armed-breakpoint
  return triggerState;
}

function runExceptionTrigger() {
  try {
    throw new Error('cf-inspector-armed-exception');
  } catch {
    // `exception --type caught` observes this without terminating the fixture.
  }
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  while (input.includes('\n')) {
    const newline = input.indexOf('\n');
    const command = input.slice(0, newline).trim();
    input = input.slice(newline + 1);
    if (command === 'breakpoint') {
      runBreakpointTrigger();
    } else if (command === 'exception') {
      runExceptionTrigger();
    }
  }
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

process.stdout.write('armed-trigger ready\n');
