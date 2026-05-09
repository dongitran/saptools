import { EventEmitter } from "node:events";

import type { AppCatalogEntry, LogStreamHandle, LogStreamProcess } from "@saptools/cf-logs";
import { describe, expect, it, vi } from "vitest";

import { CfTailRuntime } from "../../src/runtime.js";
import type { CfTailEvent, CfTailRuntimeDependencies } from "../../src/types.js";

interface FakeStream {
  readonly emitter: EventEmitter;
  readonly stdout: EventEmitter;
  readonly stderr: EventEmitter;
  killed: boolean;
}

interface FakeStreamHandle extends LogStreamHandle {
  readonly fake: FakeStream;
}

function createFakeStreamHandle(): FakeStreamHandle {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const emitter = new EventEmitter();
  const fake: FakeStream = { emitter, stdout, stderr, killed: false };
  const process = {
    stdout,
    stderr,
    on(event: string, listener: (...args: never[]) => void): LogStreamProcess {
      emitter.on(event, listener as (...args: unknown[]) => void);
      return process as unknown as LogStreamProcess;
    },
  } as unknown as LogStreamProcess;
  return {
    fake,
    process,
    stop(): void {
      fake.killed = true;
      emitter.emit("exit", 0, null);
    },
  };
}

const session = {
  apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
  email: "user@example.com",
  password: "secret",
  org: "sample-org",
  space: "sample",
} as const;

function buildRuntimeWith(
  apps: readonly AppCatalogEntry[],
  options: {
    readonly streamHandles?: Map<string, FakeStreamHandle>;
    readonly rediscoverIntervalMs?: number;
  } = {},
): { readonly runtime: CfTailRuntime; readonly events: CfTailEvent[] } {
  const events: CfTailEvent[] = [];
  const streamHandles = options.streamHandles ?? new Map<string, FakeStreamHandle>();
  const dependencies: CfTailRuntimeDependencies = {
    discoverApps: vi.fn(async () => apps),
    prepareSession: async () => undefined,
    fetchRecentLogsFromTarget: async () => "",
    spawnLogStreamFromTarget: ({ appName }) => {
      const handle = createFakeStreamHandle();
      streamHandles.set(appName, handle);
      return handle;
    },
  };
  const runtime = new CfTailRuntime(
    {
      flushIntervalMs: 5,
      ...(options.rediscoverIntervalMs === undefined
        ? { rediscoverIntervalMs: 0 }
        : { rediscoverIntervalMs: options.rediscoverIntervalMs }),
    },
    dependencies,
  );
  runtime.subscribe((event) => {
    events.push(event);
  });
  runtime.setSession({ ...session });
  return { runtime, events };
}

async function flushTimers(ms = 20): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe("CfTailRuntime", () => {
  it("emits a discovery event with the matching apps and initial=true", async () => {
    const { runtime, events } = buildRuntimeWith([
      { name: "alpha", runningInstances: 1 },
      { name: "beta", runningInstances: 1 },
    ]);
    await runtime.start();
    await runtime.stop();
    const discovery = events.find((event) => event.type === "discovery");
    expect(discovery).toBeDefined();
    if (discovery?.type === "discovery") {
      expect(discovery.apps.map((app) => app.name)).toEqual(["alpha", "beta"]);
      expect(discovery.addedApps).toEqual(["alpha", "beta"]);
      expect(discovery.initial).toBe(true);
      expect(discovery.changed).toBe(true);
    }
  });

  it("marks subsequent rediscoveries as initial=false changed=false when the catalog is unchanged", async () => {
    const apps = [{ name: "alpha", runningInstances: 1 }];
    const events: CfTailEvent[] = [];
    const dependencies: CfTailRuntimeDependencies = {
      discoverApps: vi.fn(async () => apps),
      prepareSession: async () => undefined,
      fetchRecentLogsFromTarget: async () => "",
      spawnLogStreamFromTarget: () => createFakeStreamHandle(),
    };
    const runtime = new CfTailRuntime(
      { rediscoverIntervalMs: 5, flushIntervalMs: 5 },
      dependencies,
    );
    runtime.subscribe((event) => {
      events.push(event);
    });
    runtime.setSession({ ...session });
    await runtime.start();
    await flushTimers(40);
    await runtime.stop();
    const discoveries = events.filter(
      (event): event is Extract<typeof event, { readonly type: "discovery" }> =>
        event.type === "discovery",
    );
    expect(discoveries.length).toBeGreaterThanOrEqual(2);
    expect(discoveries[0]?.initial).toBe(true);
    const subsequent = discoveries.slice(1);
    expect(subsequent.every((event) => !event.initial)).toBe(true);
    expect(subsequent.every((event) => !event.changed)).toBe(true);
  });

  it("forwards stream lines from CfLogsRuntime as lines events with tagged rows", async () => {
    const handles = new Map<string, FakeStreamHandle>();
    const { runtime, events } = buildRuntimeWith(
      [{ name: "alpha", runningInstances: 1 }],
      { streamHandles: handles },
    );
    await runtime.start();
    const handle = handles.get("alpha");
    expect(handle).toBeDefined();
    handle?.fake.stdout.emit(
      "data",
      "2026-04-12T09:14:40.00+0700 [APP/PROC/WEB/0] OUT hello\n",
    );
    await flushTimers();
    await runtime.stop();
    const lineEvents = events.filter((event) => event.type === "lines");
    expect(lineEvents.length).toBeGreaterThan(0);
    if (lineEvents[0]?.type === "lines") {
      expect(lineEvents[0].appName).toBe("alpha");
      expect(lineEvents[0].lines.length).toBeGreaterThan(0);
      expect(lineEvents[0].rows.length).toBeGreaterThan(0);
      expect(lineEvents[0].rows[0]?.appName).toBe("alpha");
    }
  });

  it("does not double-emit rows when continuations are appended (regression)", async () => {
    const handles = new Map<string, FakeStreamHandle>();
    const { runtime, events } = buildRuntimeWith(
      [{ name: "alpha", runningInstances: 1 }],
      { streamHandles: handles },
    );
    await runtime.start();
    const handle = handles.get("alpha");
    expect(handle).toBeDefined();
    // First emit: a single CF row.
    handle?.fake.stdout.emit(
      "data",
      "2026-04-12T09:14:40.00+0700 [APP/PROC/WEB/0] OUT first row\n",
    );
    await flushTimers(20);
    // Second emit: a continuation line that the parser merges into the previous row,
    // PLUS a brand-new row. cf-logs reports lines.length=2 but only 1 new row exists.
    handle?.fake.stdout.emit(
      "data",
      "continuation line\n2026-04-12T09:14:41.00+0700 [APP/PROC/WEB/0] OUT second row\n",
    );
    await flushTimers(20);
    await runtime.stop();
    const lineEvents = events.filter(
      (event): event is Extract<typeof event, { readonly type: "lines" }> =>
        event.type === "lines",
    );
    const allEmittedIds = lineEvents.flatMap((event) => event.rows.map((row) => row.id));
    const uniqueIds = new Set(allEmittedIds);
    expect(uniqueIds.size).toBe(allEmittedIds.length);
  });

  it("emits a discovery-error when discovery fails", async () => {
    const events: CfTailEvent[] = [];
    const dependencies: CfTailRuntimeDependencies = {
      discoverApps: vi.fn(async () => {
        throw new Error("network down");
      }),
      prepareSession: async () => undefined,
      fetchRecentLogsFromTarget: async () => "",
      spawnLogStreamFromTarget: () => createFakeStreamHandle(),
    };
    const runtime = new CfTailRuntime({ rediscoverIntervalMs: 0 }, dependencies);
    runtime.subscribe((event) => {
      events.push(event);
    });
    runtime.setSession({ ...session });
    await expect(runtime.start()).rejects.toThrow("network down");
    expect(events.find((event) => event.type === "discovery-error")).toBeDefined();
  });

  it("requires a session before starting", async () => {
    const runtime = new CfTailRuntime({ rediscoverIntervalMs: 0 }, {
      discoverApps: async () => [],
    });
    await expect(runtime.start()).rejects.toThrow("No CF session configured.");
  });

  it("clearing the session resets the available apps", async () => {
    const { runtime, events } = buildRuntimeWith([
      { name: "alpha", runningInstances: 1 },
    ]);
    await runtime.start();
    runtime.setSession(null);
    expect(runtime.listAppStates()).toEqual([]);
    await runtime.stop();
    expect(events.some((event) => event.type === "discovery")).toBe(true);
  });

  it("forwards stream-state events from CfLogsRuntime", async () => {
    const handles = new Map<string, FakeStreamHandle>();
    const { runtime, events } = buildRuntimeWith(
      [{ name: "alpha", runningInstances: 1 }],
      { streamHandles: handles },
    );
    await runtime.start();
    await flushTimers(10);
    await runtime.stop();
    expect(events.some((event) => event.type === "stream-state")).toBe(true);
  });

  it("ignores duplicate start and stop calls", async () => {
    const { runtime } = buildRuntimeWith([{ name: "alpha", runningInstances: 1 }]);
    await runtime.start();
    await runtime.start();
    await runtime.stop();
    await runtime.stop();
  });

  it("reschedules discovery on the configured interval", async () => {
    const apps = [{ name: "alpha", runningInstances: 1 }];
    const discoverApps = vi.fn(async () => apps);
    const dependencies: CfTailRuntimeDependencies = {
      discoverApps,
      prepareSession: async () => undefined,
      fetchRecentLogsFromTarget: async () => "",
      spawnLogStreamFromTarget: () => createFakeStreamHandle(),
    };
    const runtime = new CfTailRuntime(
      { rediscoverIntervalMs: 5, flushIntervalMs: 5 },
      dependencies,
    );
    runtime.setSession({ ...session });
    await runtime.start();
    await flushTimers(40);
    await runtime.stop();
    expect(discoverApps.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
