import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { REGIONS } from "@saptools/cf-sync";

import type { CfExecContext } from "./cf.js";
import { cfApi, cfAuth, cfTargetSpace } from "./cf.js";
import type { CfTarget } from "./types.js";

export interface SessionEnv {
  readonly email: string;
  readonly password: string;
}

export interface OpenCfSession {
  readonly context: CfExecContext;
  readonly dispose: () => Promise<void>;
}

const CF_HOME_PREFIX = "saptools-cf-files-";

export function resolveSessionEnv(env?: NodeJS.ProcessEnv): SessionEnv {
  const source = env ?? process.env;
  const email = source["SAP_EMAIL"];
  const password = source["SAP_PASSWORD"];
  if (email === undefined || email === "") {
    throw new Error("SAP_EMAIL must be set in the environment");
  }
  if (password === undefined || password === "") {
    throw new Error("SAP_PASSWORD must be set in the environment");
  }
  return { email, password };
}

export function resolveApiEndpoint(regionKey: string): string {
  const known = REGIONS as Readonly<Record<string, { readonly apiEndpoint: string } | undefined>>;
  const region = known[regionKey];
  if (!region) {
    throw new Error(`Unknown CF region: ${regionKey}`);
  }
  return region.apiEndpoint;
}

function explicitCfHome(context?: CfExecContext): string | undefined {
  const contextCfHome = context?.env?.["CF_HOME"] ?? context?.env?.["CF_FILES_CF_HOME"];
  if (contextCfHome !== undefined && contextCfHome !== "") {
    return contextCfHome;
  }

  const processCfHome = process.env["CF_FILES_CF_HOME"];
  return processCfHome === undefined || processCfHome === "" ? undefined : processCfHome;
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
  const configuredCfHome = explicitCfHome(context);
  if (configuredCfHome !== undefined) {
    return {
      context: {
        ...context,
        env: buildSessionEnv(context, configuredCfHome),
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
