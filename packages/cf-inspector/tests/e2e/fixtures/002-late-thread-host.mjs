import { Worker } from 'node:worker_threads';

process.stdout.write('late-thread-host ready\n');

setTimeout(() => {
  const worker = new Worker(new URL('./001-thread-worker.mjs', import.meta.url), {
    name: 'cf-inspector-late-worker',
  });
  worker.once('error', (error) => {
    process.stderr.write(`late thread worker failed: ${error.message}\n`);
    process.exit(1);
  });
}, 700);

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
