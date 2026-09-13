import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { registerErrorsCommand } from "../../src/cli/commands/errors.js";

let mockSearchResult: unknown = {
  totalHits: 0,
  hits: [],
  aggregations: {
    by_app: {
      buckets: [
        { key: "acme-svc-config", doc_count: 12, by_status: { buckets: [{ key: 500, doc_count: 9 }, { key: 404, doc_count: 3 }] } },
      ],
    },
  },
};

vi.mock("../../src/cli/client-bootstrap.js", () => ({
  withOpenSearchClient: vi.fn(async (_opts: unknown, work: (client: unknown) => Promise<void>) => {
    await work({
      search: vi.fn(async () => mockSearchResult),
    });
  }),
}));

describe("errors command", () => {
  beforeEach(() => {
    mockSearchResult = {
      totalHits: 0,
      hits: [],
      aggregations: {
        by_app: {
          buckets: [
            { key: "acme-svc-config", doc_count: 12, by_status: { buckets: [{ key: 500, doc_count: 9 }, { key: 404, doc_count: 3 }] } },
          ],
        },
      },
    };
  });

  it("prints a flattened app x status_code x doc_count breakdown", async () => {
    const program = new Command();
    registerErrorsCommand(program);
    const logSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await program.parseAsync(["node", "cf-log-search", "errors", "--format", "json"]);

    const printed = JSON.parse(logSpy.mock.calls.map((call) => String(call[0])).join(""));
    expect(printed).toEqual(
      expect.arrayContaining([
        { APP: "acme-svc-config", STATUS: "500", DOC_COUNT: 9 },
        { APP: "acme-svc-config", STATUS: "404", DOC_COUNT: 3 },
      ]),
    );
    logSpy.mockRestore();
  });

  it("handles empty aggregations", async () => {
    mockSearchResult = { totalHits: 0, hits: [], aggregations: {} };

    const program = new Command();
    registerErrorsCommand(program);
    const logSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await program.parseAsync(["node", "cf-log-search", "errors", "--format", "json"]);

    const printed = JSON.parse(logSpy.mock.calls.map((call) => String(call[0])).join(""));
    expect(printed).toEqual([]);
    logSpy.mockRestore();
  });

  it("handles null aggregations", async () => {
    mockSearchResult = { totalHits: 0, hits: [], aggregations: null };

    const program = new Command();
    registerErrorsCommand(program);
    const logSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await program.parseAsync(["node", "cf-log-search", "errors", "--format", "json"]);

    const printed = JSON.parse(logSpy.mock.calls.map((call) => String(call[0])).join(""));
    expect(printed).toEqual([]);
    logSpy.mockRestore();
  });

  it("handles malformed by_app buckets", async () => {
    mockSearchResult = {
      totalHits: 0,
      hits: [],
      aggregations: {
        by_app: { buckets: "not an array" },
      },
    };

    const program = new Command();
    registerErrorsCommand(program);
    const logSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await program.parseAsync(["node", "cf-log-search", "errors", "--format", "json"]);

    const printed = JSON.parse(logSpy.mock.calls.map((call) => String(call[0])).join(""));
    expect(printed).toEqual([]);
    logSpy.mockRestore();
  });

  it("filters out buckets with missing or invalid fields", async () => {
    mockSearchResult = {
      totalHits: 0,
      hits: [],
      aggregations: {
        by_app: {
          buckets: [
            { key: "app1", doc_count: 10, by_status: { buckets: [{ key: 500, doc_count: 5 }] } },
            { doc_count: 10, by_status: { buckets: [] } },
            { key: 123, doc_count: 10, by_status: { buckets: [] } },
            { key: "app2", by_status: "not an object" },
          ],
        },
      },
    };

    const program = new Command();
    registerErrorsCommand(program);
    const logSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await program.parseAsync(["node", "cf-log-search", "errors", "--format", "json"]);

    const printed = JSON.parse(logSpy.mock.calls.map((call) => String(call[0])).join(""));
    expect(printed).toEqual([{ APP: "app1", STATUS: "500", DOC_COUNT: 5 }]);
    logSpy.mockRestore();
  });

  it("respects --limit option", async () => {
    const program = new Command();
    registerErrorsCommand(program);
    const logSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await program.parseAsync(["node", "cf-log-search", "errors", "--limit", "5", "--format", "json"]);

    const printed = JSON.parse(logSpy.mock.calls.map((call) => String(call[0])).join(""));
    expect(printed.length).toBeGreaterThan(0);
    logSpy.mockRestore();
  });

  it("respects --app option", async () => {
    const program = new Command();
    registerErrorsCommand(program);
    const logSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await program.parseAsync(["node", "cf-log-search", "errors", "--app", "myapp", "--format", "json"]);

    const printed = JSON.parse(logSpy.mock.calls.map((call) => String(call[0])).join(""));
    expect(Array.isArray(printed)).toBe(true);
    logSpy.mockRestore();
  });
});
