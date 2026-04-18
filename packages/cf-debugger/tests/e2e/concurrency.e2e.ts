import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import { expect, test } from "@playwright/test";

import { readState, startCli, stopCli, waitForCliExit } from "./cli-helpers.js";
import { discoverDebugTarget } from "./discovery.js";
import { CLI_PATH, buildEnv, canConnect, cleanupHome, createIsolatedHome, readLiveCreds } from "./helpers.js";

async function runCliCommand(
  env: NodeJS.ProcessEnv,
  args: readonly string[],
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  const child = spawn("node", [CLI_PATH, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
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

test("refuses a duplicate start for the same app while one is running", async () => {
  test.setTimeout(10 * 60 * 1000);

  expect(existsSync(CLI_PATH)).toBe(true);
  const creds = readLiveCreds();
  test.skip(!creds, "SAP_EMAIL / SAP_PASSWORD not set — skipping");
  if (!creds) {
    return;
  }

  const target = await discoverDebugTarget(creds.email, creds.password);
  test.skip(target === undefined, "Could not discover a running CF app");
  if (target === undefined) {
    return;
  }

  const homeDir = await createIsolatedHome();
  const env = buildEnv(homeDir);

  try {
    const first = await startCli(
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
      8 * 60 * 1000,
    );

    try {
      const reachable = await canConnect(first.localPort, 2_000);
      expect(reachable).toBe(true);

      const duplicate = spawn(
        "node",
        [
          CLI_PATH,
          "start",
          "--region",
          target.regionKey,
          "--org",
          target.org,
          "--space",
          target.space,
          "--app",
          target.app,
        ],
        { env, stdio: ["ignore", "pipe", "pipe"] },
      );
      const duplicateStderrChunks: string[] = [];
      duplicate.stderr.on("data", (chunk: Buffer) => duplicateStderrChunks.push(chunk.toString("utf8")));
      const duplicateResult = await waitForCliExit(duplicate);
      expect(duplicateResult.code).not.toBe(0);
      expect(duplicateStderrChunks.join("")).toMatch(/SESSION_ALREADY_RUNNING/);
    } finally {
      await stopCli(first.child);
    }

    const postState = (await readState(homeDir)) as { sessions?: readonly unknown[] } | undefined;
    if (postState !== undefined) {
      expect(postState.sessions ?? []).toEqual([]);
    }
  } finally {
    await cleanupHome(homeDir);
  }
});

test("stop CLI can terminate one active session by session id", async () => {
  test.setTimeout(10 * 60 * 1000);

  expect(existsSync(CLI_PATH)).toBe(true);
  const creds = readLiveCreds();
  test.skip(!creds, "SAP_EMAIL / SAP_PASSWORD not set — skipping");
  if (!creds) {
    return;
  }

  const target = await discoverDebugTarget(creds.email, creds.password);
  test.skip(target === undefined, "Could not discover a running CF app");
  if (target === undefined) {
    return;
  }

  const homeDir = await createIsolatedHome();
  const env = buildEnv(homeDir);

  try {
    const first = await startCli(
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
      8 * 60 * 1000,
    );

    try {
      const reachable = await canConnect(first.localPort, 2_000);
      expect(reachable).toBe(true);

      const state = (await readState(homeDir)) as
        | { sessions?: readonly { sessionId: string; app: string }[] }
        | undefined;
      const session = state?.sessions?.find((entry) => entry.app === target.app);
      expect(session, `${target.app} must be present in state before stop`).toBeDefined();
      if (session === undefined) {
        return;
      }

      const stopResult = await runCliCommand(env, ["stop", "--session-id", session.sessionId]);
      expect(
        stopResult.code,
        `stop --session-id failed.\nstdout: ${stopResult.stdout}\nstderr: ${stopResult.stderr}`,
      ).toBe(0);

      await waitForCliExit(first.child);
    } finally {
      await stopCli(first.child);
    }

    const postState = (await readState(homeDir)) as { sessions?: readonly unknown[] } | undefined;
    if (postState !== undefined) {
      expect(postState.sessions ?? []).toEqual([]);
    }
  } finally {
    await cleanupHome(homeDir);
  }
});

test("list and status CLI commands report active sessions", async () => {
  test.setTimeout(10 * 60 * 1000);

  expect(existsSync(CLI_PATH)).toBe(true);
  const creds = readLiveCreds();
  test.skip(!creds, "SAP_EMAIL / SAP_PASSWORD not set — skipping");
  if (!creds) {
    return;
  }

  const target = await discoverDebugTarget(creds.email, creds.password);
  test.skip(target === undefined, "Could not discover a running CF app");
  if (target === undefined) {
    return;
  }

  const homeDir = await createIsolatedHome();
  const env = buildEnv(homeDir);

  try {
    const first = await startCli(
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
      ],
      8 * 60 * 1000,
    );

    try {
      const list = spawn("node", [CLI_PATH, "list"], { env, stdio: ["ignore", "pipe", "pipe"] });
      const listChunks: string[] = [];
      list.stdout.on("data", (chunk: Buffer) => listChunks.push(chunk.toString("utf8")));
      const listResult = await waitForCliExit(list);
      expect(listResult.code).toBe(0);
      const parsed = JSON.parse(listChunks.join("")) as readonly { app: string }[];
      expect(parsed.some((s) => s.app === target.app)).toBe(true);

      const status = spawn(
        "node",
        [
          CLI_PATH,
          "status",
          "--region",
          target.regionKey,
          "--org",
          target.org,
          "--space",
          target.space,
          "--app",
          target.app,
        ],
        { env, stdio: ["ignore", "pipe", "pipe"] },
      );
      const statusChunks: string[] = [];
      status.stdout.on("data", (chunk: Buffer) => statusChunks.push(chunk.toString("utf8")));
      const statusResult = await waitForCliExit(status);
      expect(statusResult.code).toBe(0);
      const statusJson = JSON.parse(statusChunks.join("")) as { app?: string } | null;
      expect(statusJson?.app).toBe(target.app);
    } finally {
      await stopCli(first.child);
    }
  } finally {
    await cleanupHome(homeDir);
  }
});
