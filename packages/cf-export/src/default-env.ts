import { cfAppGuid, cfCurl } from "./cf.js";
import type { CfExecContext } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeRecordInto(target: Record<string, unknown>, source: unknown): void {
  if (!isRecord(source)) {
    return;
  }
  for (const [k, v] of Object.entries(source)) {
    target[k] = v;
  }
}

function buildDefaultEnvPayload(appEnv: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  mergeRecordInto(payload, appEnv["system_env_json"]);
  mergeRecordInto(payload, appEnv["environment_variables"]);
  mergeRecordInto(payload, appEnv["running_env_json"]);
  mergeRecordInto(payload, appEnv["staging_env_json"]);

  if (Object.keys(payload).length === 0) {
    throw new Error("No environment variables found to build default-env.json.");
  }
  return payload;
}

export interface FetchDefaultEnvOptions {
  readonly appName: string;
  readonly context?: CfExecContext;
}

export async function fetchDefaultEnvJson(options: FetchDefaultEnvOptions): Promise<string> {
  const guid = await cfAppGuid(options.appName, options.context);
  const encoded = encodeURIComponent(guid);
  const stdout = await cfCurl(`/v3/apps/${encoded}/env`, options.context);

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("Unexpected JSON format for CF app environment payload.");
  }

  if (!isRecord(parsed)) {
    throw new Error("Unexpected JSON object format for CF app environment payload.");
  }

  const payload = buildDefaultEnvPayload(parsed);
  return `${JSON.stringify(payload, null, 2)}\n`;
}
