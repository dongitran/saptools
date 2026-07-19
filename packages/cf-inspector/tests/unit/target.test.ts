import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import type { SessionStatus } from "@saptools/cf-debugger";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { main } from "../../src/cli/program.js";
import {
  formatCfTunnelStatus,
  openTarget,
  resolveTarget,
  resolveTargetWithCurrentCfTarget,
} from "../../src/cli/target.js";

const mocks = vi.hoisted(() => ({
  openCfTunnel: vi.fn(),
}));

vi.mock("../../src/cf/tunnel.js", () => ({
  openCfTunnel: mocks.openCfTunnel,
}));

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

describe("Cloud Foundry tunnel cancellation", () => {
  beforeEach(() => {
    mocks.openCfTunnel.mockReset();
  });

  it("forwards the caller abort signal while opening the tunnel", async () => {
    const controller = new AbortController();
    const dispose = vi.fn(async (): Promise<void> => undefined);
    mocks.openCfTunnel.mockResolvedValueOnce({ localPort: 20_001, dispose });

    const tunnel = await openTarget(
      resolveTarget({ region: "eu10", org: "org-a", space: "dev", app: "demo" }),
      undefined,
      controller.signal,
    );

    expect(mocks.openCfTunnel).toHaveBeenCalledWith(expect.objectContaining({
      signal: controller.signal,
    }));
    await tunnel.dispose();
    expect(dispose).toHaveBeenCalledOnce();
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

  it.each([
    ["--region", { org: "org-a", space: "dev", app: "demo-app" }],
    ["--org", { region: "eu10", space: "dev", app: "demo-app" }],
    ["--space", { region: "eu10", org: "org-a", app: "demo-app" }],
    ["--app", { region: "eu10", org: "org-a", space: "dev" }],
  ] as const)("names a missing %s selector without consulting ambient state", async (flag, options) => {
    await expect(resolveTargetWithCurrentCfTarget(options)).rejects.toMatchObject({
      code: "MISSING_TARGET",
      message: expect.stringContaining(flag) as unknown as string,
    });
  });

  it("lists every missing selector and explains that ambient cf target is not consulted", async () => {
    await expect(resolveTargetWithCurrentCfTarget({ app: "demo-app" })).rejects.toMatchObject({
      code: "MISSING_TARGET",
      message: expect.stringMatching(/--region.*--org.*--space.*ambient `cf target`/i) as unknown as string,
    });
  });

  it("treats whitespace-only CF selectors as missing", async () => {
    await expect(resolveTargetWithCurrentCfTarget({
      region: "  ",
      org: "org-a",
      space: "\t",
      app: "demo-app",
    })).rejects.toMatchObject({
      code: "MISSING_TARGET",
      message: expect.stringMatching(/--region.*--space/) as unknown as string,
    });
  });

  it("resolves a complete target deterministically without invoking ambient cf state", async () => {
    await withFakeCfRecorder(async ({ readInvocations }) => {
      const explicit = {
        region: " eu10-005 ",
        apiEndpoint: " https://api.example.test ",
        org: " org-a ",
        space: " dev ",
        app: " demo-app ",
      };
      const first = await resolveTargetWithCurrentCfTarget(explicit);
      const second = await resolveTargetWithCurrentCfTarget(explicit);

      expect(first).toEqual(second);
      expect(first).toMatchObject({
        kind: "cf",
        region: "eu10-005",
        apiEndpoint: "https://api.example.test",
        org: "org-a",
        space: "dev",
        app: "demo-app",
      });
      expect(await readInvocations()).toBe("");
    });
  });

  it("keeps the --port path independent from ambient CF state", async () => {
    await withFakeCfRecorder(async ({ readInvocations }) => {
      await expect(resolveTargetWithCurrentCfTarget({
        port: "9229",
        host: "localhost",
        app: "ignored",
      })).resolves.toEqual({ kind: "port", port: 9229, host: "localhost" });
      expect(await readInvocations()).toBe("");
    });
  });

  it("preserves an explicit NodeWorker sub-session selector", () => {
    expect(resolveTarget({ port: "9229", worker: "0" })).toEqual({
      kind: "port",
      port: 9229,
      host: "127.0.0.1",
      workerIndex: 0,
    });
  });

  it.each(["-1", "1.5", "worker"])("rejects invalid --worker index %s", (worker) => {
    expect(() => resolveTarget({ port: "9229", worker })).toThrow(
      expect.objectContaining({ code: "INVALID_ARGUMENT" }),
    );
  });

  it("rejects incomplete --app targeting before every command can invoke cf target", async () => {
    const commands: readonly (readonly [string, ...string[]])[] = [
      ["snapshot", "--bp", "src/app.js:1"],
      ["watch", "--bp", "src/app.js:1", "--duration", "1"],
      ["exception"],
      ["log", "--at", "src/app.js:1", "--expr", "value", "--duration", "1"],
      ["eval", "--expr", "value"],
      ["list-scripts"],
      ["list-targets"],
      ["attach"],
    ];

    await withFakeCfRecorder(async ({ readInvocations }) => {
      for (const [command, ...args] of commands) {
        await expect(main(["node", "cf-inspector", command, "--app", "demo-app", ...args]))
          .rejects.toMatchObject({ code: "MISSING_TARGET" });
      }
      expect(await readInvocations()).toBe("");
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
    expect(stdout).not.toContain("default: current cf target");
  });
});

interface FakeCfRecorder {
  readonly readInvocations: () => Promise<string>;
}

async function withFakeCfRecorder(fn: (recorder: FakeCfRecorder) => Promise<void>): Promise<void> {
  const root = join(tmpdir(), `cf-inspector-target-${randomUUID()}`);
  const fakeCf = join(root, "fake-cf.mjs");
  const marker = join(root, "invocations.txt");
  const previous = process.env["CF_DEBUGGER_CF_BIN"];
  const previousMarker = process.env["CF_INSPECTOR_TEST_CF_MARKER"];
  await mkdir(root, { recursive: true });
  await writeFile(fakeCf, [
    "#!/usr/bin/env node",
    "const { appendFileSync } = await import('node:fs');",
    "appendFileSync(process.env.CF_INSPECTOR_TEST_CF_MARKER, `${process.argv.slice(2).join(' ')}\\n`);",
    "process.stdout.write('API endpoint:   https://api.cf.ap10.hana.ondemand.com\\n');",
    "process.stdout.write('org:            org-a\\n');",
    "process.stdout.write('space:          dev\\n');",
  ].join("\n"), "utf8");
  await chmod(fakeCf, 0o755);
  process.env["CF_DEBUGGER_CF_BIN"] = fakeCf;
  process.env["CF_INSPECTOR_TEST_CF_MARKER"] = marker;

  try {
    await fn({
      readInvocations: async (): Promise<string> => {
        try {
          return await readFile(marker, "utf8");
        } catch (error: unknown) {
          if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
            return "";
          }
          throw error;
        }
      },
    });
  } finally {
    if (previous === undefined) {
      delete process.env["CF_DEBUGGER_CF_BIN"];
    } else {
      process.env["CF_DEBUGGER_CF_BIN"] = previous;
    }
    if (previousMarker === undefined) {
      delete process.env["CF_INSPECTOR_TEST_CF_MARKER"];
    } else {
      process.env["CF_INSPECTOR_TEST_CF_MARKER"] = previousMarker;
    }
    await rm(root, { recursive: true, force: true });
  }
}
