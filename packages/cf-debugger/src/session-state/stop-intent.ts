import {
  access,
  chmod,
  mkdir,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";

import {
  saptoolsDir,
  sessionStopIntentPath,
  stateFilePath,
} from "../paths.js";

import { decodeStateFileDetailed } from "./decoder.js";

export type SessionStateStopIntentVerdict =
  | "active"
  | "missing"
  | "requested"
  | "unavailable";

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const code: unknown = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

export async function writeSessionStopIntent(sessionId: string): Promise<void> {
  const directory = saptoolsDir();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  try {
    await writeFile(sessionStopIntentPath(sessionId), "", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error: unknown) {
    if (errorCode(error) !== "EEXIST") {
      throw error;
    }
  }
}

export async function hasSessionStopIntent(sessionId: string): Promise<boolean> {
  try {
    await access(sessionStopIntentPath(sessionId));
    return true;
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function inspectSessionStateStopIntent(
  sessionId: string,
): Promise<SessionStateStopIntentVerdict> {
  let raw: string;
  try {
    raw = await readFile(stateFilePath(), "utf8");
  } catch (error: unknown) {
    return errorCode(error) === "ENOENT" ? "missing" : "unavailable";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return "unavailable";
  }
  const decoded = decodeStateFileDetailed(parsed);
  if (decoded.kind === "invalid-file") {
    return "unavailable";
  }
  const session = decoded.state.sessions.find((candidate) => candidate.sessionId === sessionId);
  if (session === undefined) {
    return decoded.dropped.length > 0 ? "unavailable" : "missing";
  }
  return session.stopRequestedAt !== undefined || session.status === "stopping"
    ? "requested"
    : "active";
}

export async function clearSessionStopIntent(sessionId: string): Promise<void> {
  await unlink(sessionStopIntentPath(sessionId)).catch((error: unknown) => {
    if (errorCode(error) !== "ENOENT") {
      throw error;
    }
  });
}
