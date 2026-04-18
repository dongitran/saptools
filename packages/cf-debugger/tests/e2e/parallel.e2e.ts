import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import { expect, test } from "@playwright/test";

import { readState, startCli, stopCli, type StartedSession, waitForCliExit } from "./cli-helpers.js";
import { discoverDebugTargets, type DebugTarget } from "./discovery.js";
import { CLI_PATH, buildEnv, canConnect, cleanupHome, createIsolatedHome, readLiveCreds } from "./helpers.js";

interface StateSession {
  readonly sessionId: string;
  readonly app: string;
  readonly localPort: number;
  readonly status: string;
}

const START_TIMEOUT_MS = 10 * 60 * 1000;

function expectCliBuilt(): void {
  expect(
    existsSync(CLI_PATH),
    `CLI must be built at ${CLI_PATH}. Run \`pnpm --filter @saptools/cf-debugger build\`.`,
  ).toBe(true);
}

async function startDebugSession(
  env: NodeJS.ProcessEnv,
  target: DebugTarget,
): Promise<StartedSession> {
  return await startCli(
    env,
    [
      "start",
      "--region",
      target.regionKey,
      "--org",
      target.org,
      "--space",
      target.space,
      "--app",
      target.app,
      "--verbose",
    ],
    START_TIMEOUT_MS,
  );
}

async function readSessions(homeDir: string): Promise<readonly StateSession[]> {
  const state = (await readState(homeDir)) as
    | { sessions?: readonly StateSession[] }
    | undefined;
  return state?.sessions ?? [];
}

async function expectSessionReachable(session: StartedSession, label: string): Promise<void> {
  expect(session.localPort).toBeGreaterThanOrEqual(20_000);
  const reachable = await canConnect(session.localPort, 2_000);
  expect(reachable, label).toBe(true);
}

async function expectSessionsReachable(
  sessions: readonly StartedSession[],
  labels: readonly string[],
): Promise<void> {
  await Promise.all(
    sessions.map(async (session, index) => {
      const label = labels[index] ?? `tunnel on port ${String(session.localPort)} must be reachable`;
      await expectSessionReachable(session, label);
    }),
  );
}

function expectDistinctPorts(sessions: readonly StartedSession[]): void {
  const ports = sessions.map((session) => session.localPort);
  expect(new Set(ports).size).toBe(ports.length);
}

function expectReadyApps(
  sessions: readonly StateSession[],
  targets: readonly DebugTarget[],
): void {
  for (const target of targets) {
    expect(
      sessions.some((session) => session.app === target.app && session.status === "ready"),
      `${target.app} must be recorded as a ready session`,
    ).toBe(true);
  }
}

async function stopSessions(
  ...sessions: readonly (StartedSession | undefined)[]
): Promise<void> {
  const active = sessions.filter((session): session is StartedSession => session !== undefined);
  await Promise.all(active.map(async (session) => {
    await stopCli(session.child);
  }));
}

async function runCliCommand(
  env: NodeJS.ProcessEnv,
  args: readonly string[],
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  const child = spawn(
    "node",
    [CLI_PATH, ...args],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk.toString("utf8")));
  const result = await waitForCliExit(child);
  return {
    code: result.code,
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
  };
}

async function stopAll(env: NodeJS.ProcessEnv): Promise<void> {
  const result = await runCliCommand(env, ["stop", "--all"]);
  expect(result.code, `stop --all failed.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);
}

test("two different apps can be debugged in parallel on distinct ports", async () => {
  test.setTimeout(15 * 60 * 1000);
  expectCliBuilt();

  const creds = readLiveCreds();
  test.skip(!creds, "SAP_EMAIL / SAP_PASSWORD not set — parallel test skipped");
  if (!creds) {
    return;
  }

  const targets = await discoverDebugTargets(creds.email, creds.password, 2);
  test.skip(targets.length < 2, "Could not discover two running CF apps in the same space for parallel test");
  if (targets.length < 2) {
    return;
  }

  const homeDir = await createIsolatedHome();
  const env = buildEnv(homeDir);

  try {
    const sessions = await Promise.all(targets.map(async (target) => await startDebugSession(env, target)));
    try {
      expectDistinctPorts(sessions);
      await expectSessionsReachable(sessions, [
        "first tunnel must be reachable",
        "second tunnel must be reachable",
      ]);
      const stateSessions = await readSessions(homeDir);
      expect(stateSessions.length).toBeGreaterThanOrEqual(2);
      expectReadyApps(stateSessions, targets);
    } finally {
      await stopSessions(...sessions);
    }

    const remaining = await readSessions(homeDir);
    expect(remaining.some((session) => targets.some((target) => target.app === session.app))).toBe(false);
  } finally {
    await cleanupHome(homeDir);
  }
});

test("a second app can start after the first is ready without clobbering the active session", async () => {
  test.setTimeout(15 * 60 * 1000);
  expectCliBuilt();

  const creds = readLiveCreds();
  test.skip(!creds, "SAP_EMAIL / SAP_PASSWORD not set — parallel test skipped");
  if (!creds) {
    return;
  }

  const targets = await discoverDebugTargets(creds.email, creds.password, 2);
  test.skip(
    targets.length < 2,
    "Could not discover two running CF apps in the same space for sequential parallel test",
  );
  if (targets.length < 2) {
    return;
  }

  const [first, second] = targets;
  if (first === undefined || second === undefined) {
    return;
  }

  const homeDir = await createIsolatedHome();
  const env = buildEnv(homeDir);
  let secondSession: StartedSession | undefined;

  try {
    const firstSession = await startDebugSession(env, first);
    try {
      await expectSessionReachable(firstSession, "first tunnel must be reachable before starting second app");
      secondSession = await startDebugSession(env, second);
      expectDistinctPorts([firstSession, secondSession]);
      await expectSessionsReachable(
        [firstSession, secondSession],
        [
          "first tunnel must stay reachable after second app starts",
          "second tunnel must be reachable",
        ],
      );
      const stateSessions = await readSessions(homeDir);
      expect(stateSessions.length).toBeGreaterThanOrEqual(2);
      expectReadyApps(stateSessions, [first, second]);
    } finally {
      await stopSessions(firstSession, secondSession);
    }

    const remaining = await readSessions(homeDir);
    expect(remaining.some((session) => session.app === first.app || session.app === second.app)).toBe(false);
  } finally {
    await cleanupHome(homeDir);
  }
});

test("three different apps can be debugged in parallel on distinct ports", async () => {
  test.setTimeout(20 * 60 * 1000);
  expectCliBuilt();

  const creds = readLiveCreds();
  test.skip(!creds, "SAP_EMAIL / SAP_PASSWORD not set — parallel test skipped");
  if (!creds) {
    return;
  }

  const targets = await discoverDebugTargets(creds.email, creds.password, 3);
  test.skip(targets.length < 3, "Could not discover three running CF apps in the same space for triple parallel test");
  if (targets.length < 3) {
    return;
  }

  const homeDir = await createIsolatedHome();
  const env = buildEnv(homeDir);

  try {
    const sessions = await Promise.all(targets.map(async (target) => await startDebugSession(env, target)));
    try {
      expectDistinctPorts(sessions);
      await expectSessionsReachable(sessions, [
        "first triple-parallel tunnel must be reachable",
        "second triple-parallel tunnel must be reachable",
        "third triple-parallel tunnel must be reachable",
      ]);
      const stateSessions = await readSessions(homeDir);
      expect(stateSessions.length).toBeGreaterThanOrEqual(3);
      expectReadyApps(stateSessions, targets);
    } finally {
      await stopSessions(...sessions);
    }

    const remaining = await readSessions(homeDir);
    expect(remaining.some((session) => targets.some((target) => target.app === session.app))).toBe(false);
  } finally {
    await cleanupHome(homeDir);
  }
});

test("stopping one of three active sessions keeps the others reachable and allows a clean restart", async () => {
  test.setTimeout(20 * 60 * 1000);
  expectCliBuilt();

  const creds = readLiveCreds();
  test.skip(!creds, "SAP_EMAIL / SAP_PASSWORD not set — parallel test skipped");
  if (!creds) {
    return;
  }

  const targets = await discoverDebugTargets(creds.email, creds.password, 3);
  test.skip(targets.length < 3, "Could not discover three running CF apps in the same space for stop-and-restart test");
  if (targets.length < 3) {
    return;
  }

  const [first, second, third] = targets;
  if (first === undefined || second === undefined || third === undefined) {
    return;
  }

  const homeDir = await createIsolatedHome();
  const env = buildEnv(homeDir);
  let restartedSecond: StartedSession | undefined;

  try {
    const [firstSession, secondSession, thirdSession] = await Promise.all([
      startDebugSession(env, first),
      startDebugSession(env, second),
      startDebugSession(env, third),
    ]);

    try {
      await expectSessionsReachable(
        [firstSession, secondSession, thirdSession],
        [
          "first tunnel must be reachable before targeted stop",
          "second tunnel must be reachable before targeted stop",
          "third tunnel must be reachable before targeted stop",
        ],
      );

      const sessionsBeforeStop = await readSessions(homeDir);
      const secondRecord = sessionsBeforeStop.find((session) => session.app === second.app);
      expect(secondRecord, `${second.app} must be present in state before targeted stop`).toBeDefined();
      if (secondRecord === undefined) {
        return;
      }

      await stopCli(secondSession.child);

      const afterStopSessions = await readSessions(homeDir);
      expect(afterStopSessions.some((session) => session.app === second.app)).toBe(false);
      await expectSessionsReachable(
        [firstSession, thirdSession],
        [
          "first survivor tunnel must remain reachable after stopping second app",
          "third survivor tunnel must remain reachable after stopping second app",
        ],
      );

      restartedSecond = await startDebugSession(env, second);
      await expectSessionsReachable(
        [firstSession, restartedSecond, thirdSession],
        [
          "first survivor tunnel must remain reachable after restart",
          "restarted second tunnel must be reachable",
          "third survivor tunnel must remain reachable after restart",
        ],
      );

      const finalSessions = await readSessions(homeDir);
      expect(finalSessions.length).toBeGreaterThanOrEqual(3);
      expectReadyApps(finalSessions, [first, second, third]);
    } finally {
      await stopSessions(firstSession, secondSession, thirdSession, restartedSecond);
    }

    const remaining = await readSessions(homeDir);
    expect(remaining.some((session) => [first, second, third].some((target) => target.app === session.app))).toBe(false);
  } finally {
    await cleanupHome(homeDir);
  }
});

test("stop --all removes every active session after multi-app startup", async () => {
  test.setTimeout(20 * 60 * 1000);
  expectCliBuilt();

  const creds = readLiveCreds();
  test.skip(!creds, "SAP_EMAIL / SAP_PASSWORD not set — parallel test skipped");
  if (!creds) {
    return;
  }

  const targets = await discoverDebugTargets(creds.email, creds.password, 3);
  test.skip(targets.length < 3, "Could not discover three running CF apps in the same space for stop-all test");
  if (targets.length < 3) {
    return;
  }

  const homeDir = await createIsolatedHome();
  const env = buildEnv(homeDir);

  try {
    const sessions = await Promise.all(targets.map(async (target) => await startDebugSession(env, target)));
    try {
      await expectSessionsReachable(
        sessions,
        [
          "first tunnel must be reachable before stop-all",
          "second tunnel must be reachable before stop-all",
          "third tunnel must be reachable before stop-all",
        ],
      );
      await stopAll(env);
      await Promise.all(sessions.map(async (session) => {
        await waitForCliExit(session.child);
      }));
      const remaining = await readSessions(homeDir);
      expect(remaining).toEqual([]);
    } finally {
      await stopSessions(...sessions);
    }
  } finally {
    await cleanupHome(homeDir);
  }
});
