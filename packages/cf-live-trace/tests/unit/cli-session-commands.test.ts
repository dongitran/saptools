import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { StoredTraceEventFile, TraceSessionSummary } from "../../src/trace-store.js";
import type { LiveTraceEvent } from "../../src/types.js";

const storeMocks = vi.hoisted(() => ({
  listTraceSessions: vi.fn(),
  listTraceEvents: vi.fn(),
  visitTraceEvents: vi.fn(),
  pruneTraceSessions: vi.fn(),
  readTraceEvent: vi.fn(),
}));

vi.mock("../../src/trace-store.js", () => storeMocks);

describe("CLI session commands", () => {
  beforeEach(() => {
    storeMocks.listTraceSessions.mockReset();
    storeMocks.listTraceEvents.mockReset();
    storeMocks.visitTraceEvents.mockReset();
    storeMocks.pruneTraceSessions.mockReset();
    storeMocks.readTraceEvent.mockReset();
    storeMocks.visitTraceEvents.mockImplementation(async (
      _sessionId: string,
      visitor: (record: StoredTraceEventFile) => boolean | Promise<boolean>,
    ): Promise<void> => {
      const records: readonly StoredTraceEventFile[] = await storeMocks.listTraceEvents();
      for (const record of records) {
        if (!await visitor(record)) {
          return;
        }
      }
    });
  });

  it("lists saved trace sessions", async () => {
    storeMocks.listTraceSessions.mockResolvedValue([createSessionSummary()]);

    const output = await runSessionCommand(["session", "list"]);

    expect(JSON.parse(output)).toEqual({
      sessions: [createSessionSummary()],
    });
  });

  it("lists filtered compact events without headers", async () => {
    storeMocks.listTraceEvents.mockResolvedValue([
      createStoredEvent({ method: "POST" }),
      createStoredEvent({ requestId: "r22222222", method: "GET" }),
    ]);

    const output = await runSessionCommand(["session", "events", "s12345678", "--method", "POST", "--limit", "1"]);
    const parsed = JSON.parse(output) as { readonly events: readonly Record<string, unknown>[] };

    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0]).toEqual(expect.objectContaining({
      sessionId: "s12345678",
      requestId: "r12345678",
      method: "POST",
    }));
    expect(parsed.events[0]).not.toHaveProperty("requestHeaders");
    expect(parsed.events[0]).not.toHaveProperty("responseHeaders");
  });

  it("searches saved response bodies by default", async () => {
    storeMocks.listTraceEvents.mockResolvedValue([createStoredEvent()]);

    const output = await runSessionCommand(["session", "search", "s12345678", "alpha", "--limit", "5", "--length", "20"]);
    const parsed = JSON.parse(output) as { readonly matches: readonly Record<string, unknown>[] };

    expect(parsed.matches).toEqual([
      expect.objectContaining({ requestId: "r12345678", body: "response", path: "/data/name" }),
    ]);
  });

  it("inspects a saved response JSON body", async () => {
    storeMocks.readTraceEvent.mockResolvedValue(createStoredEvent());

    const output = await runSessionCommand([
      "session",
      "body",
      "s12345678",
      "r12345678",
      "--body",
      "response",
      "--path",
      "/data",
      "--limit",
      "12",
      "--rows",
      "1",
    ]);
    const parsed = JSON.parse(output) as {
      readonly rows: readonly Record<string, unknown>[];
      readonly totalRows: number;
      readonly rowsTruncated: boolean;
    };

    expect(parsed.rows).toEqual([
      { path: "/data/name", type: "string", value: "alpha-value-" },
    ]);
    expect(parsed.totalRows).toBe(1);
    expect(parsed.rowsTruncated).toBe(false);
  });

  it("prunes expired trace events", async () => {
    storeMocks.pruneTraceSessions.mockResolvedValue(2);

    const output = await runSessionCommand(["session", "prune"]);

    expect(JSON.parse(output)).toEqual({ removed: 2 });
  });

  it("applies event status/path filters and rejects invalid body selectors", async () => {
    storeMocks.listTraceEvents.mockResolvedValue([
      createStoredEvent({ status: 201, normalizedUrl: "/orders/alpha" }),
      createStoredEvent({ requestId: "r22222222", status: 500, normalizedUrl: "/health" }),
    ]);

    const output = await runSessionCommand(["session", "events", "s12345678", "--status", "201", "--path", "alpha"]);
    const parsed = JSON.parse(output) as { readonly events: readonly Record<string, unknown>[] };

    expect(parsed.events).toHaveLength(1);
    await expect(runSessionCommand(["session", "search", "s12345678", "alpha", "--body", "nope"])).rejects.toThrow("Invalid --body");
    await expect(runSessionCommand(["session", "body", "s12345678", "r12345678", "--body", "both"])).rejects.toThrow("Invalid --body");
  });
});

async function runSessionCommand(args: readonly string[]): Promise<string> {
  const { registerSessionCommands } = await import("../../src/cli/session-commands.js");
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
  registerSessionCommands(program);
  const chunks: string[] = [];
  const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  try {
    await program.parseAsync(["node", "cf-live-trace", ...args]);
  } finally {
    writeSpy.mockRestore();
  }
  return chunks.join("");
}

function createSessionSummary(): TraceSessionSummary {
  return {
    sessionId: "s12345678",
    createdAt: "2026-06-30T01:00:00.000Z",
    target: {
      region: "ap10",
      org: "sample-org",
      space: "dev",
      app: "orders-api",
      instance: "0",
    },
    eventCount: 1,
    directory: "/tmp/s12345678",
  };
}

function createStoredEvent(overrides: Partial<LiveTraceEvent> & { readonly requestId?: string } = {}): StoredTraceEventFile {
  const requestId = overrides.requestId ?? "r12345678";
  const event: LiveTraceEvent = {
    id: "runtime-1",
    timestamp: "2026-06-30T01:00:00.000Z",
    appId: "orders-api",
    instance: "0",
    method: "POST",
    path: "/orders",
    url: "/orders",
    normalizedUrl: "/orders",
    status: 201,
    durationMs: 42,
    requestBytes: 64,
    responseBytes: 128,
    requestHeaders: { "content-type": "application/json" },
    responseHeaders: { "content-type": "application/json" },
    requestBodyPreview: "{\"filter\":\"alpha\"}",
    responseBodyPreview: "{\"data\":{\"name\":\"alpha-value-1234567890\"}}",
    requestBodyTruncated: false,
    responseBodyTruncated: false,
    droppedBeforeEvent: 0,
    source: "runtime-http",
    traceId: "runtime-1",
    correlationId: null,
    ...overrides,
  };
  return {
    version: 1,
    sessionId: "s12345678",
    requestId,
    createdAt: "2026-06-30T01:00:00.000Z",
    expiresAt: "2026-06-30T03:00:00.000Z",
    target: {
      region: "ap10",
      org: "sample-org",
      space: "dev",
      app: "orders-api",
      instance: "0",
    },
    requestBodyFormat: "json",
    responseBodyFormat: "json",
    event,
    backupPath: `/tmp/${requestId}.json`,
  };
}
