#!/usr/bin/env node

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function readJson(path, fallback) {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function getScenarioPath() {
  const path = process.env["CF_LOGS_FAKE_SCENARIO"];
  if (!path) {
    fail("Missing CF_LOGS_FAKE_SCENARIO");
  }
  return path;
}

function getStatePath() {
  const cfHome = process.env["CF_HOME"];
  if (!cfHome) {
    fail("Missing CF_HOME");
  }
  return join(cfHome, "fake-cf-state.json");
}

async function logInvocation(command, args, state) {
  const path = process.env["CF_LOGS_FAKE_LOG_PATH"];
  if (!path) {
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await appendFile(
    path,
    `${JSON.stringify({
      at: new Date().toISOString(),
      command,
      args,
      apiEndpoint: state.apiEndpoint ?? null,
      org: state.org ?? null,
      space: state.space ?? null,
    })}\n`,
    "utf8",
  );
}

function indexRegions(scenario) {
  const byEndpoint = new Map();
  for (const region of scenario.regions ?? []) {
    byEndpoint.set(region.apiEndpoint, region);
  }
  return byEndpoint;
}

function requireRegion(state, regionsByEndpoint) {
  const region = regionsByEndpoint.get(state.apiEndpoint ?? "");
  if (!region) {
    fail("No targeted API endpoint");
  }
  return region;
}

function requireOrg(region, state) {
  const org = (region.orgs ?? []).find((item) => item.name === state.org);
  if (!org) {
    fail("No targeted org");
  }
  return org;
}

function requireSpace(org, state) {
  const space = (org.spaces ?? []).find((item) => item.name === state.space);
  if (!space) {
    fail("No targeted space");
  }
  return space;
}

function requireApp(space, name) {
  const app = (space.apps ?? []).find((item) => item.name === name);
  if (!app) {
    fail(`Unknown app: ${name}`);
  }
  return app;
}

async function sleep(delayMs) {
  await new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

async function main() {
  const scenario = await readJson(getScenarioPath(), { regions: [] });
  const statePath = getStatePath();
  const state = await readJson(statePath, {});
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    fail("Missing command");
  }

  await logInvocation(command, args.slice(1), state);
  const regionsByEndpoint = indexRegions(scenario);

  if (command === "api") {
    const endpoint = args[1];
    if (!endpoint || !regionsByEndpoint.has(endpoint)) {
      fail(`Unknown API endpoint: ${endpoint ?? "<missing>"}`);
    }
    state.apiEndpoint = endpoint;
    delete state.org;
    delete state.space;
    await writeJson(statePath, state);
    process.stdout.write(`Setting API endpoint to ${endpoint}\nOK\n`);
    return;
  }

  if (command === "auth") {
    if (!state.apiEndpoint) {
      fail("No API endpoint targeted");
    }
    process.stdout.write("OK\n");
    return;
  }

  if (command === "target") {
    const orgFlagIndex = args.indexOf("-o");
    const spaceFlagIndex = args.indexOf("-s");
    const org = orgFlagIndex >= 0 ? args[orgFlagIndex + 1] : "";
    const space = spaceFlagIndex >= 0 ? args[spaceFlagIndex + 1] : "";
    if (!org || !space) {
      fail("Missing target org or space");
    }
    state.org = org;
    state.space = space;
    await writeJson(statePath, state);
    process.stdout.write(`Targeted org ${org} / space ${space}\n`);
    return;
  }

  if (command === "apps") {
    const region = requireRegion(state, regionsByEndpoint);
    const org = requireOrg(region, state);
    const space = requireSpace(org, state);
    const lines = ["name  requested state  processes  routes"];
    for (const app of space.apps ?? []) {
      const instances = typeof app.runningInstances === "number" ? app.runningInstances : 1;
      lines.push(`${app.name}  started  web:${instances}/${instances}  -`);
    }
    process.stdout.write(lines.join("\n") + "\n");
    return;
  }

  if (command === "logs") {
    const appName = args[1];
    if (!appName) {
      fail("Missing app name");
    }
    const region = requireRegion(state, regionsByEndpoint);
    const org = requireOrg(region, state);
    const space = requireSpace(org, state);
    const app = requireApp(space, appName);
    const isRecent = args.includes("--recent");

    if (isRecent) {
      process.stdout.write(app.recentLogs ?? "");
      return;
    }

    for (const chunk of app.stream ?? []) {
      if (chunk.delayMs) {
        await sleep(chunk.delayMs);
      }
      if (typeof chunk.stdout === "string") {
        process.stdout.write(chunk.stdout);
      }
      if (typeof chunk.stderr === "string") {
        process.stderr.write(chunk.stderr);
      }
    }
    return;
  }

  fail(`Unsupported fake cf command: ${command}`);
}

await main();
