import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ensurePrivateDirectorySync,
  readJsonFileSync,
  resolveSaptoolsRoot,
  SAPTOOLS_DIR_NAME,
  writeFileAtomicSync,
} from "../../src/saptools-paths.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "core-paths-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("resolveSaptoolsRoot", () => {
  it("prefers an explicit root, then SAPTOOLS_ROOT, then ~/.saptools", () => {
    expect(resolveSaptoolsRoot("/explicit", { SAPTOOLS_ROOT: "/from-env" })).toBe("/explicit");
    expect(resolveSaptoolsRoot(undefined, { SAPTOOLS_ROOT: "/from-env" })).toBe("/from-env");
    expect(resolveSaptoolsRoot("", { SAPTOOLS_ROOT: "" })).toBe(join(homedir(), SAPTOOLS_DIR_NAME));
  });
});

describe("ensurePrivateDirectorySync", () => {
  it("creates nested directories with a private mode and is idempotent", async () => {
    const directory = join(root, "a", "b");
    ensurePrivateDirectorySync(directory);
    ensurePrivateDirectorySync(directory);
    if (process.platform !== "win32") {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
    }
  });
});

describe("writeFileAtomicSync", () => {
  it("writes the content with the requested mode and leaves no temp file behind", async () => {
    const path = join(root, "state.json");
    writeFileAtomicSync(path, "{}\n");
    writeFileAtomicSync(path, '{"v":2}\n');
    expect(await readFile(path, "utf8")).toBe('{"v":2}\n');
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
    expect(await readdir(root)).toEqual(["state.json"]);
  });

  it("cleans up its temp file and rethrows when the target directory does not exist", async () => {
    const path = join(root, "missing", "state.json");
    expect(() => {
      writeFileAtomicSync(path, "x");
    }).toThrow();
    expect(await readdir(root)).toEqual([]);
  });
});

describe("readJsonFileSync", () => {
  it("returns parsed JSON, and undefined for a missing or malformed file", () => {
    const path = join(root, "x.json");
    expect(readJsonFileSync(path)).toBeUndefined();
    writeFileAtomicSync(path, '{"a":1}');
    expect(readJsonFileSync(path)).toEqual({ a: 1 });
    writeFileAtomicSync(path, "{oops");
    expect(readJsonFileSync(path)).toBeUndefined();
  });
});
