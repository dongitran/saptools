import type { ChildProcess } from "node:child_process";
import process from "node:process";

import { isPidAlive, isProcessGroupAlive } from "../state.js";

import {
  CHILD_SIGKILL_GRACE_MS,
  CHILD_SIGTERM_GRACE_MS,
  PID_TERMINATION_POLL_MS,
} from "./constants.js";

type TerminationTargetKind = "group" | "pid";
export type TerminationOutcome = "ownership-lost" | "still-alive" | "terminated";
export type TerminationVerifier = (signal: "SIGKILL" | "SIGTERM") => Promise<boolean>;

export async function terminatePidOrGroup(
  pid: number,
  timeoutMs: number = CHILD_SIGTERM_GRACE_MS,
  pinnedTarget?: TerminationTargetKind,
  verifyBeforeSignal?: TerminationVerifier,
): Promise<TerminationOutcome> {
  const targetKind = pinnedTarget ?? (isProcessGroupAlive(pid) ? "group" : "pid");
  const targetAlive = (): boolean => targetKind === "group"
    ? isProcessGroupAlive(pid)
    : isPidAlive(pid);
  if (!targetAlive()) {
    return "terminated";
  }
  if (
    verifyBeforeSignal !== undefined &&
    !(await verifyBeforeSignal("SIGTERM"))
  ) {
    return "ownership-lost";
  }

  try {
    process.kill(targetKind === "group" ? -pid : pid, "SIGTERM");
  } catch {
    // target already gone
  }
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!targetAlive()) {
      return "terminated";
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, PID_TERMINATION_POLL_MS);
    });
  }

  if (
    verifyBeforeSignal !== undefined &&
    !(await verifyBeforeSignal("SIGKILL"))
  ) {
    return "ownership-lost";
  }
  try {
    process.kill(targetKind === "group" ? -pid : pid, "SIGKILL");
  } catch {
    // target already gone
  }
  const forceStartedAt = Date.now();
  while (Date.now() - forceStartedAt < CHILD_SIGKILL_GRACE_MS) {
    if (!targetAlive()) {
      return "terminated";
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, PID_TERMINATION_POLL_MS);
    });
  }
  return targetAlive() ? "still-alive" : "terminated";
}

export async function killProcessGroupOrProc(
  child: ChildProcess,
  verifyBeforeSignal?: TerminationVerifier,
  timeoutMs: number = CHILD_SIGTERM_GRACE_MS,
): Promise<TerminationOutcome> {
  if (child.pid === undefined) {
    return "terminated";
  }
  const childClosed = child.exitCode !== null || child.signalCode !== null;
  if (childClosed && process.platform === "win32") {
    return "terminated";
  }
  return await terminatePidOrGroup(
    child.pid,
    timeoutMs,
    childClosed ? "group" : undefined,
    verifyBeforeSignal,
  );
}
