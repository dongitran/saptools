import process from "node:process";

import { main } from "./cli/program.js";

try {
  await main(process.argv);
} catch (error) {
  process.stderr.write(`[cf-live-trace] error: ${formatCliError(error)}\n`);
  process.exitCode = 1;
}

function formatCliError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().length > 0 ? message.trim() : "Unknown error";
}
