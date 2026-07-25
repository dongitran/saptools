import { spawn } from "node:child_process";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { connect as netConnect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cfApi, cfAuth, cfTargetSpace, resolveCfBin } from "../cf.js";
import type { CfExecContext } from "../cf.js";
import type { SapCredentials } from "../config.js";
import { CfHanaError, CredentialsNotFoundError } from "../errors.js";
import type { SelectorSource } from "../types.js";

const PORT_POLL_INTERVAL_MS = 100;
const DEFAULT_PORT_PROBE_TIMEOUT_MS = 500;

export interface TunnelTarget {
  readonly apiEndpoint: string;
  readonly orgName: string;
  readonly spaceName: string;
}

export interface TunnelChildProcess {
  readonly pid: number | undefined;
  on(event: "exit" | "error", listener: (...args: readonly unknown[]) => void): void;
  removeListener(event: "exit" | "error", listener: (...args: readonly unknown[]) => void): void;
  unref(): void;
}

export type SpawnTunnelStdio = "ignore" | readonly ["ignore", "ignore", number];

export type SpawnTunnelProcessFn = (
  command: string,
  args: readonly string[],
  options: { readonly detached: true; readonly stdio: SpawnTunnelStdio; readonly env: NodeJS.ProcessEnv },
) => TunnelChildProcess;

export interface SpawnTunnelParams {
  readonly cfHome: string | undefined;
  readonly app: string;
  readonly hanaHost: string;
  readonly hanaPort: number;
  readonly keepaliveSeconds: number;
  /** Absolute `Date.now()`-comparable wall-clock cutoff shared across every candidate. */
  readonly deadline: number;
  /** Secondary per-candidate ceiling; the remaining shared deadline still wins if smaller. */
  readonly candidateTimeoutMs: number;
}

export interface SpawnTunnelResult {
  readonly localPort: number;
  readonly pid: number;
}

export interface SpawnTunnelDeps {
  readonly spawnProcess?: SpawnTunnelProcessFn;
  readonly probePort?: (port: number) => Promise<boolean>;
  readonly allocatePort?: () => Promise<number>;
  readonly killProcess?: (pid: number | undefined) => void;
  /**
   * Called with a short diagnostic (the failed candidate's captured stderr
   * tail) when this candidate fails to become ready. Never called on
   * success, or when the capture produced no content.
   */
  readonly onFailureDiagnostic?: (message: string) => void;
  /**
   * Defaults to a real mkdtemp+open-backed stderr capture. Inject a fast,
   * no-I/O override (e.g. `() => Promise.resolve(undefined)`) in tests that
   * don't exercise diagnostic capture, so their timing stays independent of
   * genuine filesystem I/O.
   */
  readonly openStderrCapture?: () => Promise<StderrCapture | undefined>;
}

function assertPositiveSafeInteger(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new CfHanaError("CONFIG", `${label} must be a positive integer`);
  }
}

/** Ephemeral local TCP port: bound then released for a spawned listener to reclaim. */
export async function allocateLocalPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address === null || typeof address === "string") {
          reject(new CfHanaError("CONNECTION", "Could not allocate a local port for a tunnel"));
          return;
        }
        resolve(address.port);
      });
    });
  });
}

/** True once a TCP connection to `127.0.0.1:<port>` succeeds; bounded by a short timeout. */
export function probeLocalPort(
  port: number,
  timeoutMs: number = DEFAULT_PORT_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = netConnect({ host: "127.0.0.1", port });
    const finish = (result: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish(false);
    }, timeoutMs);
    timer.unref();
    socket.once("connect", () => {
      finish(true);
    });
    socket.once("error", () => {
      finish(false);
    });
  });
}

/** Best-effort termination of an abandoned candidate's tunnel process. */
export function killTunnelProcess(pid: number | undefined): void {
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Already exited or inaccessible; nothing more to do.
  }
}

/**
 * Runs `work` with the CF execution context appropriate for the selector
 * source: `undefined` (ambient env, no override — mirrors `cfEnvDirect`) for
 * an ambient selector, or a fresh, isolated `CF_HOME` authenticated against
 * the resolved org/space for an explicit selector. Unlike `withCfSession`,
 * cleanup of the isolated `CF_HOME` is deferred until `work`'s returned
 * promise settles rather than run synchronously the instant a callback
 * returns — required because `work` here spawns a detached process expected
 * to keep running after this function returns.
 */
export async function withScopedCfSession<T>(
  selectorSource: SelectorSource,
  target: TunnelTarget,
  sapCredentials: SapCredentials | undefined,
  work: (ctx?: CfExecContext) => Promise<T>,
): Promise<T> {
  if (selectorSource === "ambient") {
    return await work();
  }
  if (sapCredentials === undefined) {
    throw new CredentialsNotFoundError(
      "SAP credentials are required to open a tunnel session for an explicit selector",
    );
  }
  const cfHome = await mkdtemp(join(tmpdir(), "saptools-cf-hana-tunnel-"));
  try {
    const ctx: CfExecContext = { cfHome };
    await cfApi(target.apiEndpoint, ctx);
    await cfAuth(sapCredentials.email, sapCredentials.password, ctx);
    await cfTargetSpace(target.orgName, target.spaceName, ctx);
    return await work(ctx);
  } finally {
    await rm(cfHome, { recursive: true, force: true });
  }
}

function raceTunnelReadiness(
  child: TunnelChildProcess,
  localPort: number,
  boundMs: number,
  probePort: (port: number) => Promise<boolean>,
  killProcess: (pid: number | undefined) => void,
): Promise<SpawnTunnelResult | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const timers: { poll?: NodeJS.Timeout; deadline?: NodeJS.Timeout } = {};

    const finish = (result?: SpawnTunnelResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearInterval(timers.poll);
      clearTimeout(timers.deadline);
      child.removeListener("exit", onAbort);
      child.removeListener("error", onAbort);
      if (result === undefined) {
        killProcess(child.pid);
      } else {
        child.unref();
      }
      resolve(result);
    };

    function onAbort(): void {
      finish();
    }

    // Attached synchronously, with no `await` since `spawn()` returned:
    // child_process.spawn reports a missing/unexecutable binary via an
    // async 'error' event, not a synchronous throw, and an EventEmitter
    // 'error' event with no listener throws uncaught.
    child.on("exit", onAbort);
    child.on("error", onAbort);

    timers.poll = setInterval(() => {
      void probePort(localPort).then((open) => {
        if (open && child.pid !== undefined) {
          finish({ localPort, pid: child.pid });
        }
      });
    }, PORT_POLL_INTERVAL_MS);

    timers.deadline = setTimeout(finish, boundMs);
  });
}

const STDERR_TAIL_MAX_CHARS = 4096;

export interface StderrCapture {
  readonly path: string;
  readonly fd: number;
  close(): Promise<void>;
}

/**
 * A detached, cross-invocation-surviving process can't use a pipe for
 * stdio (an unread pipe would block the writer once the parent exits), so
 * a candidate's diagnostic output is instead redirected to a small temp
 * file - a file write has no such backpressure. Setup failures (e.g. no tmp
 * space) degrade to no capture rather than blocking the tunnel attempt.
 */
async function openStderrCapture(): Promise<StderrCapture | undefined> {
  try {
    const dir = await mkdtemp(join(tmpdir(), "saptools-cf-hana-tunnel-log-"));
    const path = join(dir, "stderr.log");
    const handle = await open(path, "w");
    return {
      path,
      fd: handle.fd,
      close: async () => {
        await handle.close().catch(() => {
          // Best-effort cleanup.
        });
        await rm(dir, { recursive: true, force: true });
      },
    };
  } catch {
    return undefined;
  }
}

/** A bounded, whitespace-collapsed tail of the capture file, or `undefined` if empty/unreadable. */
async function readStderrTail(path: string): Promise<string | undefined> {
  try {
    const content = (await readFile(path, "utf8")).trim().replace(/\s+/g, " ");
    if (content.length === 0) {
      return undefined;
    }
    return content.length > STDERR_TAIL_MAX_CHARS
      ? content.slice(-STDERR_TAIL_MAX_CHARS)
      : content;
  } catch {
    return undefined;
  }
}

/**
 * Spawns a detached `cf ssh -L` forward and races "the local port becomes
 * connectable" against "the process exited/errored early" against the
 * remaining shared fallback deadline. Returns `undefined` on any failure —
 * the caller tries the next candidate, or gives up once the deadline is
 * spent. Never throws for a failed candidate; only configuration errors
 * (an invalid keepalive value) throw before anything is spawned.
 */
export async function spawnTunnel(
  params: SpawnTunnelParams,
  deps: SpawnTunnelDeps = {},
): Promise<SpawnTunnelResult | undefined> {
  assertPositiveSafeInteger("tunnel keepalive seconds", params.keepaliveSeconds);
  const remainingMs = params.deadline - Date.now();
  if (remainingMs <= 0) {
    return undefined;
  }
  const boundMs = Math.min(remainingMs, params.candidateTimeoutMs);
  const spawnProcess = deps.spawnProcess ?? (spawn as unknown as SpawnTunnelProcessFn);
  const probePort = deps.probePort ?? probeLocalPort;
  const allocatePort = deps.allocatePort ?? allocateLocalPort;
  const killProcess = deps.killProcess ?? killTunnelProcess;

  const localPort = await allocatePort();
  const { bin, argsPrefix } = resolveCfBin();
  const forward = `${String(localPort)}:${params.hanaHost}:${String(params.hanaPort)}`;
  const args = [
    ...argsPrefix,
    "ssh",
    params.app,
    "-L",
    forward,
    "-c",
    `sleep ${String(params.keepaliveSeconds)}`,
  ];
  const env: NodeJS.ProcessEnv =
    params.cfHome === undefined ? { ...process.env } : { ...process.env, CF_HOME: params.cfHome };
  const openCapture = deps.openStderrCapture ?? openStderrCapture;
  const capture = await openCapture();
  const stdio: SpawnTunnelStdio = capture === undefined ? "ignore" : ["ignore", "ignore", capture.fd];
  const child = spawnProcess(bin, args, { detached: true, stdio, env });

  const result = await raceTunnelReadiness(child, localPort, boundMs, probePort, killProcess);
  if (capture !== undefined) {
    if (result === undefined) {
      try {
        const tail = await readStderrTail(capture.path);
        if (tail !== undefined) {
          deps.onFailureDiagnostic?.(tail);
        }
      } catch {
        // Diagnostic reporting is best-effort: a consumer-supplied
        // onFailureDiagnostic must never be able to leak the capture's temp
        // file (by skipping the close() below) or mask this candidate's
        // real (failed) outcome by throwing out of spawnTunnel instead.
      }
    }
    await capture.close();
  }
  return result;
}
