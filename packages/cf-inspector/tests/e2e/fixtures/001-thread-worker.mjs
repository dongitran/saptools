// This worker publishes a recurring frame with worker-local state. A named
// readiness message lets the host fixture avoid timing-based test setup.
import { parentPort } from 'node:worker_threads';

let workerCounter = 0;

function runWorkerTask() {
  const workerLocal = { threadLabel: 'worker-session', tick: workerCounter };
  workerCounter += 1; // cf-inspector-worker-breakpoint
  if (workerCounter % 5 === 0) {
    try {
      throw new Error('worker-caught-exception');
    } catch {
      // The exception command can opt into caught exceptions without terminating the worker.
    }
  }
  return workerLocal;
}

setInterval(runWorkerTask, 80);
parentPort?.postMessage('ready');
