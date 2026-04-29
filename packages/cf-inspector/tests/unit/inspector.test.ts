import { describe, expect, it, vi } from "vitest";

import type { CdpClient } from "../../src/cdp.js";
import type { InspectorSession } from "../../src/inspector.js";
import { waitForPause } from "../../src/inspector.js";
import type { PauseEvent } from "../../src/types.js";

function makeSession(buffer: PauseEvent[] = []): {
  session: InspectorSession;
  fireEvent: (params: unknown) => void;
} {
  const listeners = new Map<string, ((p: unknown) => void)[]>();
  const fireEvent = (params: unknown): void => {
    const list = listeners.get("Debugger.paused") ?? [];
    for (const fn of list) {
      fn(params);
    }
  };
  const client = {
    waitFor: vi.fn(async (method: string, options: { timeoutMs: number; predicate?: (p: unknown) => boolean }) => {
      return await new Promise<unknown>((resolve, reject) => {
        const off = ((): (() => void) => {
          const wrapped = (raw: unknown): void => {
            if (options.predicate && !options.predicate(raw)) {
              return;
            }
            cleanup();
            resolve(raw);
          };
          const list = listeners.get(method) ?? [];
          list.push(wrapped);
          listeners.set(method, list);
          return (): void => {
            const next = (listeners.get(method) ?? []).filter((fn) => fn !== wrapped);
            listeners.set(method, next);
          };
        })();
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`timed out after ${options.timeoutMs.toString()}ms`));
        }, options.timeoutMs);
        function cleanup(): void {
          clearTimeout(timer);
          off();
        }
      });
    }),
  } as unknown as CdpClient;
  const session: InspectorSession = {
    client,
    target: { id: "t", type: "node" } as never,
    scripts: new Map(),
    pauseBuffer: [...buffer],
    dispose: async (): Promise<void> => undefined,
  };
  return { session, fireEvent };
}

describe("waitForPause", () => {
  it("drains a pre-buffered matching event without awaiting a new one", async () => {
    const { session } = makeSession([
      {
        reason: "other",
        hitBreakpoints: ["bp-1"],
        callFrames: [],
      },
    ]);
    const result = await waitForPause(session, { timeoutMs: 50, breakpointIds: ["bp-1"] });
    expect(result.hitBreakpoints).toEqual(["bp-1"]);
    expect(session.pauseBuffer).toHaveLength(0);
  });

  it("drops buffered events whose breakpointId does not match and times out", async () => {
    const { session } = makeSession([
      {
        reason: "other",
        hitBreakpoints: ["bp-other"],
        callFrames: [],
      },
    ]);
    await expect(
      waitForPause(session, { timeoutMs: 30, breakpointIds: ["bp-1"] }),
    ).rejects.toThrow();
  });

  it("returns the first buffered event when no breakpointIds filter is given", async () => {
    const { session } = makeSession([
      { reason: "step", hitBreakpoints: [], callFrames: [] },
      { reason: "other", hitBreakpoints: ["bp-2"], callFrames: [] },
    ]);
    const result = await waitForPause(session, { timeoutMs: 50 });
    expect(result.reason).toBe("step");
    // one event was consumed; second remains buffered for a future call
    expect(session.pauseBuffer).toHaveLength(1);
  });

  it("waits on the live CDP event when buffer is empty", async () => {
    const { session, fireEvent } = makeSession([]);
    const promise = waitForPause(session, { timeoutMs: 200, breakpointIds: ["bp-7"] });
    setTimeout(() => {
      fireEvent({
        reason: "other",
        hitBreakpoints: ["bp-7"],
        callFrames: [
          {
            callFrameId: "f1",
            functionName: "fn",
            url: "file:///x.js",
            location: { lineNumber: 10, columnNumber: 0 },
            scopeChain: [],
          },
        ],
      });
    }, 5);
    const result = await promise;
    expect(result.reason).toBe("other");
    expect(result.hitBreakpoints).toEqual(["bp-7"]);
    expect(result.callFrames).toHaveLength(1);
    expect(result.callFrames[0]?.functionName).toBe("fn");
  });

  it("ignores live events whose breakpointId is not in the filter", async () => {
    const { session, fireEvent } = makeSession([]);
    const promise = waitForPause(session, { timeoutMs: 100, breakpointIds: ["bp-9"] });
    setTimeout(() => {
      // Non-matching event should be ignored by predicate.
      fireEvent({ reason: "other", hitBreakpoints: ["bp-other"], callFrames: [] });
    }, 5);
    await expect(promise).rejects.toThrow();
  });
});
