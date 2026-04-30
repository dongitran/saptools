import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { cfSshOneShot, prepareCfCliSession, type CfCommandContext } from "./cf.js";
import { explorerHome, tmpRunDir } from "./paths.js";
import { normalizeTarget } from "./target.js";
import type { ExplorerRuntimeOptions, ExplorerTarget } from "./types.js";

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
    const result = await cfSshOneShot(
      normalizeTarget(input.target),
      input.script,
      context,
      input.processName,
      input.instance,
      {
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
      },
    );
    return {
      stdout: result.stdout,
      durationMs: result.durationMs,
      truncated: result.truncated,
    };
  });
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
