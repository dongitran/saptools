import { lstat, rm } from "node:fs/promises";
import { dirname } from "node:path";

import { isOwnedSessionCfHomeDir } from "../paths.js";
import { CfDebuggerError } from "../types.js";

export type SessionHomesRootInspection =
  | { readonly status: "absent" | "safe" }
  | { readonly status: "unsafe"; readonly reason: string };

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const code: unknown = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

export async function inspectSessionHomesRoot(
  root: string,
): Promise<SessionHomesRootInspection> {
  try {
    const stats = await lstat(root);
    if (stats.isSymbolicLink()) {
      return {
        status: "unsafe",
        reason: `Debugger CF homes root ${root} is a symbolic link; refusing to traverse it.`,
      };
    }
    return stats.isDirectory()
      ? { status: "safe" }
      : {
          status: "unsafe",
          reason: `Debugger CF homes root ${root} is not a directory; refusing to traverse it.`,
        };
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") {
      return { status: "absent" };
    }
    const code = errorCode(error) ?? "unknown error";
    return {
      status: "unsafe",
      reason: `Debugger CF homes root ${root} could not be inspected (${code}); ` +
        "refusing to traverse it.",
    };
  }
}

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
  const rootInspection = await inspectSessionHomesRoot(dirname(candidate));
  if (rootInspection.status === "unsafe") {
    throw new CfDebuggerError("UNSAFE_INPUT", rootInspection.reason);
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
