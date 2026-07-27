import { access, chmod, mkdir, unlink, writeFile } from "node:fs/promises";

import { saptoolsDir, sessionStopIntentPath } from "../paths.js";

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

export async function clearSessionStopIntent(sessionId: string): Promise<void> {
  await unlink(sessionStopIntentPath(sessionId)).catch((error: unknown) => {
    if (errorCode(error) !== "ENOENT") {
      throw error;
    }
  });
}
