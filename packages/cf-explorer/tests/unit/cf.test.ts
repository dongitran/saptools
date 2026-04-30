import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  cfApp,
  cfEnableSsh,
  cfRestartApp,
  cfSshEnabled,
  cfSshOneShot,
  internals,
  isSshDisabledMessage,
  prepareCfCliSession,
  runCfCommand,
  spawnPersistentSshShell,
} from "../../src/cf.js";

describe("CF command runner", () => {
  let cfHomeDir: string;

  beforeEach(async () => {
    cfHomeDir = await mkdtemp(join(tmpdir(), "cf-explorer-cf-"));
  });

  afterEach(async () => {
    await rm(cfHomeDir, { recursive: true, force: true });
  });

  it("strips SAP credentials from normal child-process environments", () => {
    const env = internals.buildChildEnv({
      cfHomeDir,
      env: { SAP_EMAIL: "user@example.com", SAP_PASSWORD: "secret", KEEP_ME: "yes" },
    });
    expect(env["SAP_EMAIL"]).toBeUndefined();
    expect(env["SAP_PASSWORD"]).toBeUndefined();
    expect(env["KEEP_ME"]).toBe("yes");
    expect(env["CF_HOME"]).toBe(cfHomeDir);
  });

  it("does not include generated remote SSH scripts in command descriptions", () => {
    const description = internals.describeCfCommand([
      "ssh",
      "demo-app",
      "--process",
      "web",
      "-i",
      "0",
      "-c",
      "CFX_TEXT='private-needle'",
    ]);
    expect(description).toBe("cf ssh demo-app --process web -i 0 -c [remote script]");
    expect(description).not.toContain("private-needle");
  });

  it("runs local commands through argument arrays", async () => {
    const result = await runCfCommand(["--version"], { cfBin: process.execPath, cfHomeDir });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(process.version);
  });

  it("prepares CF CLI sessions with scoped auth credentials", async () => {
    const cfBin = await writeFakeCf();
    const prepared = await prepareCfCliSession(
      {
        region: "custom",
        org: "org",
        space: "dev",
        app: "demo-app",
        apiEndpoint: "https://api.example.test",
      },
      cfHomeDir,
      {
        cfBin,
        credentials: { email: "user@example.com", password: "secret" },
      },
    );
    expect(prepared.context.credentials?.email).toBe("user@example.com");
  });

  it("wraps CF app, SSH, and lifecycle commands", async () => {
    const cfBin = await writeFakeCf();
    const context = { cfBin, cfHomeDir };
    await expect(cfApp({ region: "ap10", org: "org", space: "dev", app: "demo-app" }, context))
      .resolves.toContain("instances: 1/1");
    await expect(cfSshEnabled({ region: "ap10", org: "org", space: "dev", app: "demo-app" }, context))
      .resolves.toBe(true);
    await expect(cfEnableSsh({ region: "ap10", org: "org", space: "dev", app: "demo-app" }, context))
      .resolves.toBeUndefined();
    await expect(cfRestartApp({ region: "ap10", org: "org", space: "dev", app: "demo-app" }, context))
      .resolves.toBeUndefined();
    await expect(cfSshOneShot(
      { region: "ap10", org: "org", space: "dev", app: "demo-app" },
      "printf ok",
      context,
      "web",
      0,
    )).resolves.toMatchObject({ stdout: "remote ok\n" });
  });

  it("spawns persistent SSH shells with argument arrays", async () => {
    const cfBin = await writeFakeCf();
    const child = spawnPersistentSshShell(
      { region: "ap10", org: "org", space: "dev", app: "demo-app" },
      { cfBin, cfHomeDir },
      "web",
      0,
    );
    const closed = new Promise<void>((resolve) => {
      child.once("close", () => {
        resolve();
      });
    });
    child.kill("SIGTERM");
    await closed;
    expect(child.pid).toBeGreaterThan(0);
  });

  it("recognizes common disabled-SSH messages", () => {
    expect(isSshDisabledMessage("SSH support is disabled")).toBe(true);
    expect(isSshDisabledMessage("not authorized")).toBe(true);
    expect(isSshDisabledMessage("all good")).toBe(false);
  });

  it("maps CF command failures to typed redacted errors", async () => {
    const cfBin = await writeFailingCf();
    await expect(runCfCommand(
      ["auth"],
      {
        cfBin,
        cfHomeDir,
        credentials: { email: "user@example.com", password: "secret" },
        env: { CF_PASSWORD: "secret" },
      },
    )).rejects.toMatchObject({
      code: "CF_LOGIN_FAILED",
      message: expect.not.stringContaining("secret"),
    });
    await expect(runCfCommand(["app", "missing"], { cfBin, cfHomeDir }))
      .rejects.toMatchObject({ code: "APP_NOT_FOUND" });
    await expect(runCfCommand(["target", "-o", "org"], { cfBin, cfHomeDir }))
      .rejects.toMatchObject({ code: "CF_TARGET_FAILED" });
    await expect(runCfCommand(["ssh", "demo-app"], { cfBin, cfHomeDir }))
      .rejects.toMatchObject({ code: "SSH_DISABLED" });
  });

  it("handles truncation, aborts, timeouts, and spawn errors", async () => {
    const cfBin = await writeFakeCf();
    await expect(runCfCommand(["big"], { cfBin, cfHomeDir }, { maxBytes: 4 }))
      .resolves.toMatchObject({ stdout: "0123", truncated: true });
    await expect(runCfCommand(["unicode"], { cfBin, cfHomeDir }, { maxBytes: 4 }))
      .resolves.toMatchObject({ stdout: "éé", truncated: true });

    const controller = new AbortController();
    const aborted = runCfCommand(["hang"], { cfBin, cfHomeDir, signal: controller.signal });
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ code: "ABORTED" });

    await expect(runCfCommand(["hang"], { cfBin, cfHomeDir }, { timeoutMs: 5 }))
      .rejects.toMatchObject({ code: "REMOTE_COMMAND_FAILED" });
    await expect(runCfCommand(["--version"], { cfBin: join(cfHomeDir, "missing-bin"), cfHomeDir }))
      .rejects.toMatchObject({ code: "REMOTE_COMMAND_FAILED" });
  });

  it("describes auth and generic commands without leaking auth arguments", () => {
    expect(internals.describeCfCommand(["auth"])).toBe("cf auth");
    expect(internals.describeCfCommand(["target", "-o", "org"])).toBe("cf target -o org");
    expect(internals.resolveSpawnCommand({
      cfHomeDir,
      env: { CF_EXPLORER_CF_BIN: "custom-cf" },
    })).toEqual({ bin: "custom-cf", argsPrefix: [] });
    expect(internals.resolveSpawnCommand({
      cfBin: "/tmp/fake-cf.mjs",
      cfHomeDir,
    })).toEqual({ bin: process.execPath, argsPrefix: ["/tmp/fake-cf.mjs"] });
  });

  async function writeFakeCf(): Promise<string> {
    const path = join(cfHomeDir, "fake-cf.mjs");
    await writeFile(path, [
      "const command = process.argv[2];",
      "if (command === 'api' || command === 'auth' || command === 'target') process.stdout.write('OK\\n');",
      "else if (command === 'app') process.stdout.write('instances: 1/1\\n#0 running today\\n');",
      "else if (command === 'ssh-enabled') process.stdout.write('SSH support is enabled\\n');",
      "else if (command === 'enable-ssh' || command === 'restart') process.stdout.write('OK\\n');",
      "else if (command === 'ssh' && process.argv.at(-1) === 'sh') setInterval(() => {}, 1000);",
      "else if (command === 'ssh') process.stdout.write('remote ok\\n');",
      "else if (command === 'big') process.stdout.write('0123456789');",
      "else if (command === 'unicode') process.stdout.write('ééé');",
      "else if (command === 'hang') setInterval(() => {}, 1000);",
      "else process.exit(2);",
    ].join("\n"), "utf8");
    return path;
  }

  async function writeFailingCf(): Promise<string> {
    const path = join(cfHomeDir, "failing-cf.mjs");
    await writeFile(path, [
      "const command = process.argv[2];",
      "if (command === 'auth') { process.stderr.write(`login failed ${process.env.CF_PASSWORD}\\n`); process.exit(1); }",
      "if (command === 'app') { process.stderr.write('App not found\\n'); process.exit(1); }",
      "if (command === 'target') { process.stderr.write('target failed\\n'); process.exit(1); }",
      "if (command === 'ssh') { process.stderr.write('SSH support is disabled\\n'); process.exit(1); }",
      "process.exit(2);",
    ].join("\n"), "utf8");
    return path;
  }
});
