// This host keeps both the main isolate and one named worker busy so the E2E
// suite can distinguish raw inspector targets from NodeWorker sub-sessions.
import { Worker } from 'node:worker_threads';

let mainCounter = 0;

function runMainTask() {
  const mainLocal = { threadLabel: 'main-session', tick: mainCounter };
  mainCounter += 1; // cf-inspector-main-breakpoint
  return mainLocal;
}

const worker = new Worker(new URL('./001-thread-worker.mjs', import.meta.url), {
  name: 'cf-inspector-e2e-worker',
});

worker.once('message', (message) => {
  if (message === 'ready') {
    process.stdout.write('thread-host ready\n');
  }
});
worker.once('error', (error) => {
  process.stderr.write(`thread worker failed: ${error.message}\n`);
  process.exit(1);
});

setInterval(runMainTask, 120);

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
