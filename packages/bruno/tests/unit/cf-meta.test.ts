import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildCfMetaUpdates,
  hasCfMeta,
  readCfMetaFromFile,
  readCfMetaFromVars,
  writeCfMetaToFile,
} from "../../src/cf-meta.js";

describe("readCfMetaFromVars", () => {
  it("returns undefined when any key missing", () => {
    const vars = new Map([["__cf_region", "ap10"]]);
    expect(readCfMetaFromVars(vars)).toBeUndefined();
  });

  it("returns the meta when all 4 present", () => {
    const vars = new Map([
      ["__cf_region", "ap10"],
      ["__cf_org", "o"],
      ["__cf_space", "s"],
      ["__cf_app", "a"],
    ]);
    expect(readCfMetaFromVars(vars)).toEqual({ region: "ap10", org: "o", space: "s", app: "a" });
  });
});

describe("buildCfMetaUpdates", () => {
  it("emits all 4 cf keys and optional baseUrl", () => {
    const updates = buildCfMetaUpdates(
      { region: "ap10", org: "o", space: "s", app: "a" },
      "https://x",
    );
    expect(updates.get("__cf_region")).toBe("ap10");
    expect(updates.get("baseUrl")).toBe("https://x");
  });

  it("omits baseUrl when not provided", () => {
    const updates = buildCfMetaUpdates({ region: "ap10", org: "o", space: "s", app: "a" });
    expect(updates.has("baseUrl")).toBe(false);
  });
});

describe("hasCfMeta", () => {
  it("returns true when all keys populated", () => {
    const vars = new Map([
      ["__cf_region", "ap10"],
      ["__cf_org", "o"],
      ["__cf_space", "s"],
      ["__cf_app", "a"],
    ]);
    expect(hasCfMeta(vars)).toBe(true);
  });

  it("returns false when any key empty", () => {
    const vars = new Map([
      ["__cf_region", ""],
      ["__cf_org", "o"],
      ["__cf_space", "s"],
      ["__cf_app", "a"],
    ]);
    expect(hasCfMeta(vars)).toBe(false);
  });
});

describe("cf-meta file helpers", () => {
  let tmp: string;
  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "saptools-bruno-cfmeta-"));
  });
  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("reads meta from a file", async () => {
    const path = join(tmp, "env1.bru");
    await writeFile(
      path,
      "vars {\n  __cf_region: ap10\n  __cf_org: o\n  __cf_space: s\n  __cf_app: a\n}\n",
      "utf8",
    );
    expect(await readCfMetaFromFile(path)).toEqual({ region: "ap10", org: "o", space: "s", app: "a" });
  });

  it("treats whitespace-only metadata values in files as missing", async () => {
    const path = join(tmp, "env-whitespace.bru");
    await writeFile(
      path,
      "vars {\n  __cf_region:   \n  __cf_org: o\n  __cf_space: s\n  __cf_app: a\n}\n",
      "utf8",
    );
    expect(await readCfMetaFromFile(path)).toBeUndefined();
  });

  it("writes meta to a file and is idempotent", async () => {
    const path = join(tmp, "env2.bru");
    await writeFile(path, "vars {\n  baseUrl: https://x\n}\n", "utf8");
    const first = await writeCfMetaToFile(
      path,
      { region: "ap10", org: "o", space: "s", app: "a" },
    );
    expect(first).toBe(true);
    const after = await readFile(path, "utf8");
    expect(after).toContain("__cf_region: ap10");
    const second = await writeCfMetaToFile(
      path,
      { region: "ap10", org: "o", space: "s", app: "a" },
    );
    expect(second).toBe(false);
  });

  it("writes optional baseUrl when provided", async () => {
    const path = join(tmp, "env-base-url.bru");
    await writeFile(path, "vars {\n}\n", "utf8");
    await writeCfMetaToFile(
      path,
      { region: "ap10", org: "o", space: "s", app: "a" },
      "https://example.com/api",
    );
    const raw = await readFile(path, "utf8");
    expect(raw).toContain("baseUrl: https://example.com/api");
  });
});
