import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { cfSshOneShot, prepareCfCliSession, type CfCommandContext } from "../cf/client.js";
import { normalizeTarget } from "../cf/target.js";
import type { ExplorerRuntimeOptions, ExplorerTarget } from "../core/types.js";
import { explorerHome, tmpRunDir } from "../session/paths.js";

export interface RemoteExecutionInput {
  readonly target: ExplorerTarget;
  readonly processName: string;
  readonly instance: number;
  readonly script: string;
  readonly runtime?: ExplorerRuntimeOptions;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

export interface RemoteExecutionResult {
  readonly stdout: string;
  readonly durationMs: number;
  readonly truncated: boolean;
}

export async function executeRemoteScript(
  input: RemoteExecutionInput,
): Promise<RemoteExecutionResult> {
  return await withPreparedCfSession(input.target, input.runtime, async (context) => {
    return await executeRemoteScriptWithContext(input, context);
  });
}

export async function executeRemoteScriptWithContext(
  input: RemoteExecutionInput,
  context: CfCommandContext,
): Promise<RemoteExecutionResult> {
  const timeoutMs = input.timeoutMs ?? input.runtime?.timeoutMs;
  const maxBytes = input.maxBytes ?? input.runtime?.maxBytes;
  const result = await cfSshOneShot(
    normalizeTarget(input.target),
    input.script,
    context,
    input.processName,
    input.instance,
    {
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(maxBytes === undefined ? {} : { maxBytes }),
    },
  );
  return {
    stdout: result.stdout,
    durationMs: result.durationMs,
    truncated: result.truncated,
  };
}

export async function withPreparedCfSession<T>(
  target: ExplorerTarget,
  runtime: ExplorerRuntimeOptions = {},
  work: (context: CfCommandContext) => Promise<T>,
): Promise<T> {
  const normalizedTarget = normalizeTarget(target);
  const homeDir = runtime.homeDir ?? explorerHome(runtime.env);
  const runDir = tmpRunDir(randomUUID(), homeDir);
  const cfHomeDir = join(runDir, "cf-home");
  try {
    const session = await prepareCfCliSession(normalizedTarget, cfHomeDir, runtime);
    return await work(session.context);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
}
