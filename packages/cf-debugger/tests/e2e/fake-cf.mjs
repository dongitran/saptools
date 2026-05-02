#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-unsafe-return, @typescript-eslint/restrict-template-expressions, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/restrict-plus-operands, @typescript-eslint/switch-exhaustiveness-check, @typescript-eslint/prefer-nullish-coalescing -- This is an executable Node.js fixture; keeping it as plain JS avoids a runtime transpiler in CLI E2E tests. */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import process from "node:process";
import { setInterval, setTimeout } from "node:timers";

const args = process.argv.slice(2);
const cfHome = process.env["CF_HOME"] ?? process.cwd();
const statePath = join(cfHome, "fake-cf-state.json");
const logPath = process.env["CF_DEBUGGER_FAKE_LOG"];

function logCommand() {
  if (logPath === undefined || logPath === "") {
    return;
  }
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, `${JSON.stringify({ args })}\n`, "utf8");
}

function readState() {
  if (!existsSync(statePath)) {
    return { signalAttempts: 0, sshEnabled: false };
  }
  return JSON.parse(readFileSync(statePath, "utf8"));
}

function writeState(state) {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function exitWithError(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function handleTunnel(tunnelArg) {
  if (tunnelArg === undefined) {
    exitWithError("missing tunnel argument");
  }

  if (process.env["CF_DEBUGGER_FAKE_TUNNEL_NEVER_READY"] === "1") {
    setInterval(() => {
      void process.uptime();
    }, 60_000);
    return;
  }

  const localPort = Number.parseInt(tunnelArg.split(":")[0] ?? "", 10);
  if (Number.isNaN(localPort)) {
    exitWithError(`invalid tunnel argument: ${tunnelArg}`);
  }

  const server = createServer((socket) => {
    socket.end();
  });
  const close = () => {
    server.close(() => {
      process.exit(0);
    });
    setTimeout(() => {
      process.exit(0);
    }, 500).unref();
  };

  process.on("SIGINT", close);
  process.on("SIGTERM", close);
  server.on("error", (error) => {
    exitWithError(error.message);
  });
  server.listen(localPort, "127.0.0.1");
}

function handleSsh() {
  if (args.includes("-N")) {
    handleTunnel(args[args.indexOf("-L") + 1]);
    return;
  }

  if (process.env["CF_DEBUGGER_FAKE_SIGNAL_FAIL"] === "1") {
    exitWithError("no node process");
  }

  const state = readState();
  const nextState = {
    ...state,
    signalAttempts: state.signalAttempts + 1,
  };
  writeState(nextState);

  if (
    process.env["CF_DEBUGGER_FAKE_SSH_DISABLED_ONCE"] === "1" &&
    !state.sshEnabled &&
    nextState.signalAttempts === 1
  ) {
    exitWithError("SSH support is disabled");
  }
}

function handleCommand() {
  const command = args[0];
  switch (command) {
    case "api":
    case "target":
    case "restart": {
      return;
    }
    case "auth": {
      if (process.env["CF_DEBUGGER_FAKE_AUTH_FAIL"] === "1") {
        exitWithError("authentication failed");
      }
      return;
    }
    case "ssh-enabled": {
      const state = readState();
      const enabled = state.sshEnabled || process.env["CF_DEBUGGER_FAKE_SSH_DISABLED_ONCE"] !== "1";
      process.stdout.write(enabled ? "SSH support is enabled\n" : "SSH support is disabled\n");
      return;
    }
    case "enable-ssh": {
      writeState({ ...readState(), sshEnabled: true });
      return;
    }
    case "ssh": {
      handleSsh();
      return;
    }
    case "orgs": {
      process.stdout.write("name\norg-a\n");
      return;
    }
    case "spaces": {
      process.stdout.write("name\ndev\n");
      return;
    }
    case "apps": {
      process.stdout.write(
        [
          "name               requested state   processes                      routes",
          "demo-app           started           web:1/1                         demo.example.com",
          "",
        ].join("\n"),
      );
      return;
    }
    default: {
      exitWithError(`unsupported fake cf command: ${command ?? ""}`);
    }
  }
}

logCommand();
handleCommand();
