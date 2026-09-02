import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { findPackageMetadata, readPackageManifest, readPackageMetadata } from "../../src/package-metadata.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "core-meta-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeManifest(directory: string, body: unknown): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), typeof body === "string" ? body : JSON.stringify(body));
}

describe("readPackageManifest", () => {
  it("returns name, version and directory for a manifest", async () => {
    await writeManifest(root, { name: "@saptools/demo", version: "1.2.3" });
    expect(readPackageManifest(root)).toEqual({ name: "@saptools/demo", version: "1.2.3", directory: root });
  });

  it("returns undefined when the file is missing, malformed, or lacks name/version", async () => {
    expect(readPackageManifest(root)).toBeUndefined();
    await writeManifest(root, "{nope");
    expect(readPackageManifest(root)).toBeUndefined();
    await writeManifest(root, ["array"]);
    expect(readPackageManifest(root)).toBeUndefined();
    await writeManifest(root, { name: "x" });
    expect(readPackageManifest(root)).toBeUndefined();
    await writeManifest(root, { name: "", version: "1.0.0" });
    expect(readPackageManifest(root)).toBeUndefined();
  });
});

describe("findPackageMetadata / readPackageMetadata", () => {
  it("skips a nested dependency's manifest and stops at the package with the expected name", async () => {
    const pkg = join(root, "node_modules", "@saptools", "demo");
    await writeManifest(pkg, { name: "@saptools/demo", version: "0.7.0" });
    await writeManifest(join(pkg, "dist", "vendor"), { name: "some-dep", version: "9.9.9" });
    const start = join(pkg, "dist", "vendor", "chunks");
    await mkdir(start, { recursive: true });
    expect(findPackageMetadata(start, "@saptools/demo")).toEqual({ name: "@saptools/demo", version: "0.7.0", directory: pkg });
    expect(readPackageMetadata(pathToFileURL(join(pkg, "dist", "cli.js")).href, "@saptools/demo").version).toBe("0.7.0");
  });

  it("gives up after a bounded number of levels and throws from readPackageMetadata", async () => {
    await writeManifest(root, { name: "@saptools/demo", version: "0.7.0" });
    const deep = join(root, "1", "2", "3", "4", "5", "6", "7");
    await mkdir(deep, { recursive: true });
    expect(findPackageMetadata(deep, "@saptools/demo")).toBeUndefined();
    expect(() => readPackageMetadata(pathToFileURL(join(deep, "cli.js")).href, "@saptools/demo")).toThrow(/Cannot find the package.json of @saptools\/demo/);
  });

  it("returns undefined at the filesystem root without looping", () => {
    expect(findPackageMetadata("/", "@saptools/never-there")).toBeUndefined();
  });
});
