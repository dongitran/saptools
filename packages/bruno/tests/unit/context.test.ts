import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readContext, writeContext } from "../../src/context.js";

describe("bruno context", () => {
  let fakeHome: string;
  let originalHome: string | undefined;
  beforeEach(async () => {
    fakeHome = await mkdtemp(join(tmpdir(), "saptools-bruno-ctx-"));
    originalHome = process.env["HOME"];
    process.env["HOME"] = fakeHome;
  });
  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env["HOME"];
    } else {
      process.env["HOME"] = originalHome;
    }
    await rm(fakeHome, { recursive: true, force: true });
  });

  it("returns undefined when no context file", async () => {
    expect(await readContext()).toBeUndefined();
  });

  it("round-trips writeContext / readContext", async () => {
    const written = await writeContext({ region: "ap10", org: "o", space: "s", app: "a" });
    expect(written.updatedAt).toMatch(/T/);
    const read = await readContext();
    expect(read?.app).toBe("a");
    expect(read?.region).toBe("ap10");
  });
});
