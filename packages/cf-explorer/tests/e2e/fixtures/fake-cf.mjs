#!/usr/bin/env node

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function scenarioPath() {
  const path = process.env.CF_EXPLORER_FAKE_SCENARIO;
  if (!path) fail("Missing CF_EXPLORER_FAKE_SCENARIO");
  return path;
}

function statePath() {
  const cfHome = process.env.CF_HOME;
  if (!cfHome) fail("Missing CF_HOME");
  return join(cfHome, "fake-cf-state.json");
}

async function logInvocation(command, args, state) {
  const path = process.env.CF_EXPLORER_FAKE_LOG_PATH;
  if (!path) return;
  await mkdir(dirname(path), { recursive: true });
  await appendFile(
    path,
    `${JSON.stringify({ command, args, apiEndpoint: state.apiEndpoint, org: state.org, space: state.space })}\n`,
    "utf8",
  );
}

function regionByEndpoint(scenario) {
  return new Map((scenario.regions ?? []).map((region) => [region.apiEndpoint, region]));
}

function requireRegion(state, scenario) {
  const region = regionByEndpoint(scenario).get(state.apiEndpoint);
  if (!region) fail("No targeted API endpoint");
  return region;
}

function requireApp(state, scenario, appName) {
  const region = requireRegion(state, scenario);
  const org = (region.orgs ?? []).find((item) => item.name === state.org);
  if (!org) fail("No targeted org");
  const space = (org.spaces ?? []).find((item) => item.name === state.space);
  if (!space) fail("No targeted space");
  const app = (space.apps ?? []).find((item) => item.name === appName);
  if (!app) fail(`Unknown app: ${appName}`);
  return app;
}

function appKey(state, appName) {
  return `${state.apiEndpoint}:${state.org}:${state.space}:${appName}`;
}

function appSshEnabled(state, app) {
  return state.sshEnabled?.[appKey(state, app.name)] ?? app.sshEnabled === true;
}

function setAppSshEnabled(state, app, enabled) {
  state.sshEnabled = { ...(state.sshEnabled ?? {}), [appKey(state, app.name)]: enabled };
}

function formatApp(app) {
  const instances = app.instances ?? [{ index: 0, state: "running" }];
  const running = instances.filter((item) => item.state === "running").length;
  return [
    `name: ${app.name}`,
    "requested state: started",
    `instances: ${running}/${instances.length}`,
    "     state     since",
    ...instances.map((item) => `#${item.index}   ${item.state}   today`),
    "",
  ].join("\n");
}

function listRoots(files) {
  const roots = new Set();
  for (const path of Object.keys(files)) {
    const parts = path.split("/");
    if (parts.length >= 3) roots.add(parts.slice(0, 3).join("/"));
    if (path.includes("/workspace/app/")) roots.add("/workspace/app");
  }
  return [...roots].sort();
}

function wildcardMatch(value, pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`, "i").test(value);
}

function parseVar(command, name) {
  const match = new RegExp(`${name}='((?:'\\\\''|[^'])*)'`).exec(command);
  if (!match) return undefined;
  return match[1].replaceAll("'\\''", "'");
}

function renderRoots(app) {
  return listRoots(app.files).map((root) => `CFX\tROOT\t${root}`).join("\n") + "\n";
}

function renderFind(app, command) {
  const root = parseVar(command, "CFX_ROOT") ?? "/";
  const name = parseVar(command, "CFX_NAME") ?? "*";
  return Object.keys(app.files)
    .filter((path) => path.startsWith(`${root}/`) && wildcardMatch(path.split("/").at(-1) ?? "", name))
    .map((path) => `CFX\tFIND\tfile\t${path}`)
    .join("\n") + "\n";
}

function listDirectEntries(files, path) {
  const prefix = path.endsWith("/") ? path : `${path}/`;
  const entries = new Map();
  for (const filePath of Object.keys(files)) {
    if (!filePath.startsWith(prefix)) continue;
    const relative = filePath.slice(prefix.length);
    const name = relative.split("/")[0];
    if (!name) continue;
    const entryPath = `${prefix}${name}`;
    const kind = relative.includes("/") ? "directory" : "file";
    if (entries.get(name)?.kind === "directory") continue;
    entries.set(name, { kind, path: entryPath });
  }
  return [...entries.entries()]
    .map(([name, entry]) => ({ name, ...entry }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function renderLs(app, command) {
  const path = parseVar(command, "CFX_PATH") ?? "/";
  return listDirectEntries(app.files, path)
    .map((entry) => `CFX\tLS\t${entry.kind}\t${entry.name}\t${entry.path}`)
    .join("\n") + "\n";
}

function renderGrep(app, command) {
  const root = parseVar(command, "CFX_ROOT") ?? "/";
  const text = parseVar(command, "CFX_TEXT") ?? "";
  const includePreview = command.includes("cfx_preview=");
  const lines = [];
  for (const [path, content] of Object.entries(app.files)) {
    if (!path.startsWith(`${root}/`)) continue;
    content.split("\n").forEach((line, index) => {
      if (line.includes(text)) {
        lines.push(`CFX\tGREP\t${path}\t${index + 1}\t${includePreview ? line : ""}`);
      }
    });
  }
  return `${lines.join("\n")}\n`;
}

function renderView(app, command) {
  const file = parseVar(command, "CFX_FILE") ?? "";
  const range = /CFX_VIEW_START=(\d+)[\s\S]*CFX_VIEW_END=(\d+)/.exec(command)
    ?? /sed -n '(\d+),(\d+)p'/.exec(command);
  const start = Number.parseInt(range?.[1] ?? "1", 10);
  const end = Number.parseInt(range?.[2] ?? String(start), 10);
  const content = app.files[file] ?? "";
  return content
    .split("\n")
    .slice(start - 1, end)
    .map((line, index) => `CFX\tLINE\t${start + index}\t${line}`)
    .join("\n") + "\n";
}

function renderExplorerCommand(app, command) {
  if (command.includes("CFX\tHANDSHAKE") || command.includes("CFX\\tHANDSHAKE")) {
    return "CFX\tHANDSHAKE\tok\n";
  }
  const firstOp = /CFX_OP='([^']+)'/.exec(command)?.[1];
  if (firstOp === "roots") return renderRoots(app);
  if (firstOp === "ls") return renderLs(app, command);
  if (firstOp === "find") return renderFind(app, command);
  if (firstOp === "grep") return renderGrep(app, command);
  if (firstOp === "view") return renderView(app, command);
  if (firstOp === "inspect") return renderRoots(app) + renderFind(app, command) + renderGrep(app, command);
  fail(`Unsupported ssh command: ${command}`);
}

function handlePersistentShell(app) {
  process.stdin.setEncoding("utf8");
  process.stdin.resume();
  const keepAlive = setInterval(() => {}, 60_000);
  process.on("SIGTERM", () => {
    clearInterval(keepAlive);
    process.exit(0);
  });
  let buffer = "";
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    const match = /__CF_EXPLORER_START_([a-zA-Z0-9]+)__/.exec(buffer);
    if (!match || !buffer.includes(`__CF_EXPLORER_END_${match[1]}__`)) return;
    const id = match[1];
    process.stdout.write(`__CF_EXPLORER_START_${id}__\n`);
    if (buffer.includes("CFX_TEXT='force-session-error'")) {
      process.stdout.write(`__CF_EXPLORER_END_${id}__:7\n`);
      buffer = "";
      return;
    }
    process.stdout.write(renderExplorerCommand(app, buffer));
    process.stdout.write(`__CF_EXPLORER_END_${id}__:0\n`);
    buffer = "";
  });
}

async function main() {
  const scenario = await readJson(scenarioPath(), { regions: [] });
  const state = await readJson(statePath(), {});
  const args = process.argv.slice(2);
  const command = args[0];
  if (!command) fail("Missing command");
  await logInvocation(command, args.slice(1), state);

  if (command === "api") {
    const endpoint = args[1];
    if (!regionByEndpoint(scenario).has(endpoint)) fail(`Unknown API endpoint: ${endpoint}`);
    state.apiEndpoint = endpoint;
    await writeJson(statePath(), state);
    process.stdout.write("OK\n");
    return;
  }

  if (command === "auth") {
    if (!process.env.CF_USERNAME || !process.env.CF_PASSWORD) fail("Missing credentials");
    process.stdout.write("OK\n");
    return;
  }

  if (command === "target") {
    state.org = args[args.indexOf("-o") + 1];
    state.space = args[args.indexOf("-s") + 1];
    await writeJson(statePath(), state);
    process.stdout.write("OK\n");
    return;
  }

  const appName = args[1];
  const app = requireApp(state, scenario, appName);

  if (command === "app") {
    process.stdout.write(formatApp(app));
    return;
  }
  if (command === "ssh-enabled") {
    process.stdout.write(appSshEnabled(state, app) ? "SSH support is enabled\n" : "SSH support is disabled\n");
    return;
  }
  if (command === "enable-ssh") {
    setAppSshEnabled(state, app, true);
    await writeJson(statePath(), state);
    process.stdout.write("OK\n");
    return;
  }
  if (command === "restart") {
    process.stdout.write("OK\n");
    return;
  }
  if (command === "ssh") {
    const shellCommand = args[args.indexOf("-c") + 1];
    if (shellCommand === "sh") {
      handlePersistentShell(app);
      return;
    }
    process.stdout.write(renderExplorerCommand(app, shellCommand));
    return;
  }

  fail(`Unsupported command: ${command}`);
}

await main();
