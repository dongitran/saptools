import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import {
  countSshInvocations,
  fakeCfTracePath,
  readFakeCfTraceEntries,
  runCli,
  setupFakeCfBin,
} from "./helpers.js";

const SELECTOR = "eu10/example-org/space-demo/app-demo";

interface FakeEnvOptions {
  readonly failConnect?: "once" | "always";
  readonly denyApps?: readonly string[];
  readonly tunnel?: boolean;
  readonly refreshTunnel?: boolean;
}

let home: string;
let fakeBinDir: string;

test.beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "cf-hana-tunnel-e2e-"));
  fakeBinDir = await setupFakeCfBin(home);
});

test.afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function fakeEnv(options: FakeEnvOptions = {}): Record<string, string> {
  const path = `${fakeBinDir}:${process.env["PATH"] ?? ""}`;
  return {
    HOME: home,
    CF_HANA_DRIVER: "fake",
    PATH: path,
    SAP_EMAIL: "user@example.com",
    SAP_PASSWORD: "secret",
    CF_HANA_FAKE_CF_TRACE_FILE: fakeCfTracePath(home),
    // Keeps any leaked detached fake-ssh process bounded to a few seconds
    // instead of lingering indefinitely if a test does not reap it.
    CF_HANA_TUNNEL_KEEPALIVE_SECONDS: "5",
    ...(options.failConnect === undefined ? {} : { CF_HANA_FAKE_FAIL_CONNECT: options.failConnect }),
    ...(options.denyApps === undefined
      ? {}
      : { CF_HANA_FAKE_CF_SSH_DENY_APPS: options.denyApps.join(",") }),
  };
}

function args(command: readonly string[], options: FakeEnvOptions = {}): readonly string[] {
  return [
    ...command,
    ...(options.tunnel === true ? ["--tunnel"] : []),
    ...(options.refreshTunnel === true ? ["--refresh-tunnel"] : []),
  ];
}

test("User can run the default fake-driver path with zero tunnel engagement", async () => {
  const result = await runCli(args(["ping", SELECTOR, "--read-only"]), fakeEnv());

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("OK");
  const trace = await readFakeCfTraceEntries(home);
  expect(countSshInvocations(trace)).toBe(0);
  expect(trace.some((entry) => entry.kind === "apps")).toBe(false);
});

test("User's query automatically falls back to a tunnel on a classified connectivity failure", async () => {
  const result = await runCli(
    args(["ping", SELECTOR, "--read-only"], { failConnect: "once" }),
    fakeEnv({ failConnect: "once" }),
  );

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("OK");
  const trace = await readFakeCfTraceEntries(home);
  expect(countSshInvocations(trace)).toBe(1);
  expect(trace.some((entry) => entry.kind === "ssh" && entry.app === "app-demo")).toBe(true);
});

test("A second invocation against the same host reuses the live tunnel without re-establishing", async () => {
  const first = await runCli(
    args(["ping", SELECTOR, "--read-only"], { failConnect: "once" }),
    fakeEnv({ failConnect: "once" }),
  );
  expect(first.exitCode).toBe(0);
  const afterFirst = await readFakeCfTraceEntries(home);
  expect(countSshInvocations(afterFirst)).toBe(1);

  // No failConnect this time: if the cache were not reused, the CLI would
  // still succeed via a normal direct connect, masking the real question.
  // The trace is the actual proof - no *additional* `cf ssh` invocation.
  const second = await runCli(args(["ping", SELECTOR, "--read-only"]), fakeEnv());
  expect(second.exitCode).toBe(0);

  const afterSecond = await readFakeCfTraceEntries(home);
  expect(countSshInvocations(afterSecond)).toBe(1);
});

test("--refresh-tunnel forces a fresh tunnel despite a live cached one", async () => {
  const first = await runCli(
    args(["ping", SELECTOR, "--read-only"], { failConnect: "once" }),
    fakeEnv({ failConnect: "once" }),
  );
  expect(first.exitCode).toBe(0);
  expect(countSshInvocations(await readFakeCfTraceEntries(home))).toBe(1);

  const refreshed = await runCli(
    args(["ping", SELECTOR, "--read-only"], { failConnect: "once", refreshTunnel: true }),
    fakeEnv({ failConnect: "once", refreshTunnel: true }),
  );
  expect(refreshed.exitCode).toBe(0);
  expect(countSshInvocations(await readFakeCfTraceEntries(home))).toBe(2);
});

test("A slow cf apps response never delays the fallback when the target app itself succeeds", async () => {
  const result = await runCli(
    args(["ping", SELECTOR, "--read-only"], { failConnect: "once" }),
    { ...fakeEnv({ failConnect: "once" }), CF_HANA_FAKE_CF_APPS_DELAY_MS: "3000" },
  );

  expect(result.exitCode).toBe(0);
  const trace = await readFakeCfTraceEntries(home);
  // The target app (a known candidate) succeeds without ever needing `cf
  // apps` discovery, so the injected 3s discovery delay is never paid.
  expect(trace.some((entry) => entry.kind === "apps")).toBe(false);
  expect(countSshInvocations(trace)).toBe(1);
});

test("Candidate iteration moves past a denied app to the next candidate", async () => {
  const result = await runCli(
    args(["ping", SELECTOR, "--read-only"], { failConnect: "once", denyApps: ["app-demo"] }),
    fakeEnv({ failConnect: "once", denyApps: ["app-demo"] }),
  );

  expect(result.exitCode).toBe(0);
  const trace = await readFakeCfTraceEntries(home);
  expect(countSshInvocations(trace)).toBe(2);
  expect(trace.some((entry) => entry.kind === "ssh" && entry.app === "sibling-app")).toBe(true);
});

test("A denied candidate's real failure reason surfaces on stderr instead of being silently dropped", async () => {
  const result = await runCli(
    args(["ping", SELECTOR, "--read-only"], {
      failConnect: "always",
      denyApps: ["app-demo", "sibling-app"],
      tunnel: true,
    }),
    fakeEnv({ failConnect: "always", denyApps: ["app-demo", "sibling-app"] }),
  );

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("not authorized to perform the requested action");
});

test("--tunnel skips the direct attempt entirely, proven by which error surfaces on total exhaustion", async () => {
  const result = await runCli(
    args(["ping", SELECTOR, "--read-only"], {
      failConnect: "always",
      denyApps: ["app-demo", "sibling-app"],
      tunnel: true,
    }),
    fakeEnv({ failConnect: "always", denyApps: ["app-demo", "sibling-app"] }),
  );

  expect(result.exitCode).not.toBe(0);
  // If direct had been attempted (it must not be, in --tunnel mode), the
  // surfaced error would be the raw HANA connect failure text instead.
  expect(result.stderr).toContain("Could not establish an SSH tunnel");
  expect(result.stderr).not.toContain("Failed to connect to HANA");
});

test("total exhaustion in auto mode surfaces the original connectivity error, not a generic tunnel failure", async () => {
  const result = await runCli(
    args(["ping", SELECTOR, "--read-only"], {
      failConnect: "always",
      denyApps: ["app-demo", "sibling-app"],
    }),
    fakeEnv({ failConnect: "always", denyApps: ["app-demo", "sibling-app"] }),
  );

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("Failed to connect to HANA");
});
