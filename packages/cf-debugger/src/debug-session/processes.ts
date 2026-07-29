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

function terminationTargetAlive(pid: number, targetKind: TerminationTargetKind): boolean {
  return targetKind === "group" ? isProcessGroupAlive(pid) : isPidAlive(pid);
}

function signalTerminationTarget(
  pid: number,
  targetKind: TerminationTargetKind,
  signal: "SIGKILL" | "SIGTERM",
): void {
  try {
    process.kill(targetKind === "group" ? -pid : pid, signal);
  } catch {
    // The verified target may exit between the liveness check and the signal.
  }
}

async function waitForTargetExit(
  pid: number,
  targetKind: TerminationTargetKind,
  timeoutMs: number,
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!terminationTargetAlive(pid, targetKind)) {
      return true;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, PID_TERMINATION_POLL_MS);
    });
  }
  return !terminationTargetAlive(pid, targetKind);
}

async function signalIsAuthorized(
  verifier: TerminationVerifier | undefined,
  signal: "SIGKILL" | "SIGTERM",
): Promise<boolean> {
  return verifier === undefined || await verifier(signal);
}

export async function terminatePidOrGroup(
  pid: number,
  timeoutMs: number = CHILD_SIGTERM_GRACE_MS,
  pinnedTarget?: TerminationTargetKind,
  verifyBeforeSignal?: TerminationVerifier,
): Promise<TerminationOutcome> {
  const targetKind = pinnedTarget ?? (isProcessGroupAlive(pid) ? "group" : "pid");
  if (!terminationTargetAlive(pid, targetKind)) {
    return "terminated";
  }
  if (!(await signalIsAuthorized(verifyBeforeSignal, "SIGTERM"))) {
    return "ownership-lost";
  }

  signalTerminationTarget(pid, targetKind, "SIGTERM");
  if (await waitForTargetExit(pid, targetKind, timeoutMs)) {
    return "terminated";
  }
  if (!(await signalIsAuthorized(verifyBeforeSignal, "SIGKILL"))) {
    return "ownership-lost";
  }

  signalTerminationTarget(pid, targetKind, "SIGKILL");
  return await waitForTargetExit(pid, targetKind, CHILD_SIGKILL_GRACE_MS)
    ? "terminated"
    : "still-alive";
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
