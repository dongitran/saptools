import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { compilePackages, parseCompileResult } from "../../src/compiler.js";
import type { SapPackage } from "../../src/types.js";
import { expect } from "../helpers/expect.js";
import { describe, it } from "../helpers/test.js";

async function writeWorkspaceCds(root: string): Promise<void> {
  const moduleDirectory = path.join(root, "node_modules", "@sap", "cds");
  await mkdir(moduleDirectory, { recursive: true });
  await writeFile(path.join(moduleDirectory, "package.json"), JSON.stringify({
    name: "@sap/cds",
    type: "module",
    exports: "./index.js",
  }));
  await writeFile(path.join(moduleDirectory, "index.js"), [
    'import { readFile } from "node:fs/promises";',
    'import path from "node:path";',
    'const cds = { compile: async () => {',
    '  const payload = JSON.parse(await readFile(path.join(process.cwd(), "compile-result.json"), "utf8"));',
    '  if (typeof payload.error === "string") throw new Error(payload.error);',
    '  return payload.csn;',
    '} };',
    'export default cds;',
  ].join("\n"));
}

async function writeCompilePackage(
  root: string,
  shortName: string,
  payload: Readonly<Record<string, unknown>>,
): Promise<SapPackage> {
  const directory = path.join(root, "packages", shortName);
  const name = `@acme/${shortName}`;
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ name }));
  await writeFile(path.join(directory, "compile-result.json"), JSON.stringify(payload));
  return { name, directory };
}

describe("parseCompileResult", () => {
  it("parses the last non-empty JSON line when workers print diagnostics before payload", () => {
    expect(parseCompileResult("diagnostic line\n{\"packageName\":\"@acme/a\",\"definitions\":{\"A\":{}}}\n", "@acme/a")).toEqual({
      packageName: "@acme/a",
      definitions: { A: {} },
      via: "cds",
    });
  });

  it("parses the JSON payload when workers print trailing diagnostics", () => {
    expect(parseCompileResult("{\"packageName\":\"@acme/a\",\"definitions\":{\"A\":{},\"B\":{}},\"via\":\"fallback\"}\ntrailing diagnostic\n", "@acme/a")).toEqual({
      packageName: "@acme/a",
      definitions: { A: {}, B: {} },
      via: "fallback",
    });
  });

  it("skips later invalid JSON payloads when an earlier matching payload is valid", () => {
    expect(parseCompileResult("{\"packageName\":\"@acme/a\",\"definitions\":{\"A\":{}},\"via\":\"cds\"}\n{\"packageName\":\"@acme/other\",\"definitions\":{}}\n", "@acme/a")).toEqual({
      packageName: "@acme/a",
      definitions: { A: {} },
      via: "cds",
    });
  });

  it("rejects empty, malformed, wrong-package, and invalid-definition payloads", () => {
    expect(() => parseCompileResult("", "@acme/a")).toThrow("returned no JSON payload");
    expect(() => parseCompileResult("not-json", "@acme/a")).toThrow("returned malformed JSON");
    expect(() => parseCompileResult("{\"packageName\":\"@acme/b\",\"definitions\":{}}", "@acme/a")).toThrow("returned an invalid payload");
    expect(() => parseCompileResult("{\"packageName\":\"@acme/a\",\"definitions\":[]}", "@acme/a")).toThrow("returned an invalid payload");
    expect(() => parseCompileResult("{\"packageName\":\"@acme/a\",\"definitions\":{},\"via\":\"unknown\"}", "@acme/a")).toThrow("returned an invalid payload");
  });

  it("keeps successful and empty packages while isolating failures in package order", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hana-lens-compile-outcome-"));
    try {
      await writeWorkspaceCds(root);
      const packages = await Promise.all([
        writeCompilePackage(root, "db_good", { csn: { definitions: { "acme.Good": { kind: "entity" } } } }),
        writeCompilePackage(root, "db_broken", { error: "MODEL_ERROR neutral fixture" }),
        writeCompilePackage(root, "helper_empty", { csn: { definitions: {} } }),
      ]);

      const outcome = await compilePackages(packages, false, false);

      expect(outcome.compiled.map((result) => result.packageName)).toEqual(["@acme/db_good", "@acme/helper_empty"]);
      expect(outcome.compiled.map((result) => result.via)).toEqual(["cds", "cds"]);
      expect(outcome.compiled[1]?.definitions).toEqual({});
      expect(outcome.skipped).toHaveLength(1);
      expect(outcome.skipped[0]?.package).toBe("@acme/db_broken");
      expect(outcome.skipped[0]?.reason).toContain("MODEL_ERROR neutral fixture");
      await expect(compilePackages(packages, false, true)).rejects.toThrow("Strict mode: 1 package(s) failed to compile: @acme/db_broken");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
