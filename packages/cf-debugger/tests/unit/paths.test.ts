import { homedir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CF_DEBUGGER_HOMES_DIRNAME,
  CF_DEBUGGER_LOCK_FILENAME,
  CF_DEBUGGER_STATE_FILENAME,
  SAPTOOLS_DIR_NAME,
  saptoolsDir,
  sessionCfHomeDir,
  stateFilePath,
  stateLockPath,
} from "../../src/paths.js";

describe("path helpers", () => {
  it("resolves package state paths under the user-local saptools directory", () => {
    const baseDir = join(homedir(), SAPTOOLS_DIR_NAME);

    expect(saptoolsDir()).toBe(baseDir);
    expect(stateFilePath()).toBe(join(baseDir, CF_DEBUGGER_STATE_FILENAME));
    expect(stateLockPath()).toBe(join(baseDir, CF_DEBUGGER_LOCK_FILENAME));
  });

  it("resolves isolated CF home directories by session id", () => {
    expect(sessionCfHomeDir("session-a")).toBe(
      join(homedir(), SAPTOOLS_DIR_NAME, CF_DEBUGGER_HOMES_DIRNAME, "session-a"),
    );
  });
});
