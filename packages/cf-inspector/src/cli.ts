import process from "node:process";

import { main } from "./cli/program.js";
import { CfInspectorError } from "./types.js";

try {
  await main(process.argv);
} catch (err: unknown) {
  if (err instanceof CfInspectorError) {
    process.stderr.write(`Error [${err.code}]: ${err.message}\n`);
    if (err.detail !== undefined) {
      process.stderr.write(`  detail: ${err.detail}\n`);
    }
    process.exit(1);
  }
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}
