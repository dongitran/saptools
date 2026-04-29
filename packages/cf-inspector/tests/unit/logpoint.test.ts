import { describe, expect, it, vi } from "vitest";

import type { InspectorSession } from "../../src/inspector.js";
import { internalsForTesting, streamLogpoint } from "../../src/logpoint.js";
import type { BreakpointLocation } from "../../src/types.js";

const { buildLogpointCondition, parseLogEvent, generateSentinel, SENTINEL_PREFIX } = internalsForTesting;

describe("buildLogpointCondition", () => {
  it("embeds the sentinel as a JS string literal and wraps in IIFE returning false", () => {
    const cond = buildLogpointCondition("__CFI_LOG_abc__", "user.id");
    expect(cond.startsWith("(function(){")).toBe(true);
    expect(cond.endsWith("})()")).toBe(true);
    expect(cond).toContain('"__CFI_LOG_abc__"');
    expect(cond).toContain("(user.id)");
    expect(cond).toContain("return false;");
  });

  it("escapes a sentinel that contains characters needing JSON escaping", () => {
    const cond = buildLogpointCondition('a"b\\c', "x");
    expect(cond).toContain('"a\\"b\\\\c"');
  });

  it("wraps a multi-token user expression in parens so order of operations is preserved", () => {
    const cond = buildLogpointCondition("S", "1 + 2");
    expect(cond).toContain("(1 + 2)");
  });
});

describe("generateSentinel", () => {
  it("produces unique values with the documented prefix and 16 hex chars", () => {
    const a = generateSentinel();
    const b = generateSentinel();
    expect(a).not.toBe(b);
    expect(a.startsWith(SENTINEL_PREFIX)).toBe(true);
    expect(a.endsWith("__")).toBe(true);
    const middle = a.slice(SENTINEL_PREFIX.length, -2);
    expect(middle).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("parseLogEvent", () => {
  const location: BreakpointLocation = { file: "src/handler.ts", line: 42 };
  const sentinel = "__CFI_LOG_test__";

  function arg(value: unknown, type = "string"): unknown {
    return { type, value };
  }

  it("returns undefined when the sentinel does not match", () => {
    expect(
      parseLogEvent([arg("other-prefix"), arg("payload")], sentinel, location, undefined),
    ).toBeUndefined();
  });

  it("returns undefined when args is not an array or has fewer than two entries", () => {
    expect(parseLogEvent(undefined, sentinel, location, undefined)).toBeUndefined();
    expect(parseLogEvent([arg(sentinel)], sentinel, location, undefined)).toBeUndefined();
  });

  it("decodes a JSON-encoded primitive value", () => {
    const event = parseLogEvent(
      [arg(sentinel), arg("42")],
      sentinel,
      location,
      1_000_000,
    );
    expect(event?.value).toBe("42");
    expect(event?.at).toBe("src/handler.ts:42");
    expect(event?.ts).toBe(new Date(1_000_000).toISOString());
  });

  it("decodes a JSON-encoded string value back to the original string", () => {
    const event = parseLogEvent([arg(sentinel), arg('"hi"')], sentinel, location, undefined);
    expect(event?.value).toBe("hi");
  });

  it("preserves an unparseable raw payload as both value and raw", () => {
    const event = parseLogEvent(
      [arg(sentinel), arg("not json")],
      sentinel,
      location,
      undefined,
    );
    expect(event?.value).toBe("not json");
    expect(event?.raw).toBe("not json");
  });

  it("surfaces an inspectee-side error when the payload starts with !err:", () => {
    const event = parseLogEvent(
      [arg(sentinel), arg("!err:expression threw")],
      sentinel,
      location,
      undefined,
    );
    expect(event?.error).toBe("expression threw");
    expect(event?.value).toBeUndefined();
  });

  it("re-stringifies a JSON object so the value field is a stable JSON string", () => {
    const event = parseLogEvent(
      [arg(sentinel), arg('{"id":7,"name":"x"}')],
      sentinel,
      location,
      undefined,
    );
    expect(event?.value).toBe('{"id":7,"name":"x"}');
    expect(event?.raw).toBeUndefined();
  });

  it("ignores non-string first args (number/object) so app traffic is filtered out", () => {
    expect(
      parseLogEvent([arg(7, "number"), arg("payload")], sentinel, location, undefined),
    ).toBeUndefined();
  });
});

describe("streamLogpoint", () => {
  const location: BreakpointLocation = { file: "src/handler.ts", line: 42 };

  function makeSession(): {
    session: InspectorSession;
    fire: (args: unknown) => void;
    closeFn: () => void;
    sendCalls: { method: string; params: Record<string, unknown> }[];
  } {
    const sendCalls: { method: string; params: Record<string, unknown> }[] = [];
    const eventListeners = new Map<string, ((p: unknown) => void)[]>();
    let closeListener: (() => void) | undefined;
    const send = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
      sendCalls.push({ method, params });
      if (method === "Debugger.setBreakpointByUrl") {
        return { breakpointId: "bp-1", locations: [] };
      }
      if (method === "Debugger.removeBreakpoint") {
        return {};
      }
      return {};
    });
    const fire = (args: unknown): void => {
      const listeners = eventListeners.get("Runtime.consoleAPICalled") ?? [];
      for (const fn of listeners) {
        fn({ type: "log", args, timestamp: 1_000 });
      }
    };
    const session: InspectorSession = {
      client: {
        send,
        on: (method: string, listener: (p: unknown) => void): (() => void) => {
          const list = eventListeners.get(method) ?? [];
          list.push(listener);
          eventListeners.set(method, list);
          return (): void => {
            const next = (eventListeners.get(method) ?? []).filter((l) => l !== listener);
            eventListeners.set(method, next);
          };
        },
        onClose: (listener: () => void): (() => void) => {
          closeListener = listener;
          return (): void => {
            closeListener = undefined;
          };
        },
      } as never,
      target: { id: "t", type: "node" } as never,
      scripts: new Map(),
      pauseBuffer: [],
      dispose: async (): Promise<void> => undefined,
    };
    return {
      session,
      fire,
      closeFn: (): void => {
        closeListener?.();
      },
      sendCalls,
    };
  }

  it("sets a breakpoint with the logpoint condition then forwards matching events", async () => {
    const { session, fire, sendCalls } = makeSession();
    const events: unknown[] = [];
    const stream = streamLogpoint(session, {
      location,
      expression: "user.id",
      durationMs: 50,
      onEvent: (event) => {
        events.push(event);
      },
    });
    // Yield the event loop so streamLogpoint completes its setBreakpoint await
    // chain and attaches the Runtime.consoleAPICalled listener before we fire.
    await new Promise<void>((r) => setImmediate(r));

    const setCall = sendCalls.find((c) => c.method === "Debugger.setBreakpointByUrl");
    expect(setCall).toBeDefined();
    expect(setCall?.params["condition"]).toContain("(user.id)");
    expect(setCall?.params["condition"]).toContain("__CFI_LOG_");

    const sentinel = /__CFI_LOG_[0-9a-f]+__/.exec(setCall?.params["condition"] as string)![0];
    // One matching log + one non-matching (must be filtered out by sentinel check).
    fire([{ type: "string", value: sentinel }, { type: "string", value: "42" }]);
    fire([{ type: "string", value: "not-our-sentinel" }, { type: "string", value: "xx" }]);

    const result = await stream;
    expect(result.emitted).toBe(1);
    expect(result.stoppedReason).toBe("duration");
    expect(events).toHaveLength(1);
    expect((events[0] as { value: string }).value).toBe("42");

    const removeCall = sendCalls.find((c) => c.method === "Debugger.removeBreakpoint");
    expect(removeCall?.params["breakpointId"]).toBe("bp-1");
  });

  it("stops on AbortSignal with stoppedReason='signal'", async () => {
    const { session } = makeSession();
    const ac = new AbortController();
    const promise = streamLogpoint(session, {
      location,
      expression: "x",
      signal: ac.signal,
      onEvent: (): void => undefined,
    });
    // Give streamLogpoint a chance to await setBreakpoint and reach waitForStop
    // before we fire the signal — otherwise we'd race the listener attachment.
    await new Promise<void>((r) => setTimeout(r, 5));
    ac.abort();
    const result = await promise;
    expect(result.stoppedReason).toBe("signal");
  });

  it("stops with stoppedReason='transport-closed' when the CDP connection drops", async () => {
    const { session, closeFn } = makeSession();
    const promise = streamLogpoint(session, {
      location,
      expression: "x",
      onEvent: (): void => undefined,
    });
    await new Promise<void>((r) => setTimeout(r, 5));
    closeFn();
    const result = await promise;
    expect(result.stoppedReason).toBe("transport-closed");
  });

  it("returns immediately with stoppedReason='signal' if the signal is already aborted", async () => {
    const { session } = makeSession();
    const ac = new AbortController();
    ac.abort();
    const result = await streamLogpoint(session, {
      location,
      expression: "x",
      signal: ac.signal,
      onEvent: (): void => undefined,
    });
    expect(result.stoppedReason).toBe("signal");
  });
});
