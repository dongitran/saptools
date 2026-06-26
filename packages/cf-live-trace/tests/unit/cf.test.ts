import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  buildCfSshArgs,
  buildInspectorSignalCommand,
  createSecretRedactor,
  ensureSshEnabled,
  openInspectorTunnel,
  prepareCfSession,
  runCfCommand,
  tryStartNodeInspector,
} from "../../src/cf.js";
import type { PortForwardProcess } from "../../src/types.js";

describe("Cloud Foundry helpers", () => {
  it("prepares an isolated CF session without putting credentials in args", async () => {
    const runCf = vi.fn(async () => "");

    await prepareCfSession(
      {
        apiEndpoint: "https://api.example.com",
        email: "user@example.com",
        password: "secret-password",
        org: "demo-org",
        space: "dev",
        app: "orders-api",
        cfHomeDir: "/tmp/cf-home",
      },
      { runCf },
    );

    expect(runCf).toHaveBeenNthCalledWith(
      1,
      ["api", "https://api.example.com"],
      expect.objectContaining({ cfHomeDir: "/tmp/cf-home" }),
    );
    expect(runCf).toHaveBeenNthCalledWith(
      2,
      ["auth"],
      expect.objectContaining({
        envOverrides: { CF_USERNAME: "user@example.com", CF_PASSWORD: "secret-password" },
      }),
    );
    expect(runCf).toHaveBeenNthCalledWith(3, ["target", "-o", "demo-org", "-s", "dev"], expect.any(Object));
    expect(JSON.stringify(runCf.mock.calls)).not.toContain("auth user@example.com secret-password");
  });

  it("builds instance-aware cf ssh args and a proc-based inspector startup command", () => {
    expect(buildCfSshArgs("orders-api", 2, ["-c", "true"])).toEqual([
      "ssh",
      "orders-api",
      "-i",
      "2",
      "-c",
      "true",
    ]);
    expect(buildCfSshArgs("orders-api", undefined, ["-N"])).toEqual(["ssh", "orders-api", "-N"]);

    const command = buildInspectorSignalCommand();
    expect(command).toContain("/proc/[0-9]*");
    expect(command).toContain("readlink \"$pid_dir/exe\"");
    expect(command).toContain("kill -USR1 \"$node_pid\"");
    expect(command).toContain("saptools-inspector-ready");
    expect(command).not.toContain("pidof node");
  });

  it("opens a local tunnel to the remote Node inspector and stops it when not reachable", async () => {
    const process = new EventEmitter() as PortForwardProcess;
    const stop = vi.fn();
    const spawnPortForward = vi.fn(() => ({ process, localPort: 51234, stop }));

    const result = await openInspectorTunnel(
      { appName: "orders-api", cfHomeDir: "/tmp/cf-home", instanceIndex: 1 },
      {
        allocatePort: vi.fn(async () => 51234),
        spawnPortForward,
        waitForLocalPort: vi.fn(async () => false),
      },
    );

    expect(result.status).toBe("not-reachable");
    expect(stop).toHaveBeenCalledTimes(1);
    expect(spawnPortForward).toHaveBeenCalledWith(
      expect.objectContaining({
        appName: "orders-api",
        cfHomeDir: "/tmp/cf-home",
        instanceIndex: 1,
        localPort: 51234,
        remoteHost: "127.0.0.1",
        remotePort: 9229,
      }),
    );
  });

  it("keeps a ready tunnel open when the local inspector port responds", async () => {
    const process = new EventEmitter() as PortForwardProcess;
    const stop = vi.fn();

    const result = await openInspectorTunnel(
      { app: "orders-api", instanceIndex: 0 },
      {
        allocatePort: vi.fn(async () => 51235),
        spawnPortForward: vi.fn(() => ({ process, localPort: 51235, stop })),
        waitForLocalPort: vi.fn(async () => true),
      },
    );

    expect(result).toEqual({
      status: "ready",
      handle: expect.objectContaining({ localPort: 51235, stop }),
    });
    expect(stop).not.toHaveBeenCalled();
  });

  it("redacts credentials from errors", () => {
    const redact = createSecretRedactor(["secret-password", "Bearer raw-token"]);

    expect(redact("failed with secret-password and Bearer raw-token")).toBe(
      "failed with <redacted> and <redacted>",
    );
  });

  it("enables SSH, restarts the app, and smoke checks the selected instance when disabled", async () => {
    const runCf = vi.fn(async (args: readonly string[]) => args[0] === "ssh-enabled" ? "ssh support is disabled" : "");

    await ensureSshEnabled(createTarget(), { runCf });

    expect(runCf.mock.calls.map(([args]) => args)).toEqual([
      ["ssh-enabled", "orders-api"],
      ["enable-ssh", "orders-api"],
      ["restart", "orders-api"],
      ["ssh", "orders-api", "-i", "1", "-c", "true"],
    ]);
  });

  it("does not enable SSH when the app already reports enabled", async () => {
    const runCf = vi.fn(async () => "ssh support is enabled");

    await ensureSshEnabled(createTarget(), { runCf });

    expect(runCf).toHaveBeenCalledTimes(1);
    expect(runCf).toHaveBeenCalledWith(["ssh-enabled", "orders-api"], expect.any(Object));
  });

  it("signals the remote inspector and reads the ready marker", async () => {
    const runCf = vi.fn(async () => "saptools-inspector-signaled\nsaptools-inspector-ready\n");

    await expect(tryStartNodeInspector(createTarget(), { runCf })).resolves.toBe(true);
    const firstCall = runCf.mock.calls.at(0) as [readonly string[], unknown] | undefined;
    expect(firstCall?.[0]).toEqual([
      "ssh",
      "orders-api",
      "-i",
      "1",
      "-c",
      expect.stringContaining("saptools-inspector-ready"),
    ]);
  });

  it("returns false when the remote inspector startup command fails", async () => {
    const runCf = vi.fn(async () => {
      throw new Error("ssh failed");
    });

    await expect(tryStartNodeInspector(createTarget(), { runCf })).resolves.toBe(false);
  });

  it("runs a JS CF shim through node and redacts failing stderr", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "cf-live-trace-test-"));
    const fakeCf = join(tempDir, "fake-cf.mjs");
    await writeFile(fakeCf, [
      "if (process.argv.includes('fail')) {",
      "  process.stderr.write(`secret-password ${process.env.CF_HOME}`);",
      "  process.exit(2);",
      "}",
      "process.stdout.write(JSON.stringify({ args: process.argv.slice(2), home: process.env.CF_HOME, user: process.env.CF_USERNAME }));",
    ].join("\n"));

    try {
      const stdout = await runCfCommand(["auth"], {
        command: fakeCf,
        cfHomeDir: "/tmp/cf-home",
        envOverrides: { CF_USERNAME: "user@example.com" },
      });
      expect(JSON.parse(stdout)).toEqual({
        args: ["auth"],
        home: "/tmp/cf-home",
        user: "user@example.com",
      });

      await expect(runCfCommand(["fail"], {
        command: fakeCf,
        cfHomeDir: "/tmp/cf-home",
        redactor: createSecretRedactor(["secret-password"]),
      })).rejects.toThrow("<redacted> /tmp/cf-home");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

function createTarget() {
  return {
    app: "orders-api",
    email: "user@example.com",
    password: "secret-password",
    instanceIndex: 1,
  };
}

describe("current CF target (direct cf target, no cf-sync)", () => {
  it("parses complete target and maps known region", async () => {
    const cf = await import("../../src/cf.js");
    const out = [
      "API endpoint:   https://api.cf.ap10.hana.ondemand.com",
      "API version:    3.156.0",
      "org:            demo-org",
      "space:          dev",
    ].join("\n");
    const parsed = cf.parseCurrentCfTarget(out);
    expect(parsed).toEqual({
      apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
      regionKey: "ap10",
      orgName: "demo-org",
      spaceName: "dev",
    });
  });

  it("parses with unknown region using apiEndpoint only", async () => {
    const cf = await import("../../src/cf.js");
    const out = "API endpoint:   https://api.example.com\norg: foo\nspace: bar\n";
    const parsed = cf.parseCurrentCfTarget(out);
    expect(parsed).toEqual({
      apiEndpoint: "https://api.example.com",
      orgName: "foo",
      spaceName: "bar",
    });
    expect(parsed).not.toHaveProperty("regionKey");
  });

  it("returns undefined for incomplete cf target output", async () => {
    const cf = await import("../../src/cf.js");
    expect(cf.parseCurrentCfTarget("API endpoint: x\n")).toBeUndefined();
    expect(cf.parseCurrentCfTarget("org: o\nspace: s\n")).toBeUndefined();
    expect(cf.parseCurrentCfTarget("")).toBeUndefined();
  });

  it("readCurrentCfTarget returns undefined on exec failure (no target set)", async () => {
    const cf = await import("../../src/cf.js");
    const result = await cf.readCurrentCfTarget({ command: "/non/existent/cf" });
    expect(result).toBeUndefined();
  });

  it("readCurrentCfTarget succeeds and maps region when fake cf target outputs complete info", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const os = await import("node:os");
    const cf = await import("../../src/cf.js");
    const root = path.join(os.tmpdir(), `cf-live-trace-read-current-${Date.now()}`);
    const fake = path.join(root, "fake-target-cf.mjs");
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(fake, [
      "#!/usr/bin/env node",
      "process.stdout.write('API endpoint:   https://api.cf.eu10.hana.ondemand.com\\n');",
      "process.stdout.write('org:            test-org\\n');",
      "process.stdout.write('space:          prod\\n');",
    ].join("\n"));
    await fs.chmod(fake, 0o755);
    try {
      const result = await cf.readCurrentCfTarget({ command: fake });
      expect(result).toEqual({
        apiEndpoint: "https://api.cf.eu10.hana.ondemand.com",
        regionKey: "eu10",
        orgName: "test-org",
        spaceName: "prod",
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
