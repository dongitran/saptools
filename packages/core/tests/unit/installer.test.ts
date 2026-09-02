import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import type { InstallLocation } from "../../src/self-update/install-location.js";
import { buildInstallCommand, manualInstallCommand, runInstall } from "../../src/self-update/installer.js";
import type { SpawnLike } from "../../src/self-update/process-types.js";

const NPM_GLOBAL: InstallLocation = {
  kind: "npm-global",
  packageDirectory: "/opt/homebrew/lib/node_modules/@saptools/demo",
  prefix: "/opt/homebrew",
  writable: true,
  detail: "npm global install under /opt/homebrew",
};

function location(kind: InstallLocation["kind"]): InstallLocation {
  return { ...NPM_GLOBAL, kind, prefix: kind === "npm-global" ? NPM_GLOBAL.prefix : undefined };
}

class FakeChild extends EventEmitter {
  readonly stderr = new EventEmitter();
  readonly signals: NodeJS.Signals[] = [];
  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal ?? "SIGTERM");
    queueMicrotask(() => {
      this.emit("close", null, signal ?? "SIGTERM");
    });
    return true;
  }
}

interface SpawnCall {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: Parameters<SpawnLike>[2];
}

function fakeSpawn(script: (child: FakeChild) => void): { spawnImpl: SpawnLike; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const spawnImpl: SpawnLike = (file, args, options) => {
    calls.push({ file, args, options });
    const child = new FakeChild();
    queueMicrotask(() => {
      script(child);
    });
    return child as unknown as ChildProcess;
  };
  return { spawnImpl, calls };
}

describe("manualInstallCommand", () => {
  it("names the package manager that owns the install, defaulting to npm", () => {
    expect(manualInstallCommand("npm-global", "x@1")).toBe("npm install -g x@1");
    expect(manualInstallCommand("pnpm-global", "x@1")).toBe("pnpm add -g x@1");
    expect(manualInstallCommand("yarn-global", "x@1")).toBe("yarn global add x@1");
    expect(manualInstallCommand("bun-global", "x@1")).toBe("bun add -g x@1");
    expect(manualInstallCommand("volta", "x@1")).toBe("volta install x@1");
    expect(manualInstallCommand("local", "x@1")).toBe("npm install -g x@1");
    expect(manualInstallCommand("npx", "x@1")).toBe("npm install -g x@1");
    expect(manualInstallCommand("unknown", "x@1")).toBe("npm install -g x@1");
  });
});

describe("buildInstallCommand", () => {
  const base = { packageName: "@saptools/demo", version: "0.7.0", registryUrl: "https://registry.example", platform: "darwin" as const };

  it("runs the npm-cli.js beside the current node through that node, pinned to the exact version, prefix and registry", () => {
    const command = buildInstallCommand({
      ...base,
      location: NPM_GLOBAL,
      execPath: "/opt/homebrew/Cellar/node/25.9.0/bin/node",
      exists: (path) => path === "/opt/homebrew/Cellar/node/25.9.0/bin/npm",
      realpath: () => "/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js",
    });
    expect(command).toEqual({
      file: "/opt/homebrew/Cellar/node/25.9.0/bin/node",
      args: [
        "/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js",
        "install",
        "--global",
        "--prefix",
        "/opt/homebrew",
        "@saptools/demo@0.7.0",
        "--registry",
        "https://registry.example",
        "--no-fund",
        "--no-audit",
        "--no-update-notifier",
        "--loglevel=error",
      ],
      display: "npm install -g @saptools/demo@0.7.0",
    });
  });

  it("runs a native npm launcher directly, and falls back to npm on PATH when nothing sits beside node", () => {
    const native = buildInstallCommand({ ...base, location: NPM_GLOBAL, execPath: "/usr/bin/node", exists: () => true, realpath: () => "/usr/lib/npm-launcher" });
    expect(native?.file).toBe("/usr/lib/npm-launcher");
    expect(native?.args[0]).toBe("install");

    const onPath = buildInstallCommand({ ...base, location: NPM_GLOBAL, execPath: "/usr/bin/node", exists: () => false, realpath: () => "" });
    expect(onPath?.file).toBe("npm");

    const dangling = buildInstallCommand({
      ...base,
      location: NPM_GLOBAL,
      execPath: "/usr/bin/node",
      exists: () => true,
      realpath: () => {
        throw new Error("ENOENT");
      },
    });
    expect(dangling?.file).toBe("npm");
  });

  it("on Windows only uses the bundled npm-cli.js, since .cmd shims need a shell", () => {
    const found = buildInstallCommand({ ...base, platform: "win32", location: { ...NPM_GLOBAL, prefix: "C:/npm" }, execPath: "C:/nodejs/node.exe", exists: () => true, realpath: (p) => p });
    expect(found).toMatchObject({ file: "C:/nodejs/node.exe" });
    expect(found?.args[0]).toBe("C:/nodejs/node_modules/npm/bin/npm-cli.js");
    expect(buildInstallCommand({ ...base, platform: "win32", location: { ...NPM_GLOBAL, prefix: "C:/npm" }, execPath: "C:/nodejs/node.exe", exists: () => false, realpath: (p) => p })).toBeUndefined();
  });

  it("refuses an npm-global location without a prefix", () => {
    expect(buildInstallCommand({ ...base, location: { ...NPM_GLOBAL, prefix: undefined } })).toBeUndefined();
  });

  it("builds the other package managers' commands and refuses locations that cannot be upgraded", () => {
    expect(buildInstallCommand({ ...base, location: location("pnpm-global") })).toEqual({ file: "pnpm", args: ["add", "--global", "@saptools/demo@0.7.0"], display: "pnpm add -g @saptools/demo@0.7.0" });
    expect(buildInstallCommand({ ...base, location: location("yarn-global") })?.args).toEqual(["global", "add", "@saptools/demo@0.7.0"]);
    expect(buildInstallCommand({ ...base, location: location("bun-global") })?.file).toBe("bun");
    expect(buildInstallCommand({ ...base, location: location("volta") })?.args).toEqual(["install", "@saptools/demo@0.7.0"]);
    for (const kind of ["npx", "local", "unknown"] as const) {
      expect(buildInstallCommand({ ...base, location: location(kind) })).toBeUndefined();
    }
  });
});

describe("runInstall", () => {
  const command = { file: "npm", args: ["install", "-g", "x"], display: "npm install -g x" };

  it("resolves ok on exit 0 and runs without a shell, without stdin, outside the project, with SAP credentials stripped", async () => {
    const { spawnImpl, calls } = fakeSpawn((child) => {
      child.emit("close", 0, null);
    });
    const result = await runInstall(command, { env: { SAP_EMAIL: "e", SAP_PASSWORD: "p", HOME: "/home/x" }, spawnImpl });
    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.file).toBe("npm");
    expect(call?.options.cwd).toBe(tmpdir());
    expect(call?.options.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(call?.options.shell).toBeUndefined();
    expect(call?.options.env).toEqual({ HOME: "/home/x", SAPTOOLS_AUTO_UPDATE: "off" });
  });

  it("reports the exit code and the last stderr line on failure", async () => {
    const { spawnImpl } = fakeSpawn((child) => {
      child.stderr.emit("data", Buffer.from("npm error code EACCES\nnpm error permission denied\n"));
      child.emit("close", 243, null);
    });
    const result = await runInstall(command, { env: {}, spawnImpl });
    expect(result).toEqual({ ok: false, reason: "npm install -g x exited with code 243: npm error permission denied" });
  });

  it("kills a stalled installer after the timeout and says so", async () => {
    const { spawnImpl } = fakeSpawn(() => {
      // never exits on its own
    });
    const resultPromise = runInstall(command, { env: {}, spawnImpl, timeoutMs: 30 });
    const result = await Promise.race([
      resultPromise,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => {
          reject(new Error("runInstall never resolved"));
        }, 2_000);
      }),
    ]);
    expect(result.ok).toBe(false);
  });

  it("turns a spawn error (npm missing) into a failure instead of an exception", async () => {
    const { spawnImpl } = fakeSpawn((child) => {
      child.emit("error", new Error("spawn npm ENOENT"));
    });
    expect(await runInstall(command, { env: {}, spawnImpl })).toEqual({ ok: false, reason: "npm: spawn npm ENOENT" });

    const throwing: SpawnLike = () => {
      throw new Error("EINVAL");
    };
    expect(await runInstall(command, { env: {}, spawnImpl: throwing })).toEqual({ ok: false, reason: "EINVAL" });
  });

  it("describes a signal death without a stderr suffix", async () => {
    const { spawnImpl } = fakeSpawn((child) => {
      child.emit("close", null, "SIGTERM");
    });
    const result = await runInstall(command, { env: {}, spawnImpl, timeoutMs: 5_000 });
    expect(result).toEqual({ ok: false, reason: "npm install -g x was killed by SIGTERM after 5s" });
  });
});
