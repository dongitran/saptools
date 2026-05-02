import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseShorthandPath, scanCollection } from "../../src/folder-scan.js";

describe("parseShorthandPath", () => {
  it("parses app-level shorthand", () => {
    expect(parseShorthandPath("ap10/org1/dev/app1")).toEqual({
      region: "ap10",
      org: "org1",
      space: "dev",
      app: "app1",
    });
  });

  it("parses request-file shorthand", () => {
    const ref = parseShorthandPath("ap10/org1/dev/app1/folder/call.bru");
    expect(ref?.environment).toBe("call");
    expect(ref?.filePath).toBe("folder/call.bru");
  });

  it("returns undefined when too short", () => {
    expect(parseShorthandPath("ap10/org1")).toBeUndefined();
  });

  it("tolerates leading dots and slashes", () => {
    expect(parseShorthandPath("./ap10/o/s/a")?.app).toBe("a");
  });

  it("normalizes backslash separated shorthand", () => {
    expect(parseShorthandPath("ap10\\o\\s\\a\\requests\\ping.bru")).toEqual({
      region: "ap10",
      org: "o",
      space: "s",
      app: "a",
      environment: "ping",
      filePath: "requests/ping.bru",
    });
  });

  it("keeps nested paths without a .bru extension as file paths only", () => {
    expect(parseShorthandPath("ap10/o/s/a/folder/ping")).toEqual({
      region: "ap10",
      org: "o",
      space: "s",
      app: "a",
      filePath: "folder/ping",
    });
  });
});

describe("scanCollection", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "saptools-bruno-scan-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("scans prefixed region/org/space folders and ignores strangers", async () => {
    await mkdir(join(root, "region__ap10", "org__o1", "space__dev", "app1", "environments"), { recursive: true });
    await writeFile(
      join(root, "region__ap10", "org__o1", "space__dev", "app1", "environments", "local.bru"),
      "vars {\n  __cf_region: ap10\n}\n",
      "utf8",
    );
    await writeFile(
      join(root, "region__ap10", "org__o1", "space__dev", "app1", "environments", "notes.txt"),
      "not an environment",
      "utf8",
    );
    await mkdir(join(root, "not_a_region"), { recursive: true });
    await mkdir(join(root, "region__ap10", "plain-org", "space__dev", "app2"), { recursive: true });
    await mkdir(join(root, "region__ap10", "org__o1", "plain-space", "app3"), { recursive: true });

    const collection = await scanCollection(root);
    expect(collection.regions).toHaveLength(1);
    expect(collection.regions[0]?.key).toBe("ap10");
    const space = collection.regions[0]?.orgs[0]?.spaces[0];
    expect(space?.name).toBe("dev");
    expect(space?.apps[0]?.environments[0]?.name).toBe("local");
    expect(space?.apps[0]?.environments).toHaveLength(1);
  });

  it("returns empty structure for empty root", async () => {
    const collection = await scanCollection(root);
    expect(collection.regions).toHaveLength(0);
  });
});
