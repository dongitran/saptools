import { CfExplorerError } from "./errors.js";

export const MAX_TIMER_MS = 2_147_483_647;
export const MAX_TIMER_SECONDS = Math.floor(MAX_TIMER_MS / 1000);

export function requireSafeTimerMs(value: number, label: string): number {
  assertPositiveSafeInteger(value, label);
  if (value > MAX_TIMER_MS) {
    throw new CfExplorerError(
      "UNSAFE_INPUT",
      `${label} must be less than or equal to ${MAX_TIMER_MS.toString()} milliseconds.`,
    );
  }
  return value;
}

export function resolveTimerMs(value: number | undefined, fallback: number, label: string): number {
  return requireSafeTimerMs(value ?? fallback, label);
}

export function secondsToTimerMs(seconds: number, label: string): number {
  assertPositiveSafeInteger(seconds, label);
  if (seconds > MAX_TIMER_SECONDS) {
    throw new CfExplorerError(
      "UNSAFE_INPUT",
      `${label} must be less than or equal to ${MAX_TIMER_SECONDS.toString()} seconds.`,
    );
  }
  return seconds * 1000;
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || !Number.isSafeInteger(value) || value <= 0) {
    throw new CfExplorerError("UNSAFE_INPUT", `${label} must be a positive safe integer.`);
  }
}
