import type { ChildProcess } from "node:child_process";
import process from "node:process";

import { isPidAlive } from "../state.js";

import { CHILD_SIGTERM_GRACE_MS, PID_TERMINATION_POLL_MS } from "./constants.js";

function signalPidOrGroup(pid: number, signal: NodeJS.Signals): void {
  const isWindows = process.platform === "win32";
  if (!isWindows) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // fall through to direct pid signal
    }
  }
  try {
    process.kill(pid, signal);
  } catch {
    // already gone
  }
}

export async function terminatePidOrGroup(
  pid: number,
  timeoutMs: number = CHILD_SIGTERM_GRACE_MS,
): Promise<void> {
  if (!isPidAlive(pid)) {
    return;
  }

  signalPidOrGroup(pid, "SIGTERM");
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!isPidAlive(pid)) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, PID_TERMINATION_POLL_MS);
    });
  }

  signalPidOrGroup(pid, "SIGKILL");
}

export async function killProcessGroupOrProc(
  child: ChildProcess,
  timeoutMs: number = CHILD_SIGTERM_GRACE_MS,
): Promise<void> {
  if (child.pid === undefined) {
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await terminatePidOrGroup(child.pid, timeoutMs);
}
