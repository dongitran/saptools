import { existsSync, watch } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import {
  readState,
  runCliCommand,
  CF_DEBUGGER_STATE_FILENAME,
  SAPTOOLS_DIR_NAME,
  spawnCli,
  startCli,
  stopCli,
  type StartedSession,
  waitForCliExit,
} from "./cli-helpers.js";
import {
  CLI_PATH,
  buildEnv,
  canConnect,
  cleanupHome,
  createIsolatedHome,
  findFreeLocalPort,
} from "./helpers.js";

const FAKE_CF_PATH = join(dirname(fileURLToPath(import.meta.url)), "fake-cf.mjs");

interface DebuggerStateForTest {
  readonly version: "2";
  readonly sessions: readonly {
    readonly sessionId: string;
    readonly pid: number;
    readonly controllerPid: number;
    readonly tunnelPid?: number;
    readonly app: string;
    readonly process: string;
    readonly instance: number;
    readonly status: string;
    readonly localPort: number;
    readonly hostname: string;
    readonly region: string;
    readonly org: string;
    readonly space: string;
    readonly apiEndpoint: string;
    readonly remotePort: number;
    readonly cfHomeDir: string;
    readonly startedAt: string;
  }[];
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  if (existsSync(path)) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const watcher = watch(dirname(path));
    const timer = setTimeout(() => {
      watcher.close();
      reject(new Error(`Timed out waiting for ${path}`));
    }, timeoutMs);
    watcher.on("change", () => {
      if (!existsSync(path)) {
        return;
      }
      clearTimeout(timer);
      watcher.close();
      resolve();
    });
    watcher.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function waitForCliExitWithin(
  child: StartedSession["child"],
  timeoutMs: number,
): Promise<{ readonly code: number | null }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      waitForCliExit(child),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error("CLI did not exit after stop request")); }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

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

async function writeState(homeDir: string, state: DebuggerStateForTest): Promise<void> {
  await mkdir(join(homeDir, SAPTOOLS_DIR_NAME), { recursive: true });
  await writeFile(
    join(homeDir, SAPTOOLS_DIR_NAME, CF_DEBUGGER_STATE_FILENAME),
    `${JSON.stringify(state, null, 2)}\n`,
    "utf8",
  );
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

test("User can use v2 state without modifying legacy v1 artifacts", async () => {
  expect(existsSync(CLI_PATH)).toBe(true);
  expect(existsSync(FAKE_CF_PATH)).toBe(true);

  const homeDir = await createIsolatedHome();
  const env = createFakeEnv(homeDir);
  const legacyStatePath = join(homeDir, SAPTOOLS_DIR_NAME, "cf-debugger-state.json");
  const legacyLockPath = join(homeDir, SAPTOOLS_DIR_NAME, "cf-debugger-state.lock");
  const legacyHome = join(homeDir, SAPTOOLS_DIR_NAME, "cf-debugger-homes", "legacy-session");
  const legacySentinel = join(legacyHome, "sentinel.txt");
  const legacyState = `${JSON.stringify({
    version: "1",
    sessions: [{
      sessionId: "legacy-session", pid: process.pid, controllerPid: process.pid,
      hostname: hostname(), region: "eu10", org: "org-a", space: "dev", app: "demo-app",
      process: "web", instance: 0,
      apiEndpoint: "https://api.example.invalid", localPort: 29_999, remotePort: 9229,
      cfHomeDir: legacyHome, startedAt: "2026-01-01T00:00:00.000Z", status: "starting",
    }],
    sentinel: "legacy",
  }, null, 2)}\n`;
  const legacyLock = "legacy-lock-sentinel\n";
  let session: StartedSession | undefined;

  try {
    await mkdir(legacyHome, { recursive: true });
    await writeFile(legacyStatePath, legacyState, "utf8");
    await writeFile(legacyLockPath, legacyLock, "utf8");
    await writeFile(legacySentinel, "legacy-home\n", "utf8");

    session = await startCli(env, ["start", ...TARGET_ARGS], 10_000);
    const stop = await runCliCommand(env, ["stop", ...TARGET_ARGS]);
    expect(stop.code, stop.stderr).toBe(0);
    await waitForCliExit(session.child);

    await expect(readFile(legacyStatePath, "utf8")).resolves.toBe(legacyState);
    await expect(readFile(legacyLockPath, "utf8")).resolves.toBe(legacyLock);
    await expect(readFile(legacySentinel, "utf8")).resolves.toBe("legacy-home\n");
    const v2State = (await readState(homeDir)) as { sessions?: readonly unknown[] } | undefined;
    expect(v2State?.sessions ?? []).toEqual([]);
  } finally {
    if (session !== undefined) {
      await stopCli(session.child);
    }
    await cleanupHome(homeDir);
  }
});

test("User can target a process instance and explicit remote Node PID", async () => {
  expect(existsSync(CLI_PATH)).toBe(true);
  expect(existsSync(FAKE_CF_PATH)).toBe(true);

  const homeDir = await createIsolatedHome();
  const env = createFakeEnv(homeDir);
  let session: StartedSession | undefined;

  try {
    const target = [...TARGET_ARGS, "--process", "worker", "--instance", "2"];
    session = await startCli(env, ["start", ...target, "--node-pid", "9876"], 10_000);
    expect(session.stdout()).toContain("Node PID:    9876");

    const status = await runCliCommand(env, ["status", ...target]);
    expect(status.code, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      process: "worker",
      instance: 2,
      remoteNodePid: 9876,
    });

    const commands = await readFakeCommands(homeDir);
    expect(
      commands.some((command) =>
        command.includes("ssh demo-app --process worker -i 2 --disable-pseudo-tty -c") &&
        command.includes("requested_node_pid=9876"),
      ),
    ).toBe(true);
    expect(
      commands.some((command) =>
        command.includes("ssh demo-app --process worker -i 2 -N -L"),
      ),
    ).toBe(true);
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

test("User list and status retain state when tunnel ownership becomes unverifiable", async () => {
  expect(existsSync(CLI_PATH)).toBe(true);
  expect(existsSync(FAKE_CF_PATH)).toBe(true);

  const homeDir = await createIsolatedHome();
  const env = createFakeEnv(homeDir);
  let session: StartedSession | undefined;

  try {
    session = await startCli(env, ["start", ...TARGET_ARGS], 10_000);
    await expect(canConnect(session.localPort, 1_000)).resolves.toBe(true);

    const state = (await readState(homeDir)) as DebuggerStateForTest | undefined;
    const storedSession = state?.sessions[0];
    expect(storedSession).toBeDefined();
    if (state === undefined || storedSession === undefined) {
      return;
    }

    const stalePid = 2_147_483_600;
    await writeState(homeDir, {
      ...state,
      sessions: [{ ...storedSession, pid: stalePid, tunnelPid: stalePid }],
    });

    const list = await runCliCommand(env, ["list"]);
    expect(list.code, list.stderr).toBe(0);
    expect(JSON.parse(list.stdout)).toEqual([
      expect.objectContaining({ sessionId: storedSession.sessionId }),
    ]);

    const status = await runCliCommand(env, ["status", ...TARGET_ARGS]);
    expect(status.code, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ sessionId: storedSession.sessionId });
  } finally {
    if (session !== undefined) {
      await stopCli(session.child);
    }
    await cleanupHome(homeDir);
  }
});


test("User can remove a stale session by session id", async () => {
  expect(existsSync(CLI_PATH)).toBe(true);

  const homeDir = await createIsolatedHome();
  const env = createFakeEnv(homeDir);

  try {
    await writeState(homeDir, {
      version: "2",
      sessions: [
        {
          sessionId: "stale-session",
          pid: 2_147_483_600,
          controllerPid: 2_147_483_600,
          tunnelPid: 2_147_483_600,
          hostname: (await import("node:os")).hostname(),
          region: "eu10",
          org: "org-a",
          space: "dev",
          app: "demo-app",
          process: "web",
          instance: 0,
          apiEndpoint: "https://api.example.com",
          localPort: 20_009,
          remotePort: 9229,
          cfHomeDir: join(homeDir, "stale-home"),
          startedAt: new Date().toISOString(),
          status: "ready",
        },
      ],
    });

    const stop = await runCliCommand(env, ["stop", "--session-id", "stale-session"]);
    expect(stop.code, stop.stderr).toBe(0);
    expect(stop.stdout).toContain("Removed stale session stale-session");

    const finalState = (await readState(homeDir)) as { sessions?: readonly unknown[] } | undefined;
    expect(finalState?.sessions ?? []).toEqual([]);
  } finally {
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
    const [portA, portB] = await Promise.all([findFreeLocalPort(), findFreeLocalPort()]);
    sessions.push(
      await startCli(env, [
        "start", ...targetArgs("demo-app-a"), "--port", portA.toString(),
      ], 10_000),
      await startCli(env, [
        "start", ...targetArgs("demo-app-b"), "--port", portB.toString(),
      ], 10_000),
    );

    const stop = await runCliCommand(env, ["stop", "--all"]);
    expect(stop.code, stop.stderr).toBe(0);
    expect(stop.stdout).toContain("Stop requested for 2 session(s).");
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
    expect(stop.stderr).toContain("pass --session-id or region/org/space/app");
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

test("User can start a default web tunnel with a CF CLI v6-compatible argument set", async () => {
  expect(existsSync(CLI_PATH)).toBe(true);
  expect(existsSync(FAKE_CF_PATH)).toBe(true);

  const homeDir = await createIsolatedHome();
  const env = createFakeEnv(homeDir, { CF_DEBUGGER_FAKE_CF_V6: "1" });
  let session: StartedSession | undefined;

  try {
    session = await startCli(env, ["start", ...TARGET_ARGS], 10_000);
    const sshCommands = (await readFakeCommands(homeDir)).filter((command) =>
      command.startsWith("ssh ")
    );
    expect(sshCommands.length).toBeGreaterThan(0);
    expect(sshCommands.every((command) => !command.includes("--process"))).toBe(true);
  } finally {
    if (session !== undefined) {
      await stopCli(session.child);
    }
    await cleanupHome(homeDir);
  }
});

test("User can see an explicit Node PID restart rejected before app mutation", async () => {
  expect(existsSync(CLI_PATH)).toBe(true);
  expect(existsSync(FAKE_CF_PATH)).toBe(true);

  const homeDir = await createIsolatedHome();
  const env = createFakeEnv(homeDir, { CF_DEBUGGER_FAKE_SSH_DISABLED_ONCE: "1" });

  try {
    const result = await runCliCommand(env, [
      "start",
      ...TARGET_ARGS,
      "--node-pid",
      "9876",
    ]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("NODE_PID_RESTART_UNSAFE");

    const commands = await readFakeCommands(homeDir);
    expect(commands).not.toContain("enable-ssh demo-app");
    expect(commands).not.toContain("restart demo-app");
    expect(commands.filter((command) => command.startsWith("ssh "))).toHaveLength(1);
  } finally {
    await cleanupHome(homeDir);
  }
});

test("User can stop startup without leaving an unmanaged tunnel", async () => {
  expect(existsSync(CLI_PATH)).toBe(true);
  expect(existsSync(FAKE_CF_PATH)).toBe(true);

  const homeDir = await createIsolatedHome();
  const tunnelMarker = join(homeDir, "tunnel-started.marker");
  const tunnelPort = await findFreeLocalPort();
  const env = createFakeEnv(homeDir, {
    CF_DEBUGGER_FAKE_TUNNEL_MARKER: tunnelMarker,
    CF_DEBUGGER_FAKE_TUNNEL_NEVER_READY: "1",
  });
  const running = spawnCli(env, [
    "start", ...TARGET_ARGS, "--port", tunnelPort.toString(),
  ]);

  try {
    await waitForFile(tunnelMarker, 10_000);
    const state = (await readState(homeDir)) as DebuggerStateForTest | undefined;
    const starting = state?.sessions[0];
    expect(starting).toMatchObject({ status: "tunneling" });
    if (starting === undefined) {
      return;
    }

    const stop = await runCliCommand(env, ["stop", "--session-id", starting.sessionId]);
    expect(stop.code, stop.stderr).toBe(0);
    expect(stop.stdout).toContain(`Stop requested for session ${starting.sessionId}`);

    await waitForCliExitWithin(running.child, 10_000);
    const finalState = (await readState(homeDir)) as { sessions?: readonly unknown[] } | undefined;
    expect(finalState?.sessions ?? []).toEqual([]);
    await expect(access(starting.cfHomeDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(canConnect(starting.localPort, 500)).resolves.toBe(false);
  } finally {
    await stopCli(running.child);
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

    const invalidInstance = await runCliCommand(missingCredsEnv, [
      "start",
      ...TARGET_ARGS,
      "--instance",
      "1.5",
    ]);
    expect(invalidInstance.code).toBe(1);
    expect(invalidInstance.stderr).toContain("instance must be an integer");

    const invalidNodePid = await runCliCommand(missingCredsEnv, [
      "start",
      ...TARGET_ARGS,
      "--node-pid",
      "12x",
    ]);
    expect(invalidNodePid.code).toBe(1);
    expect(invalidNodePid.stderr).toContain("nodePid must be an integer");

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
