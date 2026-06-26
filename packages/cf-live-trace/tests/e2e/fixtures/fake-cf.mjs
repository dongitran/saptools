#!/usr/bin/env node

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { dirname, join } from "node:path";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
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

async function logInvocation(command, args) {
  const logPath = process.env["CF_LIVE_TRACE_FAKE_LOG_PATH"];
  if (!logPath) {
    return;
  }
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, `${JSON.stringify({ command, args })}\n`, "utf8");
}

function getStatePath() {
  const cfHome = process.env["CF_HOME"];
  if (!cfHome) {
    fail("Missing CF_HOME");
  }
  return join(cfHome, "fake-cf-state.json");
}

function getInspectorPort() {
  const raw = process.env["CF_LIVE_TRACE_TEST_INSPECTOR_PORT"];
  const port = Number.parseInt(raw ?? "", 10);
  if (!Number.isInteger(port) || port <= 0) {
    fail("Missing CF_LIVE_TRACE_TEST_INSPECTOR_PORT");
  }
  return port;
}

function parseForwardSpec(args) {
  const flagIndex = args.indexOf("-L");
  const spec = flagIndex >= 0 ? args[flagIndex + 1] : "";
  const localPort = Number.parseInt(String(spec).split(":")[0] ?? "", 10);
  if (!Number.isInteger(localPort) || localPort <= 0) {
    fail(`Invalid tunnel spec: ${spec}`);
  }
  return localPort;
}

function hasCommand(args, expected) {
  const commandIndex = args.indexOf("-c");
  const command = commandIndex >= 0 ? args[commandIndex + 1] : "";
  return String(command).includes(expected);
}

function probeInspector(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function startTunnel(localPort, inspectorPort) {
  const server = createServer((client) => {
    const upstream = connect({ host: "127.0.0.1", port: inspectorPort });
    client.pipe(upstream);
    upstream.pipe(client);
    client.once("error", () => upstream.destroy());
    upstream.once("error", () => client.destroy());
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(localPort, "127.0.0.1", resolve);
  });
  process.stdout.write("fake-cf-tunnel-ready\n");
  await new Promise((resolve) => {
    const stop = () => {
      server.close(() => resolve());
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  });
}

async function handleSsh(args) {
  if (args.includes("-L")) {
    await startTunnel(parseForwardSpec(args), getInspectorPort());
    return;
  }
  if (hasCommand(args, "saptools-inspector-ready")) {
    if (await probeInspector(getInspectorPort())) {
      process.stdout.write("saptools-inspector-signaled\nsaptools-inspector-ready\n");
      return;
    }
    process.stdout.write("saptools-inspector-not-ready\n");
    return;
  }
  process.stdout.write("OK\n");
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  if (!command) {
    fail("Missing command");
  }
  await logInvocation(command, args.slice(1));
  const statePath = getStatePath();
  const state = await readJson(statePath, {});

  if (command === "api") {
    state.apiEndpoint = args[1] ?? "";
    await writeJson(statePath, state);
    process.stdout.write("OK\n");
    return;
  }
  if (command === "auth") {
    process.stdout.write("OK\n");
    return;
  }
  if (command === "target") {
    if (!args.includes("-o") && !args.includes("-s")) {
      if (!state.apiEndpoint || !state.org || !state.space) {
        fail("No org or space targeted");
      }
      process.stdout.write([
        `API endpoint:   ${state.apiEndpoint}`,
        "API version:    3.156.0",
        "user:           e2e@example.com",
        `org:            ${state.org}`,
        `space:          ${state.space}`,
        "",
      ].join("\n"));
      return;
    }
    state.org = args[args.indexOf("-o") + 1] ?? "";
    state.space = args[args.indexOf("-s") + 1] ?? "";
    await writeJson(statePath, state);
    process.stdout.write("OK\n");
    return;
  }
  if (command === "ssh-enabled") {
    process.stdout.write("ssh support is enabled\n");
    return;
  }
  if (command === "ssh") {
    await handleSsh(args.slice(1));
    return;
  }

  fail(`Unsupported fake cf command: ${command}`);
}

await main();
