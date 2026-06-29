#!/usr/bin/env node

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function logInvocation(command, args) {
  const logPath = process.env["CF_OPS_FAKE_LOG_PATH"];
  if (!logPath) {
    fail("Missing CF_OPS_FAKE_LOG_PATH");
  }
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(
    logPath,
    `${JSON.stringify({
      command,
      args,
      env: {
        hasSapEmail: process.env["SAP_EMAIL"] !== undefined,
        hasSapPassword: process.env["SAP_PASSWORD"] !== undefined,
      },
    })}\n`,
    "utf8",
  );
}

const [command, ...args] = process.argv.slice(2);
if (!command) {
  fail("Missing fake CF command");
}

const supported = new Set(["restart", "restage", "start", "stop", "scale"]);
if (!supported.has(command)) {
  fail(`Unsupported fake CF command: ${command}`);
}

await logInvocation(command, args);
process.stdout.write(`fake cf ${command} ${args.join(" ")}\n`);
