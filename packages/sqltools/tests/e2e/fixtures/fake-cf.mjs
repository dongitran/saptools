#!/usr/bin/env node
// Fake `cf` binary used by the e2e tests. Reads a JSON "scenario" file whose
// path is provided via the SQLTOOLS_FAKE_CF_SCENARIO env variable and responds
// only to `cf env <app>` — all other sub-commands exit with a non-zero status.

import { readFile } from "node:fs/promises";
import process from "node:process";

const [subcommand, appName] = process.argv.slice(2);

if (subcommand !== "env" || appName === undefined) {
  process.stderr.write(`fake-cf: unsupported invocation ${JSON.stringify(process.argv.slice(2))}\n`);
  process.exit(2);
}

const scenarioPath = process.env.SQLTOOLS_FAKE_CF_SCENARIO;
if (!scenarioPath) {
  process.stderr.write("fake-cf: SQLTOOLS_FAKE_CF_SCENARIO is not set\n");
  process.exit(2);
}

const scenario = JSON.parse(await readFile(scenarioPath, "utf8"));
const apps = scenario.apps ?? {};
const vcap = apps[appName];

if (vcap === undefined) {
  process.stderr.write(`fake-cf: FAILED — no env for app ${appName}\n`);
  process.exit(1);
}

const body = [
  `Getting env variables for app ${appName} in org acme / space dev as e2e@example.com...`,
  "",
  "System-Provided:",
  `VCAP_SERVICES: ${JSON.stringify(vcap, null, 2)}`,
  "",
  `VCAP_APPLICATION: ${JSON.stringify({ application_name: appName }, null, 2)}`,
  "",
].join("\n");

process.stdout.write(body);
