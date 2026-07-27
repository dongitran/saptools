import { rm } from "node:fs/promises";

import { isOwnedSessionCfHomeDir } from "../paths.js";
import { CfDebuggerError } from "../types.js";

export async function removeOwnedSessionCfHome(
  sessionId: string,
  candidate: string,
): Promise<void> {
  if (!isOwnedSessionCfHomeDir(sessionId, candidate)) {
    throw new CfDebuggerError(
      "UNSAFE_INPUT",
      `Refusing to remove unowned debugger CF home for session ${sessionId}.`,
    );
  }
  await rm(candidate, { recursive: true, force: true });
}

export async function tryRemoveOwnedSessionCfHome(
  sessionId: string,
  candidate: string,
): Promise<boolean> {
  if (!isOwnedSessionCfHomeDir(sessionId, candidate)) {
    return false;
  }
  try {
    await removeOwnedSessionCfHome(sessionId, candidate);
    return true;
  } catch {
    return false;
  }
}
