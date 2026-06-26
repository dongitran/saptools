import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveApiEndpoint, resolveSessionEnv } from "@saptools/cf-files";
import { cfApi, cfAuth, cfTargetSpace } from "./cf.js";
import type { CfExecContext, CfTarget } from "./types.js";

// Delegate pure resolve helpers to @saptools/cf-files (shared, less duplication for non-exec parts)
export { resolveApiEndpoint, resolveSessionEnv } from "@saptools/cf-files";

// Local openCfSession still uses our custom CF_EXPORT_* envs and prefix while calling the shared cf* functions.

export interface SessionEnv {
  readonly email: string;
  readonly password: string;
}

export interface OpenCfSession {
  readonly context: CfExecContext;
  readonly dispose: () => Promise<void>;
}

const CF_HOME_PREFIX = "saptools-cf-export-";

// resolveSessionEnv and resolveApiEndpoint are re-exported from @saptools/cf-files above
// (keeps implementation in one place, reduces duplication).

function explicitCfHome(context?: CfExecContext): string | undefined {
  const fromContext =
    context?.env?.["CF_HOME"] ?? context?.env?.["CF_EXPORT_CF_HOME"];
  if (fromContext !== undefined && fromContext !== "") {
    return fromContext;
  }
  const fromProcess = process.env["CF_EXPORT_CF_HOME"];
  return fromProcess === undefined || fromProcess === "" ? undefined : fromProcess;
}

function buildSessionEnv(context: CfExecContext | undefined, cfHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(context?.env ?? {})) {
    if (key !== "SAP_EMAIL" && key !== "SAP_PASSWORD") {
      env[key] = value;
    }
  }
  env["CF_HOME"] = cfHome;
  return env;
}

async function createSessionContext(context?: CfExecContext): Promise<OpenCfSession> {
  const configured = explicitCfHome(context);
  if (configured !== undefined) {
    return {
      context: {
        ...context,
        env: buildSessionEnv(context, configured),
      },
      dispose: (): Promise<void> => Promise.resolve(),
    };
  }

  const cfHome = await mkdtemp(join(tmpdir(), CF_HOME_PREFIX));
  return {
    context: {
      ...context,
      env: buildSessionEnv(context, cfHome),
    },
    dispose: async (): Promise<void> => {
      await rm(cfHome, { recursive: true, force: true });
    },
  };
}

export async function openCfSession(
  target: CfTarget,
  context?: CfExecContext,
): Promise<OpenCfSession> {
  const { email, password } = resolveSessionEnv(context?.env);
  const apiEndpoint = resolveApiEndpoint(target.region);
  const session = await createSessionContext(context);

  try {
    await cfApi(apiEndpoint, session.context);
    await cfAuth(email, password, session.context);
    await cfTargetSpace(target.org, target.space, session.context);
    return session;
  } catch (err) {
    await session.dispose();
    throw err;
  }
}
