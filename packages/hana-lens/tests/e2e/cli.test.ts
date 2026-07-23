import { spawnSync } from "node:child_process";
import { access, cp, lstat, mkdtemp, mkdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readCache } from "../../src/cache.js";
import { CACHE_FILE_NAME, PACKAGE_ANNOTATION } from "../../src/types.js";
import type { HanaLensCsn } from "../../src/types.js";
import { expect } from "../helpers/expect.js";
import { it } from "../helpers/test.js";

const cliPath = path.resolve("dist/cli.js");

interface CliResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runCli(args: readonly string[], cwd: string, executable = cliPath): CliResult {
  const result = spawnSync(process.execPath, [executable, ...args], { cwd, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function runBuild(root: string, flags: readonly string[] = [], executable = cliPath): CliResult {
  return runCli(["build-cache", "--dir", root, "--prefix", "@acme/", ...flags], root, executable);
}

async function copyCliTo(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  await cp(path.resolve("dist"), path.join(directory, "dist"), { recursive: true });
  return path.join(directory, "dist", "cli.js");
}

async function writeCapPackage(directory: string, name: string, source: string): Promise<void> {
  await mkdir(path.join(directory, "srv"), { recursive: true });
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ name, dependencies: { "@sap/cds": "^9" } }));
  await writeFile(path.join(directory, "srv", "model.cds"), source);
}

async function writeWorkspaceCds(root: string, source?: string): Promise<void> {
  const moduleDirectory = path.join(root, "node_modules", "@sap", "cds");
  await mkdir(moduleDirectory, { recursive: true });
  await writeFile(path.join(moduleDirectory, "package.json"), JSON.stringify({
    name: "@sap/cds",
    type: "module",
    exports: "./index.js",
  }));
  const defaultSource = [
    'import { readFile } from "node:fs/promises";',
    'import path from "node:path";',
    'const cds = { compile: async (models) => {',
    '  if (JSON.stringify(models) !== JSON.stringify(["*"])) throw new Error("Expected compile([\\"*\\"])");',
    '  const payload = JSON.parse(await readFile(path.join(process.cwd(), "compile-result.json"), "utf8"));',
    '  if (typeof payload.error === "string") throw new Error(payload.error);',
    '  return payload.csn;',
    '} };',
    'export default cds;',
  ].join("\n");
  await writeFile(path.join(moduleDirectory, "index.js"), source ?? defaultSource);
}

async function writeCsnPackage(
  directory: string,
  name: string,
  source: string,
  payload: Readonly<Record<string, unknown>>,
): Promise<void> {
  await writeCapPackage(directory, name, source);
  await writeFile(path.join(directory, "compile-result.json"), JSON.stringify(payload));
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function occurrenceCount(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

async function writeCache(directory: string, csn: HanaLensCsn | string): Promise<void> {
  await writeFile(path.join(directory, CACHE_FILE_NAME), typeof csn === "string" ? csn : JSON.stringify(csn));
}

async function writeScopedCacheFixture(root: string): Promise<void> {
  await writeWorkspaceCds(root);
  const externalFromDb = { kind: "entity", "@cds.external": true, elements: { ID: { type: "cds.UUID", key: true } } };
  const externalFromService = { kind: "entity", "@cds.external": true, elements: { ID: { type: "cds.UUID", key: true }, label: { type: "cds.String" } } };
  await writeCsnPackage(
    path.join(root, "packages", "db_catalog"),
    "@acme/db_catalog",
    "namespace acme.catalog; type Status : String enum { ACTIVE; }; entity Widget { key ID: UUID; status: Status; }",
    { csn: { definitions: {
      "acme.catalog.Status": { kind: "type", type: "cds.String", enum: { ACTIVE: {} } },
      "acme.catalog.Widget": { kind: "entity", elements: { ID: { type: "cds.UUID", key: true }, status: { type: "acme.catalog.Status" } } },
      "remote.catalog.Product": externalFromDb,
    } } },
  );
  await writeCsnPackage(
    path.join(root, "packages", "srv_catalog"),
    "@acme/srv_catalog",
    "using { acme.catalog as db } from '@acme/db_catalog'; service CatalogService { entity Widgets as projection on db.Widget; }",
    { csn: { definitions: {
      "acme.api.CatalogService": { kind: "service" },
      "acme.api.CatalogService.Widgets": { kind: "entity", projection: { from: { ref: ["acme.catalog.Widget"] } } },
      "acme.api.CatalogService.UploadBuffer": { kind: "entity", elements: { ID: { type: "cds.UUID", key: true }, content: { type: "cds.LargeBinary" } } },
      "acme.shared": { kind: "context" },
      "remote.catalog.Product": externalFromService,
    } } },
  );
}

async function withTempWorkspace<T>(callback: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "hana-lens-e2e-"));
  try {
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

  it("documents cache kind, fallback, and strict build-cache flags in help", () => {
    const help = runCli(["--help"], process.cwd());
    expect(help.status).toBe(0);
    expect(help.stderr).toBe("");
    expect(help.stdout).toContain("build-cache --dir <workspace_path> --prefix <package_prefix> [--kind db|service|all] [--allow-fallback] [--strict]");
  });

  it("build-cache compiles matching CAP packages, ignores generated folders, writes minified origin metadata, and links siblings", async () => {
    await withTempWorkspace(async (root) => {
      await writeCapPackage(path.join(root, "packages", "sales"), "@acme/sales", "namespace acme.sales; entity BusinessRequest { key reqID: String(36); customer: Association to acme.master.Customer; }");
      await writeCapPackage(path.join(root, "packages", "master"), "@acme/master", "namespace acme.master; entity Customer { key ID: Integer; name: String(80); requests: Association to many acme.sales.BusinessRequest; }");
      await writeCapPackage(path.join(root, "gen", "ignored"), "@acme/ignored", "this is deliberately invalid cds and must never be compiled");
      await mkdir(path.join(root, "packages", "sales", "node_modules", "stray", "srv"), { recursive: true });
      await writeFile(path.join(root, "packages", "sales", "node_modules", "stray", "srv", "model.cds"), "namespace stray; entity DependencyEntity { key ID: Integer; }");
      await mkdir(path.join(root, "packages", "sales", "dist", "srv"), { recursive: true });
      await writeFile(path.join(root, "packages", "sales", "dist", "srv", "model.cds"), "namespace built; entity BuildEntity { key ID: Integer; }");
      const isolatedCli = await copyCliTo(path.join(root, "isolated-cli"));

      const build = runBuild(root, ["--allow-fallback"], isolatedCli);
      expect(build.status).toBe(0);
      expect(build.stderr).toContain("WARNING: DEGRADED regex fallback used for 2 package(s)");
      expect(build.stdout).toContain("packages=2");
      expect(build.stdout).toContain("compiled=2 skipped=0 via=fallback kind=db");
      expect(build.stdout).toContain(CACHE_FILE_NAME);

      const rawCache = await readFile(path.join(root, CACHE_FILE_NAME), "utf8");
      expect(rawCache.includes("\n")).toBe(false);
      const parsed = JSON.parse(rawCache) as HanaLensCsn;
      expect(parsed.definitions["acme.sales.BusinessRequest"]?.[PACKAGE_ANNOTATION]).toBe("@acme/sales");
      expect(parsed.definitions["acme.master.Customer"]?.[PACKAGE_ANNOTATION]).toBe("@acme/master");
      expect(parsed.definitions["stray.DependencyEntity"]).toBe(undefined);
      expect(parsed.definitions["built.BuildEntity"]).toBe(undefined);

      const salesToMaster = path.join(root, "packages", "sales", "node_modules", "@acme", "master");
      expect((await lstat(salesToMaster)).isSymbolicLink()).toBe(true);
      expect(await readlink(salesToMaster)).toBe(path.join(root, "packages", "master"));
    });
  }, 30_000);

  it("build-cache recovers a duplicate package name and compiles both packages", async () => {
    await withTempWorkspace(async (root) => {
      const invoice = path.join(root, "packages", "acme_billing_invoice");
      const ledger = path.join(root, "packages", "acme_billing_ledger");
      await writeCapPackage(invoice, "@acme/billing_invoice", "namespace acme.invoice; entity Invoice { key ID: Integer; }");
      await writeCapPackage(ledger, "@acme/billing_invoice", "namespace acme.ledger; entity Ledger { key ID: Integer; }");
      const isolatedCli = await copyCliTo(path.join(root, "isolated-cli"));

      const build = runBuild(root, ["--allow-fallback"], isolatedCli);

      expect(build.status).toBe(0);
      expect(build.stdout).toContain("packages=2");
      expect(build.stdout).toContain("compiled=2 skipped=0 via=fallback");
      expect(build.stderr).toContain("@acme/billing_invoice");
      expect(build.stderr).toContain(invoice);
      expect(build.stderr).toContain(ledger);
      expect(build.stderr).toContain("@acme/billing_ledger");
      expect(build.stderr).toContain("WARNING: DEGRADED regex fallback used for 2 package(s)");

      const parsed = await readCache(root);
      expect(parsed.definitions["acme.invoice.Invoice"]?.[PACKAGE_ANNOTATION]).toBe("@acme/billing_invoice");
      expect(parsed.definitions["acme.ledger.Ledger"]?.[PACKAGE_ANNOTATION]).toBe("@acme/billing_ledger");
    });
  }, 30_000);

  it("resolves a minimal CDS test double from the workspace and preserves its inherited CSN shape via cds", async () => {
    await withTempWorkspace(async (root) => {
      const packageDirectory = path.join(root, "packages", "db_catalog");
      await writeWorkspaceCds(root);
      await writeCsnPackage(
        packageDirectory,
        "@acme/db_catalog",
        "namespace acme; aspect base { key ID: UUID; } entity Widget : base { name: String(40); }",
        { csn: { definitions: {
          "acme.base": { kind: "aspect", elements: { ID: { key: true, type: "cds.UUID" } } },
          "acme.Widget": { kind: "entity", elements: { ID: { key: true, type: "cds.UUID" }, name: { type: "cds.String", length: 40 } } },
        } } },
      );

      const build = runBuild(root);

      // This deterministic test double proves workspace resolution, default unwrapping, compile(["*"]), via plumbing, and inherited-shape propagation; representative verification must prove full CAP compiler semantics.
      expect(build.status).toBe(0);
      expect(build.stderr).toBe("");
      expect(build.stdout).toContain("packages=1");
      expect(build.stdout).toContain("compiled=1 skipped=0 via=cds kind=db");
      const parsed = await readCache(root);
      expect(parsed.definitions["acme.Widget"]?.elements?.["ID"]).toEqual({ key: true, type: "cds.UUID" });
      expect(parsed.definitions["acme.Widget"]?.elements?.["name"]).toEqual({ type: "cds.String", length: 40 });
      expect(parsed.definitions["acme.Widget"]?.[PACKAGE_ANNOTATION]).toBe("@acme/db_catalog");
    });
  }, 30_000);

  it("scopes caches to db by default and supports service, all, invalid, and deterministic builds", async () => {
    await withTempWorkspace(async (root) => {
      await writeScopedCacheFixture(root);

      const firstDb = runBuild(root);
      const firstDbCache = await readFile(path.join(root, CACHE_FILE_NAME), "utf8");
      const secondDb = runBuild(root);
      const secondDbCache = await readFile(path.join(root, CACHE_FILE_NAME), "utf8");

      expect(firstDb.status).toBe(0);
      expect(firstDb.stderr).toBe("");
      expect(firstDb.stdout).toContain("cached=3");
      expect(firstDb.stdout).toContain("compiled=2 skipped=0 via=cds kind=db");
      expect(Object.keys((await readCache(root)).definitions)).toEqual([
        "acme.catalog.Status",
        "acme.catalog.Widget",
        "acme.api.CatalogService.UploadBuffer",
      ]);
      expect(secondDbCache).toBe(firstDbCache);
      expect(secondDb.stdout).toBe(firstDb.stdout);
      expect(secondDb.stderr).toBe(firstDb.stderr);

      const all = runBuild(root, ["--kind", "all"]);
      expect(all.status).toBe(0);
      expect(all.stdout).toContain("cached=7");
      expect(all.stdout).toContain("compiled=2 skipped=0 via=cds kind=all");
      expect(all.stderr).toContain("WARNING: 1 definition name(s) defined differently in >1 package");
      expect(Object.keys((await readCache(root)).definitions)).toEqual([
        "acme.catalog.Status",
        "acme.catalog.Widget",
        "remote.catalog.Product",
        "acme.api.CatalogService",
        "acme.api.CatalogService.Widgets",
        "acme.api.CatalogService.UploadBuffer",
        "acme.shared",
      ]);

      const service = runBuild(root, ["--kind", "service"]);
      expect(service.status).toBe(0);
      expect(service.stdout).toContain("cached=6");
      expect(service.stdout).toContain("compiled=2 skipped=0 via=cds kind=service");
      expect(Object.keys((await readCache(root)).definitions)).toEqual([
        "acme.catalog.Status",
        "remote.catalog.Product",
        "acme.api.CatalogService",
        "acme.api.CatalogService.Widgets",
        "acme.api.CatalogService.UploadBuffer",
        "acme.shared",
      ]);

      await rm(path.join(root, CACHE_FILE_NAME), { force: true });
      const invalid = runBuild(root, ["--kind", "bogus"]);
      expect(invalid.status).toBe(1);
      expect(invalid.stderr).toContain('--kind must be one of db|service|all (got "bogus")');
      expect(await fileExists(path.join(root, CACHE_FILE_NAME))).toBe(false);
    });
  }, 30_000);

  it("resolves CDS beside an isolated CLI and still gives the analyzed workspace precedence", async () => {
    await withTempWorkspace(async (root) => {
      const isolatedCliRoot = path.join(root, "isolated-cli");
      const isolatedCliPath = await copyCliTo(isolatedCliRoot);
      await writeWorkspaceCds(isolatedCliRoot, [
        'const cds = { compile: async () => ({ definitions: {',
        '  "acme.FromCli": { kind: "entity", elements: { ID: { key: true, type: "cds.UUID" } } }',
        '} }) };',
        'export default cds;',
      ].join("\n"));

      const cliOnlyWorkspace = path.join(root, "cli-only-workspace");
      await writeCapPackage(path.join(cliOnlyWorkspace, "db_cli"), "@acme/db_cli", "namespace acme; entity FromCli { key ID: UUID; }");
      const cliOnly = runCli(
        ["build-cache", "--dir", cliOnlyWorkspace, "--prefix", "@acme/"],
        cliOnlyWorkspace,
        isolatedCliPath,
      );
      expect(cliOnly.status).toBe(0);
      expect(cliOnly.stdout).toContain("via=cds");
      expect((await readCache(cliOnlyWorkspace)).definitions["acme.FromCli"]?.[PACKAGE_ANNOTATION]).toBe("@acme/db_cli");

      const workspaceFirst = path.join(root, "workspace-first");
      await writeWorkspaceCds(workspaceFirst, [
        'const cds = { compile: async () => ({ definitions: {',
        '  "acme.FromWorkspace": { kind: "entity", elements: { ID: { key: true, type: "cds.UUID" } } }',
        '} }) };',
        'export default cds;',
      ].join("\n"));
      await writeCapPackage(path.join(workspaceFirst, "db_workspace"), "@acme/db_workspace", "namespace acme; entity FromWorkspace { key ID: UUID; }");
      const preferred = runCli(
        ["build-cache", "--dir", workspaceFirst, "--prefix", "@acme/"],
        workspaceFirst,
        isolatedCliPath,
      );
      const preferredCache = await readCache(workspaceFirst);
      expect(preferred.status).toBe(0);
      expect(preferredCache.definitions["acme.FromWorkspace"]?.[PACKAGE_ANNOTATION]).toBe("@acme/db_workspace");
      expect(preferredCache.definitions["acme.FromCli"]).toBe(undefined);
    });
  }, 30_000);

  it("fails closed without resolvable CDS and writes no cache", async () => {
    await withTempWorkspace(async (root) => {
      await writeCapPackage(path.join(root, "packages", "db_plain"), "@acme/db_plain", "namespace acme; entity Plain { key ID: UUID; }");
      const isolatedCli = await copyCliTo(path.join(root, "isolated-cli"));

      const build = runBuild(root, [], isolatedCli);

      expect(build.status).toBe(1);
      expect(build.stderr).toContain("@sap/cds is not resolvable");
      expect(build.stderr).toContain("Pass --allow-fallback to accept a DEGRADED cache");
      expect(await fileExists(path.join(root, CACHE_FILE_NAME))).toBe(false);

      const strict = runBuild(root, ["--strict"], isolatedCli);
      expect(strict.status).toBe(1);
      expect(strict.stderr).toContain("@sap/cds is not resolvable");
      expect(strict.stderr).toContain("Pass --allow-fallback to accept a DEGRADED cache");
    });
  }, 30_000);

  it("does not fall back when resolved CDS has no compile API", async () => {
    await withTempWorkspace(async (root) => {
      await writeWorkspaceCds(root, "export default {};");
      await writeCapPackage(path.join(root, "packages", "db_invalid_api"), "@acme/db_invalid_api", "namespace acme; entity InvalidApi { key ID: UUID; }");

      const build = runBuild(root, ["--allow-fallback"]);

      expect(build.status).toBe(1);
      expect(build.stderr).toContain("@sap/cds resolved but exposes no compile() API");
      expect(build.stderr.includes("DEGRADED regex fallback used")).toBe(false);
      expect(await fileExists(path.join(root, CACHE_FILE_NAME))).toBe(false);
    });
  }, 30_000);

  it("propagates compiler errors that resemble the old module-resolution message", async () => {
    await withTempWorkspace(async (root) => {
      await writeWorkspaceCds(root, [
        'const cds = { compile: async () => {',
        '  throw new Error("Cannot find package \'@sap/cds\' from neutral compiler");',
        '} };',
        'export default cds;',
      ].join("\n"));
      await writeCapPackage(path.join(root, "packages", "db_model_error"), "@acme/db_model_error", "namespace acme; entity ModelError { key ID: UUID; }");

      const build = runBuild(root, ["--allow-fallback"]);

      expect(build.status).toBe(1);
      expect(build.stderr).toContain("Cannot find package '@sap/cds' from neutral compiler");
      expect(build.stderr.includes("DEGRADED regex fallback used")).toBe(false);
      expect(await fileExists(path.join(root, CACHE_FILE_NAME))).toBe(false);
    });
  }, 30_000);

  it("uses the degraded parser only when explicitly allowed and reports fallback provenance", async () => {
    await withTempWorkspace(async (root) => {
      await writeCapPackage(path.join(root, "packages", "db_plain"), "@acme/db_plain", "namespace acme; entity Plain { key ID: UUID; }");
      const isolatedCli = await copyCliTo(path.join(root, "isolated-cli"));

      const build = runBuild(root, ["--allow-fallback"], isolatedCli);

      expect(build.status).toBe(0);
      expect(build.stderr).toContain("WARNING: DEGRADED regex fallback used for 1 package(s)");
      expect(build.stdout).toContain("compiled=1 skipped=0 via=fallback");
      expect((await readCache(root)).definitions["acme.Plain"]?.[PACKAGE_ANNOTATION]).toBe("@acme/db_plain");
    });
  }, 30_000);

  it("aggregates mixed workspace CDS and opt-in fallback compilation paths", async () => {
    await withTempWorkspace(async (root) => {
      const cdsPackage = path.join(root, "packages", "db_cds");
      await writeWorkspaceCds(cdsPackage);
      await writeCsnPackage(cdsPackage, "@acme/db_cds", "namespace acme; entity FromCds { key ID: UUID; }", {
        csn: { definitions: { "acme.FromCds": { kind: "entity", elements: { ID: { key: true, type: "cds.UUID" } } } } },
      });
      await writeCapPackage(path.join(root, "packages", "db_fallback"), "@acme/db_fallback", "namespace acme; entity FromFallback { key ID: UUID; }");
      const isolatedCli = await copyCliTo(path.join(root, "isolated-cli"));

      const build = runBuild(root, ["--allow-fallback"], isolatedCli);

      expect(build.status).toBe(0);
      expect(build.stderr).toContain("WARNING: DEGRADED regex fallback used for 1 package(s)");
      expect(build.stdout).toContain("compiled=2 skipped=0 via=cds+fallback(1)");
    });
  }, 30_000);

  it("isolates package compiler failures by default and aborts them in strict mode", async () => {
    await withTempWorkspace(async (root) => {
      await writeWorkspaceCds(root);
      await writeCsnPackage(path.join(root, "packages", "db_good"), "@acme/db_good", "namespace acme; entity Good { key ID: UUID; }", {
        csn: { definitions: { "acme.Good": { kind: "entity", elements: { ID: { key: true, type: "cds.UUID" } } } } },
      });
      await writeCsnPackage(path.join(root, "packages", "db_broken"), "@acme/db_broken", "this model is intentionally broken", {
        error: "MODEL_ERROR neutral fixture",
      });
      await writeCsnPackage(path.join(root, "packages", "helper_empty"), "@acme/helper_empty", "namespace acme.empty;", {
        csn: { definitions: {} },
      });

      const build = runBuild(root);

      expect(build.status).toBe(0);
      expect(build.stderr).toContain("Skipped 1/3 package(s): @acme/db_broken");
      expect(build.stdout).toContain("packages=3");
      expect(build.stdout).toContain("compiled=2 skipped=1 via=cds");
      expect((await readCache(root)).definitions["acme.Good"]?.[PACKAGE_ANNOTATION]).toBe("@acme/db_good");

      await rm(path.join(root, CACHE_FILE_NAME), { force: true });
      const strict = runBuild(root, ["--strict"]);
      expect(strict.status).toBe(1);
      expect(strict.stderr).toContain("Strict mode: 1 package(s) failed to compile: @acme/db_broken");
      expect(await fileExists(path.join(root, CACHE_FILE_NAME))).toBe(false);
    });
  }, 30_000);

  it("fails when every discovered package fails to compile", async () => {
    await withTempWorkspace(async (root) => {
      await writeWorkspaceCds(root);
      await writeCsnPackage(path.join(root, "packages", "db_broken_alpha"), "@acme/db_broken_alpha", "this model is intentionally broken", {
        error: "MODEL_ERROR first package failed",
      });
      await writeCsnPackage(path.join(root, "packages", "db_broken_beta"), "@acme/db_broken_beta", "this model is also intentionally broken", {
        error: "MODEL_ERROR second package failed",
      });

      const build = runBuild(root);

      expect(build.status).toBe(1);
      expect(build.stderr).toContain("No packages compiled successfully");
      expect(build.stderr).toContain("MODEL_ERROR first package failed");
      expect(await fileExists(path.join(root, CACHE_FILE_NAME))).toBe(false);
    });
  }, 30_000);

  it("search reads an existing cache offline, supports fuzzy and regex modes, limits output, and reports regex errors", async () => {
    await withTempWorkspace(async (root) => {
      await writeCache(root, { definitions: {
        "demo.sales.BusinessRequest": { [PACKAGE_ANNOTATION]: "@demo/sales" },
        "demo.sales.BusinessRequestItem": { [PACKAGE_ANNOTATION]: "@demo/sales" },
        "demo.master.Customer": { [PACKAGE_ANNOTATION]: "@demo/master" },
        ...Object.fromEntries(Array.from({ length: 20 }, (_value, index) => [`demo.generated.Entity${(19 - index).toString().padStart(2, "0")}`, { [PACKAGE_ANNOTATION]: "@demo/generated" }])),
      } });

      const fuzzy = runCli(["search", "BusinessReq"], root);
      expect(fuzzy.status).toBe(0);
      expect(fuzzy.stderr).toBe("");
      expect(fuzzy.stdout).toContain("demo.sales.BusinessRequest|@demo/sales");

      const regex = runCli(["search", "Customer$", "--regex"], root);
      expect(regex.status).toBe(0);
      expect(regex.stdout).toBe("demo.master.Customer|@demo/master\n");

      const shortRegex = runCli(["search", "^Customer$", "--regex"], root);
      expect(shortRegex.status).toBe(0);
      expect(shortRegex.stdout).toBe("demo.master.Customer|@demo/master\n");

      const groupedRegex = runCli(["search", "^(demo\\.master\\..*)?Customer$", "--regex"], root);
      expect(groupedRegex.status).toBe(0);
      expect(groupedRegex.stdout).toBe("demo.master.Customer|@demo/master\n");

      const limited = runCli(["search", "demo"], root);
      expect(limited.status).toBe(0);
      expect(limited.stdout.trim().split("\n")).toHaveLength(11);
      expect(limited.stdout).toContain("... showing 10 of 23 matches\n");

      const regexLimited = runCli(["search", "^demo\\.generated\\.", "--regex"], root);
      expect(regexLimited.status).toBe(0);
      expect(regexLimited.stdout.split("\n")[0]).toBe("demo.generated.Entity00|@demo/generated");
      expect(regexLimited.stdout).toContain("... showing 10 of 20 matches\n");

      const empty = runCli(["search", "NeverMatches$", "--regex"], root);
      expect(empty.status).toBe(0);
      expect(empty.stdout).toBe('No matches for "NeverMatches$"\n');

      const invalidRegex = runCli(["search", "[", "--regex"], root);
      expect(invalidRegex.status).toBe(1);
      expect(invalidRegex.stderr).toContain("Invalid regular expression");
    });
  });

  it("describe reads an existing cache offline, prints dense fields, expands associations, and guards circular or missing targets", async () => {
    await withTempWorkspace(async (root) => {
      await writeCache(root, { definitions: {
        "demo.sales.BusinessRequest": { [PACKAGE_ANNOTATION]: "@demo/sales", elements: { reqID: { key: true, type: "cds.String", length: 36 }, tenantID: { key: true, type: "cds.String", length: 36 }, createdAt: { "@Core.Computed": true, type: "cds.Timestamp" }, generatedID: { key: true, "@Core.Computed": true, type: "cds.UUID" }, amount: { type: "cds.Decimal", precision: 3, scale: 1 }, history: { items: { type: "cds.Map" } }, labels: { items: { elements: { value: { type: "cds.String" }, label: { type: "cds.String" } } } }, status: { type: "cds.String", enum: { ACTIVE: { val: "A" }, INACTIVE: { val: "INACTIVE" } }, "@readonly": true, "@title": "Status" }, statusText: { type: "cds.String" }, customer: { type: "cds.Association", target: "Customer", on: [{ ref: ["customer", "ID"] }, "=", { ref: ["customerID"] }, "and", { ref: ["customer", "tenantID"] }, "=", { ref: ["tenantID"] }] }, missing: { type: "cds.Composition", target: "demo.master.Missing", cardinality: { max: "*" } } } },
        "demo.master.Customer": { [PACKAGE_ANNOTATION]: "@demo/master", elements: { ID: { key: true, type: "cds.Integer" }, name: { type: "cds.String", length: 80 }, request: { type: "cds.Association", target: "demo.sales.BusinessRequest" } } },
        "demo.other.BusinessRequest": { [PACKAGE_ANNOTATION]: "@demo/other", elements: { ID: { key: true, type: "cds.UUID" } } },
        "demo.other.RequestAudit": { [PACKAGE_ANNOTATION]: "@demo/other", elements: { request: { type: "cds.Association", target: "demo.other.BusinessRequest" } } },
        "demo.sales.BusinessRequestView": { [PACKAGE_ANNOTATION]: "@demo/service", kind: "entity", projection: { from: { ref: ["demo.sales.BusinessRequest"] } } },
        "demo.common.RequestStatus": { [PACKAGE_ANNOTATION]: "@demo/common", kind: "type", type: "cds.String", enum: { SUBMITTED: { val: "S" }, REJECTED: { val: "REJECTED" } } },
        "demo.common.UserName": { [PACKAGE_ANNOTATION]: "@demo/common", kind: "type", type: "cds.String", length: 255 },
        "demo.common.CustomerLink": { [PACKAGE_ANNOTATION]: "@demo/common", kind: "type", type: "cds.Association", target: "demo.master.Customer" },
        User: { [PACKAGE_ANNOTATION]: "@demo/common", kind: "type", type: "cds.String" },
        "demo.identity.User": { [PACKAGE_ANNOTATION]: "@demo/identity", kind: "entity", elements: { ID: { key: true, type: "cds.UUID" } } },
        "demo.identity.UserAudit": { [PACKAGE_ANNOTATION]: "@demo/identity", kind: "entity", elements: { user: { type: "cds.Association", target: "demo.identity.User" } } },
        "demo.operations.Lookup": { [PACKAGE_ANNOTATION]: "@demo/operations", kind: "function", params: { requestID: { type: "cds.UUID" } }, returns: { type: "cds.Boolean" } },
        "demo.empty.EmptyEntity": { [PACKAGE_ANNOTATION]: "@demo/empty" },
      } });

      const compact = runCli(["describe", "demo.sales.BusinessRequest"], root);
      expect(compact.status).toBe(0);
      expect(compact.stdout).toContain("[PK] reqID: cds.String(36)");
      expect(compact.stdout).toContain("[PK] tenantID: cds.String(36)");
      expect(compact.stdout).toContain("[computed] createdAt: cds.Timestamp");
      expect(compact.stdout).toContain("[PK] [computed] generatedID: cds.UUID");
      expect(compact.stdout).toContain("amount: cds.Decimal(3, 1)");
      expect(compact.stdout).toContain("history: array of cds.Map");
      expect(compact.stdout).toContain("labels: array of { value, label }");
      expect(compact.stdout).toContain('status: cds.String enum[ACTIVE = "A", INACTIVE]');
      expect(compact.stdout.includes("@readonly=true")).toBe(false);
      expect(compact.stdout).toContain("customer: cds.Association to Customer ON [customer.ID = customerID and customer.tenantID = tenantID]");
      expect(compact.stdout).toContain("missing: cds.Composition to many demo.master.Missing");
      expect(compact.stdout.includes("- [PK] ID")).toBe(false);

      const annotated = runCli(["describe", "demo.sales.BusinessRequest", "--with-annotations"], root);
      expect(annotated.status).toBe(0);
      expect(annotated.stdout).toContain('status: cds.String enum[ACTIVE = "A", INACTIVE] @readonly=true @title="Status"');

      const references = runCli(["references", "demo.sales.BusinessRequest"], root);
      expect(references.status).toBe(0);
      expect(references.stdout).toBe("Incoming References to [demo.sales.BusinessRequest]:\n- demo.master.Customer (via field: request)\n- demo.sales.BusinessRequestView (via field: (projection))\n");

      const shortReferences = runCli(["references", "BusinessRequest"], root);
      expect(shortReferences.status).toBe(0);
      expect(shortReferences.stdout).toContain('Note: "BusinessRequest" matched 2 definitions (demo.other.BusinessRequest, demo.sales.BusinessRequest); references below are the union.');
      expect(shortReferences.stdout).toContain("- demo.master.Customer (via field: request)");
      expect(shortReferences.stdout).toContain("- demo.other.RequestAudit (via field: request)");

      const shadowedShortReferences = runCli(["references", "User"], root);
      expect(shadowedShortReferences.status).toBe(0);
      expect(shadowedShortReferences.stdout).toContain('Note: "User" matched 2 definitions');
      expect(shadowedShortReferences.stdout).toContain("references below are the union.");
      expect(shadowedShortReferences.stdout).toContain("- demo.identity.UserAudit (via field: user)");

      const exactUserReferences = runCli(["references", "demo.identity.User"], root);
      expect(exactUserReferences.status).toBe(0);
      expect(exactUserReferences.stdout).toBe("Incoming References to [demo.identity.User]:\n- demo.identity.UserAudit (via field: user)\n");

      const exactShortDescribe = runCli(["describe", "User"], root);
      expect(exactShortDescribe.status).toBe(0);
      expect(exactShortDescribe.stdout).toBe("cds.String\n");

      const shortDescribe = runCli(["describe", "Customer"], root);
      expect(shortDescribe.status).toBe(0);
      expect(shortDescribe.stdout).toContain("[PK] ID: cds.Integer");

      const ambiguousDescribe = runCli(["describe", "BusinessRequest"], root);
      expect(ambiguousDescribe.status).toBe(1);
      expect(ambiguousDescribe.stderr).toContain('Ambiguous name "BusinessRequest" matches 2 definitions');

      const fieldSearch = runCli(["search-field", "status"], root);
      expect(fieldSearch.status).toBe(0);
      expect(fieldSearch.stdout).toBe('Field matching "status" found in:\n- demo.sales.BusinessRequest (exact: status)\n- demo.sales.BusinessRequest (matched: statusText)\n');

      const emptyFieldSearch = runCli(["search-field", "neverMatches"], root);
      expect(emptyFieldSearch.status).toBe(0);
      expect(emptyFieldSearch.stdout).toBe('No field matches for "neverMatches"\n');

      expect(runCli(["describe", "demo.common.RequestStatus"], root).stdout).toBe('cds.String enum[SUBMITTED = "S", REJECTED]\n');
      expect(runCli(["describe", "demo.common.UserName"], root).stdout).toBe("cds.String(255)\n");
      expect(runCli(["describe", "demo.common.CustomerLink"], root).stdout).toBe("cds.Association to demo.master.Customer\n");
      expect(runCli(["describe", "demo.operations.Lookup"], root).stdout).toBe("(function)\n- param requestID: cds.UUID\n- returns: cds.Boolean\n");

      const nonsense = runCli(["search", "utterly-nonsensical-query"], root);
      expect(nonsense.status).toBe(0);
      expect(nonsense.stdout).toBe('No matches for "utterly-nonsensical-query"\n');

      const expanded = runCli(["describe", "demo.sales.BusinessRequest", "--expand"], root);
      expect(expanded.status).toBe(0);
      expect(expanded.stdout).toContain("- [PK] ID: cds.Integer");
      expect(expanded.stdout.includes("- Customer: missing")).toBe(false);
      expect(expanded.stdout).toContain("-- demo.sales.BusinessRequest: circular");
      expect(expanded.stdout).toContain("- demo.master.Missing: missing");

      expect(runCli(["describe", "demo.empty.EmptyEntity"], root).stdout).toBe("(no elements)\n");
    });
  });

  it("reports actionable failures for empty workspaces, missing caches, malformed caches, invalid cache shapes, and missing entities", async () => {
    await withTempWorkspace(async (root) => {
      const empty = runBuild(root);
      expect(empty.status).toBe(1);
      expect(empty.stderr).toContain("No packages starting with @acme/");

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

      const missingReferences = runCli(["references", "Missing"], root);
      expect(missingReferences.status).toBe(1);
      expect(missingReferences.stderr).toContain("Entity not found: Missing");
    });
  });

  it("silently collapses identical definitions emitted by multiple fallback packages", async () => {
    await withTempWorkspace(async (root) => {
      await writeCapPackage(path.join(root, "db_first"), "@acme/db_first", "namespace acme.dup; entity Shared { key ID: Integer; }");
      await writeCapPackage(path.join(root, "db_second"), "@acme/db_second", "namespace acme.dup; entity Shared { key ID: Integer; }");
      const isolatedCli = await copyCliTo(path.join(root, "isolated-cli"));

      const result = runBuild(root, ["--allow-fallback"], isolatedCli);

      expect(result.status).toBe(0);
      expect(result.stderr.includes("defined differently")).toBe(false);
      expect(Object.keys((await readCache(root)).definitions)).toEqual(["acme.dup.Shared"]);
    });
  }, 30_000);

  it("collapses a shared aspect re-emitted by two importing db packages", async () => {
    await withTempWorkspace(async (root) => {
      await writeWorkspaceCds(root);
      const shared = { kind: "aspect", elements: { ID: { key: true, type: "cds.UUID" } } };
      await writeCsnPackage(path.join(root, "packages", "db_common"), "@acme/db_common", "namespace acme.common; aspect base { key ID: UUID; }", {
        csn: { definitions: { "acme.common.base": shared } },
      });
      await writeCsnPackage(path.join(root, "packages", "db_alpha"), "@acme/db_alpha", "using { acme.common.base } from '@acme/db_common'; namespace acme.alpha; entity Alpha : base { name: String(40); }", {
        csn: { definitions: {
          "acme.common.base": shared,
          "acme.alpha.Alpha": { kind: "entity", elements: { ID: { key: true, type: "cds.UUID" }, name: { type: "cds.String", length: 40 } } },
        } },
      });
      await writeCsnPackage(path.join(root, "packages", "db_beta"), "@acme/db_beta", "using { acme.common.base } from '@acme/db_common'; namespace acme.beta; entity Beta : base { label: String(60); }", {
        csn: { definitions: {
          "acme.common.base": shared,
          "acme.beta.Beta": { kind: "entity", elements: { ID: { key: true, type: "cds.UUID" }, label: { type: "cds.String", length: 60 } } },
        } },
      });

      const result = runBuild(root);
      const cache = await readCache(root);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(Object.keys(cache.definitions)).toEqual(["acme.common.base", "acme.alpha.Alpha", "acme.beta.Beta"]);
    });
  }, 30_000);

  it("silently collapses a service package re-emitting an imported db definition", async () => {
    await withTempWorkspace(async (root) => {
      await writeWorkspaceCds(root);
      const shared = { kind: "entity", elements: { ID: { key: true, type: "cds.UUID" }, title: { type: "cds.String", length: 80 } } };
      await writeCsnPackage(path.join(root, "packages", "db_catalog"), "@acme/db_catalog", "namespace acme.catalog; entity Widget { key ID: UUID; title: String(80); }", {
        csn: { definitions: { "acme.catalog.Widget": shared } },
      });
      await writeCsnPackage(path.join(root, "packages", "srv_catalog"), "@acme/srv_catalog", "using { acme.catalog as db } from '@acme/db_catalog'; service Catalog { entity Widgets as projection on db.Widget; }", {
        csn: { definitions: { "acme.catalog.Widget": shared } },
      });

      const result = runBuild(root);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(Object.keys((await readCache(root)).definitions)).toEqual(["acme.catalog.Widget"]);
    });
  }, 30_000);

  it("warns and keeps one conflicting definition by default, then aborts under strict mode", async () => {
    await withTempWorkspace(async (root) => {
      await writeCapPackage(path.join(root, "db_first"), "@acme/db_first", "namespace acme.dup; entity Shared { key ID: Integer; }");
      await writeCapPackage(path.join(root, "db_second"), "@acme/db_second", "namespace acme.dup; entity Shared { key code: String(20); }");
      const isolatedCli = await copyCliTo(path.join(root, "isolated-cli"));

      const result = runBuild(root, ["--allow-fallback"], isolatedCli);

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("WARNING: 1 definition name(s) defined differently in >1 package");
      expect(result.stderr).toContain("acme.dup.Shared (@acme/db_first vs @acme/db_second)");
      expect((await readCache(root)).definitions["acme.dup.Shared"]?.elements?.["ID"]?.key).toBe(true);

      await rm(path.join(root, CACHE_FILE_NAME), { force: true });
      const strict = runBuild(root, ["--allow-fallback", "--strict"], isolatedCli);
      expect(strict.status).toBe(1);
      expect(strict.stderr).toContain("Strict mode: 1 conflicting definition name(s)");
      expect(await fileExists(path.join(root, CACHE_FILE_NAME))).toBe(false);
    });
  }, 30_000);

  it("produces byte-identical cache and stable skip/conflict diagnostics across repeated builds", async () => {
    await withTempWorkspace(async (root) => {
      await writeWorkspaceCds(root);
      await writeCsnPackage(path.join(root, "packages", "db_alpha"), "@acme/db_alpha", "namespace acme; entity Stable { key ID: UUID; }", {
        csn: { definitions: { "acme.Stable": { kind: "entity", elements: { ID: { key: true, type: "cds.UUID" } } } } },
      });
      await writeCsnPackage(path.join(root, "packages", "db_beta"), "@acme/db_beta", "namespace acme; entity Stable { key code: String(20); }", {
        csn: { definitions: { "acme.Stable": { kind: "entity", elements: { code: { key: true, type: "cds.String", length: 20 } } } } },
      });
      await writeCsnPackage(path.join(root, "packages", "srv_broken"), "@acme/srv_broken", "this model is intentionally broken", {
        error: "MODEL_ERROR deterministic fixture",
      });

      const first = runBuild(root);
      const firstCache = await readFile(path.join(root, CACHE_FILE_NAME), "utf8");
      const second = runBuild(root);
      const secondCache = await readFile(path.join(root, CACHE_FILE_NAME), "utf8");

      expect(first.status).toBe(0);
      expect(second.status).toBe(0);
      expect(secondCache).toBe(firstCache);
      expect(second.stdout).toBe(first.stdout);
      expect(second.stderr).toBe(first.stderr);
      expect(occurrenceCount(first.stderr, "definition name(s) defined differently")).toBe(1);
      expect(occurrenceCount(first.stderr, "Skipped 1/3 package(s)")).toBe(1);
    });
  }, 30_000);
