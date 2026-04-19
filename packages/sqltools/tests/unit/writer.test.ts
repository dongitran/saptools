import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AppHanaEntry } from "../../src/types.js";
import { OUTPUT_FILENAME, writeCredentials } from "../../src/writer.js";

const ENTRY: AppHanaEntry = {
  app: "svc",
  org: "acme",
  space: "dev",
  region: "eu10",
  hana: {
    host: "h",
    port: "443",
    user: "u",
    password: "p",
    schema: "s",
    hdiUser: "hu",
    hdiPassword: "hp",
    url: "jdbc:sap://h:443",
    databaseId: "d",
    certificate: "c",
  },
};

describe("writeCredentials", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "sqltools-writer-"));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("writes to <cwd>/hana-credentials.json by default", async () => {
    const filePath = await writeCredentials([ENTRY], { cwd: tempRoot });
    expect(filePath).toBe(join(tempRoot, OUTPUT_FILENAME));
    const contents = JSON.parse(await readFile(filePath, "utf-8")) as readonly AppHanaEntry[];
    expect(contents.length).toBe(1);
    expect(contents[0]?.app).toBe("svc");
  });

  it("respects a custom output path", async () => {
    const filePath = await writeCredentials([ENTRY], {
      cwd: tempRoot,
      outputPath: "custom.json",
    });
    expect(filePath).toBe(join(tempRoot, "custom.json"));
    const contents = await readFile(filePath, "utf-8");
    expect(contents.endsWith("\n")).toBe(true);
  });

  it("writes an empty array when passed no entries", async () => {
    const filePath = await writeCredentials([], { cwd: tempRoot });
    const contents = JSON.parse(await readFile(filePath, "utf-8")) as unknown;
    expect(contents).toEqual([]);
  });
});
