import { readFile } from "node:fs/promises";
import path from "node:path";

import { expect } from "../helpers/expect.js";
import { describe, it } from "../helpers/test.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readPackageJson(): Promise<Record<string, unknown>> {
  const raw = await readFile(path.resolve("package.json"), "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error("package.json must be an object");
  }
  return parsed;
}

describe("hana-lens package metadata", () => {
  it("builds runtime files before npm pack or publish", async () => {
    const packageJson = await readPackageJson();
    const scripts = packageJson["scripts"];
    expect(isRecord(scripts)).toBe(true);
    if (!isRecord(scripts)) {
      return;
    }
    expect(scripts["prepack"]).toBe("npm run build");
  });
});
