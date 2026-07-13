import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  loadCatalogObjectsWithCache,
  metadataCacheKey,
  readMetadataCache,
  writeMetadataCache,
  toMetadataCacheScope,
} from "../../src/metadata-cache.js";

const info = {
  selector: "eu/org/space/app",
  appName: "app",
  host: "hana.example",
  schema: "APP_SCHEMA",
  role: "runtime" as const,
  driver: "fake",
  credentialSource: "live" as const,
};
const objects = [{ schema: "APP_SCHEMA", name: "ORDERS", type: "TABLE" as const }];

describe("metadata cache", () => {
  it("misses, hits inside 30 minutes, expires at 30 minutes, and refreshes", async () => {
    const root = await mkdtemp(join(tmpdir(), "cf-hana-cache-"));
    const scope = toMetadataCacheScope(info);
    let calls = 0;
    const now = new Date("2026-07-01T00:00:00Z");
    const first = await loadCatalogObjectsWithCache(scope, false, async () => { calls += 1; return objects; }, { saptoolsRoot: root, now: () => now });
    expect(first).toEqual(objects);
    const hit = await loadCatalogObjectsWithCache(scope, false, async () => { calls += 1; return []; }, { saptoolsRoot: root, now: () => new Date(now.getTime() + 29 * 60_000) });
    expect(hit).toEqual(objects);
    const expired = await loadCatalogObjectsWithCache(scope, false, async () => { calls += 1; return [{ schema: "APP_SCHEMA", name: "NEW", type: "VIEW" as const }]; }, { saptoolsRoot: root, now: () => new Date(now.getTime() + 30 * 60_000) });
    expect(expired[0]?.name).toBe("NEW");
    await loadCatalogObjectsWithCache(scope, true, async () => { calls += 1; return objects; }, { saptoolsRoot: root, now: () => now });
    expect(calls).toBe(3);
  });

  it("rejects cache entries with mismatched scope or future timestamps", async () => {
    const root = await mkdtemp(join(tmpdir(), "cf-hana-cache-"));
    const scope = toMetadataCacheScope(info);
    await writeMetadataCache(scope, objects, {
      saptoolsRoot: root,
      now: () => new Date("2026-07-01T00:30:00Z"),
    });
    expect(
      await readMetadataCache(scope, {
        saptoolsRoot: root,
        now: () => new Date("2026-07-01T00:00:00Z"),
      }),
    ).toBeUndefined();

    await writeMetadataCache(scope, objects, { saptoolsRoot: root });
    const cachePath = join(root, "cf-hana", "metadata", `${metadataCacheKey(scope)}.json`);
    const stored = JSON.parse(await readFile(cachePath, "utf8")) as {
      scope: { schema: string };
    };
    stored.scope.schema = "OTHER_SCHEMA";
    await writeFile(cachePath, `${JSON.stringify(stored)}\n`, "utf8");
    expect(await readMetadataCache(scope, { saptoolsRoot: root })).toBeUndefined();
  });

  it("returns fresh metadata when cache writes fail", async () => {
    const rootFile = join(await mkdtemp(join(tmpdir(), "cf-hana-cache-file-")), "not-a-directory");
    await writeFile(rootFile, "blocking-file", "utf8");
    await expect(
      loadCatalogObjectsWithCache(toMetadataCacheScope(info), false, async () => objects, {
        saptoolsRoot: rootFile,
      }),
    ).resolves.toEqual(objects);
  });

  it("treats malformed files as misses and scopes by non-secret identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "cf-hana-cache-"));
    const scope = toMetadataCacheScope(info);
    const key = metadataCacheKey(scope);
    const otherBindingScope = toMetadataCacheScope({ ...info, bindingName: "other-binding" });
    expect(key).not.toContain("password");
    expect(metadataCacheKey({ ...scope, schema: "OTHER" })).not.toBe(key);
    expect(otherBindingScope.bindingName).toBe("other-binding");
    expect(metadataCacheKey(otherBindingScope)).not.toBe(key);
    const dir = join(root, "cf-hana", "metadata");
    await import("node:fs/promises").then(async (fs) => await fs.mkdir(dir, { recursive: true }));
    await writeFile(join(dir, `${key}.json`), "not-json", "utf8");
    expect(await readMetadataCache(scope, { saptoolsRoot: root })).toBeUndefined();
    const loaded = await loadCatalogObjectsWithCache(scope, false, async () => objects, { saptoolsRoot: root });
    expect(loaded).toEqual(objects);
    const stored = await readFile(join(dir, `${key}.json`), "utf8");
    expect(stored).not.toContain("secret");
    expect(stored).not.toContain("sample-row");
    expect(stored).not.toContain("?");
  });
});
