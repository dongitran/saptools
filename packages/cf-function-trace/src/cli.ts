import process from "node:process";

import { runCli } from "./cli/main.js";

const abortController = new AbortController();
const abort = (): void => {
  abortController.abort();
};

process.once("SIGINT", abort);
process.once("SIGTERM", abort);
try {
  process.exitCode = await runCli(process.argv, {
    stdout: process.stdout,
    stderr: process.stderr,
    signal: abortController.signal,
  });
} catch {
  process.exitCode = 1;
} finally {
  process.off("SIGINT", abort);
  process.off("SIGTERM", abort);
}
