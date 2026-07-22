import { EventEmitter, getEventListeners } from "node:events";
import { performance } from "node:perf_hooks";

import { describe, expect, it, vi } from "vitest";

import type { CdpClient } from "../../src/cdp/client.js";
import { BreakpointFanout } from "../../src/inspector/fanout.js";
import type { InspectorSession, InspectorSessionGroup } from "../../src/inspector/types.js";
import { CfInspectorError } from "../../src/types.js";
import type { BreakpointHandle, InspectorIsolate, PauseEvent } from "../../src/types.js";

interface FakeSessionResult {
  readonly session: InspectorSession;
  readonly calls: string[];
  pause(pause?: Partial<PauseEvent>): void;
  close(): void;
}

class FakeGroup implements InspectorSessionGroup {
  private readonly sessions: InspectorSession[] = [];
  private readonly listeners = new Set<(session: InspectorSession) => void>();
  private readonly removedListeners = new Set<(session: InspectorSession) => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();
  public readonly targetIndex = 0;
  public readonly targetCount = 1;
  public readonly workerDiscoverySupported = true;

  public add(session: InspectorSession): void {
    this.sessions.push(session);
    for (const listener of this.listeners) {
      listener(session);
    }
  }

  public list(): readonly InspectorSession[] {
    return this.sessions;
  }

  public remove(session: InspectorSession): void {
    const index = this.sessions.indexOf(session);
    if (index >= 0) {
      this.sessions.splice(index, 1);
    }
    for (const listener of this.removedListeners) {
      listener(session);
    }
  }

  public onSession(listener: (session: InspectorSession) => void): () => void {
    this.listeners.add(listener);
    for (const session of this.sessions) {
      listener(session);
    }
    return (): void => {
      this.listeners.delete(listener);
    };
  }

  public onSessionRemoved(listener: (session: InspectorSession) => void): () => void {
    this.removedListeners.add(listener);
    return (): void => {
      this.removedListeners.delete(listener);
    };
  }

  public onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener);
    return (): void => {
      this.errorListeners.delete(listener);
    };
  }

  public dispose(): Promise<void> {
    return Promise.resolve();
  }
}

function breakpoint(id: string): BreakpointHandle {
  return {
    breakpointId: id,
    file: "worker.mjs",
    line: 10,
    urlRegex: "worker",
    resolvedLocations: [{ scriptId: id, lineNumber: 9 }],
  };
}

function fakeSession(isolate: InspectorIsolate, breakpointId: string): FakeSessionResult {
  const emitter = new EventEmitter();
  const calls: string[] = [];
  const session: InspectorSession = {
    client: {
      isClosed: false,
      waitFor: async (_method: string, options: { readonly signal?: AbortSignal }) =>
        await new Promise<unknown>((resolve, reject) => {
          const onPause = (value: unknown): void => {
            options.signal?.removeEventListener("abort", onAbort);
            resolve(value);
          };
          const onAbort = (): void => {
            emitter.off("pause", onPause);
            reject(new CfInspectorError("ABORTED", "aborted"));
          };
          emitter.once("pause", onPause);
          emitter.once("close", () => {
            reject(new Error("detached worker connection closed"));
          });
          options.signal?.addEventListener("abort", onAbort, { once: true });
        }),
      send: async (method: string): Promise<unknown> => {
        calls.push(method);
        if (method === "Debugger.resume") {
          session.debuggerState.paused = false;
        }
        return {};
      },
    } as unknown as CdpClient,
    target: { id: breakpointId, type: "node" } as never,
    isolate,
    scripts: new Map(),
    pauseBuffer: [],
    pauseWaitGate: { active: false },
    debuggerState: { paused: false },
    dispose: async (): Promise<void> => undefined,
  };
  return {
    session,
    calls,
    pause: (pause = {}): void => {
      const event: PauseEvent = {
        reason: "other",
        hitBreakpoints: [breakpointId],
        callFrames: [],
        ...pause,
      };
      session.debuggerState.paused = true;
      session.debuggerState.currentPause = event;
      emitter.emit("pause", event);
    },
    close: (): void => {
      emitter.emit("close");
    },
  };
}

describe("BreakpointFanout", () => {
  it("returns the first isolate and resumes another isolate that also paused", async () => {
    const group = new FakeGroup();
    const main = fakeSession({ kind: "main" }, "bp-main");
    const worker = fakeSession({ kind: "worker", workerId: "7" }, "bp-worker");
    group.add(main.session);
    group.add(worker.session);
    const fanout = new BreakpointFanout(group, async (session) => ({
      handles: [breakpoint(session.target.id)],
    }));
    await fanout.ready();

    const pending = fanout.waitForFirst(1_000);
    await vi.waitFor(() => {
      expect(main.session.pauseWaitGate.active).toBe(true);
      expect(worker.session.pauseWaitGate.active).toBe(true);
    });
    worker.pause();
    main.pause();
    const hit = await pending;

    expect(hit.session).toBe(worker.session);
    expect(main.calls).toContain("Debugger.resume");
    expect(worker.calls).not.toContain("Debugger.resume");
    const cleanup = await fanout.cleanup();
    expect(cleanup).toMatchObject({ attempted: 2, cleared: 2 });
  });

  it("arms and races a worker added after waiting starts", async () => {
    const group = new FakeGroup();
    const main = fakeSession({ kind: "main" }, "bp-main");
    group.add(main.session);
    const setup = vi.fn(async (session: InspectorSession) => ({
      handles: [breakpoint(session.target.id)],
    }));
    const fanout = new BreakpointFanout(group, setup);
    await fanout.ready();
    const pending = fanout.waitForFirst(1_000);
    const worker = fakeSession({ kind: "worker", workerId: "9" }, "bp-worker");
    group.add(worker.session);
    await vi.waitFor(() => {
      expect(setup).toHaveBeenCalledTimes(2);
      expect(worker.session.pauseWaitGate.active).toBe(true);
    });
    worker.pause();

    await expect(pending).resolves.toMatchObject({ session: worker.session });
    await fanout.cleanup();
  });

  it("resumes paused sessions and clears breakpoints during abort cleanup", async () => {
    const group = new FakeGroup();
    const worker = fakeSession({ kind: "worker", workerId: "11" }, "bp-worker");
    group.add(worker.session);
    const fanout = new BreakpointFanout(group, async () => ({ handles: [breakpoint("bp-worker")] }));
    await fanout.ready();
    worker.pause();
    const cleanup = await fanout.cleanup();

    expect(cleanup).toEqual({ attempted: 1, cleared: 1, resumed: 1 });
    expect(worker.calls).toEqual(["Debugger.removeBreakpoint", "Debugger.resume"]);
  });

  it("bounds cleanup when setup or resume never settles", async () => {
    const setupGroup = new FakeGroup();
    const setupSession = fakeSession({ kind: "main" }, "bp-main");
    setupGroup.add(setupSession.session);
    const setupFanout = new BreakpointFanout(
      setupGroup,
      async () => await new Promise<never>(() => undefined),
    );
    const setupStarted = performance.now();
    await setupFanout.cleanup(20);
    expect(performance.now() - setupStarted).toBeLessThan(100);

    const resumeGroup = new FakeGroup();
    const resumeSession = fakeSession({ kind: "main" }, "bp-main");
    resumeSession.pause();
    resumeSession.session.client.send = async (): Promise<never> =>
      await new Promise<never>(() => undefined);
    resumeGroup.add(resumeSession.session);
    const resumeFanout = new BreakpointFanout(resumeGroup, async () => ({ handles: [] }));
    await resumeFanout.ready();
    const resumeStarted = performance.now();
    await resumeFanout.cleanup(20);
    expect(performance.now() - resumeStarted).toBeLessThan(100);
  });

  it("removes the shared abort listener after every completed race", async () => {
    const group = new FakeGroup();
    const main = fakeSession({ kind: "main" }, "bp-main");
    group.add(main.session);
    const fanout = new BreakpointFanout(group, async () => ({ handles: [breakpoint("bp-main")] }));
    await fanout.ready();
    const controller = new AbortController();
    for (let index = 0; index < 5; index += 1) {
      const pending = fanout.waitForFirst(1_000, {}, controller.signal);
      await vi.waitFor(() => {
        expect(main.session.pauseWaitGate.active).toBe(true);
      });
      main.pause();
      await pending;
      await resumeForNextRace(main.session);
    }
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    await fanout.cleanup();
  });

  it("does not include a detached worker in later pause races", async () => {
    const group = new FakeGroup();
    const main = fakeSession({ kind: "main" }, "bp-main");
    const worker = fakeSession({ kind: "worker", workerId: "3" }, "bp-worker");
    group.add(main.session);
    group.add(worker.session);
    const fanout = new BreakpointFanout(group, async (session) => ({
      handles: [breakpoint(session.target.id)],
    }));
    await fanout.ready();
    group.remove(worker.session);
    worker.close();
    const pending = fanout.waitForFirst(1_000);
    await vi.waitFor(() => {
      expect(main.session.pauseWaitGate.active).toBe(true);
    });
    main.pause();
    await expect(pending).resolves.toMatchObject({ session: main.session });
    await fanout.cleanup();
  });

  it("continues an active race when a worker detaches", async () => {
    const group = new FakeGroup();
    const main = fakeSession({ kind: "main" }, "bp-main");
    const worker = fakeSession({ kind: "worker", workerId: "4" }, "bp-worker");
    group.add(main.session);
    group.add(worker.session);
    const fanout = new BreakpointFanout(group, async (session) => ({
      handles: [breakpoint(session.target.id)],
    }));
    await fanout.ready();
    const pending = fanout.waitForFirst(1_000);
    await vi.waitFor(() => {
      expect(worker.session.pauseWaitGate.active).toBe(true);
    });
    group.remove(worker.session);
    await vi.waitFor(() => {
      expect(main.session.pauseWaitGate.active).toBe(true);
    });
    main.pause();
    await expect(pending).resolves.toMatchObject({ session: main.session });
    await fanout.cleanup();
  });

  it("clears handles tracked before a later setup failure", async () => {
    const group = new FakeGroup();
    const main = fakeSession({ kind: "main" }, "bp-main");
    group.add(main.session);
    const fanout = new BreakpointFanout(group, async (_session, trackHandle) => {
      trackHandle(breakpoint("bp-created"));
      throw new Error("second breakpoint failed");
    });
    await expect(fanout.ready()).rejects.toThrow("second breakpoint failed");
    await expect(fanout.cleanup()).resolves.toMatchObject({ attempted: 1, cleared: 1 });
    expect(main.calls).toContain("Debugger.removeBreakpoint");
  });

  it("does not resume an unrelated pause during cleanup", async () => {
    const group = new FakeGroup();
    const main = fakeSession({ kind: "main" }, "bp-main");
    group.add(main.session);
    const fanout = new BreakpointFanout(group, async () => ({ handles: [breakpoint("bp-main")] }));
    await fanout.ready();
    main.pause({ hitBreakpoints: ["some-other-breakpoint"] });

    await expect(fanout.cleanup()).resolves.toMatchObject({ resumed: 0 });
    expect(main.calls).not.toContain("Debugger.resume");
  });

  it("resumes an owned exception pause when another isolate fails during setup", async () => {
    const group = new FakeGroup();
    const main = fakeSession({ kind: "main" }, "main");
    const worker = fakeSession({ kind: "worker", workerId: "12" }, "worker");
    group.add(main.session);
    group.add(worker.session);
    const fanout = new BreakpointFanout(group, async (session) => {
      if (session === main.session) {
        main.pause({ reason: "exception", hitBreakpoints: [] });
        return { handles: [] };
      }
      throw new Error("worker setup failed");
    }, ["exception", "promiseRejection"]);

    await expect(fanout.ready()).rejects.toThrow("worker setup failed");
    await expect(fanout.cleanup()).resolves.toMatchObject({ resumed: 1 });
    expect(main.calls).toContain("Debugger.resume");
  });
});

async function resumeForNextRace(session: InspectorSession): Promise<void> {
  session.debuggerState.paused = false;
  delete session.debuggerState.currentPause;
  await Promise.resolve();
}
