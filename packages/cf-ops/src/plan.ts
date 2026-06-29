import type { LifecycleAction, LifecyclePlan, RestartStrategy, ScaleInput, ScalePlan } from "./types.js";

const CF_SIZE_PATTERN = /^\d+(?:M|MB|G|GB)$/i;

export function parseInstanceCount(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed.toString() !== value.trim()) {
    throw new Error("instance count must be a non-negative integer.");
  }
  return parsed;
}

export function parseSize(value: string, optionName: string): string {
  const normalized = value.trim().toUpperCase();
  if (!CF_SIZE_PATTERN.test(normalized)) {
    throw new Error(`${optionName} must use a Cloud Foundry size such as 512M, 1G, 1024MB, or 2GB.`);
  }
  const amount = Number.parseInt(normalized, 10);
  if (amount <= 0) {
    throw new Error(`${optionName} must be greater than zero.`);
  }
  return normalized;
}

export function parseRestartStrategy(value: string | undefined): RestartStrategy {
  if (value === undefined || value === "default" || value === "rolling") {
    return value ?? "default";
  }
  throw new Error("--strategy must be either default or rolling.");
}

export function buildLifecyclePlan(
  appName: string,
  action: LifecycleAction,
  strategy: RestartStrategy = "default",
): LifecyclePlan {
  const normalizedApp = appName.trim();
  if (normalizedApp.length === 0) {
    throw new Error("app name is required.");
  }
  if (strategy === "rolling" && action !== "restart") {
    throw new Error("--strategy rolling is only supported for restart.");
  }
  return { appName: normalizedApp, action, strategy };
}

export function buildScalePlan(input: ScaleInput): ScalePlan {
  const appName = input.appName.trim();
  if (appName.length === 0) {
    throw new Error("app name is required.");
  }

  const args: string[] = ["scale", appName];
  if (input.instances !== undefined) {
    args.push("-i", input.instances.toString());
  }
  if (input.memory !== undefined) {
    args.push("-m", parseSize(input.memory, "memory"));
  }
  if (input.disk !== undefined) {
    args.push("-k", parseSize(input.disk, "disk"));
  }
  if (args.length === 2) {
    throw new Error("scale requires at least one of --instances, --memory, or --disk.");
  }

  const restartAfterScale = input.restart
    ? buildLifecyclePlan(appName, "restart", input.strategy)
    : undefined;
  return { appName, args, ...(restartAfterScale ? { restartAfterScale } : {}) };
}
