import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("storage", () => {
  let tempDir: string;
  let originalEnv: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "mgit-test-"));
    originalEnv = process.env["MGIT_CONFIG_HOME"];
    process.env["MGIT_CONFIG_HOME"] = tempDir;
  });

  afterEach(async () => {
    if (originalEnv === undefined) {
      delete process.env["MGIT_CONFIG_HOME"];
    } else {
      process.env["MGIT_CONFIG_HOME"] = originalEnv;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it("readRepos returns empty config when file does not exist", async () => {
    const { readRepos } = await import("../../src/config/storage.js");
    const config = await readRepos();
    expect(config.repos).toEqual({});
  });

  it("writeRepos then readRepos round-trips data", async () => {
    const { readRepos, writeRepos } = await import("../../src/config/storage.js");

    await writeRepos({ repos: { myrepo: "/home/user/myrepo" } });
    const config = await readRepos();

    expect(config.repos).toEqual({ myrepo: "/home/user/myrepo" });
  });

  it("readGroups returns empty config when file does not exist", async () => {
    const { readGroups } = await import("../../src/config/storage.js");
    const config = await readGroups();
    expect(config.groups).toEqual({});
  });

  it("writeGroups then readGroups round-trips data", async () => {
    const { readGroups, writeGroups } = await import("../../src/config/storage.js");

    await writeGroups({ groups: { team: ["repo1", "repo2"] } });
    const config = await readGroups();

    expect(config.groups).toEqual({ team: ["repo1", "repo2"] });
  });

  it("readContext returns null context when file does not exist", async () => {
    const { readContext } = await import("../../src/config/storage.js");
    const config = await readContext();
    expect(config.context).toBeNull();
  });

  it("writeContext then readContext round-trips data", async () => {
    const { readContext, writeContext } = await import("../../src/config/storage.js");

    await writeContext({ context: "my-group" });
    const config = await readContext();

    expect(config.context).toBe("my-group");
  });

  it("writeContext supports clearing context to null", async () => {
    const { readContext, writeContext } = await import("../../src/config/storage.js");

    await writeContext({ context: "some-group" });
    await writeContext({ context: null });
    const config = await readContext();

    expect(config.context).toBeNull();
  });

  it("multiple writes overwrite previous data", async () => {
    const { readRepos, writeRepos } = await import("../../src/config/storage.js");

    await writeRepos({ repos: { old: "/old/path" } });
    await writeRepos({ repos: { new: "/new/path" } });
    const config = await readRepos();

    expect(config.repos).toEqual({ new: "/new/path" });
    expect(config.repos["old"]).toBeUndefined();
  });

  it("readRepos throws on corrupted JSON", async () => {
    const { writeFile } = await import("node:fs/promises");
    const { REPOS_FILE } = await import("../../src/config/paths.js");
    await writeFile(REPOS_FILE, "{ invalid json }", "utf8");

    const { readRepos } = await import("../../src/config/storage.js");
    await expect(readRepos()).rejects.toThrow(SyntaxError);
  });

  it("readGroups throws on corrupted JSON", async () => {
    const { writeFile } = await import("node:fs/promises");
    const { GROUPS_FILE } = await import("../../src/config/paths.js");
    await writeFile(GROUPS_FILE, "not json at all", "utf8");

    const { readGroups } = await import("../../src/config/storage.js");
    await expect(readGroups()).rejects.toThrow(SyntaxError);
  });
});
