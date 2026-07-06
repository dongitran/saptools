#!/usr/bin/env node

import { readFile } from "node:fs/promises";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function loadScenario() {
  const path = process.env["CF_EVENTS_FAKE_SCENARIO"];
  if (!path) {
    fail("Missing CF_EVENTS_FAKE_SCENARIO");
  }
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    fail(`Could not read the fake scenario: ${String(error)}`);
    return { apps: {} };
  }
}

function findAppByGuid(scenario, guid) {
  for (const app of Object.values(scenario.apps ?? {})) {
    if (app.guid === guid) {
      return app;
    }
  }
  return undefined;
}

function respondAuditEvents(scenario, path) {
  const queryIndex = path.indexOf("?");
  const params = new URLSearchParams(queryIndex >= 0 ? path.slice(queryIndex + 1) : "");
  const targetGuids = (params.get("target_guids") ?? "")
    .split(",")
    .filter((value) => value.length > 0);
  const spaceGuids = (params.get("space_guids") ?? "")
    .split(",")
    .filter((value) => value.length > 0);
  const typesParam = params.get("types");
  const types = typesParam
    ? typesParam.split(",").filter((value) => value.length > 0)
    : undefined;
  const createdAfter = params.get("created_ats[gt]");
  const perPage = Number.parseInt(params.get("per_page") ?? "100", 10);

  let events = [];
  for (const app of Object.values(scenario.apps ?? {})) {
    const appSpaceGuid = app.spaceGuid ?? scenario.spaceGuid ?? "space-1";
    if ((targetGuids.length === 0 || targetGuids.includes(app.guid)) && (spaceGuids.length === 0 || spaceGuids.includes(appSpaceGuid))) {
      events = events.concat(app.events ?? []);
    }
  }
  if (types) {
    events = events.filter((event) => types.includes(event.type));
  }
  if (createdAfter) {
    events = events.filter((event) => String(event.created_at) > createdAfter);
  }
  events.sort((left, right) => (String(left.created_at) < String(right.created_at) ? 1 : -1));
  return { pagination: { next: null }, resources: events.slice(0, perPage) };
}

function respondOrganizations(scenario, path) {
  const queryIndex = path.indexOf("?");
  const params = new URLSearchParams(queryIndex >= 0 ? path.slice(queryIndex + 1) : "");
  if (params.get("names") === scenario.org) {
    return { pagination: { next: null }, resources: [{ guid: scenario.orgGuid ?? "org-1", name: scenario.org }] };
  }
  return { pagination: { next: null }, resources: [] };
}

function respondSpaces(scenario, path) {
  const queryIndex = path.indexOf("?");
  const params = new URLSearchParams(queryIndex >= 0 ? path.slice(queryIndex + 1) : "");
  if (params.get("names") === scenario.space && params.get("organization_guids") === (scenario.orgGuid ?? "org-1")) {
    return { pagination: { next: null }, resources: [{ guid: scenario.spaceGuid ?? "space-1", name: scenario.space }] };
  }
  return { pagination: { next: null }, resources: [] };
}

function respondCurl(scenario, path) {
  const sshMatch = /^\/v3\/apps\/([^/?]+)\/ssh_enabled/.exec(path);
  if (sshMatch) {
    const app = findAppByGuid(scenario, sshMatch[1]);
    if (!app) {
      fail(`Unknown app guid: ${sshMatch[1]}`);
    }
    return app.sshEnabled ?? { enabled: false, reason: "" };
  }

  const statsMatch = /^\/v3\/apps\/([^/?]+)\/processes\/web\/stats/.exec(path);
  if (statsMatch) {
    const app = findAppByGuid(scenario, statsMatch[1]);
    if (!app) {
      fail(`Unknown app guid: ${statsMatch[1]}`);
    }
    return app.stats ?? { resources: [] };
  }

  if (path.startsWith("/v3/organizations")) {
    return respondOrganizations(scenario, path);
  }

  if (path.startsWith("/v3/spaces")) {
    return respondSpaces(scenario, path);
  }

  if (path.startsWith("/v3/audit_events")) {
    return respondAuditEvents(scenario, path);
  }

  const appMatch = /^\/v3\/apps\/([^/?]+)$/.exec(path);
  if (appMatch) {
    const app = findAppByGuid(scenario, appMatch[1]);
    if (!app) {
      fail(`Unknown app guid: ${appMatch[1]}`);
    }
    return app.app ?? { guid: appMatch[1], name: "", state: "" };
  }

  fail(`Unsupported curl path: ${path}`);
  return {};
}

async function main() {
  const scenario = await loadScenario();
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === "api" || command === "auth") {
    process.stdout.write("OK\n");
    return;
  }

  if (command === "target") {
    if (args.includes("-o") || args.includes("-s")) {
      process.stdout.write("OK\n");
      return;
    }
    process.stdout.write(
      [
        `API endpoint:   ${scenario.apiEndpoint}`,
        "API version:    3.156.0",
        "user:           tester@example.com",
        `org:            ${scenario.org}`,
        `space:          ${scenario.space}`,
        "",
      ].join("\n"),
    );
    return;
  }

  if (command === "app") {
    if (!args.includes("--guid")) {
      fail("Unsupported app invocation");
    }
    const app = (scenario.apps ?? {})[args[1] ?? ""];
    if (!app) {
      fail(`App not found: ${args[1] ?? "<missing>"}`);
    }
    process.stdout.write(`${app.guid}\n`);
    return;
  }

  if (command === "curl") {
    process.stdout.write(JSON.stringify(respondCurl(scenario, args[1] ?? "")));
    return;
  }

  fail(`Unsupported fake cf command: ${command ?? "<missing>"}`);
}

await main();
