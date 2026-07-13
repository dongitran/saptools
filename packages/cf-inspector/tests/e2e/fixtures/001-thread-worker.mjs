// This worker publishes a recurring frame with worker-local state. A named
// readiness message lets the host fixture avoid timing-based test setup.
import { parentPort } from 'node:worker_threads';

let workerCounter = 0;

function runWorkerTask() {
  const workerLocal = { threadLabel: 'worker-session', tick: workerCounter };
  workerCounter += 1; // cf-inspector-worker-breakpoint
  return workerLocal;
}

setInterval(runWorkerTask, 80);
parentPort?.postMessage('ready');
