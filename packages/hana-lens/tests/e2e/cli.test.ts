import { spawnSync } from "node:child_process";
import { lstat, mkdtemp, mkdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CACHE_FILE_NAME, PACKAGE_ANNOTATION } from "../../src/types.js";
import type { HanaLensCsn } from "../../src/types.js";
import { expect } from "../helpers/expect.js";
import { describe, it } from "../helpers/test.js";

const cliPath = path.resolve("dist/cli.js");

interface CliResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runCli(args: readonly string[], cwd: string): CliResult {
  const result = spawnSync(process.execPath, [cliPath, ...args], { cwd, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function writeCapPackage(directory: string, name: string, source: string): Promise<void> {
  await mkdir(path.join(directory, "srv"), { recursive: true });
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ name, dependencies: { "@sap/cds": "^9" } }));
  await writeFile(path.join(directory, "srv", "model.cds"), source);
}

async function writeCache(directory: string, csn: HanaLensCsn | string): Promise<void> {
  await writeFile(path.join(directory, CACHE_FILE_NAME), typeof csn === "string" ? csn : JSON.stringify(csn));
}

async function withTempWorkspace<T>(callback: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "hana-lens-e2e-"));
  try {
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("hana-lens CLI e2e", () => {
  it("build-cache compiles matching CAP packages, ignores generated folders, writes minified origin metadata, and links siblings", async () => {
    await withTempWorkspace(async (root) => {
      await writeCapPackage(path.join(root, "packages", "sales"), "@demo/sales", "namespace demo.sales; entity BusinessRequest { key reqID: String(36); customer: Association to demo.master.Customer; }");
      await writeCapPackage(path.join(root, "packages", "master"), "@demo/master", "namespace demo.master; entity Customer { key ID: Integer; name: String(80); requests: Association to many demo.sales.BusinessRequest; }");
      await writeCapPackage(path.join(root, "gen", "ignored"), "@demo/ignored", "this is deliberately invalid cds and must never be compiled");

      const build = runCli(["build-cache", "--dir", root, "--prefix", "@demo/"], root);
      expect(build.status).toBe(0);
      expect(build.stderr).toBe("");
      expect(build.stdout).toContain("packages=2");
      expect(build.stdout).toContain(CACHE_FILE_NAME);

      const rawCache = await readFile(path.join(root, CACHE_FILE_NAME), "utf8");
      expect(rawCache.includes("\n")).toBe(false);
      const parsed = JSON.parse(rawCache) as HanaLensCsn;
      expect(parsed.definitions["demo.sales.BusinessRequest"]?.[PACKAGE_ANNOTATION]).toBe("@demo/sales");
      expect(parsed.definitions["demo.master.Customer"]?.[PACKAGE_ANNOTATION]).toBe("@demo/master");

      const salesToMaster = path.join(root, "packages", "sales", "node_modules", "@demo", "master");
      expect((await lstat(salesToMaster)).isSymbolicLink()).toBe(true);
      expect(await readlink(salesToMaster)).toBe(path.join(root, "packages", "master"));
    });
  }, 30_000);

  it("search reads an existing cache offline, supports fuzzy and regex modes, limits output, and reports regex errors", async () => {
    await withTempWorkspace(async (root) => {
      await writeCache(root, { definitions: {
        "demo.sales.BusinessRequest": { [PACKAGE_ANNOTATION]: "@demo/sales" },
        "demo.sales.BusinessRequestItem": { [PACKAGE_ANNOTATION]: "@demo/sales" },
        "demo.master.Customer": { [PACKAGE_ANNOTATION]: "@demo/master" },
        ...Object.fromEntries(Array.from({ length: 20 }, (_value, index) => [`demo.generated.Entity${index.toString().padStart(2, "0")}`, { [PACKAGE_ANNOTATION]: "@demo/generated" }])),
      } });

      const fuzzy = runCli(["search", "BusinesReq"], root);
      expect(fuzzy.status).toBe(0);
      expect(fuzzy.stderr).toBe("");
      expect(fuzzy.stdout).toContain("demo.sales.BusinessRequest|@demo/sales");

      const regex = runCli(["search", "Customer$", "--regex"], root);
      expect(regex.status).toBe(0);
      expect(regex.stdout).toBe("demo.master.Customer|@demo/master\n");

      const limited = runCli(["search", "demo"], root);
      expect(limited.status).toBe(0);
      expect(limited.stdout.trim().split("\n")).toHaveLength(10);

      const invalidRegex = runCli(["search", "[", "--regex"], root);
      expect(invalidRegex.status).toBe(1);
      expect(invalidRegex.stderr).toContain("Invalid regular expression");
    });
  });

  it("describe reads an existing cache offline, prints dense fields, expands associations, and guards circular or missing targets", async () => {
    await withTempWorkspace(async (root) => {
      await writeCache(root, { definitions: {
        "demo.sales.BusinessRequest": { [PACKAGE_ANNOTATION]: "@demo/sales", elements: { reqID: { key: true, type: "cds.String", length: 36 }, createdAt: { "@Core.Computed": true, type: "cds.Timestamp" }, customer: { type: "cds.Association", target: "demo.master.Customer" }, missing: { type: "cds.Composition", target: "demo.master.Missing" } } },
        "demo.master.Customer": { [PACKAGE_ANNOTATION]: "@demo/master", elements: { ID: { key: true, type: "cds.Integer" }, name: { type: "cds.String", length: 80 }, request: { type: "cds.Association", target: "demo.sales.BusinessRequest" } } },
        "demo.empty.EmptyEntity": { [PACKAGE_ANNOTATION]: "@demo/empty" },
      } });

      const compact = runCli(["describe", "demo.sales.BusinessRequest"], root);
      expect(compact.status).toBe(0);
      expect(compact.stdout).toContain("[PK] reqID: cds.String(36)");
      expect(compact.stdout).toContain("[PK] createdAt: cds.Timestamp");
      expect(compact.stdout).toContain("customer: cds.Association");
      expect(compact.stdout.includes("- [PK] ID")).toBe(false);

      const expanded = runCli(["describe", "demo.sales.BusinessRequest", "--expand"], root);
      expect(expanded.status).toBe(0);
      expect(expanded.stdout).toContain("- [PK] ID: cds.Integer");
      expect(expanded.stdout).toContain("-- demo.sales.BusinessRequest: circular");
      expect(expanded.stdout).toContain("- demo.master.Missing: missing");

      expect(runCli(["describe", "demo.empty.EmptyEntity"], root).stdout).toBe("(no elements)\n");
    });
  });

  it("reports actionable failures for empty workspaces, missing caches, malformed caches, invalid cache shapes, and missing entities", async () => {
    await withTempWorkspace(async (root) => {
      const empty = runCli(["build-cache", "--dir", root, "--prefix", "@demo/"], root);
      expect(empty.status).toBe(1);
      expect(empty.stderr).toContain("No packages starting with @demo/");

      const missingCache = runCli(["search", "x"], root);
      expect(missingCache.status).toBe(1);
      expect(missingCache.stderr).toContain("Run hana-lens build-cache first");

      await writeCache(root, "{");
      const malformed = runCli(["search", "x"], root);
      expect(malformed.status).toBe(1);
      expect(malformed.stderr).toContain("malformed JSON");

      await writeCache(root, JSON.stringify({ definitions: [] }));
      const invalidShape = runCli(["search", "x"], root);
      expect(invalidShape.status).toBe(1);
      expect(invalidShape.stderr).toContain("definitions object");

      await writeCache(root, { definitions: { Entity: { elements: {} } } });
      const missingEntity = runCli(["describe", "Missing"], root);
      expect(missingEntity.status).toBe(1);
      expect(missingEntity.stderr).toContain("Entity not found: Missing");
    });
  });

  it("build-cache fails rather than silently overwriting duplicate definitions", async () => {
    await withTempWorkspace(async (root) => {
      await writeCapPackage(path.join(root, "first"), "@demo/first", "namespace demo.dup; entity Shared { key ID: Integer; }");
      await writeCapPackage(path.join(root, "second"), "@demo/second", "namespace demo.dup; entity Shared { key ID: Integer; }");

      const result = runCli(["build-cache", "--dir", root, "--prefix", "@demo/"], root);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Duplicate CSN definition demo.dup.Shared");
    });
  }, 30_000);
});
