import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import {
  readState,
  runCliCommand,
  startCli,
  stopCli,
  type StartedSession,
  waitForCliExit,
} from "./cli-helpers.js";
import { CLI_PATH, buildEnv, canConnect, cleanupHome, createIsolatedHome } from "./helpers.js";

const FAKE_CF_PATH = join(dirname(fileURLToPath(import.meta.url)), "fake-cf.mjs");
function targetArgs(app = "demo-app"): readonly string[] {
  return [
    "--region",
    "eu10",
    "--org",
    "org-a",
    "--space",
    "dev",
    "--app",
    app,
  ];
}

const TARGET_ARGS = targetArgs();

function createFakeEnv(homeDir: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...buildEnv(homeDir),
    SAP_EMAIL: "user@example.com",
    SAP_PASSWORD: "opaque-value",
    CF_DEBUGGER_CF_BIN: FAKE_CF_PATH,
    CF_DEBUGGER_FAKE_LOG: join(homeDir, "fake-cf.log"),
    ...overrides,
  };
}

async function readFakeCommands(homeDir: string): Promise<readonly string[]> {
  const raw = await readFile(join(homeDir, "fake-cf.log"), "utf8").catch(() => "");
  return raw
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const entry = JSON.parse(line) as { args: readonly string[] };
      return entry.args.join(" ");
    });
}

test("User can start, inspect, and stop a fake-backed session", async () => {
  expect(existsSync(CLI_PATH)).toBe(true);
  expect(existsSync(FAKE_CF_PATH)).toBe(true);

  const homeDir = await createIsolatedHome();
  const env = createFakeEnv(homeDir);
  let session: StartedSession | undefined;

  try {
    session = await startCli(env, ["start", ...TARGET_ARGS, "--verbose"], 10_000);
    await expect(canConnect(session.localPort, 1_000)).resolves.toBe(true);

    const list = await runCliCommand(env, ["list"]);
    expect(list.code, list.stderr).toBe(0);
    const listed = JSON.parse(list.stdout) as readonly { app: string; status: string }[];
    expect(listed).toContainEqual(expect.objectContaining({ app: "demo-app", status: "ready" }));

    const status = await runCliCommand(env, ["status", ...TARGET_ARGS]);
    expect(status.code, status.stderr).toBe(0);
    const statusJson = JSON.parse(status.stdout) as { app?: string; status?: string } | null;
    expect(statusJson).toMatchObject({ app: "demo-app", status: "ready" });

    const stop = await runCliCommand(env, ["stop", ...TARGET_ARGS]);
    expect(stop.code, stop.stderr).toBe(0);
    await waitForCliExit(session.child);

    const state = (await readState(homeDir)) as { sessions?: readonly unknown[] } | undefined;
    expect(state?.sessions ?? []).toEqual([]);
  } finally {
    if (session !== undefined) {
      await stopCli(session.child);
    }
    await cleanupHome(homeDir);
  }
});

test("User can choose a preferred local port for a fake-backed session", async () => {
  expect(existsSync(CLI_PATH)).toBe(true);
  expect(existsSync(FAKE_CF_PATH)).toBe(true);

  const homeDir = await createIsolatedHome();
  const env = createFakeEnv(homeDir);
  let session: StartedSession | undefined;

  try {
    session = await startCli(env, ["start", ...TARGET_ARGS, "--port", "20555"], 10_000);
    expect(session.localPort).toBe(20_555);
    await expect(canConnect(session.localPort, 1_000)).resolves.toBe(true);
  } finally {
    if (session !== undefined) {
      await stopCli(session.child);
    }
    await cleanupHome(homeDir);
  }
});

test("User can stop a fake-backed session by session id", async () => {
  expect(existsSync(CLI_PATH)).toBe(true);
  expect(existsSync(FAKE_CF_PATH)).toBe(true);

  const homeDir = await createIsolatedHome();
  const env = createFakeEnv(homeDir);
  let session: StartedSession | undefined;

  try {
    session = await startCli(env, ["start", ...TARGET_ARGS], 10_000);
    const state = (await readState(homeDir)) as
      | { sessions?: readonly { sessionId: string }[] }
      | undefined;
    const sessionId = state?.sessions?.[0]?.sessionId;
    expect(sessionId).toBeDefined();
    if (sessionId === undefined) {
      return;
    }

    const stop = await runCliCommand(env, ["stop", "--session-id", sessionId]);
    expect(stop.code, stop.stderr).toBe(0);
    await waitForCliExit(session.child);

    const finalState = (await readState(homeDir)) as { sessions?: readonly unknown[] } | undefined;
    expect(finalState?.sessions ?? []).toEqual([]);
  } finally {
    if (session !== undefined) {
      await stopCli(session.child);
    }
    await cleanupHome(homeDir);
  }
});

test("User can clear multiple fake-backed sessions with stop all", async () => {
  expect(existsSync(CLI_PATH)).toBe(true);
  expect(existsSync(FAKE_CF_PATH)).toBe(true);

  const homeDir = await createIsolatedHome();
  const env = createFakeEnv(homeDir);
  const sessions: StartedSession[] = [];

  try {
    sessions.push(
      await startCli(env, ["start", ...targetArgs("demo-app-a")], 10_000),
      await startCli(env, ["start", ...targetArgs("demo-app-b")], 10_000),
    );

    const stop = await runCliCommand(env, ["stop", "--all"]);
    expect(stop.code, stop.stderr).toBe(0);
    expect(stop.stdout).toContain("Stopped 2 session(s).");
    await Promise.all(sessions.map(async (started) => await waitForCliExit(started.child)));

    const finalState = (await readState(homeDir)) as { sessions?: readonly unknown[] } | undefined;
    expect(finalState?.sessions ?? []).toEqual([]);
  } finally {
    await Promise.all(sessions.map(async (started) => {
      await stopCli(started.child);
    }));
    await cleanupHome(homeDir);
  }
});

test("User can see empty status and missing stop results", async () => {
  expect(existsSync(CLI_PATH)).toBe(true);
  expect(existsSync(FAKE_CF_PATH)).toBe(true);

  const homeDir = await createIsolatedHome();
  const env = createFakeEnv(homeDir);

  try {
    const status = await runCliCommand(env, ["status", ...TARGET_ARGS]);
    expect(status.code, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toBeNull();

    const stop = await runCliCommand(env, ["stop", ...TARGET_ARGS]);
    expect(stop.code).toBe(1);
    expect(stop.stderr).toContain("No matching session found.");
  } finally {
    await cleanupHome(homeDir);
  }
});

test("User can see duplicate-session protection before a second tunnel starts", async () => {
  expect(existsSync(CLI_PATH)).toBe(true);
  expect(existsSync(FAKE_CF_PATH)).toBe(true);

  const homeDir = await createIsolatedHome();
  const env = createFakeEnv(homeDir);
  let session: StartedSession | undefined;

  try {
    session = await startCli(env, ["start", ...TARGET_ARGS], 10_000);
    const duplicate = await runCliCommand(env, ["start", ...TARGET_ARGS]);
    expect(duplicate.code).not.toBe(0);
    expect(duplicate.stderr).toContain("SESSION_ALREADY_RUNNING");
  } finally {
    if (session !== undefined) {
      await stopCli(session.child);
    }
    await cleanupHome(homeDir);
  }
});

test("User can exercise the SSH enable and restart retry path with a fake CF CLI", async () => {
  expect(existsSync(CLI_PATH)).toBe(true);
  expect(existsSync(FAKE_CF_PATH)).toBe(true);

  const homeDir = await createIsolatedHome();
  const env = createFakeEnv(homeDir, { CF_DEBUGGER_FAKE_SSH_DISABLED_ONCE: "1" });
  let session: StartedSession | undefined;

  try {
    session = await startCli(env, ["start", ...TARGET_ARGS, "--verbose"], 10_000);
    await expect(canConnect(session.localPort, 1_000)).resolves.toBe(true);
    const commands = await readFakeCommands(homeDir);
    expect(commands).toContain("enable-ssh demo-app");
    expect(commands).toContain("restart demo-app");
  } finally {
    if (session !== undefined) {
      await stopCli(session.child);
    }
    await cleanupHome(homeDir);
  }
});

test("User can see validation and startup errors from the CLI", async () => {
  expect(existsSync(CLI_PATH)).toBe(true);
  expect(existsSync(FAKE_CF_PATH)).toBe(true);

  const homeDir = await createIsolatedHome();
  const missingCredsEnv = createFakeEnv(homeDir, {
    SAP_EMAIL: "",
    SAP_PASSWORD: "",
  });

  try {
    const invalidPort = await runCliCommand(missingCredsEnv, [
      "start",
      ...TARGET_ARGS,
      "--port",
      "70000",
    ]);
    expect(invalidPort.code).toBe(1);
    expect(invalidPort.stderr).toContain("Invalid port: 70000");

    const missingCreds = await runCliCommand(missingCredsEnv, ["start", ...TARGET_ARGS]);
    expect(missingCreds.code).toBe(1);
    expect(missingCreds.stderr).toContain("MISSING_CREDENTIALS");

    const timeoutEnv = createFakeEnv(homeDir, { CF_DEBUGGER_FAKE_TUNNEL_NEVER_READY: "1" });
    const timeout = await runCliCommand(timeoutEnv, [
      "start",
      ...TARGET_ARGS,
      "--timeout",
      "1",
    ]);
    expect(timeout.code).toBe(1);
    expect(timeout.stderr).toContain("TUNNEL_NOT_READY");

    const authFailure = await runCliCommand(
      createFakeEnv(homeDir, { CF_DEBUGGER_FAKE_AUTH_FAIL: "1" }),
      ["start", ...TARGET_ARGS],
    );
    expect(authFailure.code).toBe(1);
    expect(authFailure.stderr).toContain("CF_LOGIN_FAILED");

    const signalFailure = await runCliCommand(
      createFakeEnv(homeDir, { CF_DEBUGGER_FAKE_SIGNAL_FAIL: "1" }),
      ["start", ...TARGET_ARGS],
    );
    expect(signalFailure.code).toBe(1);
    expect(signalFailure.stderr).toContain("USR1_SIGNAL_FAILED");
  } finally {
    await cleanupHome(homeDir);
  }
});
