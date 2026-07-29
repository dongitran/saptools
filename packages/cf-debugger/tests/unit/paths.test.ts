import {
  access,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  removeOwnedSessionCfHome,
  tryRemoveOwnedSessionCfHome,
} from "../../src/debug-session/session-home.js";
import {
  CF_DEBUGGER_HOMES_DIRNAME,
  CF_DEBUGGER_LOCK_FILENAME,
  CF_DEBUGGER_STATE_FILENAME,
  SAPTOOLS_DIR_NAME,
  isOwnedSessionCfHomeDir,
  saptoolsDir,
  sessionCfHomeDir,
  stateFilePath,
  stateLockPath,
} from "../../src/paths.js";

describe("path helpers", () => {
  it("resolves package state paths under the user-local saptools directory", () => {
    const baseDir = join(homedir(), SAPTOOLS_DIR_NAME);

    expect(CF_DEBUGGER_STATE_FILENAME).toBe("cf-debugger-state-v2.json");
    expect(CF_DEBUGGER_LOCK_FILENAME).toBe("cf-debugger-state-v2.lock");
    expect(CF_DEBUGGER_HOMES_DIRNAME).toBe("cf-debugger-homes-v2");
    expect(saptoolsDir()).toBe(baseDir);
    expect(stateFilePath()).toBe(join(baseDir, CF_DEBUGGER_STATE_FILENAME));
    expect(stateLockPath()).toBe(join(baseDir, CF_DEBUGGER_LOCK_FILENAME));
  });

  it("resolves isolated CF home directories by session id", () => {
    expect(sessionCfHomeDir("session-a")).toBe(
      join(homedir(), SAPTOOLS_DIR_NAME, CF_DEBUGGER_HOMES_DIRNAME, "session-a"),
    );
  });

  it("recognizes only the canonical CF home owned by a safe session id", () => {
    expect(isOwnedSessionCfHomeDir("session-a", sessionCfHomeDir("session-a"))).toBe(true);
    expect(isOwnedSessionCfHomeDir("session-a", sessionCfHomeDir("session-b"))).toBe(false);
    expect(isOwnedSessionCfHomeDir("../../outside", join(homedir(), "outside"))).toBe(false);
    expect(isOwnedSessionCfHomeDir(
      "session-a",
      `${sessionCfHomeDir("session-b")}/../session-a`,
    )).toBe(false);
  });

  it("rejects unsafe session ids before resolving a CF home", () => {
    expect(() => sessionCfHomeDir("../../outside")).toThrow("Invalid debugger session ID");
  });
});

describe("guarded session-home removal", () => {
  let originalHome: string | undefined;
  let tempHome: string;

  beforeEach(async (): Promise<void> => {
    originalHome = process.env["HOME"];
    tempHome = await mkdtemp(join(tmpdir(), "cf-debugger-home-guard-"));
    process.env["HOME"] = tempHome;
  });

  afterEach(async (): Promise<void> => {
    if (originalHome === undefined) {
      delete process.env["HOME"];
    } else {
      process.env["HOME"] = originalHome;
    }
    await rm(tempHome, { recursive: true, force: true });
  });

  it("refuses a symlinked homes root and preserves the external target", async () => {
    const toolsDir = join(tempHome, SAPTOOLS_DIR_NAME);
    const outside = join(tempHome, "outside");
    const externalHome = join(outside, "session-a");
    const sentinel = join(externalHome, "SENTINEL.txt");
    await mkdir(toolsDir, { recursive: true });
    await mkdir(externalHome, { recursive: true });
    await writeFile(sentinel, "keep", "utf8");
    await symlink(outside, join(toolsDir, CF_DEBUGGER_HOMES_DIRNAME), "dir");

    await expect(
      removeOwnedSessionCfHome("session-a", sessionCfHomeDir("session-a")),
    ).rejects.toMatchObject({
      code: "UNSAFE_INPUT",
      message: expect.stringContaining("is a symbolic link"),
    });
    await expect(
      tryRemoveOwnedSessionCfHome("session-a", sessionCfHomeDir("session-a")),
    ).resolves.toBe(false);
    await expect(access(sentinel)).resolves.toBeUndefined();
  });

  it("refuses a non-directory homes root", async () => {
    const toolsDir = join(tempHome, SAPTOOLS_DIR_NAME);
    const homesRoot = join(toolsDir, CF_DEBUGGER_HOMES_DIRNAME);
    await mkdir(toolsDir, { recursive: true });
    await writeFile(homesRoot, "not a directory", "utf8");

    await expect(
      removeOwnedSessionCfHome("session-a", sessionCfHomeDir("session-a")),
    ).rejects.toMatchObject({
      code: "UNSAFE_INPUT",
      message: expect.stringContaining("is not a directory"),
    });
    await expect(access(homesRoot)).resolves.toBeUndefined();
  });

  it("allows a symlinked saptools parent when the homes root is a real directory", async () => {
    const relocatedTools = join(tempHome, "relocated-saptools");
    const relocatedHome = join(
      relocatedTools,
      CF_DEBUGGER_HOMES_DIRNAME,
      "session-a",
    );
    await mkdir(relocatedHome, { recursive: true });
    await symlink(relocatedTools, join(tempHome, SAPTOOLS_DIR_NAME), "dir");

    await expect(
      removeOwnedSessionCfHome("session-a", sessionCfHomeDir("session-a")),
    ).resolves.toBeUndefined();
    await expect(access(relocatedHome)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(relocatedTools)).resolves.toBeUndefined();
  });
});
