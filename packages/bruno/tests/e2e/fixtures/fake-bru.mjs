#!/usr/bin/env node
import { appendFileSync } from "node:fs";

const logPath = process.env["FAKE_BRU_LOG"];
const payload = JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  saptoolsAccessToken: process.env["SAPTOOLS_ACCESS_TOKEN"] ?? null,
});
if (logPath) {
  appendFileSync(logPath, `${payload}\n`, "utf8");
}
process.stdout.write(`FAKE_BRU_OK ${payload}\n`);
process.exit(0);
