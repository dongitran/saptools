import { spawn } from "node:child_process";
import { constants } from "node:os";

import type { SpawnLike } from "./process-types.js";

/** Set on the re-executed process so it can never start a second update. */
export const REEXEC_MARKER_ENV = "SAPTOOLS_SELF_UPDATE_REEXEC";

export interface ReexecRequest {
  readonly execPath: string;
  readonly execArgv: readonly string[];
  readonly binPath: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}

/** Resolves only when the re-executed command has finished and the replacement failed to end this process itself. */
export type ReexecImpl = (request: ReexecRequest) => Promise<void>;

type ExecveLike = (file: string, args: readonly string[], env: NodeJS.ProcessEnv) => never;

export interface ReexecRuntime {
  readonly platform: NodeJS.Platform;
  readonly execve: ExecveLike | undefined;
  readonly spawnImpl: SpawnLike;
  readonly onSignal: (signal: NodeJS.Signals, handler: (signal: NodeJS.Signals) => void) => void;
  readonly offSignal: (signal: NodeJS.Signals, handler: (signal: NodeJS.Signals) => void) => void;
  readonly kill: (pid: number, signal: NodeJS.Signals) => void;
  readonly exit: (code: number) => void;
}

const FORWARDED_SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

function nativeExecve(): ExecveLike | undefined {
  return process.execve?.bind(process);
}

function defaultRuntime(): ReexecRuntime {
  return {
    platform: process.platform,
    execve: nativeExecve(),
    spawnImpl: spawn,
    onSignal: (signal, handler): void => {
      process.on(signal, handler);
    },
    offSignal: (signal, handler): void => {
      process.off(signal, handler);
    },
    kill: (pid, signal): void => {
      process.kill(pid, signal);
    },
    exit: (code): void => {
      process.exit(code);
    },
  };
}

export function buildReexecArgv(request: ReexecRequest): string[] {
  return [...request.execArgv, request.binPath, ...request.args];
}

export function reexecEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, [REEXEC_MARKER_ENV]: "1" };
}

function signalExitCode(signal: NodeJS.Signals): number {
  const number = constants.signals[signal];
  return 128 + number;
}

/**
 * Run the same command again on the freshly installed version. On POSIX with
 * Node >= 22.15 the process image is replaced outright (`execve`), so stdin,
 * stdout, the exit code and signals all belong to the new version with no
 * wrapper left behind. Elsewhere a child inherits our stdio, terminal signals
 * are forwarded to it, and we mirror its exit code or signal.
 */
export async function reexecProcess(request: ReexecRequest, runtimeOverrides: Partial<ReexecRuntime> = {}): Promise<void> {
  const runtime: ReexecRuntime = { ...defaultRuntime(), ...runtimeOverrides };
  const argv = buildReexecArgv(request);
  const env = reexecEnvironment(request.env);

  if (runtime.platform !== "win32" && runtime.execve !== undefined) {
    try {
      runtime.execve(request.execPath, [request.execPath, ...argv], env);
    } catch {
      // execve refused (for example EACCES on an odd mount): the child-process route below still works.
    }
  }

  await new Promise<void>((resolve, reject) => {
    const child = runtime.spawnImpl(request.execPath, argv, { stdio: "inherit", env });
    const forward = (signal: NodeJS.Signals): void => {
      child.kill(signal);
    };
    for (const signal of FORWARDED_SIGNALS) {
      runtime.onSignal(signal, forward);
    }
    const detach = (): void => {
      for (const signal of FORWARDED_SIGNALS) {
        runtime.offSignal(signal, forward);
      }
    };
    child.once("error", (error) => {
      detach();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      detach();
      if (signal === null) {
        runtime.exit(code ?? 1);
      } else {
        runtime.kill(process.pid, signal);
        runtime.exit(signalExitCode(signal));
      }
      resolve();
    });
  });
}
