import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RunOptions } from "../../src/cli/options.js";

interface MockStateEvent {
  readonly state: "streaming" | "error";
  readonly app: string;
  readonly instance: string;
  readonly message: string;
  readonly runtimeHookInstalled: boolean;
  readonly runtimeHookMayRemain: boolean;
}

interface MockSessionOptions {
  readonly target: {
    readonly app: string;
  };
  readonly onState?: (event: MockStateEvent) => void;
}

interface MockStopOptions {
  readonly reason: string;
  readonly uninstallRuntimeHook: boolean;
}

const sessionMocks = vi.hoisted(() => ({
  startCalls: [] as readonly unknown[],
  stopCalls: [] as MockStopOptions[],
}));

vi.mock("../../src/session.js", () => ({
  LiveTraceSession: class MockLiveTraceSession {
    public constructor(private readonly options: MockSessionOptions) {}

    public async start(options: unknown): Promise<void> {
      sessionMocks.startCalls = [...sessionMocks.startCalls, options];
      this.options.onState?.(createMockState("streaming", "Streaming runtime HTTP trace events."));
      setTimeout(() => {
        this.options.onState?.(createMockState("error", "Runtime HTTP trace connection was lost."));
      }, 0);
    }

    public async stop(options: MockStopOptions): Promise<void> {
      sessionMocks.stopCalls.push(options);
    }
  },
}));

describe("CLI trace runner", () => {
  beforeEach(() => {
    sessionMocks.startCalls = [];
    sessionMocks.stopCalls.splice(0);
  });

  it("rejects and cleans up with error reason when a streaming session reports an error", async () => {
    const { runTraceCommand } = await import("../../src/cli/program.js");

    await expect(runTraceCommand(createRunOptions())).rejects.toThrow("Runtime HTTP trace connection was lost.");

    expect(sessionMocks.startCalls).toHaveLength(1);
    expect(sessionMocks.stopCalls).toEqual([
      { uninstallRuntimeHook: true, reason: "error" },
    ]);
  });
});

function createRunOptions(): RunOptions {
  return {
    target: {
      apiEndpoint: "https://api.example.com",
      email: "user@example.com",
      password: "password",
      org: "demo-org",
      space: "dev",
      app: "orders-api",
      cfHomeDir: "/tmp/cf-home",
    },
    trace: {
      captureHeaders: true,
      captureRequestBody: true,
      captureResponseBody: true,
      maxBodyBytes: 4096,
      runtimeQueueSize: 1000,
    },
    limits: {
      durationMs: 50,
    },
    format: "ndjson",
    uninstallOnExit: true,
    quiet: true,
  };
}

function createMockState(state: MockStateEvent["state"], message: string): MockStateEvent {
  return {
    state,
    app: "orders-api",
    instance: "0",
    message,
    runtimeHookInstalled: state === "streaming",
    runtimeHookMayRemain: state === "error",
  };
}
