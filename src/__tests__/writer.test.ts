import { describe, it, expect, afterEach } from "vitest";
import { writeCredentials, OUTPUT_FILENAME } from "../writer.js";
import { readFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import type { AppHanaEntry } from "../types.js";

const MOCK_ENTRY: AppHanaEntry = {
  app: "my-app",
  org: "my-org",
  space: "app",
  region: "ap11",
  hana: {
    host: "abc.hana.ondemand.com",
    port: "443",
    user: "USER_RT",
    password: "pass",
    schema: "MY_SCHEMA",
    hdiUser: "USER_DT",
    hdiPassword: "hdi-pass",
    url: "jdbc:sap://abc.hana.ondemand.com:443",
    databaseId: "db-uuid",
    certificate: "-----BEGIN CERTIFICATE-----",
  },
};

const TEST_OUTPUT = "/tmp/saptools-test-output.json";

describe("writeCredentials", () => {
  afterEach(async () => {
    try {
      await unlink(TEST_OUTPUT);
    } catch {
      // File may not exist if test failed early
    }
  });

  it("writes entries as a JSON array to the specified path", async () => {
    await writeCredentials([MOCK_ENTRY], TEST_OUTPUT);

    const content = await readFile(TEST_OUTPUT, "utf-8");
    const parsed = JSON.parse(content) as unknown[];

    expect(parsed).toHaveLength(1);
  });

  it("pretty-prints output with 2-space indent", async () => {
    await writeCredentials([MOCK_ENTRY], TEST_OUTPUT);

    const content = await readFile(TEST_OUTPUT, "utf-8");

    expect(content).toContain("  ");
  });

  it("writes an empty array when no entries given", async () => {
    await writeCredentials([], TEST_OUTPUT);

    const content = await readFile(TEST_OUTPUT, "utf-8");

    expect(content.trim()).toBe("[]");
  });

  it("returns the resolved file path", async () => {
    const returned = await writeCredentials([MOCK_ENTRY], TEST_OUTPUT);

    expect(returned).toBe(resolve(TEST_OUTPUT));
  });

  it("uses OUTPUT_FILENAME as default when no path given", () => {
    expect(OUTPUT_FILENAME).toBe("hana-credentials.json");
  });
});
