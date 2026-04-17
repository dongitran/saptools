#!/usr/bin/env node

import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const path = process.env["CF_SYNC_FAKE_SCENARIO"];
  if (!path) {
    fail("Missing CF_SYNC_FAKE_SCENARIO");
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
  const path = process.env["CF_SYNC_FAKE_LOG_PATH"];
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

function indexScenario(scenario) {
  const byEndpoint = new Map();
  for (const region of scenario.regions ?? []) {
    byEndpoint.set(region.apiEndpoint, region);
  }
  return byEndpoint;
}

function getCurrentRegion(state, regionsByEndpoint) {
  const region = regionsByEndpoint.get(state.apiEndpoint ?? "");
  if (!region) {
    fail("No targeted API endpoint");
  }
  return region;
}

function getCurrentOrg(region, state) {
  const org = (region.orgs ?? []).find((candidate) => candidate.name === state.org);
  if (!org) {
    fail("No targeted org");
  }
  return org;
}

function getCurrentSpace(org, state) {
  const space = (org.spaces ?? []).find((candidate) => candidate.name === state.space);
  if (!space) {
    fail("No targeted space");
  }
  return space;
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

  const regionsByEndpoint = indexScenario(scenario);

  if (command === "api") {
    const apiEndpoint = args[1];
    if (!apiEndpoint || !regionsByEndpoint.has(apiEndpoint)) {
      fail(`Unknown API endpoint: ${apiEndpoint ?? "<missing>"}`);
    }
    state.apiEndpoint = apiEndpoint;
    delete state.org;
    delete state.space;
    await writeJson(statePath, state);
    process.stdout.write(`Setting API endpoint to ${apiEndpoint}\n`);
    return;
  }

  const region = getCurrentRegion(state, regionsByEndpoint);

  if (command === "auth") {
    if (region.accessible === false) {
      fail("Authentication failed");
    }
    process.stdout.write("OK\n");
    return;
  }

  if (command === "orgs") {
    await sleep(region.orgsDelayMs ?? 0);
    process.stdout.write(`name\n${(region.orgs ?? []).map((org) => org.name).join("\n")}\n`);
    return;
  }

  if (command === "target") {
    const orgFlagIndex = args.indexOf("-o");
    if (orgFlagIndex === -1 || !args[orgFlagIndex + 1]) {
      fail("Missing -o");
    }

    const orgName = args[orgFlagIndex + 1];
    const org = (region.orgs ?? []).find((candidate) => candidate.name === orgName);
    if (!org) {
      fail(`Unknown org: ${orgName}`);
    }

    const spaceFlagIndex = args.indexOf("-s");
    state.apiEndpoint = region.apiEndpoint;
    state.org = orgName;

    if (spaceFlagIndex === -1) {
      delete state.space;
      await writeJson(statePath, state);
      process.stdout.write("OK\n");
      return;
    }

    const spaceName = args[spaceFlagIndex + 1];
    const space = (org.spaces ?? []).find((candidate) => candidate.name === spaceName);
    if (!space) {
      fail(`Unknown space: ${spaceName ?? "<missing>"}`);
    }

    state.space = spaceName;
    await writeJson(statePath, state);
    process.stdout.write("OK\n");
    return;
  }

  if (command === "spaces") {
    const org = getCurrentOrg(region, state);
    await sleep(org.spacesDelayMs ?? 0);
    process.stdout.write(`name\n${(org.spaces ?? []).map((space) => space.name).join("\n")}\n`);
    return;
  }

  if (command === "apps") {
    const org = getCurrentOrg(region, state);
    const space = getCurrentSpace(org, state);
    await sleep(space.appsDelayMs ?? 0);
    const lines = (space.apps ?? []).map((app) => `${app}  started`).join("\n");
    process.stdout.write(`name  requested state\n${lines}\n`);
    return;
  }

  fail(`Unsupported command: ${command}`);
}

await main();
