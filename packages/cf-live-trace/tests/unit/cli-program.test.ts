import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RunOptions } from "../../src/cli/options.js";
import type { StoredTraceEvent, TraceSession } from "../../src/trace-store.js";
import type { LiveTraceEvent } from "../../src/types.js";

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
  readonly onEvents?: (events: readonly LiveTraceEvent[]) => void | Promise<void>;
}

interface MockStopOptions {
  readonly reason: string;
  readonly uninstallRuntimeHook: boolean;
}

const sessionMocks = vi.hoisted(() => ({
  startCalls: [] as readonly unknown[],
  stopCalls: [] as MockStopOptions[],
  eventBatch: undefined as readonly LiveTraceEvent[] | undefined,
  reportRuntimeError: true,
}));

const storeMocks = vi.hoisted(() => ({
  createTraceSession: vi.fn(),
  writeTraceEvent: vi.fn(),
}));

vi.mock("../../src/session.js", () => ({
  LiveTraceSession: class MockLiveTraceSession {
    public constructor(private readonly options: MockSessionOptions) {}

    public async start(options: unknown): Promise<void> {
      sessionMocks.startCalls = [...sessionMocks.startCalls, options];
      this.options.onState?.(createMockState("streaming", "Streaming runtime HTTP trace events."));
      if (sessionMocks.eventBatch !== undefined) {
        await this.options.onEvents?.(sessionMocks.eventBatch);
      }
      if (sessionMocks.reportRuntimeError) {
        setTimeout(() => {
          this.options.onState?.(createMockState("error", "Runtime HTTP trace connection was lost."));
        }, 0);
      }
    }

    public async stop(options: MockStopOptions): Promise<void> {
      sessionMocks.stopCalls.push(options);
    }
  },
}));

vi.mock("../../src/trace-store.js", () => storeMocks);

describe("CLI trace runner", () => {
  beforeEach(() => {
    sessionMocks.startCalls = [];
    sessionMocks.stopCalls.splice(0);
    sessionMocks.eventBatch = undefined;
    sessionMocks.reportRuntimeError = true;
    storeMocks.createTraceSession.mockReset();
    storeMocks.writeTraceEvent.mockReset();
    storeMocks.createTraceSession.mockResolvedValue(createTraceSession());
    storeMocks.writeTraceEvent.mockImplementation(async (_session: TraceSession, event: LiveTraceEvent) => ({
      ...createStoredEvent(event),
      backupPath: `/tmp/${event.id}.json`,
    }));
  });

  it("rejects and cleans up with error reason when a streaming session reports an error", async () => {
    const { runTraceCommand } = await import("../../src/cli/program.js");

    await expect(runTraceCommand(createRunOptions())).rejects.toThrow("Runtime HTTP trace connection was lost.");

    expect(sessionMocks.startCalls).toHaveLength(1);
    expect(sessionMocks.stopCalls).toEqual([
      { uninstallRuntimeHook: true, reason: "error" },
    ]);
  });

  it("backs up and emits no more than the configured maximum event count", async () => {
    const { runTraceCommand } = await import("../../src/cli/program.js");
    sessionMocks.reportRuntimeError = false;
    sessionMocks.eventBatch = [createEvent("runtime-1"), createEvent("runtime-2")];
    const stdout: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
      stdout.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    });

    try {
      await runTraceCommand({
        ...createRunOptions(),
        limits: { maxEvents: 1 },
        format: "ndjson",
      });
    } finally {
      writeSpy.mockRestore();
    }

    expect(storeMocks.writeTraceEvent).toHaveBeenCalledTimes(1);
    expect(stdout.join("").trim().split("\n")).toHaveLength(1);
    expect(sessionMocks.stopCalls).toEqual([
      { uninstallRuntimeHook: true, reason: "max-events" },
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

function createTraceSession(): TraceSession {
  return {
    sessionId: "s12345678",
    createdAt: "2026-06-30T01:00:00.000Z",
    target: {
      region: "ap10",
      org: "demo-org",
      space: "dev",
      app: "orders-api",
      instance: "0",
    },
    directory: "/tmp/s12345678",
    eventsDirectory: "/tmp/s12345678/events",
    manifestPath: "/tmp/s12345678/manifest.json",
  };
}

function createEvent(id: string): LiveTraceEvent {
  return {
    id,
    timestamp: "2026-06-30T01:00:00.000Z",
    appId: "orders-api",
    instance: "0",
    method: "GET",
    path: "/orders",
    url: "/orders",
    normalizedUrl: "/orders",
    status: 200,
    durationMs: 10,
    requestBytes: 0,
    responseBytes: 2,
    requestHeaders: {},
    responseHeaders: { "content-type": "application/json" },
    requestBodyPreview: "",
    responseBodyPreview: "{}",
    requestBodyTruncated: false,
    responseBodyTruncated: false,
    droppedBeforeEvent: 0,
    source: "runtime-http",
    traceId: id,
    correlationId: null,
  };
}

function createStoredEvent(event: LiveTraceEvent): StoredTraceEvent {
  return {
    version: 1,
    sessionId: "s12345678",
    requestId: event.id === "runtime-1" ? "r11111111" : "r22222222",
    createdAt: event.timestamp,
    expiresAt: "2026-06-30T03:00:00.000Z",
    target: createTraceSession().target,
    requestBodyFormat: "empty",
    responseBodyFormat: "json",
    event,
  };
}
