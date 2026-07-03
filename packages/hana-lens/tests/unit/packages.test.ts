import { mkdtemp, readlink, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { autoLinkPackages, normalizePackagePrefix, packageScope, scanForPackages } from "../../src/packages.js";
import { expect } from "../helpers/expect.js";
import { describe, it } from "../helpers/test.js";

describe("package scanning and linking", () => {
  it("validates scoped prefixes and extracts npm scopes", () => {
    expect(normalizePackagePrefix("@demo")).toBe("@demo/");
    expect(normalizePackagePrefix(" @demo/ ")).toBe("@demo/");
    expect(packageScope("@demo/")).toBe("@demo");
    expect(() => normalizePackagePrefix("@demo/tools")).toThrow("package scope");
    expect(() => packageScope("demo/")).toThrow("scoped package prefix");
  });
  it("finds prefixed packages and ignores generated folders", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hana-lens-"));
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "root" }));
    await writeFile(path.join(root, "broken.json"), "{");
    await fsMkdir(path.join(root, "packages", "a"));
    await writeFile(path.join(root, "packages", "a", "package.json"), JSON.stringify({ name: "@demo/a" }));
    await fsMkdir(path.join(root, "gen", "b"));
    await writeFile(path.join(root, "gen", "b", "package.json"), JSON.stringify({ name: "@demo/b" }));
    await expect(scanForPackages(root, "@demo/")).resolves.toEqual([{ name: "@demo/a", directory: path.join(root, "packages", "a") }]);
    await rm(root, { recursive: true, force: true });
  });

  it("throws deterministic errors for malformed package JSON", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hana-lens-malformed-"));
    await fsMkdir(path.join(root, "bad"));
    await writeFile(path.join(root, "bad", "package.json"), "{");
    await expect(scanForPackages(root, "@demo/")).rejects.toThrow("Malformed package.json");
    await rm(root, { recursive: true, force: true });
  });

  it("returns an empty package list for missing workspaces", async () => {
    await expect(scanForPackages(path.join(os.tmpdir(), "hana-lens-does-not-exist"), "@demo/")).resolves.toEqual([]);
  });

  it("rejects existing non-symlink paths instead of hiding auto-link conflicts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hana-lens-link-conflict-"));
    const a = path.join(root, "a");
    const b = path.join(root, "b");
    await fsMkdir(path.join(a, "node_modules", "@demo", "b"));
    await fsMkdir(b);
    await expect(autoLinkPackages([{ name: "@demo/a", directory: a }, { name: "@demo/b", directory: b }], "@demo/")).rejects.toThrow("path already exists and is not a symlink");
    await rm(root, { recursive: true, force: true });
  });

  it("replaces broken symlinks while preserving real directories", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hana-lens-link-"));
    const a = path.join(root, "a");
    const b = path.join(root, "b");
    await fsMkdir(path.join(a, "node_modules", "@demo"));
    await fsMkdir(b);
    await symlink(path.join(root, "missing"), path.join(a, "node_modules", "@demo", "b"), "dir");
    await autoLinkPackages([{ name: "@demo/a", directory: a }, { name: "@demo/b", directory: b }], "@demo/");
    await expect(readlink(path.join(a, "node_modules", "@demo", "b"))).resolves.toBe(b);
    await rm(root, { recursive: true, force: true });
  });
});

async function fsMkdir(directory: string): Promise<void> {
  await import("node:fs/promises").then(async ({ mkdir }) => await mkdir(directory, { recursive: true }));
}
