import { homedir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

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
