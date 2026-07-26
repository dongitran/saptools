import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

  it("leaves no .tmp-* artifacts in the workspace directory after a successful write", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hana-lens-cache-clean-"));
    const results = [{ packageName: "@acme/a", definitions: { Entity: { kind: "entity" } }, via: "cds" }] as const;
    await writeCache(root, results);
    const entries = await readdir(root);
    expect(entries.some((entry) => entry.includes(".tmp-"))).toBe(false);
    expect(entries).toEqual([path.basename(cachePath(root))]);
    await rm(root, { recursive: true, force: true });
  });

  it("leaves an existing cache untouched and removes the temp file when the write fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hana-lens-cache-atomic-"));
    const originalResults = [{ packageName: "@acme/a", definitions: { Original: { kind: "entity" } }, via: "cds" }] as const;
    await writeCache(root, originalResults);
    const originalContent = await readFile(cachePath(root), "utf8");

    await chmod(root, 0o500);
    try {
      const nextResults = [{ packageName: "@acme/b", definitions: { Replacement: { kind: "entity" } }, via: "cds" }] as const;
      await expect(writeCache(root, nextResults)).rejects.toThrow();
    } finally {
      await chmod(root, 0o700);
    }

    expect(await readFile(cachePath(root), "utf8")).toBe(originalContent);
    const entries = await readdir(root);
    expect(entries.some((entry) => entry.includes(".tmp-"))).toBe(false);
    await rm(root, { recursive: true, force: true });
  });

  it("removes the temp file when rename fails after the temp write already succeeded", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hana-lens-cache-rename-fail-"));
    const finalPath = cachePath(root);
    // A directory (not a file) at the destination lets writeFile(tempPath, ...) succeed while
    // rename(tempPath, finalPath) genuinely fails with EISDIR -- the other half of the atomic
    // write's failure surface from the "writeFile itself fails" case covered above.
    await mkdir(finalPath);
    await writeFile(path.join(finalPath, "placeholder.txt"), "not empty", "utf8");

    const results = [{ packageName: "@acme/a", definitions: { Entity: { kind: "entity" } }, via: "cds" }] as const;
    await expect(writeCache(root, results)).rejects.toThrow();

    const entries = await readdir(root);
    expect(entries.some((entry) => entry.includes(".tmp-"))).toBe(false);
    expect(entries).toEqual([path.basename(finalPath)]);
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
      expect(() => mergeCompileResults(results, true)).toThrow(
        "Strict mode: 1 definition name(s) defined differently in >1 package (1 conflicting copies): acme.Shared (@acme/db_one vs @acme/db_two)",
      );
      expect(chunks.join("")).toBe("");
    } finally {
      stderrWrite.mock.restore();
    }
  });

  it("keeps the more complete non-projection copy based on element coverage, not arrival order", () => {
    const partial = { kind: "entity", "@hanaLens.packageName": "@acme/db_one", elements: { ID: { key: true, type: "cds.UUID" } } };
    const complete = { kind: "entity", "@hanaLens.packageName": "@acme/db_two", elements: { ID: { key: true, type: "cds.UUID" }, name: { type: "cds.String" } } };

    const partialFirst = mergeWithStderr([
      { packageName: "@acme/db_one", definitions: { "acme.Shared": partial }, via: "cds" },
      { packageName: "@acme/db_two", definitions: { "acme.Shared": complete }, via: "cds" },
    ]);
    expect(partialFirst.ast.definitions["acme.Shared"]?.["@hanaLens.packageName"]).toBe("@acme/db_two");

    const completeFirst = mergeWithStderr([
      { packageName: "@acme/db_two", definitions: { "acme.Shared": complete }, via: "cds" },
      { packageName: "@acme/db_one", definitions: { "acme.Shared": partial }, via: "cds" },
    ]);
    expect(completeFirst.ast.definitions["acme.Shared"]?.["@hanaLens.packageName"]).toBe("@acme/db_two");
  });

  it("breaks a tie between disjoint, equally-sized non-projection copies by content, not arrival order", () => {
    // Neither {A,B} nor {B,C} is a superset of the other -- genuinely incomparable copies of the
    // same FQN. The chosen survivor must be the same regardless of which one is scanned first.
    const alphaCopy = { kind: "entity", "@hanaLens.packageName": "@acme/alpha", elements: { A: { type: "cds.String" }, B: { type: "cds.String" } } };
    const betaCopy = { kind: "entity", "@hanaLens.packageName": "@acme/beta", elements: { B: { type: "cds.String" }, C: { type: "cds.String" } } };

    const alphaFirst = mergeCompileResults([
      { packageName: "@acme/alpha", definitions: { "acme.Shared": alphaCopy }, via: "cds" },
      { packageName: "@acme/beta", definitions: { "acme.Shared": betaCopy }, via: "cds" },
    ]);
    const betaFirst = mergeCompileResults([
      { packageName: "@acme/beta", definitions: { "acme.Shared": betaCopy }, via: "cds" },
      { packageName: "@acme/alpha", definitions: { "acme.Shared": alphaCopy }, via: "cds" },
    ]);

    expect(alphaFirst.definitions["acme.Shared"]).toEqual(betaFirst.definitions["acme.Shared"]);
  });

  it("separates the distinct-name count from the pairwise-conflict count for one name conflicting across 3+ packages", () => {
    const shared = (length: number): Record<string, unknown> => ({ kind: "type", type: "cds.String", length });
    const results = [
      { packageName: "@acme/a", definitions: { "acme.Shared": shared(1) }, via: "cds" },
      { packageName: "@acme/b", definitions: { "acme.Shared": shared(2) }, via: "cds" },
      { packageName: "@acme/c", definitions: { "acme.Shared": shared(3) }, via: "cds" },
    ] as const;

    const result = mergeWithStderr(results);

    expect(result.stderr).toContain("WARNING: 1 definition name(s) defined differently in >1 package (2 conflicting copies)");
  });

  it("bases the remaining-names suffix on distinct names left to show, not on leftover conflict copies", () => {
    const shared = (length: number): Record<string, unknown> => ({ kind: "type", type: "cds.String", length });
    const results = [
      { packageName: "@acme/a0", definitions: { "acme.Shared": shared(1) }, via: "cds" },
      { packageName: "@acme/a1", definitions: { "acme.Shared": shared(2) }, via: "cds" },
      { packageName: "@acme/a2", definitions: { "acme.Shared": shared(3) }, via: "cds" },
      { packageName: "@acme/b0", definitions: { "acme.D2": shared(1) }, via: "cds" },
      { packageName: "@acme/b1", definitions: { "acme.D2": shared(2) }, via: "cds" },
      { packageName: "@acme/c0", definitions: { "acme.D3": shared(1) }, via: "cds" },
      { packageName: "@acme/c1", definitions: { "acme.D3": shared(2) }, via: "cds" },
      { packageName: "@acme/d0", definitions: { "acme.D4": shared(1) }, via: "cds" },
      { packageName: "@acme/d1", definitions: { "acme.D4": shared(2) }, via: "cds" },
      { packageName: "@acme/e0", definitions: { "acme.D5": shared(1) }, via: "cds" },
      { packageName: "@acme/e1", definitions: { "acme.D5": shared(2) }, via: "cds" },
    ] as const;

    const result = mergeWithStderr(results);

    // 6 pairwise conflicts (2 for acme.Shared, 1 each for D2-D5) across 5 distinct names; the first
    // 5 conflict entries shown cover only 4 distinct names (both acme.Shared copies land inside that
    // slice), so exactly 1 name -- not 0 -- remains unlisted.
    expect(result.stderr).toContain("WARNING: 5 definition name(s) defined differently in >1 package (6 conflicting copies)");
    expect(result.stderr).toContain(", ... (+1 more name(s))");
  });

  it("keeps a __proto__-named definition as a real enumerable entry instead of corrupting the container", () => {
    // Computed-key syntax creates a genuine own "__proto__" property; a literal
    // {"__proto__": ...} key instead sets the object's own prototype and cannot reproduce the bug.
    const protoDefinition = { kind: "entity", "@hanaLens.packageName": "@acme/a", elements: { ID: { key: true, type: "cds.UUID" } } };
    const results = [{ packageName: "@acme/a", definitions: { ["__proto__"]: protoDefinition }, via: "cds" }] as const;

    const merged = mergeCompileResults(results);

    expect(Object.getPrototypeOf(merged.definitions)).toBe(null);
    expect(Object.keys(merged.definitions)).toEqual(["__proto__"]);
    expect(merged.definitions["__proto__"]).toEqual(protoDefinition);

    // JSON.parse always yields a normal Object.prototype-based object, so the round trip is
    // checked by key/value rather than by deep-equal, which would fail on prototype identity alone.
    const roundTripped = JSON.parse(JSON.stringify(merged)) as HanaLensCsn;
    expect(Object.keys(roundTripped.definitions)).toEqual(["__proto__"]);
    expect(roundTripped.definitions["__proto__"]).toEqual(protoDefinition);
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
      "acme.StockChanged": { kind: "event" },
      "acme.PersistenceNote": { kind: "annotation" },
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
      "acme.Model",
      "acme.StockChanged",
      "acme.PersistenceNote",
    ]);
    expect(Object.keys(all[0]?.definitions ?? {})).toEqual(Object.keys(mixedResult.definitions));
    expect(all[0]?.packageName).toBe("@acme/model");
    expect(all[0]?.via).toBe("cds");
    const dbNames = new Set(Object.keys(db[0]?.definitions ?? {}));
    const serviceNames = new Set(Object.keys(service[0]?.definitions ?? {}));
    for (const name of Object.keys(all[0]?.definitions ?? {})) {
      expect(dbNames.has(name) || serviceNames.has(name)).toBe(true);
    }
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
      [
        "acme.api.InventoryService.Stock",
        "acme.api.InventoryService2.Stock",
        "acme.common.Code",
      ],
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

  it("aggregates service shape across every package copy of a definition", () => {
    const results = [
      {
        packageName: "@acme/service-declarations",
        via: "cds",
        definitions: { "acme.api.CatalogService": { kind: "service" } },
      },
      {
        packageName: "@acme/service-model",
        via: "cds",
        definitions: {
          "acme.api.CatalogService.Phantom": { kind: "entity", "@cds.persistence.skip": true },
          "acme.catalog.Shared": { kind: "entity", "@cds.persistence.skip": true },
        },
      },
      {
        packageName: "@acme/service-provider",
        via: "cds",
        definitions: {
          "acme.api.CatalogService.Phantom": { kind: "entity" },
          "acme.api.CatalogService.PersistedRecord": { kind: "entity" },
          "acme.catalog.Shared": { kind: "entity" },
        },
      },
    ] as const;

    expect(applyCacheKindFilter(results, CACHE_KINDS.DB).map((result) => Object.keys(result.definitions))).toEqual([
      [],
      [],
      [
        "acme.api.CatalogService.PersistedRecord",
        "acme.catalog.Shared",
      ],
    ]);
    expect(applyCacheKindFilter(results, CACHE_KINDS.SERVICE).map((result) => Object.keys(result.definitions))).toEqual([
      ["acme.api.CatalogService"],
      [
        "acme.api.CatalogService.Phantom",
        "acme.catalog.Shared",
      ],
      [
        "acme.api.CatalogService.Phantom",
        "acme.api.CatalogService.PersistedRecord",
      ],
    ]);
  });

  it("keeps a referenced if-unused code list in db scope but drops an unreferenced one", () => {
    const results = [{
      packageName: "@acme/model",
      via: "cds",
      definitions: {
        "sap.common.Currencies": { kind: "entity", "@cds.persistence.skip": "if-unused", elements: { code: { key: true, type: "cds.String" } } },
        "sap.common.UnusedCodeList": { kind: "entity", "@cds.persistence.skip": "if-unused", elements: { code: { key: true, type: "cds.String" } } },
        "acme.Order": { kind: "entity", elements: {
          ID: { key: true, type: "cds.UUID" },
          currency: { type: "cds.Association", target: "sap.common.Currencies" },
        } },
      },
    } as const];

    const db = applyCacheKindFilter(results, CACHE_KINDS.DB);
    const service = applyCacheKindFilter(results, CACHE_KINDS.SERVICE);

    expect(Object.keys(db[0]?.definitions ?? {})).toEqual(["sap.common.Currencies", "acme.Order"]);
    expect(Object.keys(service[0]?.definitions ?? {})).toEqual(["sap.common.UnusedCodeList"]);
  });

  it("documents the accepted limitation: a bare fallback-parser target can suffix-match an unrelated if-unused entity", () => {
    const results = [{
      packageName: "@acme/model",
      via: "fallback",
      definitions: {
        "ns1.Code": { kind: "entity", "@cds.persistence.skip": "if-unused", elements: { value: { type: "cds.String" } } },
        "ns2.Order": { kind: "entity", elements: {
          ID: { key: true, type: "cds.UUID" },
          // Bare, unqualified target -- typical of the degraded --allow-fallback parser, which
          // never namespace-qualifies association targets.
          code: { type: "cds.Association", target: "Code" },
        } },
      },
    } as const];

    const db = applyCacheKindFilter(results, CACHE_KINDS.DB);

    // ns1.Code is not really what "code" points at, but the bare suffix match still counts it as
    // referenced -- kept in db rather than dropped. Erring toward keeping is the accepted,
    // documented direction (see isReferenced's comment): it never causes a genuinely-needed
    // table to vanish, only an occasional unused one to linger.
    expect(Object.keys(db[0]?.definitions ?? {})).toContain("ns1.Code");
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
