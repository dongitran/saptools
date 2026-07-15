import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock } from "node:test";

import { cachePath, mergeCompileResults, readCache, writeCache } from "../../src/cache.js";
import { describeEntity } from "../../src/describe.js";
import { applyCacheKindFilter, CACHE_KINDS, parseCacheKind } from "../../src/scope.js";
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

describe("cache kind scope", () => {
  const mixedResult = {
    packageName: "@acme/model",
    via: "cds",
    definitions: {
      "acme.Inventory": { kind: "entity", elements: { ID: { key: true, type: "cds.UUID" } } },
      "acme.ExistingInventory": { kind: "entity", "@cds.persistence.exists": true },
      "acme.InventoryView": { kind: "entity", query: { SELECT: { from: { ref: ["acme.Inventory"] } } } },
      "acme.InventoryProjection": { kind: "entity", projection: { from: { ref: ["acme.Inventory"] } } },
      "remote.Inventory": { kind: "entity", "@cds.external": true },
      "acme.TransientInventory": { kind: "entity", "@cds.persistence.skip": true },
      "acme.InventoryCode": { kind: "type", type: "cds.String" },
      "acme.managed": { kind: "aspect", elements: { createdAt: { type: "cds.Timestamp" } } },
      "acme.InventoryService": { kind: "service" },
      "acme.restock": { kind: "action" },
      "acme.stockLevel": { kind: "function" },
      "acme.Model": { kind: "context" },
    },
  } as const;

  it("defaults to db and validates explicit cache kinds", () => {
    expect(parseCacheKind(undefined)).toBe(CACHE_KINDS.DB);
    expect(parseCacheKind("db")).toBe(CACHE_KINDS.DB);
    expect(parseCacheKind("service")).toBe(CACHE_KINDS.SERVICE);
    expect(parseCacheKind("all")).toBe(CACHE_KINDS.ALL);
    expect(() => parseCacheKind("bogus")).toThrow('--kind must be one of db|service|all (got "bogus")');
  });

  it("classifies persistence, service-layer, support, and container definitions by CAP semantics", () => {
    const db = applyCacheKindFilter([mixedResult], CACHE_KINDS.DB);
    const service = applyCacheKindFilter([mixedResult], CACHE_KINDS.SERVICE);
    const all = applyCacheKindFilter([mixedResult], CACHE_KINDS.ALL);

    expect(Object.keys(db[0]?.definitions ?? {})).toEqual([
      "acme.Inventory",
      "acme.ExistingInventory",
      "acme.InventoryCode",
      "acme.managed",
    ]);
    expect(Object.keys(service[0]?.definitions ?? {})).toEqual([
      "acme.InventoryView",
      "acme.InventoryProjection",
      "remote.Inventory",
      "acme.TransientInventory",
      "acme.InventoryCode",
      "acme.managed",
      "acme.InventoryService",
      "acme.restock",
      "acme.stockLevel",
    ]);
    expect(Object.keys(all[0]?.definitions ?? {})).toEqual(Object.keys(mixedResult.definitions));
    expect(all[0]?.packageName).toBe("@acme/model");
    expect(all[0]?.via).toBe("cds");
  });

  it("uses the global service list and dotted ancestors without package-name heuristics", () => {
    const results = [
      {
        packageName: "@acme/service-declarations",
        via: "cds",
        definitions: { "acme.api.InventoryService": { kind: "service" } },
      },
      {
        packageName: "@acme/srv_inventory",
        via: "cds",
        definitions: {
          "acme.api.InventoryService.Stock": { kind: "entity" },
          "acme.api.InventoryService.Code": { kind: "type", type: "cds.String" },
          "acme.api.InventoryService.Container": { kind: "context" },
          "acme.api.InventoryService2.Stock": { kind: "entity" },
          "acme.common.Code": { kind: "type", type: "cds.String" },
        },
      },
    ] as const;

    expect(applyCacheKindFilter(results, CACHE_KINDS.DB).map((result) => Object.keys(result.definitions))).toEqual([
      [],
      ["acme.api.InventoryService2.Stock", "acme.common.Code"],
    ]);
    expect(applyCacheKindFilter(results, CACHE_KINDS.SERVICE).map((result) => Object.keys(result.definitions))).toEqual([
      ["acme.api.InventoryService"],
      [
        "acme.api.InventoryService.Stock",
        "acme.api.InventoryService.Code",
        "acme.api.InventoryService.Container",
        "acme.common.Code",
      ],
    ]);
  });

  it("keeps persistence association targets reference-closed for describe expansion", () => {
    const scoped = applyCacheKindFilter([{
      packageName: "@acme/db_inventory",
      via: "cds",
      definitions: {
        "acme.Stock": { kind: "entity", elements: { location: { type: "cds.Association", target: "acme.Location" } } },
        "acme.Location": { kind: "entity", elements: { ID: { key: true, type: "cds.UUID" } } },
        "acme.StockService": { kind: "service" },
      },
    } as const], CACHE_KINDS.DB);
    const output = describeEntity(mergeCompileResults(scoped), "acme.Stock", true);

    expect(output).toContain("location: cds.Association to acme.Location");
    expect(output).toContain("- [PK] ID: cds.UUID");
    expect(output.includes("missing")).toBe(false);
  });
});
