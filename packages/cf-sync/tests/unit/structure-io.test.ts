import { mkdtemp, rm } from "node:fs/promises";
import type * as NodeOs from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CfStructure } from "../../src/types.js";

let tempHome: string;

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), "saptools-test-"));
  vi.resetModules();
  vi.doMock("node:os", async () => {
    const actual = await vi.importActual<typeof NodeOs>("node:os");
    return { ...actual, homedir: () => tempHome };
  });
});

afterEach(async () => {
  vi.doUnmock("node:os");
  await rm(tempHome, { recursive: true, force: true });
});

describe("structure file I/O", () => {
  it("returns undefined when file does not exist", async () => {
    const { readStructure } = await import("../../src/structure.js");
    expect(await readStructure()).toBeUndefined();
  });

  it("writes and reads back a structure", async () => {
    const { readStructure, writeStructure } = await import("../../src/structure.js");
    const fixture: CfStructure = {
      syncedAt: "2026-04-18T00:00:00.000Z",
      regions: [
        {
          key: "ap10",
          label: "test",
          apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
          accessible: true,
          orgs: [{ name: "o", spaces: [{ name: "s", apps: [{ name: "a" }] }] }],
        },
      ],
    };
    await writeStructure(fixture);
    const readBack = await readStructure();
    expect(readBack).toEqual(fixture);
  });

  it("creates parent directory when missing", async () => {
    const { writeStructure } = await import("../../src/structure.js");
    const fixture: CfStructure = { syncedAt: "2026-04-18T00:00:00.000Z", regions: [] };
    await writeStructure(fixture);
    const { cfStructurePath } = await import("../../src/paths.js");
    expect(cfStructurePath().startsWith(tempHome)).toBe(true);
  });
});
