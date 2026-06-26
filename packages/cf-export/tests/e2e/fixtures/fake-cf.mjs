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
  const path = process.env["CF_EXPORT_FAKE_SCENARIO"];
  if (!path) fail("Missing CF_EXPORT_FAKE_SCENARIO");
  return path;
}

function getStatePath() {
  const cfHome = process.env["CF_HOME"];
  if (!cfHome) fail("Missing CF_HOME");
  return join(cfHome, "fake-cf-state.json");
}

async function logInvocation(command, args, state) {
  const path = process.env["CF_EXPORT_FAKE_LOG_PATH"];
  if (!path) return;
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

function requireRegion(state, regionsByEndpoint) {
  const region = regionsByEndpoint.get(state.apiEndpoint ?? "");
  if (!region) fail("No targeted API endpoint");
  return region;
}

function requireOrg(region, state) {
  const org = (region.orgs ?? []).find((o) => o.name === state.org);
  if (!org) fail("No targeted org");
  return org;
}

function requireSpace(org, state) {
  const space = (org.spaces ?? []).find((s) => s.name === state.space);
  if (!space) fail("No targeted space");
  return space;
}

function requireApp(space, appName) {
  const app = (space.apps ?? []).find((a) => a.name === appName);
  if (!app) fail(`App not found: ${appName}`);
  return app;
}

async function main() {
  const scenarioPath = getScenarioPath();
  const statePath = getStatePath();
  const scenario = await readJson(scenarioPath, { regions: [] });
  const regionsByEndpoint = indexScenario(scenario);
  let state = await readJson(statePath, {});

  const [cmd, ...args] = process.argv.slice(2);
  await logInvocation(cmd ?? "", args, state);

  if (cmd === "api") {
    const endpoint = args[0];
    if (!endpoint) fail("cf api: missing endpoint");
    state.apiEndpoint = endpoint;
    await writeJson(statePath, state);
    process.stdout.write("API endpoint set\n");
    return;
  }

  if (cmd === "auth") {
    // Accept any; real validation is in real cf. We just mark authed.
    state.authed = true;
    await writeJson(statePath, state);
    process.stdout.write("OK\n");
    return;
  }

  if (cmd === "target") {
    // -o org -s space
    let org, space;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-o") org = args[i + 1];
      if (args[i] === "-s") space = args[i + 1];
    }
    if (org) state.org = org;
    if (space) state.space = space;
    await writeJson(statePath, state);
    process.stdout.write(`Targeted ${state.org}/${state.space}\n`);
    return;
  }

  if (cmd === "app" && args[1] === "--guid") {
    const appName = args[0];
    const region = requireRegion(state, regionsByEndpoint);
    const org = requireOrg(region, state);
    const space = requireSpace(org, state);
    const app = requireApp(space, appName);
    const guid = app.guid ?? `guid-${appName}`;
    process.stdout.write(`${guid}\n`);
    return;
  }

  if (cmd === "curl") {
    const path = args[0] || "";
    const match = path.match(/^\/v3\/apps\/([^/]+)\/env$/);
    if (match) {
      const guid = decodeURIComponent(match[1]);
      // Find app by guid or just return a payload
      const region = requireRegion(state, regionsByEndpoint);
      const org = requireOrg(region, state);
      const space = requireSpace(org, state);
      const app = (space.apps ?? []).find((a) => a.guid === guid || `guid-${a.name}` === guid);
      const envPayload = app?.envPayload ?? {
        system_env_json: { VCAP_SERVICES: { xsuaa: [{ credentials: { clientid: "id" } }] } },
        environment_variables: { NODE_ENV: "production" },
      };
      process.stdout.write(`${JSON.stringify(envPayload)}\n`);
      return;
    }
    fail(`Unsupported curl path in fake: ${path}`);
  }

  if (cmd === "ssh-enabled") {
    // Default to enabled for all e2e scenarios. Real enable/restart path can be tested
    // by extending the scenario with per-app sshEnabled flag if needed in future.
    process.stdout.write("ssh support is enabled\n");
    return;
  }

  if (cmd === "enable-ssh") {
    process.stdout.write("Enabling SSH support...\n");
    return;
  }

  if (cmd === "restart") {
    const appName = args[0] || "app";
    process.stdout.write(`Restarting app ${appName}...\n`);
    return;
  }

  if (cmd === "ssh") {
    // ['ssh', appName, '--disable-pseudo-tty', '-c', 'the command string']
    const appName = args[0];
    const dashCIndex = args.indexOf("-c");
    const shellCmd = dashCIndex >= 0 ? args[dashCIndex + 1] ?? "" : "";

    const region = requireRegion(state, regionsByEndpoint);
    const org = requireOrg(region, state);
    const space = requireSpace(org, state);
    const app = requireApp(space, appName);

    // The guard command contains: printf 'SENTINEL'\n cat <path>
    // We detect requested path by looking for known file names
    const files = app.files ?? {};

    // Try to extract a path after the last "cat " or if [ -f 'xxx' ]
    let requestedPath = "";
    const catMatch = shellCmd.match(/cat\s+'([^']+)'/);
    if (catMatch) {
      requestedPath = catMatch[1];
    } else {
      const fileMatch = shellCmd.match(/-f\s+'([^']+)'/);
      if (fileMatch) requestedPath = fileMatch[1];
    }

    if (requestedPath && Object.prototype.hasOwnProperty.call(files, requestedPath)) {
      const val = files[requestedPath];
      const sentinel = "__SAPTOOLS_CF_EXPORT_FILE_CONTENT__";
      process.stdout.write(`${sentinel}\n${val}\n`);
      return;
    }

    // not found
    process.exit(66);
  }

  // Fallback: echo OK for unknown but "successful" commands
  process.stdout.write("OK\n");
}

main().catch((e) => {
  fail(e instanceof Error ? e.message : String(e));
});
