import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { detectInstallLocation, isUpgradableKind } from "../../src/self-update/install-location.js";

const NAME = "@saptools/demo";

let root: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "core-loc-")));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Lay down `<directory>/package.json` + `<directory>/dist/cli.js` and return the cli path. */
async function installAt(directory: string, name = NAME): Promise<string> {
  await mkdir(join(directory, "dist"), { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({ name, version: "0.6.0" }));
  const cli = join(directory, "dist", "cli.js");
  await writeFile(cli, "");
  return cli;
}

describe("detectInstallLocation", () => {
  it("recognizes an npm global install through its bin symlink and derives the prefix", async () => {
    const prefix = join(root, "prefix");
    const pkg = join(prefix, "lib", "node_modules", "@saptools", "demo");
    const cli = await installAt(pkg);
    await mkdir(join(prefix, "bin"));
    const bin = join(prefix, "bin", "demo");
    await symlink(cli, bin);

    const location = detectInstallLocation({ binPath: bin, packageName: NAME, platform: "darwin", env: {} });
    expect(location).toMatchObject({ kind: "npm-global", prefix, packageDirectory: pkg, writable: true });
    expect(location.detail).toContain(prefix);
    expect(isUpgradableKind(location.kind)).toBe(true);
  });

  it("handles an unscoped package in the npm global layout", async () => {
    const prefix = join(root, "prefix");
    const cli = await installAt(join(prefix, "lib", "node_modules", "demo"), "demo");
    expect(detectInstallLocation({ binPath: cli, packageName: "demo", platform: "linux", env: {} })).toMatchObject({ kind: "npm-global", prefix });
  });

  it("is not writable when any touched directory is read-only", async () => {
    const prefix = join(root, "usr");
    const cli = await installAt(join(prefix, "lib", "node_modules", "@saptools", "demo"));
    const location = detectInstallLocation({
      binPath: cli,
      packageName: NAME,
      platform: "linux",
      env: {},
      isWritable: (path) => path !== join(prefix, "bin"),
    });
    expect(location).toMatchObject({ kind: "npm-global", writable: false });
  });

  it("treats a repository checkout or a linked package as local", async () => {
    const cli = await installAt(join(root, "repo", "packages", "demo"));
    const location = detectInstallLocation({ binPath: cli, packageName: NAME, platform: "darwin", env: {} });
    expect(location).toMatchObject({ kind: "local", writable: false });
    expect(isUpgradableKind(location.kind)).toBe(false);
  });

  it("treats a project-local node_modules as local, not as a global install", async () => {
    const cli = await installAt(join(root, "project", "node_modules", "@saptools", "demo"));
    expect(detectInstallLocation({ binPath: cli, packageName: NAME, platform: "darwin", env: {} }).kind).toBe("local");
  });

  it("recognizes the npx cache and pnpm dlx as ephemeral", async () => {
    const npx = await installAt(join(root, ".npm", "_npx", "0123abcd", "node_modules", "@saptools", "demo"));
    expect(detectInstallLocation({ binPath: npx, packageName: NAME, platform: "darwin", env: {} }).kind).toBe("npx");
    const dlx = await installAt(join(root, ".cache", "pnpm", "dlx", "abc", "node_modules", "@saptools", "demo"));
    expect(detectInstallLocation({ binPath: dlx, packageName: NAME, platform: "linux", env: {} }).kind).toBe("npx");
    const dlxTemp = await installAt(join(root, "dlx-8f2a", "node_modules", "@saptools", "demo"));
    expect(detectInstallLocation({ binPath: dlxTemp, packageName: NAME, platform: "linux", env: {} }).kind).toBe("npx");
  });

  it("recognizes pnpm, yarn, bun and volta global layouts", async () => {
    const pnpm = await installAt(join(root, "Library", "pnpm", "global", "5", ".pnpm", "@saptools+demo@0.6.0", "node_modules", "@saptools", "demo"));
    expect(detectInstallLocation({ binPath: pnpm, packageName: NAME, platform: "darwin", env: {} })).toMatchObject({ kind: "pnpm-global", writable: true });

    const pnpmHome = join(root, "custom-pnpm");
    const viaHome = await installAt(join(pnpmHome, "global", "5", "node_modules", "@saptools", "demo"));
    expect(detectInstallLocation({ binPath: viaHome, packageName: NAME, platform: "linux", env: { PNPM_HOME: `${pnpmHome}/` } }).kind).toBe("pnpm-global");

    const yarn = await installAt(join(root, ".config", "yarn", "global", "node_modules", "@saptools", "demo"));
    expect(detectInstallLocation({ binPath: yarn, packageName: NAME, platform: "linux", env: {} }).kind).toBe("yarn-global");

    const bun = await installAt(join(root, ".bun", "install", "global", "node_modules", "@saptools", "demo"));
    expect(detectInstallLocation({ binPath: bun, packageName: NAME, platform: "linux", env: {} }).kind).toBe("bun-global");

    const volta = await installAt(join(root, ".volta", "tools", "image", "packages", "demo", "lib", "node_modules", "@saptools", "demo"));
    expect(detectInstallLocation({ binPath: volta, packageName: NAME, platform: "darwin", env: {} }).kind).toBe("volta");
  });

  it("recognizes the Windows npm global layout by its prefix directory name", async () => {
    const prefix = join(root, "AppData", "Roaming", "npm");
    const cli = await installAt(join(prefix, "node_modules", "@saptools", "demo"));
    expect(detectInstallLocation({ binPath: cli, packageName: NAME, platform: "win32", env: {} })).toMatchObject({ kind: "npm-global", prefix, writable: true });
    const other = await installAt(join(root, "somewhere", "node_modules", "@saptools", "demo"));
    expect(detectInstallLocation({ binPath: other, packageName: NAME, platform: "win32", env: {} }).kind).toBe("local");
  });

  it("returns unknown when the bin cannot be resolved or belongs to no matching package", async () => {
    const missing = detectInstallLocation({ binPath: join(root, "nope"), packageName: NAME, platform: "darwin", env: {} });
    expect(missing).toMatchObject({ kind: "unknown", writable: false, packageDirectory: undefined });
    expect(missing.detail).toContain("cannot resolve");

    const foreign = await installAt(join(root, "prefix", "lib", "node_modules", "@saptools", "other"), "@saptools/other");
    const wrongName = detectInstallLocation({ binPath: foreign, packageName: NAME, platform: "darwin", env: {} });
    expect(wrongName.kind).toBe("unknown");
    expect(wrongName.detail).toContain("no package.json for @saptools/demo");
  });
});
