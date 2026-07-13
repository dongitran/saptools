import { describe, expect, it, vi } from "vitest";

import type { CdpClient } from "../../src/cdp/client.js";
import type {
  ExceptionCommandOptions,
  SnapshotCommandOptions,
  Target,
  WatchCommandOptions,
} from "../../src/cli/commandTypes.js";
import { internalsForTesting as exceptionInternals } from "../../src/cli/commands/exception.js";
import { internalsForTesting as snapshotInternals } from "../../src/cli/commands/snapshot.js";
import { internalsForTesting as watchInternals } from "../../src/cli/commands/watch.js";
import type { InspectorSession } from "../../src/inspector/index.js";
import type { ScriptInfo } from "../../src/types.js";

const target: Target = { kind: "port", port: 9229, host: "127.0.0.1" };

function snapshotOptions(overrides: Partial<SnapshotCommandOptions> = {}): SnapshotCommandOptions {
  return {
    bp: ["fixtures/sample-app.mjs:14"],
    json: true,
    ...overrides,
  };
}

function watchOptions(overrides: Partial<WatchCommandOptions> = {}): WatchCommandOptions {
  return {
    bp: ["fixtures/sample-app.mjs:14"],
    json: true,
    ...overrides,
  };
}

function exceptionOptions(
  overrides: Partial<ExceptionCommandOptions> = {},
): ExceptionCommandOptions {
  return { json: true, ...overrides };
}

describe("setup-eval command preparation", () => {
  it("snapshot preparation defaults setupEvals to an empty array", () => {
    const prepared = snapshotInternals.prepareSnapshotCommand(snapshotOptions(), target);
    expect(prepared.setupEvals).toEqual([]);
  });

  it("snapshot preparation preserves repeated setup eval order", () => {
    const prepared = snapshotInternals.prepareSnapshotCommand(
      snapshotOptions({ setupEval: ["globalThis.a = 1", "globalThis.b = globalThis.a + 1"] }),
      target,
    );
    expect(prepared.setupEvals).toEqual(["globalThis.a = 1", "globalThis.b = globalThis.a + 1"]);
  });

  it("snapshot preparation trims setup evals and ignores empty expressions", () => {
    const prepared = snapshotInternals.prepareSnapshotCommand(
      snapshotOptions({ setupEval: ["  globalThis.a = 1  ", "   ", "globalThis.b = 2"] }),
      target,
    );
    expect(prepared.setupEvals).toEqual(["globalThis.a = 1", "globalThis.b = 2"]);
  });

  it("watch preparation defaults setupEvals to an empty array", () => {
    const prepared = watchInternals.prepareWatchCommand(watchOptions(), target);
    expect(prepared.setupEvals).toEqual([]);
  });

  it("watch preparation preserves repeated setup eval order", () => {
    const prepared = watchInternals.prepareWatchCommand(
      watchOptions({ setupEval: ["globalThis.a = 1", "globalThis.b = globalThis.a + 1"] }),
      target,
    );
    expect(prepared.setupEvals).toEqual(["globalThis.a = 1", "globalThis.b = globalThis.a + 1"]);
  });

  it("watch preparation trims setup evals and ignores empty expressions", () => {
    const prepared = watchInternals.prepareWatchCommand(
      watchOptions({ setupEval: ["  globalThis.a = 1  ", "", "  ", "globalThis.b = 2"] }),
      target,
    );
    expect(prepared.setupEvals).toEqual(["globalThis.a = 1", "globalThis.b = 2"]);
  });
});

describe("capture mutation command preparation", () => {
  it("enables V8 side-effect blocking by default for every capture command", () => {
    expect(snapshotInternals.prepareSnapshotCommand(snapshotOptions(), target).throwOnSideEffect).toBe(true);
    expect(watchInternals.prepareWatchCommand(watchOptions(), target).throwOnSideEffect).toBe(true);
    expect(exceptionInternals.prepareExceptionCommand(exceptionOptions(), target).throwOnSideEffect).toBe(true);
  });

  it("disables V8 side-effect blocking only when --allow-mutation is explicit", () => {
    expect(snapshotInternals.prepareSnapshotCommand(
      snapshotOptions({ allowMutation: true }),
      target,
    ).throwOnSideEffect).toBe(false);
    expect(watchInternals.prepareWatchCommand(
      watchOptions({ allowMutation: true }),
      target,
    ).throwOnSideEffect).toBe(false);
    expect(exceptionInternals.prepareExceptionCommand(
      exceptionOptions({ allowMutation: true }),
      target,
    ).throwOnSideEffect).toBe(false);
  });

  it("blocks a mutation-shaped native breakpoint condition without opt-in", () => {
    expect(() => snapshotInternals.prepareSnapshotCommand(
      snapshotOptions({ condition: "state.value = 1" }),
      target,
    )).toThrow(expect.objectContaining({ code: "MUTATION_NOT_ALLOWED" }));
    expect(() => watchInternals.prepareWatchCommand(
      watchOptions({ condition: "items.push(1)" }),
      target,
    )).toThrow(expect.objectContaining({ code: "MUTATION_NOT_ALLOWED" }));
  });

  it("allows a mutation-shaped native condition after explicit opt-in", () => {
    const prepared = snapshotInternals.prepareSnapshotCommand(
      snapshotOptions({ condition: "state.value = 1", allowMutation: true }),
      target,
    );
    expect(prepared.condition).toBe("state.value = 1");
  });
});

describe("watch setup-eval execution ordering", () => {
  it("runs setup eval before condition validation and breakpoint setup", async () => {
    const calls: string[] = [];
    const session = makeSession(async (method, params) => {
      const expression = params["expression"];
      const condition = params["condition"];
      const detail = typeof expression === "string" ? expression : (typeof condition === "string" ? condition : "");
      calls.push(`${method}:${detail}`);
      if (method === "Debugger.setBreakpointByUrl") {
        return { breakpointId: "bp-1", locations: [] };
      }
      return {};
    });
    const command = watchInternals.prepareWatchCommand(
      watchOptions({ setupEval: ["globalThis.ready = true"], condition: "globalThis.ready" }),
      target,
    );
    const controller = new AbortController();
    controller.abort();
    await watchInternals.runWatchLoop(session, command, watchOptions(), controller.signal);
    expect(calls.slice(0, 3)).toEqual([
      "Runtime.evaluate:globalThis.ready = true",
      "Runtime.compileScript:globalThis.ready",
      "Debugger.setBreakpointByUrl:globalThis.ready",
    ]);
  });

  it("does not install a breakpoint when setup eval fails", async () => {
    const calls: string[] = [];
    const session = makeSession(async (method) => {
      calls.push(method);
      if (method === "Runtime.evaluate") {
        return { exceptionDetails: { text: "setup failed" } };
      }
      return {};
    });
    const command = watchInternals.prepareWatchCommand(
      watchOptions({ setupEval: ["throw new Error('setup failed')"], condition: "true" }),
      target,
    );
    await expect(
      watchInternals.runWatchLoop(session, command, watchOptions(), new AbortController().signal),
    ).rejects.toMatchObject({ code: "SETUP_EVAL_FAILED", message: "setup failed" });
    expect(calls).toEqual(["Runtime.evaluate"]);
  });

  it("warns after a bound zero-hit watch is stopped by a signal", async () => {
    const writeErrorSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const session = makeSession(async (method) => {
      if (method === "Debugger.setBreakpointByUrl") {
        return {
          breakpointId: "bp-1",
          locations: [{ scriptId: "script-1", lineNumber: 13 }],
        };
      }
      return {};
    });
    const command = watchInternals.prepareWatchCommand(watchOptions(), target);
    const controller = new AbortController();
    controller.abort();
    try {
      const result = await watchInternals.runWatchLoop(
        session,
        command,
        watchOptions(),
        controller.signal,
      );
      expect(result).toEqual({ emitted: 0, stoppedReason: "signal" });
      const output = writeErrorSpy.mock.calls.flatMap((call) => call).join("");
      expect(output).toContain("no hit was observed");
      expect(output).toContain("worker isolate");
    } finally {
      writeErrorSpy.mockRestore();
    }
  });
});

describe("snapshot setup-eval execution ordering", () => {
  it("runs setup eval before condition validation and breakpoint setup", async () => {
    const calls: string[] = [];
    const session = makeSession(async (method, params) => {
      const expression = params["expression"];
      const condition = params["condition"];
      const detail = typeof expression === "string" ? expression : (typeof condition === "string" ? condition : "");
      calls.push(`${method}:${detail}`);
      if (method === "Debugger.setBreakpointByUrl") {
        return { breakpointId: "bp-1", locations: [] };
      }
      return {};
    }, {
      hitBreakpoints: ["bp-1"],
    });
    const command = snapshotInternals.prepareSnapshotCommand(
      snapshotOptions({ setupEval: ["globalThis.ready = true"], condition: "globalThis.ready" }),
      target,
    );
    await snapshotInternals.runSnapshotOnSession(session, command, snapshotOptions());
    expect(calls.slice(0, 4)).toEqual([
      "Runtime.evaluate:globalThis.ready = true",
      "Runtime.compileScript:globalThis.ready",
      "Debugger.setBreakpointByUrl:globalThis.ready",
      "Debugger.resume:",
    ]);
  });

  it("does not install a breakpoint when setup eval fails", async () => {
    const calls: string[] = [];
    const session = makeSession(async (method) => {
      calls.push(method);
      if (method === "Runtime.evaluate") {
        return { exceptionDetails: { text: "setup failed" } };
      }
      return {};
    });
    const command = snapshotInternals.prepareSnapshotCommand(
      snapshotOptions({ setupEval: ["throw new Error('setup failed')"], condition: "true" }),
      target,
    );
    await expect(
      snapshotInternals.runSnapshotOnSession(session, command, snapshotOptions()),
    ).rejects.toMatchObject({ code: "SETUP_EVAL_FAILED", message: "setup failed" });
    expect(calls).toEqual(["Runtime.evaluate"]);
  });
});

function makeSession(
  responder: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  pause?: { readonly hitBreakpoints: readonly string[] },
): InspectorSession {
  const send = vi.fn(async (method: string, params: Record<string, unknown> = {}) => await responder(method, params));
  return {
    client: {
      send,
      onClose: () => (): void => undefined,
      waitFor: async () => ({
        reason: "other",
        hitBreakpoints: pause?.hitBreakpoints ?? [],
        callFrames: [
          {
            callFrameId: "frame-1",
            functionName: "handler",
            url: "file:///repo/fixtures/sample-app.mjs",
            lineNumber: 13,
            columnNumber: 0,
            scopeChain: [],
          },
        ],
      }),
    } as unknown as CdpClient,
    target: { id: "t", type: "node" } as never,
    scripts: new Map<string, ScriptInfo>(),
    pauseBuffer: [],
    pauseWaitGate: { active: false },
    debuggerState: {},
    dispose: async (): Promise<void> => undefined,
  };
}
