import { CfDebuggerError } from "./types.js";

export type RestartEnvironment = "allow" | "forbid" | "unset";

export function parseRestartEnvironment(
  value: string | undefined,
): RestartEnvironment {
  if (value === undefined) {
    return "unset";
  }
  if (value === "0") {
    return "forbid";
  }
  if (value === "1") {
    return "allow";
  }
  throw new CfDebuggerError(
    "UNSAFE_INPUT",
    "CF_DEBUGGER_ALLOW_RESTART must be 0 or 1.",
  );
}

export function applyRestartEnvironmentVeto(
  requested: boolean | undefined,
  value: string | undefined,
): boolean {
  return parseRestartEnvironment(value) === "forbid"
    ? false
    : requested === true;
}
