import type { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as clientBootstrap from "../../src/cli/client-bootstrap.js";
import { buildProgram } from "../../src/cli/program.js";
import type { OpenSearchClient } from "../../src/opensearch-client.js";
import * as watch from "../../src/watch.js";

vi.mock("../../src/cli/client-bootstrap.js", () => ({ withOpenSearchClient: vi.fn() }));
vi.mock("../../src/watch.js", () => ({ watchMetrics: vi.fn() }));

function applyExitOverride(command: Command): void {
  command.exitOverride();
  for (const nested of command.commands) {
    applyExitOverride(nested);
  }
}

function buildTestProgram(): Command {
  const program = buildProgram();
  applyExitOverride(program);
  return program;
}

function captureOutput(): { text: () => string } {
  let buffer = "";
  const append = (chunk: unknown): boolean => {
    buffer += String(chunk);
    return true;
  };
  vi.spyOn(process.stdout, "write").mockImplementation(append);
  vi.spyOn(process.stderr, "write").mockImplementation(append);
  return { text: () => buffer };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("watch command wiring", () => {
  it("resolves the client, then hands watchMetrics the requested service/name/interval and formats a text point", async () => {
    const fakeOpenSearchClient = {} as OpenSearchClient;
    vi.mocked(clientBootstrap.withOpenSearchClient).mockImplementation(async (_opts, work) => await work(fakeOpenSearchClient));
    const watchSpy = vi.mocked(watch.watchMetrics).mockImplementation(async (_client, _opts, onPoint) => {
      onPoint({ time: "2026-08-31T12:00:00.000Z", name: "container.cpu.usage", value: 0.02, unit: "1" });
    });

    const output = captureOutput();
    await buildTestProgram().parseAsync([
      "node",
      "cf-metrics",
      "watch",
      "--service",
      "app",
      "--name",
      "container.cpu.usage",
      "--interval",
      "5000",
    ]);

    expect(watchSpy).toHaveBeenCalledWith(
      fakeOpenSearchClient,
      expect.objectContaining({ service: "app", name: "container.cpu.usage", intervalMs: 5000 }),
      expect.any(Function),
      expect.anything(),
      expect.any(Function),
    );
    expect(output.text()).toContain("2026-08-31T12:00:00.000Z  container.cpu.usage  0.02 1");
  });

  it("routes watchMetrics' onNotice callback through printNotice, to stderr", async () => {
    const fakeOpenSearchClient = {} as OpenSearchClient;
    vi.mocked(clientBootstrap.withOpenSearchClient).mockImplementation(async (_opts, work) => await work(fakeOpenSearchClient));
    vi.mocked(watch.watchMetrics).mockImplementation(async (_client, _opts, _onPoint, _signal, onNotice) => {
      onNotice?.("100+ new points this cycle, showing the oldest 100 — catching up next poll");
    });

    const output = captureOutput();
    await buildTestProgram().parseAsync(["node", "cf-metrics", "watch", "--service", "app"]);

    expect(output.text()).toContain("cf-metrics: 100+ new points this cycle, showing the oldest 100 — catching up next poll");
  });

  it("emits NDJSON when --json is passed", async () => {
    const fakeOpenSearchClient = {} as OpenSearchClient;
    vi.mocked(clientBootstrap.withOpenSearchClient).mockImplementation(async (_opts, work) => await work(fakeOpenSearchClient));
    vi.mocked(watch.watchMetrics).mockImplementation(async (_client, _opts, onPoint) => {
      onPoint({ time: "t1", name: "container.cpu.usage", value: 0.02 });
    });

    const output = captureOutput();
    await buildTestProgram().parseAsync(["node", "cf-metrics", "watch", "--service", "app", "--json"]);

    const jsonLine = output.text().split("\n").find((line) => line.startsWith("{"));
    expect(JSON.parse(jsonLine ?? "")).toEqual({ time: "t1", name: "container.cpu.usage", value: 0.02 });
  });

  it("rejects an --interval below the minimum before calling watchMetrics at all", async () => {
    const watchSpy = vi.mocked(watch.watchMetrics);
    await expect(
      buildTestProgram().parseAsync(["node", "cf-metrics", "watch", "--service", "app", "--interval", "500"]),
    ).rejects.toThrow(/at least/);
    expect(watchSpy).not.toHaveBeenCalled();
  });

  it("defaults --lookback to 2m when not passed", async () => {
    const fakeOpenSearchClient = {} as OpenSearchClient;
    vi.mocked(clientBootstrap.withOpenSearchClient).mockImplementation(async (_opts, work) => await work(fakeOpenSearchClient));
    const watchSpy = vi.mocked(watch.watchMetrics).mockImplementation(async () => undefined);

    await buildTestProgram().parseAsync(["node", "cf-metrics", "watch", "--service", "app"]);

    expect(watchSpy).toHaveBeenCalledWith(
      fakeOpenSearchClient,
      expect.objectContaining({ lookback: "2m" }),
      expect.any(Function),
      expect.anything(),
      expect.any(Function),
    );
  });

  it("forwards a custom --lookback to watchMetrics instead of the hardcoded default", async () => {
    const fakeOpenSearchClient = {} as OpenSearchClient;
    vi.mocked(clientBootstrap.withOpenSearchClient).mockImplementation(async (_opts, work) => await work(fakeOpenSearchClient));
    const watchSpy = vi.mocked(watch.watchMetrics).mockImplementation(async () => undefined);

    await buildTestProgram().parseAsync(["node", "cf-metrics", "watch", "--service", "app", "--lookback", "10m"]);

    expect(watchSpy).toHaveBeenCalledWith(
      fakeOpenSearchClient,
      expect.objectContaining({ lookback: "10m" }),
      expect.any(Function),
      expect.anything(),
      expect.any(Function),
    );
  });

  it("rejects an unparseable --lookback before calling watchMetrics at all", async () => {
    const watchSpy = vi.mocked(watch.watchMetrics);
    await expect(
      buildTestProgram().parseAsync(["node", "cf-metrics", "watch", "--service", "app", "--lookback", "not-a-duration"]),
    ).rejects.toThrow(/Invalid --lookback value/);
    expect(watchSpy).not.toHaveBeenCalled();
  });

  it("requires --service", async () => {
    await expect(buildTestProgram().parseAsync(["node", "cf-metrics", "watch"])).rejects.toThrow();
  });
});

/**
 * `watchMetrics` re-seeds its cursor from `--lookback` every time it is
 * entered, and `withOpenSearchClient` re-enters it when a cached credential is
 * rejected mid-session — so a 401 an hour into a watch replayed the whole
 * lookback window as duplicate output, and announced the session twice.
 */
describe("watch across a credential retry", () => {
  it("does not replay points it already printed, and announces the session once", async () => {
    const fakeOpenSearchClient = {} as OpenSearchClient;
    vi.mocked(clientBootstrap.withOpenSearchClient).mockImplementation(async (_opts, work) => {
      await work(fakeOpenSearchClient);
      return await work(fakeOpenSearchClient);
    });
    vi.mocked(watch.watchMetrics).mockImplementation(async (_client, _opts, onPoint) => {
      onPoint({ time: "2026-08-31T12:00:00.000Z", name: "m", value: 1, unit: "1" });
      onPoint({ time: "2026-08-31T12:00:05.000Z", name: "m", value: 2, unit: "1" });
    });
    const output = captureOutput();

    await buildTestProgram().parseAsync(["node", "cf-metrics", "watch", "--service", "app", "--json"]);

    const printed = output.text().split("\n").filter((line) => line.startsWith("{"));
    expect(printed).toHaveLength(2);
    expect(output.text().split("\n").filter((line) => line.includes("press Ctrl+C to stop"))).toHaveLength(1);
  });

  it("still prints a point newer than anything seen before the retry", async () => {
    const fakeOpenSearchClient = {} as OpenSearchClient;
    let attempt = 0;
    vi.mocked(clientBootstrap.withOpenSearchClient).mockImplementation(async (_opts, work) => {
      await work(fakeOpenSearchClient);
      return await work(fakeOpenSearchClient);
    });
    vi.mocked(watch.watchMetrics).mockImplementation(async (_client, _opts, onPoint) => {
      attempt += 1;
      onPoint({ time: "2026-08-31T12:00:00.000Z", name: "m", value: 1, unit: "1" });
      if (attempt === 2) {
        onPoint({ time: "2026-08-31T12:00:09.000Z", name: "m", value: 3, unit: "1" });
      }
    });
    const output = captureOutput();

    await buildTestProgram().parseAsync(["node", "cf-metrics", "watch", "--service", "app", "--json"]);

    const printed = output.text().split("\n").filter((line) => line.startsWith("{"));
    // The replayed point is dropped; the genuinely new one still gets through.
    expect(printed).toHaveLength(2);
    expect(printed[1]).toContain("12:00:09");
  });
});

