import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

function fakeLogHit(id: string, sourceType: string, extra: Record<string, unknown> = {}) {
  return { _id: id, _source: { "@timestamp": "2026-09-12T06:00:00.000Z", source_type: sourceType, app_name: "acme-svc-config", vcap_request_id: "11111111-1111-4111-8111-111111111111", ...extra } };
}

describe("trace command", () => {
  it("returns just the matched log rows when --with-span is not passed", async () => {
    vi.resetModules();
    vi.doMock("../../src/cli/client-bootstrap.js", () => ({
      withOpenSearchClient: vi.fn(async (_opts: unknown, work: (client: unknown) => Promise<void>) => {
        await work({
          search: vi.fn(async (index: string) => {
            expect(index).toBe("logs-cfsyslog-*");
            return { totalHits: 1, hits: [fakeLogHit("rtr-1", "RTR", { trace_id: "deaddeaddeaddeaddeaddeaddeaddead", method: "GET", request: "/x", response_status: 200 })] };
          }),
        });
      }),
    }));
    const { registerTraceCommand } = await import("../../src/cli/commands/trace.js");
    const program = new Command();
    registerTraceCommand(program);
    const logSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await program.parseAsync(["node", "cf-log-search", "trace", "11111111-1111-4111-8111-111111111111", "--format", "json"]);

    const printed = JSON.parse(logSpy.mock.calls.map((call) => String(call[0])).join(""));
    expect(printed).toEqual([expect.objectContaining({ KIND: "log", SOURCE_TYPE: "RTR" })]);
    logSpy.mockRestore();
  });

  it("--with-span joins on the matched RTR row's own traceId, never on vcap_request_id, against otel-v1-apm-span-*", async () => {
    vi.resetModules();
    const searchCalls: { index: string; body: Record<string, unknown> }[] = [];
    vi.doMock("../../src/cli/client-bootstrap.js", () => ({
      withOpenSearchClient: vi.fn(async (_opts: unknown, work: (client: unknown) => Promise<void>) => {
        await work({
          search: vi.fn(async (index: string, body: Record<string, unknown>) => {
            searchCalls.push({ index, body });
            if (index === "logs-cfsyslog-*") {
              return { totalHits: 1, hits: [fakeLogHit("rtr-1", "RTR", { trace_id: "deaddeaddeaddeaddeaddeaddeaddead", method: "GET", request: "/x", response_status: 200 })] };
            }
            return { totalHits: 1, hits: [{ _id: "span-1", _source: { traceId: "deaddeaddeaddeaddeaddeaddeaddead", spanId: "beefbeefbeefbeef", name: "GET /x", kind: "SPAN_KIND_SERVER", startTime: "2026-09-12T06:00:00.100Z", serviceName: "acme-svc-config" } }] };
          }),
        });
      }),
    }));
    const { registerTraceCommand } = await import("../../src/cli/commands/trace.js");
    const program = new Command();
    registerTraceCommand(program);
    const logSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await program.parseAsync(["node", "cf-log-search", "trace", "11111111-1111-4111-8111-111111111111", "--with-span", "--format", "json"]);

    const spanCall = searchCalls.find((call) => call.index === "otel-v1-apm-span-*");
    expect(spanCall?.body["query"]).toEqual({ term: { traceId: "deaddeaddeaddeaddeaddeaddeaddead" } });
    expect(JSON.stringify(spanCall?.body)).not.toContain("vcap_request_id");
    const printed = JSON.parse(logSpy.mock.calls.map((call) => String(call[0])).join(""));
    expect(printed).toEqual(expect.arrayContaining([expect.objectContaining({ KIND: "span", SPAN_ID: "beefbeefbeefbeef" })]));
    logSpy.mockRestore();
  });

  it("--with-span prints a lag/no-match notice, not an error, when zero spans are found", async () => {
    vi.resetModules();
    vi.doMock("../../src/cli/client-bootstrap.js", () => ({
      withOpenSearchClient: vi.fn(async (_opts: unknown, work: (client: unknown) => Promise<void>) => {
        await work({
          search: vi.fn(async (index: string) => {
            if (index === "logs-cfsyslog-*") {
              return { totalHits: 1, hits: [fakeLogHit("rtr-1", "RTR", { trace_id: "deaddeaddeaddeaddeaddeaddeaddead" })] };
            }
            return { totalHits: 0, hits: [] };
          }),
        });
      }),
    }));
    const { registerTraceCommand } = await import("../../src/cli/commands/trace.js");
    const program = new Command();
    registerTraceCommand(program);
    const logSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await program.parseAsync(["node", "cf-log-search", "trace", "11111111-1111-4111-8111-111111111111", "--with-span"]);

    expect(errSpy.mock.calls.map((call) => String(call[0])).join("")).toMatch(/lag log ingestion/);
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("prints a not-found notice, at exit 0, when no log document matches the id at all", async () => {
    vi.resetModules();
    vi.doMock("../../src/cli/client-bootstrap.js", () => ({
      withOpenSearchClient: vi.fn(async (_opts: unknown, work: (client: unknown) => Promise<void>) => {
        await work({ search: vi.fn(async () => ({ totalHits: 0, hits: [] })) });
      }),
    }));
    const { registerTraceCommand } = await import("../../src/cli/commands/trace.js");
    const program = new Command();
    registerTraceCommand(program);
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await program.parseAsync(["node", "cf-log-search", "trace", "00000000-0000-0000-0000-000000000000"]);

    expect(errSpy.mock.calls.map((call) => String(call[0])).join("")).toMatch(/no logs-cfsyslog-\* document/);
    errSpy.mockRestore();
  });
});
