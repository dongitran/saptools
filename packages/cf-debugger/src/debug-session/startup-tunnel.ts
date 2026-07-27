import type { ChildProcess } from "node:child_process";

import {
  formatTunnelDiagnostics,
  getTunnelDiagnostics,
  spawnSshTunnel,
  type CfExecContext,
} from "../cf.js";
import type { ResolvedNodeTarget } from "../cloud-foundry/node-process.js";
import {
  inspectPortOwnership,
  isPortFree,
  probeInspectorReady,
  probeTunnelReady,
} from "../port.js";
import {
  updateSessionPid,
} from "../state.js";
import type { StateAccessOptions } from "../state.js";
import type { ActiveSession, StartDebuggerOptions } from "../types.js";
import { CfDebuggerError } from "../types.js";

import { throwIfStartupAborted } from "./startup-deadline.js";

interface TunnelInputs {
  readonly options: StartDebuggerOptions;
  readonly target: ResolvedNodeTarget;
  readonly session: ActiveSession;
  readonly context: CfExecContext;
  readonly tunnelReadyTimeoutMs: number;
  readonly onChild: (child: ChildProcess) => void;
}

interface LinkedAbortSignal {
  readonly signal: AbortSignal;
  dispose(): void;
}

function linkAbortSignals(signals: readonly AbortSignal[]): LinkedAbortSignal {
  const controller = new AbortController();
  const subscriptions: (readonly [AbortSignal, () => void])[] = [];
  for (const signal of signals) {
    const abort = (): void => {
      controller.abort(signal.reason);
    };
    if (signal.aborted) {
      abort();
      break;
    }
    signal.addEventListener("abort", abort, { once: true });
    subscriptions.push([signal, abort]);
  }
  return {
    signal: controller.signal,
    dispose: (): void => {
      for (const [signal, abort] of subscriptions) {
        signal.removeEventListener("abort", abort);
      }
    },
  };
}

function diagnosticsStderr(child: ChildProcess): string | undefined {
  return formatTunnelDiagnostics(getTunnelDiagnostics(child));
}

async function ensurePortAvailable(
  localPort: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!(await isPortFree(localPort, signal))) {
    throw new CfDebuggerError(
      "PORT_UNAVAILABLE",
      `Local port ${localPort.toString()} was taken before the tunnel could start.`,
    );
  }
}

function remainingReadyTimeout(inputs: TunnelInputs): number {
  if (inputs.context.deadlineAt === undefined) {
    return inputs.tunnelReadyTimeoutMs;
  }
  return Math.max(
    1,
    Math.min(inputs.tunnelReadyTimeoutMs, inputs.context.deadlineAt - Date.now()),
  );
}

function startupStateAccess(inputs: TunnelInputs): StateAccessOptions {
  return {
    ...(inputs.context.signal === undefined ? {} : { signal: inputs.context.signal }),
    ...(inputs.context.deadlineAt === undefined
      ? {}
      : { timeoutMs: Math.max(1, inputs.context.deadlineAt - Date.now()) }),
  };
}

function ownerVerificationError(
  localPort: number,
  inspection: Awaited<ReturnType<typeof inspectPortOwnership>>,
  child: ChildProcess,
): CfDebuggerError {
  const stderr = diagnosticsStderr(child);
  if (inspection.status === "unverified") {
    return new CfDebuggerError(
      "TUNNEL_OWNER_UNVERIFIED",
      `Could not verify local tunnel port ${localPort.toString()}: ${inspection.reason}`,
      stderr,
    );
  }
  const owners = inspection.status === "not-owned"
    ? inspection.pids.join(", ")
    : "none";
  return new CfDebuggerError(
    "TUNNEL_OWNER_MISMATCH",
    `Local tunnel port ${localPort.toString()} is not owned by the spawned tunnel ` +
      `(observed PID(s): ${owners}).`,
    stderr,
  );
}

async function waitForLocalTunnel(
  inputs: TunnelInputs,
  child: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  const childEnded = new AbortController();
  const linked = linkAbortSignals([
    ...(inputs.context.signal === undefined ? [] : [inputs.context.signal]),
    childEnded.signal,
  ]);
  try {
    const probe = probeTunnelReady(inputs.session.localPort, timeoutMs, linked.signal);
    const winner = await Promise.race([
      probe.then((ready) => ({ kind: "probe" as const, ready })),
      childExitPromise(child).then(() => ({ kind: "child-exit" as const })),
    ]);
    if (winner.kind === "probe" && winner.ready) {
      return;
    }
    if (winner.kind === "child-exit") {
      childEnded.abort();
      await probe.catch(() => false);
    }
  } finally {
    linked.dispose();
  }
  throw new CfDebuggerError(
    "TUNNEL_NOT_READY",
    `SSH tunnel on local port ${inputs.session.localPort.toString()} did not bind within ` +
      `${Math.round(timeoutMs / 1000).toString()}s.`,
    diagnosticsStderr(child),
  );
}

async function verifyLocalOwner(
  inputs: TunnelInputs,
  child: ChildProcess,
  childPid: number,
): Promise<void> {
  const ownership = await inspectPortOwnership(
    inputs.session.localPort,
    childPid,
    inputs.context.signal,
  );
  if (ownership.status !== "owned") {
    throw ownerVerificationError(inputs.session.localPort, ownership, child);
  }
}

function childExitPromise(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    child.once("close", () => {
      resolve();
    });
  });
}

async function verifyInspector(
  inputs: TunnelInputs,
  child: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  const childEnded = new AbortController();
  const linked = linkAbortSignals([
    ...(inputs.context.signal === undefined ? [] : [inputs.context.signal]),
    childEnded.signal,
  ]);
  try {
    const probe = probeInspectorReady(inputs.session.localPort, timeoutMs, linked.signal);
    const winner = await Promise.race([
      probe.then((result) => ({ kind: "probe" as const, result })),
      childExitPromise(child).then(() => ({ kind: "child-exit" as const })),
    ]);
    if (winner.kind === "probe" && winner.result.status === "ready") {
      return;
    }
    if (winner.kind === "child-exit") {
      childEnded.abort();
      await probe.catch(() => ({ status: "unreachable" as const }));
    }
  } finally {
    linked.dispose();
  }
  throw new CfDebuggerError(
    "INSPECTOR_UNREACHABLE",
    `The inspector did not answer through local port ${inputs.session.localPort.toString()} ` +
      `to remote port ${inputs.session.remotePort.toString()}. The inspector may not have opened, ` +
      "the app or container may have restarted, or a different Node PID may own it.",
    diagnosticsStderr(child),
  );
}

function requireChildPid(child: ChildProcess): number {
  if (child.pid === undefined) {
    throw new CfDebuggerError(
      "TUNNEL_PROCESS_MISSING",
      "The CF SSH tunnel process did not expose a PID.",
    );
  }
  return child.pid;
}

async function recordTunnelPid(inputs: TunnelInputs, childPid: number): Promise<void> {
  const state = await updateSessionPid(
    inputs.session.sessionId,
    childPid,
    startupStateAccess(inputs),
  );
  if (
    state === undefined
    || state.stopRequestedAt !== undefined
    || state.status === "stopping"
  ) {
    throw new CfDebuggerError(
      state === undefined ? "SESSION_STATE_LOST" : "ABORTED",
      state === undefined
        ? "Debugger session ownership state disappeared while recording the tunnel PID."
        : "Debugger session stop was requested while recording the tunnel PID.",
    );
  }
  if (state.tunnelPid !== childPid || state.pid !== childPid) {
    throw new CfDebuggerError(
      "SESSION_STATE_CONFLICT",
      "Debugger session did not retain ownership of the spawned tunnel process.",
    );
  }
}

function ensureStartupActive(inputs: TunnelInputs, phase: string): void {
  throwIfStartupAborted(
    inputs.context.signal,
    inputs.context.deadlineAt ?? Number.MAX_SAFE_INTEGER,
    inputs.context.startupTimeoutMs ?? Number.MAX_SAFE_INTEGER,
    phase,
  );
}

export async function openReadyTunnel(inputs: TunnelInputs): Promise<void> {
  await ensurePortAvailable(inputs.session.localPort, inputs.context.signal);
  ensureStartupActive(inputs, "the final local-port check");
  const child = spawnSshTunnel(
    inputs.options.app,
    inputs.session.localPort,
    inputs.session.remotePort,
    { ...inputs.context, phase: "opening the SSH tunnel" },
    { process: inputs.target.process, instance: inputs.target.instance },
  );
  inputs.onChild(child);
  const childPid = requireChildPid(child);
  await recordTunnelPid(inputs, childPid);
  const timeoutMs = remainingReadyTimeout(inputs);
  const readyDeadline = Date.now() + timeoutMs;
  await waitForLocalTunnel(inputs, child, timeoutMs);
  ensureStartupActive(inputs, "local tunnel binding");
  await verifyLocalOwner(inputs, child, childPid);
  ensureStartupActive(inputs, "local tunnel ownership verification");
  await verifyInspector(inputs, child, Math.max(1, readyDeadline - Date.now()));
  ensureStartupActive(inputs, "inspector readiness verification");
  await verifyLocalOwner(inputs, child, childPid);
  ensureStartupActive(inputs, "final local tunnel ownership verification");
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new CfDebuggerError(
      "TUNNEL_NOT_READY",
      `SSH tunnel on local port ${inputs.session.localPort.toString()} exited during readiness verification.`,
      diagnosticsStderr(child),
    );
  }
}
