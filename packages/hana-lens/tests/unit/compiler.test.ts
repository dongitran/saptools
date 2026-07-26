import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { compilePackage, compilePackages, parseCompileResult, resolveCompileOutcome } from "../../src/compiler.js";
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

  it("isolates a spawn-level failure (bad cwd) without crashing the rest of the batch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hana-lens-spawn-fail-"));
    try {
      await writeWorkspaceCds(root);
      const good = await writeCompilePackage(root, "db_good", { csn: { definitions: { "acme.Good": { kind: "entity" } } } });
      const missing: SapPackage = { name: "@acme/missing", directory: path.join(root, "does-not-exist") };

      await expect(compilePackage(missing, false)).rejects.toThrow();

      const outcome = await compilePackages([good, missing], false, false);
      expect(outcome.compiled.map((result) => result.packageName)).toEqual(["@acme/db_good"]);
      expect(outcome.skipped).toHaveLength(1);
      expect(outcome.skipped[0]?.package).toBe("@acme/missing");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("classifies an unresolvable-module compile error distinctly from a semantic one", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hana-lens-compile-error-kind-"));
    try {
      await writeWorkspaceCds(root);
      const missingModule = await writeCompilePackage(root, "missing_module", {
        error: "Can't find local module './does-not-exist'",
      });
      const semanticError = await writeCompilePackage(root, "semantic_error", {
        error: 'Duplicate definition of "acme.Thing"',
      });

      const outcome = await compilePackages([missingModule, semanticError], false, false);

      expect(outcome.compiled).toEqual([]);
      expect(outcome.skipped).toHaveLength(2);
      const missingSkip = outcome.skipped.find((skip) => skip.package === "@acme/missing_module");
      const semanticSkip = outcome.skipped.find((skip) => skip.package === "@acme/semantic_error");
      expect(missingSkip?.reason).toContain("could not resolve a referenced file");
      expect(missingSkip?.reason.includes("CDS model problem")).toBe(false);
      expect(semanticSkip?.reason).toContain("CDS model problem, not a missing or unusable @sap/cds install");
      expect(semanticSkip?.reason.includes("could not resolve a referenced file")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never attributes a cds.* framework built-in to the package that happened to compile it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hana-lens-framework-builtin-"));
    try {
      await writeWorkspaceCds(root);
      const packages = [await writeCompilePackage(root, "orders", {
        csn: { definitions: {
          "acme.Order": { kind: "entity" },
          "cds.outbox.Messages": { kind: "entity" },
        } },
      })];

      const outcome = await compilePackages(packages, false, false);
      const definitions = outcome.compiled[0]?.definitions ?? {};

      // Kept in the cache (so it stays resolvable and `--kind all` remains complete), just never
      // attributed to whichever package happened to compile it.
      expect(Object.keys(definitions)).toEqual(["acme.Order", "cds.outbox.Messages"]);
      expect(definitions["cds.outbox.Messages"]?.["@hanaLens.packageName"]).toBe(undefined);
      expect(definitions["acme.Order"]?.["@hanaLens.packageName"]).toBe("@acme/orders");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("resolveCompileOutcome", () => {
  const validPayload = JSON.stringify({ packageName: "@acme/a", definitions: { A: {} }, via: "cds" });

  it("uses a valid payload already on stdout even when the process was signal-killed", () => {
    expect(resolveCompileOutcome("@acme/a", null, "SIGTERM", validPayload, "")).toEqual({
      packageName: "@acme/a",
      definitions: { A: {} },
      via: "cds",
    });
  });

  it("uses a valid payload already on stdout even after a non-zero exit", () => {
    expect(resolveCompileOutcome("@acme/a", 1, null, validPayload, "unrelated teardown warning")).toEqual({
      packageName: "@acme/a",
      definitions: { A: {} },
      via: "cds",
    });
  });

  it("reports the terminating signal, not a generic error, when no usable payload exists", () => {
    expect(() => resolveCompileOutcome("@acme/a", null, "SIGKILL", "", "out of memory")).toThrow(
      "Compilation failed for @acme/a: out of memory (terminated by signal SIGKILL)",
    );
  });

  it("reports the exit code when no signal terminated the process", () => {
    expect(() => resolveCompileOutcome("@acme/a", 1, null, "", "")).toThrow(
      "Compilation failed for @acme/a: (no stderr output) (exit code 1)",
    );
  });

  it("names the exit condition honestly when neither a code nor a signal is available", () => {
    expect(() => resolveCompileOutcome("@acme/a", null, null, "", "")).toThrow(
      "Compilation failed for @acme/a: (no stderr output) (unknown exit condition)",
    );
  });

  it("surfaces the parse error directly on a clean exit with no signal involved", () => {
    expect(() => resolveCompileOutcome("@acme/a", 0, null, "not json", "")).toThrow("returned malformed JSON");
  });
});
