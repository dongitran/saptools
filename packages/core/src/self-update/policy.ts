import type { InstallLocation } from "./install-location.js";
import { REEXEC_MARKER_ENV } from "./reexec.js";

export type UpdatePolicy = "on" | "notify" | "off";

export const POLICY_ENV = "SAPTOOLS_AUTO_UPDATE";
export const INTERVAL_ENV = "SAPTOOLS_UPDATE_INTERVAL_MINUTES";
export const DEBUG_ENV = "SAPTOOLS_UPDATE_DEBUG";
export const DEFAULT_CHECK_INTERVAL_MINUTES = 60;
export const SELF_UPDATE_COMMAND = "self-update";

export interface PolicyDecision {
  readonly policy: UpdatePolicy;
  readonly reason: string;
  /** True when the user set the policy through the environment rather than relying on the default. */
  readonly explicit: boolean;
}

export interface ResolvePolicyInput {
  readonly env: NodeJS.ProcessEnv;
  readonly envPrefix?: string;
  readonly location: InstallLocation;
  /** Space-joined command path being run, e.g. `credential list`; empty for the root action. */
  readonly commandPath?: string;
  readonly skipCommands?: readonly string[];
  /** The explicit `self-update` command: ignore the exclusions and CI/test gates, but never the install-location facts. */
  readonly manual?: boolean;
}

export function parsePolicy(raw: string | undefined): UpdatePolicy | undefined {
  if (raw === undefined) {
    return;
  }
  const value = raw.trim().toLowerCase();
  if (["on", "1", "true", "yes", "auto", "always"].includes(value)) {
    return "on";
  }
  if (["notify", "check"].includes(value)) {
    return "notify";
  }
  if (["off", "0", "false", "no", "never", "disabled"].includes(value)) {
    return "off";
  }
  return;
}

/** `CI=true`, `CI=1`, even `CI=yes` count; `CI=0`, `CI=false` and an empty value do not. */
export function isTruthyFlag(raw: string | undefined): boolean {
  return raw !== undefined && !["", "0", "false", "no", "off"].includes(raw.trim().toLowerCase());
}

function readExplicitPolicy(env: NodeJS.ProcessEnv, envPrefix: string | undefined): UpdatePolicy | undefined {
  const perPackage = envPrefix === undefined ? undefined : parsePolicy(env[`${envPrefix}_AUTO_UPDATE`]);
  return perPackage ?? parsePolicy(env[POLICY_ENV]);
}

function off(reason: string, explicit: boolean): PolicyDecision {
  return { policy: "off", reason, explicit };
}

function notify(reason: string, explicit: boolean): PolicyDecision {
  return { policy: "notify", reason, explicit };
}

function locationDecision(location: InstallLocation, explicit: boolean): PolicyDecision | undefined {
  switch (location.kind) {
    case "local":
      return off("running from a source checkout or linked package, not a package-manager install", explicit);
    case "npx":
      return off("running through npx or dlx, which resolves the version on its own", explicit);
    case "unknown":
      return notify(`install location not recognized (${location.detail})`, explicit);
    case "npm-global":
    case "pnpm-global":
    case "yarn-global":
    case "bun-global":
    case "volta":
      return;
  }
}

/**
 * Decide what this invocation may do. Order matters: the re-exec marker and
 * the command exclusions are absolute, an explicit `off` wins next, then the
 * environment defaults (CI, test runs) that only an explicit setting
 * overrides, and only then the facts about the install: a checkout can never
 * be upgraded by npm, a read-only prefix can only be announced.
 */
export function resolveUpdatePolicy(input: ResolvePolicyInput): PolicyDecision {
  const { env, location } = input;
  const manual = input.manual === true;
  const explicit = readExplicitPolicy(env, input.envPrefix);

  if (!manual && isTruthyFlag(env[REEXEC_MARKER_ENV])) {
    return off("already re-executed after an update", false);
  }
  const commandPath = input.commandPath ?? "";
  if (!manual && (commandPath === SELF_UPDATE_COMMAND || (input.skipCommands ?? []).includes(commandPath))) {
    return off(`the "${commandPath}" command is excluded from automatic updates`, false);
  }
  if (!manual && explicit === "off") {
    return off(`${POLICY_ENV} is off`, true);
  }
  if (!manual && explicit === undefined) {
    if (isTruthyFlag(env["NO_UPDATE_NOTIFIER"])) {
      return off("NO_UPDATE_NOTIFIER is set", false);
    }
    if (isTruthyFlag(env["CI"])) {
      return off("running in CI", false);
    }
    if (env["NODE_ENV"] === "test") {
      return off("NODE_ENV is test", false);
    }
  }
  const byLocation = locationDecision(location, explicit !== undefined);
  if (byLocation !== undefined) {
    return byLocation;
  }
  if (!location.writable) {
    return notify("the install directory is not writable by this user", explicit !== undefined);
  }
  if (manual) {
    return { policy: "on", reason: "requested explicitly", explicit: true };
  }
  return explicit === undefined
    ? { policy: "on", reason: "default", explicit: false }
    : { policy: explicit, reason: `${POLICY_ENV} is ${explicit}`, explicit: true };
}

/** Minutes between registry checks; `0` checks on every run. Invalid values fall back to the default. */
export function resolveCheckIntervalMs(env: NodeJS.ProcessEnv): number {
  const raw = env[INTERVAL_ENV];
  if (raw === undefined) {
    return DEFAULT_CHECK_INTERVAL_MINUTES * 60_000;
  }
  const minutes = Number(raw.trim());
  if (!Number.isFinite(minutes) || minutes < 0) {
    return DEFAULT_CHECK_INTERVAL_MINUTES * 60_000;
  }
  return Math.round(minutes * 60_000);
}
