import { CfDebuggerError } from "../types.js";

import { type CfExecContext, runCf } from "./execute.js";
import { parseAppNames, parseNameTable } from "./parsers.js";

const CF_RESTART_TIMEOUT_MS = 120_000;
const CF_AUTH_MAX_ATTEMPTS = 3;

export async function cfApi(apiEndpoint: string, context: CfExecContext): Promise<void> {
  await runCf(["api", apiEndpoint], context);
}

export async function cfAuth(
  email: string,
  password: string,
  context: CfExecContext,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < CF_AUTH_MAX_ATTEMPTS; attempt++) {
    try {
      await runCf(["auth", email, password], context);
      return;
    } catch (err: unknown) {
      lastError = err;
      if (attempt < CF_AUTH_MAX_ATTEMPTS - 1) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 1000 * (attempt + 1));
        });
      }
    }
  }
  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new CfDebuggerError("CF_AUTH_FAILED", `cf auth failed: ${String(lastError)}`);
}

export async function cfLogin(
  apiEndpoint: string,
  email: string,
  password: string,
  context: CfExecContext,
): Promise<void> {
  try {
    await cfApi(apiEndpoint, context);
    await cfAuth(email, password, context);
  } catch (err: unknown) {
    if (err instanceof CfDebuggerError) {
      throw new CfDebuggerError("CF_LOGIN_FAILED", err.message, err.stderr);
    }
    throw err;
  }
}

export async function cfTarget(
  org: string,
  space: string,
  context: CfExecContext,
): Promise<void> {
  try {
    await runCf(["target", "-o", org, "-s", space], context);
  } catch (err: unknown) {
    if (err instanceof CfDebuggerError) {
      throw new CfDebuggerError("CF_TARGET_FAILED", err.message, err.stderr);
    }
    throw err;
  }
}

export async function cfAppExists(appName: string, context: CfExecContext): Promise<boolean> {
  try {
    await runCf(["app", appName], context);
    return true;
  } catch (err: unknown) {
    const stderr = (err as CfDebuggerError).stderr ?? "";
    if (stderr.toLowerCase().includes("not found")) {
      return false;
    }
    throw err;
  }
}

export async function cfSshEnabled(appName: string, context: CfExecContext): Promise<boolean> {
  try {
    const stdout = await runCf(["ssh-enabled", appName], context);
    return stdout.toLowerCase().includes("ssh support is enabled");
  } catch {
    return false;
  }
}

export async function cfEnableSsh(appName: string, context: CfExecContext): Promise<void> {
  try {
    await runCf(["enable-ssh", appName], context);
  } catch (err: unknown) {
    if (err instanceof CfDebuggerError) {
      throw new CfDebuggerError("SSH_NOT_ENABLED", err.message, err.stderr);
    }
    throw err;
  }
}

export async function cfRestartApp(appName: string, context: CfExecContext): Promise<void> {
  await runCf(["restart", appName], context, CF_RESTART_TIMEOUT_MS);
}

export async function cfApps(context: CfExecContext): Promise<readonly string[]> {
  const stdout = await runCf(["apps"], context);
  return parseAppNames(stdout);
}

export async function cfOrgs(context: CfExecContext): Promise<readonly string[]> {
  const stdout = await runCf(["orgs"], context);
  return parseNameTable(stdout);
}

export async function cfSpaces(context: CfExecContext): Promise<readonly string[]> {
  const stdout = await runCf(["spaces"], context);
  return parseNameTable(stdout);
}
