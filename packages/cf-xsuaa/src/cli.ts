import process from "node:process";

import { main } from "./cli/index.js";

export { main } from "./cli/index.js";

try {
  await main(process.argv);
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Error: ${msg}\n`);
  process.exit(1);
}
