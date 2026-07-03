import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { cachePath, mergeCompileResults, readCache, writeCache } from "../../src/cache.js";
import { expect } from "../helpers/expect.js";
import { describe, it } from "../helpers/test.js";

describe("cache IO", () => {
  it("writes minified JSON and reads validated CSN", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hana-lens-cache-"));
    await writeCache(root, [{ packageName: "@demo/a", definitions: { Entity: { kind: "entity", "@hanaLens.packageName": "@demo/a" } } }]);
    const raw = await readFile(cachePath(root), "utf8");
    expect(raw).toBe(JSON.stringify({ definitions: { Entity: { kind: "entity", "@hanaLens.packageName": "@demo/a" } } }));
    await expect(readCache(root)).resolves.toEqual({ definitions: { Entity: { kind: "entity", "@hanaLens.packageName": "@demo/a" } } });
    await rm(root, { recursive: true, force: true });
  });

  it("rejects malformed cache JSON and duplicate definitions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hana-lens-bad-cache-"));
    await writeFile(cachePath(root), "{");
    await expect(readCache(root)).rejects.toThrow("malformed JSON");
    expect(() => mergeCompileResults([
      { packageName: "@demo/a", definitions: { Entity: { kind: "entity" } } },
      { packageName: "@demo/b", definitions: { Entity: { kind: "entity" } } },
    ])).toThrow("Duplicate CSN definition Entity from @demo/a and @demo/b");
    await rm(root, { recursive: true, force: true });
  });
});
