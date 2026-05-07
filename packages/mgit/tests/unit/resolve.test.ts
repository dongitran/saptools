import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("resolveRepos", () => {
  let tempDir: string;
  let originalEnv: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "mgit-resolve-test-"));
    originalEnv = process.env["MGIT_CONFIG_HOME"];
    process.env["MGIT_CONFIG_HOME"] = tempDir;

    const { writeRepos, writeGroups, writeContext } = await import("../../src/config/storage.js");

    await writeRepos({
      repos: {
        alpha: "/repos/alpha",
        beta: "/repos/beta",
        gamma: "/repos/gamma",
      },
    });

    await writeGroups({
      groups: {
        frontend: ["alpha", "beta"],
        backend: ["gamma"],
      },
    });

    await writeContext({ context: null });
  });

  afterEach(async () => {
    if (originalEnv === undefined) {
      delete process.env["MGIT_CONFIG_HOME"];
    } else {
      process.env["MGIT_CONFIG_HOME"] = originalEnv;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns all repos when no args and no context", async () => {
    const { resolveRepos } = await import("../../src/repos/resolve.js");
    const repos = await resolveRepos([]);

    expect(repos).toHaveLength(3);
    expect(repos.map((r) => r.name)).toContain("alpha");
    expect(repos.map((r) => r.name)).toContain("beta");
    expect(repos.map((r) => r.name)).toContain("gamma");
  });

  it("returns repos filtered by active context when no args", async () => {
    const { writeContext } = await import("../../src/config/storage.js");
    await writeContext({ context: "frontend" });

    const { resolveRepos } = await import("../../src/repos/resolve.js");
    const repos = await resolveRepos([]);

    expect(repos).toHaveLength(2);
    expect(repos.map((r) => r.name)).toContain("alpha");
    expect(repos.map((r) => r.name)).toContain("beta");
    expect(repos.map((r) => r.name)).not.toContain("gamma");
  });

  it("resolves by repo name", async () => {
    const { resolveRepos } = await import("../../src/repos/resolve.js");
    const repos = await resolveRepos(["alpha"]);

    expect(repos).toHaveLength(1);
    expect(repos[0]?.name).toBe("alpha");
    expect(repos[0]?.path).toBe("/repos/alpha");
  });

  it("resolves by group name", async () => {
    const { resolveRepos } = await import("../../src/repos/resolve.js");
    const repos = await resolveRepos(["frontend"]);

    expect(repos).toHaveLength(2);
    expect(repos.map((r) => r.name)).toContain("alpha");
    expect(repos.map((r) => r.name)).toContain("beta");
  });

  it("resolves mixed repo and group names without duplicates", async () => {
    const { resolveRepos } = await import("../../src/repos/resolve.js");
    const repos = await resolveRepos(["frontend", "alpha"]);

    expect(repos).toHaveLength(2);
    const names = repos.map((r) => r.name);
    expect(names.filter((n) => n === "alpha")).toHaveLength(1);
  });

  it("throws for unknown repo or group name", async () => {
    const { resolveRepos } = await import("../../src/repos/resolve.js");
    await expect(resolveRepos(["nonexistent"])).rejects.toThrow(
      'Unknown repository or group: "nonexistent"',
    );
  });

  it("throws when context group is missing from groups config", async () => {
    const { writeContext } = await import("../../src/config/storage.js");
    await writeContext({ context: "deleted-group" });

    const { resolveRepos } = await import("../../src/repos/resolve.js");
    await expect(resolveRepos([])).rejects.toThrow(
      "Active context group not found: deleted-group",
    );
  });
});
