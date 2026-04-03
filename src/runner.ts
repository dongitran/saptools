#!/usr/bin/env node
// One-shot sync runner — invoked by launchd every 15 min and as postinstall warm-up.
// Reads credentials from env vars; exits gracefully if not set.
import process from "node:process";
import { syncAll } from "./sync.js";

const email = process.env["SAP_EMAIL"];
const password = process.env["SAP_PASSWORD"];

if (!email || !password) {
  process.stdout.write("saptools-sync: skipping (SAP_EMAIL / SAP_PASSWORD not set in environment)\n");
  process.exit(0);
}

syncAll(email, password, { verbose: true }).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);

  process.stderr.write(`saptools-sync: ${msg}\n`);
  process.exit(1);
});
