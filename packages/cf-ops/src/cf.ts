import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { CfExecContext, CfExecError, LifecyclePlan, ScalePlan } from "./types.js";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 16 * 1024 * 1024;

function resolveCfCommand(context?: CfExecContext): string {
  return context?.command ?? process.env["CF_OPS_CF_BIN"] ?? "cf";
}

function resolveCfEnv(context?: CfExecContext): NodeJS.ProcessEnv {
  const env = context?.env ? { ...process.env, ...context.env } : { ...process.env };
  delete env["SAP_EMAIL"];
  delete env["SAP_PASSWORD"];
  return env;
}

function resolveCommandParts(command: string, args: readonly string[]): { readonly file: string; readonly args: readonly string[] } {
  if (/\.(?:c|m)?js$/i.test(command)) {
    return { file: process.execPath, args: [command, ...args] };
  }
  return { file: command, args };
}

function describeCfCommand(args: readonly string[]): string {
  return args.length === 0 ? "cf" : `cf ${args.join(" ")}`;
}

function errorDetailFrom(error: CfExecError): string {
  const detail = error.stderr ?? error.message;
  return Buffer.isBuffer(detail) ? detail.toString("utf8") : detail;
}

export async function runCf(args: readonly string[], context?: CfExecContext): Promise<string> {
  const command = resolveCommandParts(resolveCfCommand(context), args);
  try {
    const result = await execFileAsync(command.file, [...command.args], {
      env: resolveCfEnv(context),
      maxBuffer: MAX_BUFFER,
    });
    return typeof result === "string" ? result : result.stdout;
  } catch (error) {
    const cfError = error as CfExecError;
    const detail = errorDetailFrom(cfError).trim();
    const suffix = detail.length > 0 ? `: ${detail}` : "";
    throw new Error(`${describeCfCommand(args)} failed${suffix}`, { cause: error });
  }
}

export function lifecycleCommandArgs(plan: LifecyclePlan): readonly string[] {
  if (plan.action === "restart" && plan.strategy === "rolling") {
    return ["restart", plan.appName, "--strategy", "rolling"];
  }
  return [plan.action, plan.appName];
}

export function scaleCommandArgs(plan: ScalePlan): readonly (readonly string[])[] {
  return plan.restartAfterScale === undefined
    ? [plan.args]
    : [plan.args, lifecycleCommandArgs(plan.restartAfterScale)];
}

export async function runLifecycle(plan: LifecyclePlan, context?: CfExecContext): Promise<void> {
  await runCf(lifecycleCommandArgs(plan), context);
}

export async function runScale(plan: ScalePlan, context?: CfExecContext): Promise<void> {
  for (const args of scaleCommandArgs(plan)) {
    await runCf(args, context);
  }
}

export const internals = {
  describeCfCommand,
  errorDetailFrom,
  resolveCommandParts,
};
