import { randomUUID } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import type { SessionStatus } from "@saptools/cf-debugger";
import { describe, expect, it } from "vitest";

import { main } from "../../src/cli/program.js";
import {
  formatCfTunnelStatus,
  resolveTarget,
  resolveTargetWithCurrentCfTarget,
} from "../../src/cli/target.js";

describe("Cloud Foundry tunnel progress", () => {
  it.each<readonly [SessionStatus, string]>([
    ["starting", "Preparing the Cloud Foundry debugger..."],
    ["logging-in", "Logging in to Cloud Foundry..."],
    ["targeting", "Targeting the Cloud Foundry org and space..."],
    ["ssh-enabling", "Enabling SSH for the Cloud Foundry app..."],
    ["ssh-restarting", "Restarting the Cloud Foundry app to activate SSH..."],
    ["signaling", "Starting the remote Node.js inspector..."],
    ["tunneling", "Opening the SSH inspector tunnel..."],
    ["ready", "Cloud Foundry inspector tunnel is ready."],
    ["stopping", "Closing the Cloud Foundry inspector tunnel..."],
    ["stopped", "Cloud Foundry inspector tunnel closed."],
    ["error", "Cloud Foundry inspector tunnel failed."],
  ])("maps %s without exposing raw status detail", (status, expected) => {
    expect(formatCfTunnelStatus(status)).toBe(expected);
  });
});

describe("Cloud Foundry target timeout", () => {
  const cfOptions = {
    region: "eu10",
    org: "org-a",
    space: "dev",
    app: "demo-app",
  };

  it("allows three minutes for tunnel readiness by default", () => {
    expect(resolveTarget(cfOptions)).toMatchObject({
      kind: "cf",
      tunnelTimeoutMs: 180_000,
    });
  });

  it("preserves an explicit --timeout override for CF tunnel readiness", () => {
    expect(resolveTarget({ ...cfOptions, timeout: "45" })).toMatchObject({
      kind: "cf",
      tunnelTimeoutMs: 45_000,
    });
  });

  it("can reserve --timeout for command wait semantics while keeping the default tunnel timeout", () => {
    expect(resolveTarget({ ...cfOptions, timeout: "45" }, { useTimeoutForTunnel: false })).toMatchObject({
      kind: "cf",
      tunnelTimeoutMs: 180_000,
    });
  });

  it("preserves an explicit --api-endpoint override", () => {
    expect(
      resolveTarget({
        ...cfOptions,
        region: "eu10-005",
        apiEndpoint: "https://api.cf.eu10-005.hana.ondemand.com",
      }),
    ).toMatchObject({
      kind: "cf",
      region: "eu10-005",
      apiEndpoint: "https://api.cf.eu10-005.hana.ondemand.com",
    });
  });

  it("uses the current CF target when only --app is provided", async () => {
    const root = join(tmpdir(), `cf-inspector-target-${randomUUID()}`);
    const fakeCf = join(root, "fake-cf.mjs");
    const previous = process.env["CF_DEBUGGER_CF_BIN"];
    await mkdir(root, { recursive: true });
    await writeFile(fakeCf, [
      "#!/usr/bin/env node",
      "if (process.argv[2] !== 'target') process.exit(1);",
      "process.stdout.write('API endpoint:   https://api.cf.ap10.hana.ondemand.com\\n');",
      "process.stdout.write('org:            org-a\\n');",
      "process.stdout.write('space:          dev\\n');",
    ].join("\n"), "utf8");
    await chmod(fakeCf, 0o755);
    process.env["CF_DEBUGGER_CF_BIN"] = fakeCf;

    try {
      await expect(resolveTargetWithCurrentCfTarget({ app: "demo-app" })).resolves.toMatchObject({
        kind: "cf",
        region: "ap10",
        org: "org-a",
        space: "dev",
        app: "demo-app",
      });
    } finally {
      if (previous === undefined) {
        delete process.env["CF_DEBUGGER_CF_BIN"];
      } else {
        process.env["CF_DEBUGGER_CF_BIN"] = previous;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("derives indexed regions from the current CF target and keeps the raw endpoint", async () => {
    await withFakeCfTarget("https://api.cf.eu10-005.hana.ondemand.com", async () => {
      await expect(resolveTargetWithCurrentCfTarget({ app: "demo-app" })).resolves.toMatchObject({
        kind: "cf",
        region: "eu10-005",
        apiEndpoint: "https://api.cf.eu10-005.hana.ondemand.com",
        org: "org-a",
        space: "dev",
        app: "demo-app",
      });
    });
  });

  it("derives China regions from the current CF target domain", async () => {
    await withFakeCfTarget("https://api.cf.cn20.platform.sapcloud.cn", async () => {
      await expect(resolveTargetWithCurrentCfTarget({ app: "demo-app" })).resolves.toMatchObject({
        kind: "cf",
        region: "cn20",
        apiEndpoint: "https://api.cf.cn20.platform.sapcloud.cn",
      });
    });
  });

  it("documents --api-endpoint in command help", async () => {
    const previousWrite = process.stdout.write.bind(process.stdout);
    let stdout = "";
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      stdout += chunk.toString();
      return true;
    }) as typeof process.stdout.write;
    try {
      await expect(main(["node", "cf-inspector", "eval", "--help"])).rejects.toThrow(
        /process\.exit unexpectedly called/,
      );
    } finally {
      process.stdout.write = previousWrite;
    }

    expect(stdout).toContain("--api-endpoint <url>");
  });
});

async function withFakeCfTarget(apiEndpoint: string, fn: () => Promise<void>): Promise<void> {
  const root = join(tmpdir(), `cf-inspector-target-${randomUUID()}`);
  const fakeCf = join(root, "fake-cf.mjs");
  const previous = process.env["CF_DEBUGGER_CF_BIN"];
  await mkdir(root, { recursive: true });
  await writeFile(fakeCf, [
    "#!/usr/bin/env node",
    "if (process.argv[2] !== 'target') process.exit(1);",
    `process.stdout.write('API endpoint:   ${apiEndpoint}\\n');`,
    "process.stdout.write('org:            org-a\\n');",
    "process.stdout.write('space:          dev\\n');",
  ].join("\n"), "utf8");
  await chmod(fakeCf, 0o755);
  process.env["CF_DEBUGGER_CF_BIN"] = fakeCf;

  try {
    await fn();
  } finally {
    if (previous === undefined) {
      delete process.env["CF_DEBUGGER_CF_BIN"];
    } else {
      process.env["CF_DEBUGGER_CF_BIN"] = previous;
    }
    await rm(root, { recursive: true, force: true });
  }
}
