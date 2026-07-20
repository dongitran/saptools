export interface GuardedResource {
  readonly label: string;
  // Declared as a plain callback property (not a method signature) since
  // these are always stateless closures, never invoked with a meaningful
  // `this` — callers may freely extract and store the function reference.
  readonly release: () => Promise<void>;
}

export interface ProcessGuardFailure {
  readonly label: string;
  readonly error: Error;
}

export interface ProcessGuard {
  /**
   * Tracks a resource for best-effort release during an emergency shutdown.
   * Returns an unregister function; call it once the resource is disposed
   * through its own normal (non-emergency) path so a later emergency
   * cleanup does not redundantly act on it.
   */
  register(resource: GuardedResource): () => void;
  /**
   * Releases every currently registered resource, most-recently-registered
   * first, swallowing each resource's own errors so a signal handler never
   * throws. Safe to call more than once, including concurrently: only the
   * first call does any work, later callers await the same result.
   */
  runCleanup(): Promise<readonly ProcessGuardFailure[]>;
}

export interface ProcessGuardOptions {
  readonly releaseTimeoutMs?: number;
}

const DEFAULT_RELEASE_TIMEOUT_MS = 2_000;

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(`Non-error rejection: ${String(value)}`);
}

function releaseDeadline(label: string, timeoutMs: number): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    setTimeout(() => {
      reject(new Error(`${label} cleanup timed out after ${timeoutMs.toString()}ms`));
    }, timeoutMs);
  });
}

async function releaseOne(
  resource: GuardedResource,
  timeoutMs: number,
): Promise<ProcessGuardFailure | undefined> {
  try {
    await Promise.race([resource.release(), releaseDeadline(resource.label, timeoutMs)]);
    return undefined;
  } catch (error: unknown) {
    return { label: resource.label, error: asError(error) };
  }
}

async function releaseAll(
  resources: readonly GuardedResource[],
  timeoutMs: number,
): Promise<readonly ProcessGuardFailure[]> {
  const failures: ProcessGuardFailure[] = [];
  // Most-recently-registered first: mirrors nested try/finally unwind order
  // (the debugger port before the session before the tunnel that carries
  // it) and keeps each step's own CDP traffic clear of a connection a later
  // step is about to close.
  for (const resource of [...resources].reverse()) {
    const failure = await releaseOne(resource, timeoutMs);
    if (failure !== undefined) {
      failures.push(failure);
    }
  }
  return failures;
}

export function createProcessGuard(options: ProcessGuardOptions = {}): ProcessGuard {
  const releaseTimeoutMs = options.releaseTimeoutMs ?? DEFAULT_RELEASE_TIMEOUT_MS;
  let resources: readonly GuardedResource[] = [];
  let cleanup: Promise<readonly ProcessGuardFailure[]> | undefined;

  function register(resource: GuardedResource): () => void {
    resources = [...resources, resource];
    return (): void => {
      resources = resources.filter((candidate) => candidate !== resource);
    };
  }

  function runCleanup(): Promise<readonly ProcessGuardFailure[]> {
    cleanup ??= releaseAll(resources, releaseTimeoutMs);
    return cleanup;
  }

  return { register, runCleanup };
}

let sharedGuard: ProcessGuard | undefined;

/**
 * cf-function-trace records at most one trace per CLI process invocation, so
 * a single shared guard lets cli.ts's signal and exception handlers reach
 * whatever tunnel, inspector session, and debugger port the in-flight
 * `record` command has registered — without threading a guard parameter
 * through every layer between the CLI entry point and the trace runtime.
 */
export function getSharedProcessGuard(): ProcessGuard {
  sharedGuard ??= createProcessGuard();
  return sharedGuard;
}
