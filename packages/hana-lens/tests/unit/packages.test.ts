import { chmod, mkdtemp, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock } from "node:test";

import { autoLinkPackages, normalizePackagePrefix, packageScope, scanForPackages } from "../../src/packages.js";
import type { PackageScanWarning, SapPackage } from "../../src/types.js";
import { expect } from "../helpers/expect.js";
import { describe, it } from "../helpers/test.js";

interface ScanCapture {
  readonly packages: readonly SapPackage[];
  readonly warnings: readonly PackageScanWarning[];
  readonly excluded: readonly PackageScanWarning[];
  readonly stderr: string;
}

describe("package scanning and linking", () => {
  it("validates scoped prefixes and extracts npm scopes", () => {
    expect(normalizePackagePrefix("@demo")).toBe("@demo/");
    expect(normalizePackagePrefix(" @demo/ ")).toBe("@demo/");
    expect(packageScope("@demo/")).toBe("@demo");
    expect(() => normalizePackagePrefix("@demo/tools")).toThrow("package scope");
    expect(() => packageScope("demo/")).toThrow("scoped package prefix");
  });
  it("finds prefixed packages and ignores generated folders", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hana-lens-"));
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "root" }));
    await writeFile(path.join(root, "broken.json"), "{");
    await fsMkdir(path.join(root, "packages", "a"));
    await writeFile(path.join(root, "packages", "a", "package.json"), JSON.stringify({ name: "@demo/a" }));
    await fsMkdir(path.join(root, "gen", "b"));
    await writeFile(path.join(root, "gen", "b", "package.json"), JSON.stringify({ name: "@demo/b" }));
    await expect(scanForPackages(root, "@demo/")).resolves.toEqual({ packages: [{ name: "@demo/a", directory: path.join(root, "packages", "a") }], warnings: [], excluded: [] });
    await rm(root, { recursive: true, force: true });
  });

  it("warns and continues past malformed package JSON instead of aborting the scan", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hana-lens-malformed-"));
    const bad = path.join(root, "bad");
    await fsMkdir(bad);
    await writeFile(path.join(bad, "package.json"), "{");
    await fsMkdir(path.join(root, "good"));
    await writeFile(path.join(root, "good", "package.json"), JSON.stringify({ name: "@demo/good" }));

    const result = await scanWithStderr(root);

    expect(result.packages).toEqual([{ name: "@demo/good", directory: path.join(root, "good") }]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.directory).toBe(bad);
    expect(result.warnings[0]?.reason).toContain("Malformed package.json");
    expect(result.stderr).toContain("Malformed package.json");
    expect(result.stderr).toContain(bad);
    await rm(root, { recursive: true, force: true });
  });

  it("recurses into nested packages beneath a directory with malformed package.json", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hana-lens-malformed-nested-"));
    const malformed = path.join(root, "workspace");
    const nested = path.join(malformed, "nested");
    await fsMkdir(malformed);
    await writeFile(path.join(malformed, "package.json"), "{ not valid json");
    await fsMkdir(nested);
    await writeFile(path.join(nested, "package.json"), JSON.stringify({ name: "@demo/nested" }));

    const result = await scanWithStderr(root);

    expect(result.packages).toEqual([{ name: "@demo/nested", directory: nested }]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.directory).toBe(malformed);
    expect(result.warnings[0]?.reason).toContain("Malformed package.json");
    expect(result.stderr).toContain("Malformed package.json");
    expect(result.stderr).toContain(malformed);
    await rm(root, { recursive: true, force: true });
  });

  it("distinguishes an unreadable package.json from malformed JSON with a different reason and error code", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hana-lens-unreadable-"));
    const goodDirectory = path.join(root, "good");
    const malformedDirectory = path.join(root, "malformed");
    const unreadableDirectory = path.join(root, "unreadable");
    await fsMkdir(goodDirectory);
    await writeFile(path.join(goodDirectory, "package.json"), JSON.stringify({ name: "@demo/good" }));
    await fsMkdir(malformedDirectory);
    await writeFile(path.join(malformedDirectory, "package.json"), "{");
    await fsMkdir(unreadableDirectory);
    const unreadablePackageJson = path.join(unreadableDirectory, "package.json");
    await writeFile(unreadablePackageJson, JSON.stringify({ name: "@demo/unreadable" }));
    await chmod(unreadablePackageJson, 0o000);

    try {
      const result = await scanWithStderr(root);

      expect(result.packages).toEqual([{ name: "@demo/good", directory: goodDirectory }]);
      expect(result.warnings).toHaveLength(2);
      const malformedWarning = result.warnings.find((warning) => warning.directory === malformedDirectory);
      const unreadableWarning = result.warnings.find((warning) => warning.directory === unreadableDirectory);
      expect(malformedWarning?.reason).toContain("Malformed package.json");
      expect(unreadableWarning?.reason).toContain("Unable to read package.json");
      expect(unreadableWarning?.reason).toContain("EACCES");
      expect(unreadableWarning?.reason.includes("Malformed package.json")).toBe(false);
    } finally {
      await chmod(unreadablePackageJson, 0o644);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the closest folder match and renames the colliding package", async () => {
    await withTempWorkspace("hana-lens-duplicate-package-", async (root): Promise<void> => {
      const invoice = path.join(root, "demo_billing_invoice");
      const ledger = path.join(root, "demo_billing_ledger");
      await writePackageJson(invoice, "@demo/billing_invoice");
      await writePackageJson(ledger, "@demo/billing_invoice");

      const result = await scanWithStderr(root);

      expect(result.packages).toEqual([
        { name: "@demo/billing_invoice", directory: invoice },
        { name: "@demo/billing_ledger", directory: ledger },
      ]);
      expect(result.stderr).toContain("@demo/billing_invoice");
      expect(result.stderr).toContain(invoice);
      expect(result.stderr).toContain(ledger);
      expect(result.stderr).toContain("@demo/billing_ledger");
      expect(result.stderr.trim().split("\n")).toHaveLength(1);
    });
  });

  it("renames every loser in a three-way collision and preserves folder casing", async () => {
    await withTempWorkspace("hana-lens-three-way-package-", async (root): Promise<void> => {
      const winner = path.join(root, "Demo-Shared");
      const ledger = path.join(root, "DEMO-BillingLedger");
      const emptyAfterStrip = path.join(root, "demo_");
      await writePackageJson(winner, "@demo/shared");
      await writePackageJson(ledger, "@demo/shared");
      await writePackageJson(emptyAfterStrip, "@demo/shared");

      const result = await scanWithStderr(root);
      const expected = [
        { name: "@demo/shared", directory: winner },
        { name: "@demo/BillingLedger", directory: ledger },
        { name: "@demo/demo_", directory: emptyAfterStrip },
      ].sort((left, right) => left.name.localeCompare(right.name));

      expect(result.packages).toEqual(expected);
      expect(result.stderr.trim().split("\n")).toHaveLength(2);
    });
  });

  it("breaks equal edit-distance ties by directory instead of scan order", async () => {
    await withTempWorkspace("hana-lens-package-tie-", async (root): Promise<void> => {
      const lexicalWinner = path.join(root, "a", "aby");
      const discoveredFirst = path.join(root, "z", "abx");
      await writePackageJson(discoveredFirst, "@demo/abc");
      await writePackageJson(lexicalWinner, "@demo/abc");

      const result = await scanWithStderr(root);

      expect(result.packages).toEqual([
        { name: "@demo/abc", directory: lexicalWinner },
        { name: "@demo/abx", directory: discoveredFirst },
      ]);
    });
  });

  it("keeps one deterministic survivor rather than dropping the whole group when two losers derive the same fallback name", async () => {
    await withTempWorkspace("hana-lens-fallback-pair-", async (root): Promise<void> => {
      const alpha = path.join(root, "alpha");
      const beta = path.join(root, "beta");
      const alphaCore = path.join(root, "domain-a", "core");
      const betaCore = path.join(root, "domain-b", "core");
      await writePackageJson(alpha, "@demo/alpha");
      await writePackageJson(alphaCore, "@demo/alpha");
      await writePackageJson(beta, "@demo/beta");
      await writePackageJson(betaCore, "@demo/beta");

      const result = await scanWithStderr(root);

      // Neither loser kept its declared name, so the fallback-name collision has no
      // keptDeclaredName tiebreaker to fall back on -- the directory-sorted-first candidate
      // (domain-a sorts before domain-b) survives as "@demo/core" instead of the whole group
      // being silently dropped, and the other loser is reported via `excluded`, not just stderr.
      expect(result.packages).toEqual([
        { name: "@demo/alpha", directory: alpha },
        { name: "@demo/beta", directory: beta },
        { name: "@demo/core", directory: alphaCore },
      ]);
      expect(result.stderr.trim().split("\n")).toHaveLength(3);
      expect(result.stderr).toContain("@demo/core");
      expect(result.stderr).toContain(alphaCore);
      expect(result.stderr).toContain(betaCore);
      expect(result.stderr).toContain("missing from the cache");
      expect(result.excluded).toEqual([{
        directory: betaCore,
        reason: 'Excluding fallback package name "@demo/core"; entities under this folder will be missing from the cache',
      }]);
    });
  });

  it("keeps exactly one deterministic survivor when three or more fallback names collide", async () => {
    await withTempWorkspace("hana-lens-fallback-triple-", async (root): Promise<void> => {
      const alpha = path.join(root, "alpha");
      const beta = path.join(root, "beta");
      const gamma = path.join(root, "gamma");
      const alphaCore = path.join(root, "domain-a", "core");
      const betaCore = path.join(root, "domain-b", "core");
      const gammaCore = path.join(root, "domain-c", "core");
      await writePackageJson(alpha, "@demo/alpha");
      await writePackageJson(alphaCore, "@demo/alpha");
      await writePackageJson(beta, "@demo/beta");
      await writePackageJson(betaCore, "@demo/beta");
      await writePackageJson(gamma, "@demo/gamma");
      await writePackageJson(gammaCore, "@demo/gamma");

      const result = await scanForPackages(root, "@demo/");
      const corePackages = result.packages.filter((entry) => entry.name === "@demo/core");

      expect(result.packages).toHaveLength(4);
      expect(corePackages).toEqual([{ name: "@demo/core", directory: alphaCore }]);
      expect(result.excluded.map((warning) => warning.directory).sort()).toEqual([betaCore, gammaCore].sort());
    });
  });

  it("keeps an unrelated singleton when a fallback name collides with it", async () => {
    await withTempWorkspace("hana-lens-fallback-singleton-", async (root): Promise<void> => {
      const singleton = path.join(root, "honest", "core");
      const winner = path.join(root, "shared");
      const loser = path.join(root, "stale", "core");
      await writePackageJson(singleton, "@demo/core");
      await writePackageJson(winner, "@demo/shared");
      await writePackageJson(loser, "@demo/shared");

      const result = await scanWithStderr(root);
      const exclusion = result.stderr.split("\n").find((line) => line.includes("missing from the cache")) ?? "";

      expect(result.packages).toEqual([
        { name: "@demo/core", directory: singleton },
        { name: "@demo/shared", directory: winner },
      ]);
      expect(exclusion).toContain(loser);
      expect(exclusion.includes(singleton)).toBe(false);
    });
  });

  it("keeps the winner when a loser's fallback collides back with it", async () => {
    await withTempWorkspace("hana-lens-fallback-winner-", async (root): Promise<void> => {
      const winner = path.join(root, "a", "demo_billing_invoice");
      const loser = path.join(root, "z", "demo_billing_invoice");
      await writePackageJson(winner, "@demo/billing_invoice");
      await writePackageJson(loser, "@demo/billing_invoice");

      const result = await scanWithStderr(root);

      expect(result.packages).toEqual([{ name: "@demo/billing_invoice", directory: winner }]);
      expect(result.stderr).toContain(loser);
      expect(result.stderr).toContain("missing from the cache");
    });
  });

  it("uses an unscoped folder basename unchanged for comparison and fallback", async () => {
    await withTempWorkspace("hana-lens-unscoped-folder-", async (root): Promise<void> => {
      const invoice = path.join(root, "billing_invoice");
      const ledger = path.join(root, "Ledger-Service");
      await writePackageJson(invoice, "@demo/billing_invoice");
      await writePackageJson(ledger, "@demo/billing_invoice");

      const result = await scanWithStderr(root);
      const expected = [
        { name: "@demo/billing_invoice", directory: invoice },
        { name: "@demo/Ledger-Service", directory: ledger },
      ].sort((left, right) => left.name.localeCompare(right.name));

      expect(result.packages).toEqual(expected);
    });
  });

  it("resolves malformed colliding short names without using the strict linking helper", async () => {
    await withTempWorkspace("hana-lens-malformed-collision-", async (root): Promise<void> => {
      await writePackageJson(path.join(root, "empty-a", "a"), "@demo/");
      await writePackageJson(path.join(root, "empty-b", "b"), "@demo/");
      await writePackageJson(path.join(root, "nested-a", "c"), "@demo/billing/invoice");
      await writePackageJson(path.join(root, "nested-b", "d"), "@demo/billing/invoice");

      const result = await scanWithStderr(root);

      expect(result.packages).toHaveLength(4);
      expect(result.packages.some((entry) => entry.name === "@demo/")).toBe(true);
      expect(result.packages.some((entry) => entry.name === "@demo/billing/invoice")).toBe(true);
    });
  });

  it("preserves exact output and stderr when no package names collide", async () => {
    await withTempWorkspace("hana-lens-no-collision-", async (root): Promise<void> => {
      const alpha = path.join(root, "z", "alpha-folder");
      const zeta = path.join(root, "a", "zeta-folder");
      await writePackageJson(zeta, "@demo/zeta");
      await writePackageJson(alpha, "@demo/alpha");

      const result = await scanWithStderr(root);

      expect(result.packages).toEqual([
        { name: "@demo/alpha", directory: alpha },
        { name: "@demo/zeta", directory: zeta },
      ]);
      expect(result.stderr).toBe("");
    });
  });

  it("returns an empty package list for missing workspaces", async () => {
    await expect(scanForPackages(path.join(os.tmpdir(), "hana-lens-does-not-exist"), "@demo/")).resolves.toEqual({ packages: [], warnings: [], excluded: [] });
  });

  it("rejects existing non-symlink paths instead of hiding auto-link conflicts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hana-lens-link-conflict-"));
    const a = path.join(root, "a");
    const b = path.join(root, "b");
    await fsMkdir(path.join(a, "node_modules", "@demo", "b"));
    await fsMkdir(b);
    await expect(autoLinkPackages([{ name: "@demo/a", directory: a }, { name: "@demo/b", directory: b }], "@demo/")).rejects.toThrow("path already exists and is not a symlink");
    await rm(root, { recursive: true, force: true });
  });

  it("replaces broken symlinks while preserving real directories", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hana-lens-link-"));
    const a = path.join(root, "a");
    const b = path.join(root, "b");
    await fsMkdir(path.join(a, "node_modules", "@demo"));
    await fsMkdir(b);
    await symlink(path.join(root, "missing"), path.join(a, "node_modules", "@demo", "b"), "dir");
    await autoLinkPackages([{ name: "@demo/a", directory: a }, { name: "@demo/b", directory: b }], "@demo/");
    await expect(readlink(path.join(a, "node_modules", "@demo", "b"))).resolves.toBe(b);
    await rm(root, { recursive: true, force: true });
  });

  it("prunes a stale symlink that no longer corresponds to a scanned package", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hana-lens-prune-"));
    const a = path.join(root, "a");
    const b = path.join(root, "b");
    const staleTarget = path.join(root, "gone");
    await fsMkdir(path.join(a, "node_modules", "@demo"));
    await fsMkdir(b);
    await fsMkdir(staleTarget);
    await symlink(staleTarget, path.join(a, "node_modules", "@demo", "old"), "dir");

    await autoLinkPackages([{ name: "@demo/a", directory: a }, { name: "@demo/b", directory: b }], "@demo/");

    const entries = await readdir(path.join(a, "node_modules", "@demo"));
    expect(entries.includes("old")).toBe(false);
    expect(entries.includes("b")).toBe(true);
    await rm(root, { recursive: true, force: true });
  });

  it("never prunes a real directory even when it does not match a scanned package", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hana-lens-prune-real-"));
    const a = path.join(root, "a");
    const b = path.join(root, "b");
    await fsMkdir(path.join(a, "node_modules", "@demo", "manual-install"));
    await fsMkdir(b);

    await autoLinkPackages([{ name: "@demo/a", directory: a }, { name: "@demo/b", directory: b }], "@demo/");

    const entries = await readdir(path.join(a, "node_modules", "@demo"));
    expect(entries.includes("manual-install")).toBe(true);
    await rm(root, { recursive: true, force: true });
  });

  it("rolls back every link this call created when a later linking attempt fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hana-lens-rollback-"));
    const a = path.join(root, "a");
    const b = path.join(root, "b");
    await fsMkdir(a);
    await fsMkdir(b);
    // A real (non-symlink) directory already sits where b's link to a would go, so b's linking
    // pass fails -- after a's own pass (linking to b) has already succeeded.
    await fsMkdir(path.join(b, "node_modules", "@demo", "a"));

    await expect(autoLinkPackages([
      { name: "@demo/a", directory: a },
      { name: "@demo/b", directory: b },
    ], "@demo/")).rejects.toThrow("path already exists and is not a symlink");

    const aScopeEntries = await readdir(path.join(a, "node_modules", "@demo")).catch(() => []);
    expect(aScopeEntries).toEqual([]);
    await rm(root, { recursive: true, force: true });
  });

  it("isolates a single unlinkable package name instead of aborting linking for the rest", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hana-lens-unlinkable-"));
    const bareScope = path.join(root, "bare-scope");
    const a = path.join(root, "a");
    const b = path.join(root, "b");
    await fsMkdir(bareScope);
    await fsMkdir(a);
    await fsMkdir(b);

    // "@demo/" (the bare scope, no direct-child short name) cannot be turned into a link
    // segment -- that single unlinkable name must not stop a and b from linking to each other.
    await autoLinkPackages([
      { name: "@demo/", directory: bareScope },
      { name: "@demo/a", directory: a },
      { name: "@demo/b", directory: b },
    ], "@demo/");

    await expect(readlink(path.join(a, "node_modules", "@demo", "b"))).resolves.toBe(b);
    await expect(readlink(path.join(b, "node_modules", "@demo", "a"))).resolves.toBe(a);
    await rm(root, { recursive: true, force: true });
  });
});

async function fsMkdir(directory: string): Promise<void> {
  await import("node:fs/promises").then(async ({ mkdir }) => await mkdir(directory, { recursive: true }));
}

async function writePackageJson(directory: string, name: string): Promise<void> {
  await fsMkdir(directory);
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ name }));
}

async function scanWithStderr(root: string): Promise<ScanCapture> {
  const chunks: string[] = [];
  const stderrWrite = mock.method(process.stderr, "write", (chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  try {
    const result = await scanForPackages(root, "@demo/");
    return { packages: result.packages, warnings: result.warnings, excluded: result.excluded, stderr: chunks.join("") };
  } finally {
    stderrWrite.mock.restore();
  }
}

async function withTempWorkspace<T>(prefix: string, callback: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
