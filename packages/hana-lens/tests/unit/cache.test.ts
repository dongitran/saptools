import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock } from "node:test";

import { cachePath, mergeCompileResults, readCache, writeCache } from "../../src/cache.js";
import type { HanaLensCsn } from "../../src/types.js";
import { expect } from "../helpers/expect.js";
import { describe, it } from "../helpers/test.js";

interface MergeCapture {
  readonly ast: HanaLensCsn;
  readonly stderr: string;
}

function mergeWithStderr(results: Parameters<typeof mergeCompileResults>[0], strict = false): MergeCapture {
  const chunks: string[] = [];
  const stderrWrite = mock.method(process.stderr, "write", (chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  try {
    return { ast: mergeCompileResults(results, strict), stderr: chunks.join("") };
  } finally {
    stderrWrite.mock.restore();
  }
}

describe("cache IO", () => {
  it("writes minified JSON and reads validated CSN", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hana-lens-cache-"));
    const results = [{ packageName: "@acme/a", definitions: { Entity: { kind: "entity", "@hanaLens.packageName": "@acme/a" } }, via: "cds" }] as const;
    await writeCache(root, results);
    const raw = await readFile(cachePath(root), "utf8");
    expect(raw).toBe(JSON.stringify({ definitions: { Entity: { kind: "entity", "@hanaLens.packageName": "@acme/a" } } }));
    await expect(readCache(root)).resolves.toEqual({ definitions: { Entity: { kind: "entity", "@hanaLens.packageName": "@acme/a" } } });
    await writeCache(root, results);
    expect(await readFile(cachePath(root), "utf8")).toBe(raw);
    await rm(root, { recursive: true, force: true });
  });

  it("rejects malformed cache JSON", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hana-lens-bad-cache-"));
    await writeFile(cachePath(root), "{");
    await expect(readCache(root)).rejects.toThrow("malformed JSON");
    await rm(root, { recursive: true, force: true });
  });

  it("silently collapses identical shared definitions with first-owner metadata", () => {
    const results = [
      { packageName: "@acme/db_alpha", definitions: { "acme.common.Managed": { kind: "aspect", "@hanaLens.packageName": "@acme/db_alpha", elements: { ID: { key: true, type: "cds.UUID" } } } }, via: "cds" },
      { packageName: "@acme/srv_alpha", definitions: { "acme.common.Managed": { kind: "aspect", "@hanaLens.packageName": "@acme/srv_alpha", elements: { ID: { key: true, type: "cds.UUID" } } } }, via: "cds" },
    ] as const;
    const result = mergeWithStderr(results);
    const strictResult = mergeWithStderr(results, true);

    expect(Object.keys(result.ast.definitions)).toEqual(["acme.common.Managed"]);
    expect(result.ast.definitions["acme.common.Managed"]?.["@hanaLens.packageName"]).toBe("@acme/db_alpha");
    expect(result.stderr).toBe("");
    expect(strictResult.ast).toEqual(result.ast);
    expect(strictResult.stderr).toBe("");
  });

  it("warns on different definitions and keeps persistence over a projection", () => {
    const projection = {
      kind: "entity",
      query: { SELECT: { from: { ref: ["acme.Inventory"] } } },
      "@hanaLens.packageName": "@acme/srv_inventory",
      elements: { ID: { key: true, type: "cds.UUID" } },
    };
    const persistence = {
      kind: "entity",
      "@hanaLens.packageName": "@acme/db_inventory",
      elements: { ID: { key: true, type: "cds.UUID" }, quantity: { type: "cds.Integer" } },
    };

    const result = mergeWithStderr([
      { packageName: "@acme/srv_inventory", definitions: { "acme.Inventory": projection }, via: "cds" },
      { packageName: "@acme/db_inventory", definitions: { "acme.Inventory": persistence }, via: "cds" },
    ]);

    expect(result.ast.definitions["acme.Inventory"]?.["@hanaLens.packageName"]).toBe("@acme/db_inventory");
    expect(result.stderr).toContain("WARNING: 1 definition name(s) defined differently in >1 package");
    expect(result.stderr).toContain("acme.Inventory (@acme/srv_inventory vs @acme/db_inventory)");

    const persistenceFirst = mergeWithStderr([
      { packageName: "@acme/db_inventory", definitions: { "acme.Inventory": persistence }, via: "cds" },
      { packageName: "@acme/srv_inventory", definitions: { "acme.Inventory": projection }, via: "cds" },
    ]);
    expect(persistenceFirst.ast.definitions["acme.Inventory"]?.["@hanaLens.packageName"]).toBe("@acme/db_inventory");
  });

  it("detects length-only conflicts in strict mode without warning", () => {
    const results = [
      { packageName: "@acme/db_one", definitions: { "acme.Shared": { kind: "entity", elements: { code: { key: true, type: "cds.String", length: 10 } } } }, via: "cds" },
      { packageName: "@acme/db_two", definitions: { "acme.Shared": { kind: "entity", elements: { code: { key: true, type: "cds.String", length: 20 } } } }, via: "cds" },
    ] as const;
    const chunks: string[] = [];
    const stderrWrite = mock.method(process.stderr, "write", (chunk: string | Uint8Array): boolean => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    });
    try {
      expect(() => mergeCompileResults(results, true)).toThrow("Strict mode: 1 conflicting definition name(s): acme.Shared (@acme/db_one vs @acme/db_two)");
      expect(chunks.join("")).toBe("");
    } finally {
      stderrWrite.mock.restore();
    }
  });
});
