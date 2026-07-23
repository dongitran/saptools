import { performance } from "node:perf_hooks";

import type { BreakpointHandle, PauseEvent } from "../types.js";
import { CfInspectorError } from "../types.js";

import { removeBreakpoint } from "./breakpoints.js";
import { waitForPause } from "./pause.js";
import { resume } from "./runtime.js";
import type { InspectorSession, InspectorSessionGroup, WaitForPauseOptions } from "./types.js";

const DEFAULT_CLEANUP_TIMEOUT_MS = 2_000;

export interface SessionBreakpointSetup {
  readonly handles: readonly BreakpointHandle[];
}

export interface SessionBreakpointOutcome {
  readonly session: InspectorSession;
  readonly setup: SessionBreakpointSetup;
}

export interface FanoutReadyOptions {
  readonly includeNewSessions?: boolean;
  readonly onReady?: (outcomes: readonly SessionBreakpointOutcome[]) => void;
}

interface SessionRecord {
  readonly session: InspectorSession;
  readonly handles: BreakpointHandle[];
  setup: Promise<void>;
}

export interface IsolatePause {
  readonly session: InspectorSession;
  readonly pause: PauseEvent;
}

export interface FanoutCleanupSummary {
  readonly attempted: number;
  readonly cleared: number;
  readonly resumed: number;
}

export class BreakpointFanout {
  private readonly records = new Map<InspectorSession, SessionRecord>();
  private readonly setupErrors: ((error: unknown) => void)[] = [];
  private readonly detach: () => void;
  private readonly detachRemoved: () => void;
  private readonly detachError: () => void;
  private activeRace: ActivePauseRace | undefined;
  private pauseReasons: readonly string[] = [];
  private pendingSetupError: Error | undefined;
  private preserveReadinessErrors = false;

  public constructor(
    group: InspectorSessionGroup,
    setupSession: (
      session: InspectorSession,
      trackHandle: (handle: BreakpointHandle) => void,
    ) => Promise<SessionBreakpointSetup>,
    pauseReasons: readonly string[] = [],
  ) {
    this.pauseReasons = pauseReasons;
    this.detach = group.onSession((session) => {
      const record: SessionRecord = { session, handles: [], setup: Promise.resolve() };
      this.records.set(session, record);
      record.setup = setupSession(session, (handle) => {
        this.trackHandle(session, handle);
      }).then((result) => {
        for (const handle of result.handles) {
          this.trackHandle(session, handle);
        }
      });
      const setup = record.setup;
      setup.catch((error: unknown) => {
        for (const reject of this.setupErrors) {
          reject(error);
        }
      });
      this.activeRace?.add(record);
    });
    this.detachRemoved = group.onSessionRemoved((session) => {
      this.records.delete(session);
      this.activeRace?.remove(session);
    });
    this.detachError = group.onError((error) => {
      if (this.setupErrors.length === 0 && this.pendingSetupError === undefined) {
        this.pendingSetupError = error;
      }
      for (const reject of this.setupErrors) {
        reject(error);
      }
    });
  }

  public async ready(options: FanoutReadyOptions = {}): Promise<void> {
    if (options.includeNewSessions !== true) {
      const records = [...this.records.values()];
      await Promise.all(records.map((record) => record.setup));
      options.onReady?.(this.outcomesFor(records));
      return;
    }
    this.preserveReadinessErrors = true;
    const pendingError = this.takePendingSetupError();
    if (pendingError !== undefined) {
      throw pendingError;
    }
    let rejectGroupError: (error: unknown) => void = (): void => undefined;
    const groupError = new Promise<never>((_resolve, reject) => {
      rejectGroupError = reject;
    });
    this.setupErrors.push(rejectGroupError);
    try {
      let stableRecords: readonly SessionRecord[] | undefined;
      while (stableRecords === undefined) {
        const records = [...this.records.values()];
        await Promise.race([
          Promise.all(records.map((record) => record.setup)),
          groupError,
        ]);
        const stable = records.length === this.records.size &&
          records.every((record) => this.records.get(record.session) === record);
        if (stable) {
          stableRecords = records;
        }
      }
      // Run the callback before this promise resolves. A session-registration
      // callback cannot interleave between this stable check and the emitted
      // readiness event on JavaScript's single thread.
      options.onReady?.(this.outcomesFor(stableRecords));
    } finally {
      const index = this.setupErrors.indexOf(rejectGroupError);
      if (index >= 0) {
        this.setupErrors.splice(index, 1);
      }
    }
  }

  public trackHandle(session: InspectorSession, handle: BreakpointHandle): void {
    const record = this.records.get(session);
    if (record !== undefined && !record.handles.some((candidate) => candidate.breakpointId === handle.breakpointId)) {
      record.handles.push(handle);
    }
  }

  public availableOutcomes(): readonly SessionBreakpointOutcome[] {
    return this.outcomesFor([...this.records.values()]);
  }

  private outcomesFor(records: readonly SessionRecord[]): readonly SessionBreakpointOutcome[] {
    return records.map((record) => ({
      session: record.session,
      setup: { handles: record.handles },
    }));
  }

  private takePendingSetupError(): Error | undefined {
    const error = this.pendingSetupError;
    this.pendingSetupError = undefined;
    return error;
  }

  public async waitForFirst(
    timeoutMs: number,
    options: Omit<WaitForPauseOptions, "timeoutMs" | "breakpointIds" | "signal"> = {},
    signal?: AbortSignal,
  ): Promise<IsolatePause> {
    if (this.activeRace !== undefined) {
      throw new CfInspectorError("INVALID_ARGUMENT", "A fan-out pause race is already active");
    }
    const race = new ActivePauseRace(timeoutMs, options, signal);
    this.pauseReasons = options.pauseReasons ?? [];
    this.activeRace = race;
    this.setupErrors.push(race.reject);
    if (this.preserveReadinessErrors) {
      const pendingError = this.takePendingSetupError();
      if (pendingError !== undefined) {
        race.reject(pendingError);
      }
    }
    for (const record of this.records.values()) {
      race.add(record);
    }
    try {
      const winner = await race.result;
      await race.stopAndSettle();
      await this.resumePausedLosers(winner.session);
      return winner;
    } finally {
      this.activeRace = undefined;
      const index = this.setupErrors.indexOf(race.reject);
      if (index >= 0) {
        this.setupErrors.splice(index, 1);
      }
      await race.stopAndSettle();
    }
  }

  public async resumePaused(except?: InspectorSession): Promise<number> {
    return await this.resumePausedLosers(except, DEFAULT_CLEANUP_TIMEOUT_MS);
  }

  public async cleanup(
    timeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS,
    preservePaused?: InspectorSession,
  ): Promise<FanoutCleanupSummary> {
    this.detach();
    this.detachRemoved();
    this.detachError();
    const deadline = performance.now() + timeoutMs;
    await settleWithin(Promise.allSettled([...this.records.values()].map(async (record) => {
      await record.setup;
    })), remaining(deadline));
    const breakpointEntries = [...this.records.values()].flatMap((record) =>
      record.handles.map((handle) => ({
          session: record.session,
          breakpointId: handle.breakpointId,
        })));
    let cleared = 0;
    const clearWork = Promise.allSettled(breakpointEntries.map(async (entry) => {
      await removeBreakpoint(entry.session, entry.breakpointId);
      cleared += 1;
    }));
    await settleWithin(clearWork, remaining(deadline));
    const resumed = await this.resumePausedLosers(preservePaused, remaining(deadline));
    return { attempted: breakpointEntries.length, cleared, resumed };
  }

  private async resumePausedLosers(
    except?: InspectorSession,
    timeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS,
  ): Promise<number> {
    let resumed = 0;
    await settleWithin(Promise.allSettled([...this.records.keys()].map(async (session) => {
      if (
        session === except ||
        session.debuggerState.paused !== true ||
        session.client.isClosed ||
        !this.ownsCurrentPause(session)
      ) {
        return;
      }
      await resume(session);
      session.debuggerState.paused = false;
      resumed += 1;
    })), timeoutMs);
    return resumed;
  }

  private ownsCurrentPause(session: InspectorSession): boolean {
    const pause = session.debuggerState.currentPause;
    if (pause === undefined) {
      return false;
    }
    if (this.pauseReasons.includes(pause.reason)) {
      return true;
    }
    const record = this.records.get(session);
    const breakpointIds = new Set(record?.handles.map((handle) => handle.breakpointId) ?? []);
    return pause.hitBreakpoints.some((breakpointId) => breakpointIds.has(breakpointId));
  }
}

class ActivePauseRace {
  private readonly controller = new AbortController();
  private readonly waits = new Set<Promise<void>>();
  private settled = false;
  private readonly deadline: number;
  private readonly timeout: ReturnType<typeof setTimeout>;
  private readonly externalSignal: AbortSignal | undefined;
  private readonly onExternalAbort = (): void => {
    this.reject(new CfInspectorError("ABORTED", "Aborted while waiting for an isolate pause"));
    this.controller.abort();
  };
  private readonly resolveResult: (winner: IsolatePause) => void;
  private terminalTimeoutError: CfInspectorError | undefined;
  private readonly removedSessions = new Set<InspectorSession>();
  public readonly reject: (error: unknown) => void;
  public readonly result: Promise<IsolatePause>;

  public constructor(
    timeoutMs: number,
    private readonly options: Omit<WaitForPauseOptions, "timeoutMs" | "breakpointIds" | "signal">,
    signal?: AbortSignal,
  ) {
    this.externalSignal = signal;
    this.deadline = performance.now() + timeoutMs;
    let resolveResult: ((winner: IsolatePause) => void) | undefined;
    let rejectResult: ((error: unknown) => void) | undefined;
    this.result = new Promise<IsolatePause>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.resolveResult = (winner): void => {
      if (this.settled) {
        return;
      }
      this.settled = true;
      resolveResult?.(winner);
    };
    this.reject = (error): void => {
      if (this.settled) {
        return;
      }
      this.settled = true;
      rejectResult?.(error);
    };
    this.timeout = setTimeout(() => {
      this.reject(this.terminalTimeoutError ?? new CfInspectorError(
          "BREAKPOINT_NOT_HIT",
          `Timed out waiting for a matching pause in any isolate after ${timeoutMs.toString()}ms`,
        ));
      this.controller.abort();
    }, timeoutMs + 25);
    if (signal !== undefined) {
      if (signal.aborted) {
        this.reject(new CfInspectorError("ABORTED", "Aborted while waiting for an isolate pause"));
      } else {
        signal.addEventListener("abort", this.onExternalAbort, { once: true });
      }
    }
  }

  public add(record: SessionRecord): void {
    if (this.settled) {
      return;
    }
    const wait = this.wait(record).finally(() => {
      this.waits.delete(wait);
    });
    this.waits.add(wait);
  }

  public remove(session: InspectorSession): void {
    this.removedSessions.add(session);
  }

  public async stopAndSettle(): Promise<void> {
    clearTimeout(this.timeout);
    this.externalSignal?.removeEventListener("abort", this.onExternalAbort);
    this.controller.abort();
    await Promise.allSettled([...this.waits]);
  }

  private async wait(record: SessionRecord): Promise<void> {
    try {
      await record.setup;
      const remainingMs = Math.max(1, this.deadline - performance.now());
      const pause = await waitForPause(record.session, {
        ...this.options,
        timeoutMs: remainingMs,
        breakpointIds: record.handles.map((handle) => handle.breakpointId),
        signal: this.controller.signal,
      });
      record.session.debuggerState.paused = true;
      this.resolveResult({ session: record.session, pause });
      this.controller.abort();
    } catch (error: unknown) {
      if (this.removedSessions.has(record.session)) {
        return;
      }
      if (error instanceof CfInspectorError && error.code === "UNRELATED_PAUSE_TIMEOUT") {
        this.terminalTimeoutError = error;
        return;
      }
      if (isExpectedRaceStop(error)) {
        return;
      }
      this.reject(error);
      this.controller.abort();
    }
  }
}

function isExpectedRaceStop(error: unknown): boolean {
  return error instanceof CfInspectorError && (
    error.code === "ABORTED" ||
    error.code === "BREAKPOINT_NOT_HIT" ||
    error.code === "UNRELATED_PAUSE_TIMEOUT"
  );
}

function remaining(deadline: number): number {
  return Math.max(0, deadline - performance.now());
}

async function settleWithin<T>(work: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race<T | null>([
      work,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          resolve(null);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
