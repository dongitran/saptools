import { describe, expect, it, vi } from "vitest";

import { CfEventsRuntime, createDefaultDependencies } from "../../src/runtime.js";
import type { CfAppSession, CfClient, CfEventsDependencies } from "../../src/runtime.js";
import type { CfCredentials, ResolvedSelector } from "../../src/types.js";

import { makeEvent } from "./factories.js";

const NOW = new Date("2026-05-22T12:00:00.000Z");

const CREDENTIALS: CfCredentials = { email: "user@example.com", password: "secret" };

const SELECTOR: ResolvedSelector = {
  raw: "ap10/demo-org/dev/orders-srv",
  regionKey: "ap10",
  apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
  orgName: "demo-org",
  spaceName: "dev",
  appName: "orders-srv",
};

function makeClient(overrides: Partial<CfClient> = {}): CfClient {
  return {
    fetchAuditEvents: vi.fn().mockResolvedValue([]),
    fetchApp: vi.fn().mockResolvedValue({ guid: "app-1", name: "orders-srv", state: "STARTED" }),
    fetchSshEnabled: vi.fn().mockResolvedValue({ enabled: true, reason: "" }),
    fetchWebProcessStats: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function makeDeps(client: CfClient): CfEventsDependencies {
  return {
    resolveSelector: () => Promise.resolve(SELECTOR),
    withCfApp: async <T>(
      _selector: ResolvedSelector,
      _credentials: CfCredentials,
      work: (session: CfAppSession) => Promise<T>,
    ): Promise<T> => await work({ appGuid: "app-1", client }),
    now: () => NOW,
  };
}

describe("CfEventsRuntime.fetchEvents", () => {
  it("queries audit events with resolved options", async () => {
    const events = [makeEvent({ guid: "e1" })];
    const fetchAuditEvents = vi.fn().mockResolvedValue(events);
    const runtime = new CfEventsRuntime(makeDeps(makeClient({ fetchAuditEvents })));
    const result = await runtime.fetchEvents("orders-srv", CREDENTIALS, {
      limit: 20,
      since: "1h",
      types: ["audit.app.start"],
    });
    expect(result).toBe(events);
    expect(fetchAuditEvents).toHaveBeenCalledWith({
      appGuid: "app-1",
      types: ["audit.app.start"],
      createdAfter: "2026-05-22T11:00:00.000Z",
      limit: 20,
    });
  });

  it("omits the type and created filters when not provided", async () => {
    const fetchAuditEvents = vi.fn().mockResolvedValue([]);
    const runtime = new CfEventsRuntime(makeDeps(makeClient({ fetchAuditEvents })));
    await runtime.fetchEvents("orders-srv", CREDENTIALS, { limit: 10, since: undefined, types: [] });
    expect(fetchAuditEvents).toHaveBeenCalledWith({
      appGuid: "app-1",
      types: undefined,
      createdAfter: undefined,
      limit: 10,
    });
  });
});

describe("CfEventsRuntime.getSshStatus", () => {
  it("builds SSH status from the ssh-enabled flag and ssh events", async () => {
    const client = makeClient({
      fetchSshEnabled: vi.fn().mockResolvedValue({ enabled: true, reason: "" }),
      fetchAuditEvents: vi.fn().mockResolvedValue([
        makeEvent({
          guid: "s1",
          type: "audit.app.ssh-authorized",
          createdAt: "2026-05-22T11:55:00.000Z",
        }),
      ]),
    });
    const runtime = new CfEventsRuntime(makeDeps(client));
    const status = await runtime.getSshStatus("orders-srv", CREDENTIALS, "24h");
    expect(status.sshEnabled).toBe(true);
    expect(status.sessions).toHaveLength(1);
    expect(status.activeSessionCount).toBe(1);
  });
});

describe("CfEventsRuntime.getCrashes", () => {
  it("summarizes crash events", async () => {
    const client = makeClient({
      fetchAuditEvents: vi.fn().mockResolvedValue([
        makeEvent({ guid: "c1", type: "audit.app.crash", createdAt: "2026-05-22T09:00:00.000Z" }),
      ]),
    });
    const runtime = new CfEventsRuntime(makeDeps(client));
    const summary = await runtime.getCrashes("orders-srv", CREDENTIALS, {
      limit: 50,
      since: "7d",
    });
    expect(summary.crashCount).toBe(1);
    expect(summary.appName).toBe("orders-srv");
  });
});

describe("CfEventsRuntime.getStatus", () => {
  it("assembles app health from the parallel API calls", async () => {
    const client = makeClient({
      fetchApp: vi.fn().mockResolvedValue({ guid: "app-1", name: "orders-srv", state: "STARTED" }),
      fetchWebProcessStats: vi.fn().mockResolvedValue([
        {
          type: "web",
          index: 0,
          state: "RUNNING",
          uptimeSeconds: 100,
          cpu: 0.1,
          memBytes: 1,
          memQuotaBytes: 2,
          diskBytes: 1,
          diskQuotaBytes: 2,
        },
      ]),
      fetchSshEnabled: vi.fn().mockResolvedValue({ enabled: false, reason: "off" }),
      fetchAuditEvents: vi.fn().mockResolvedValue([makeEvent({ guid: "last" })]),
    });
    const runtime = new CfEventsRuntime(makeDeps(client));
    const health = await runtime.getStatus("orders-srv", CREDENTIALS);
    expect(health.appName).toBe("orders-srv");
    expect(health.requestedState).toBe("STARTED");
    expect(health.sshEnabled).toBe(false);
    expect(health.instances).toHaveLength(1);
    expect(health.lastEvent?.guid).toBe("last");
  });
});

describe("CfEventsRuntime.watchEvents", () => {
  it("emits new events oldest-first and stops when aborted", async () => {
    const controller = new AbortController();
    let calls = 0;
    const client = makeClient({
      fetchAuditEvents: vi.fn().mockImplementation(() => {
        calls += 1;
        if (calls === 1) {
          return Promise.resolve([
            makeEvent({ guid: "e2", createdAt: "2026-05-22T10:02:00.000Z" }),
            makeEvent({ guid: "e1", createdAt: "2026-05-22T10:01:00.000Z" }),
          ]);
        }
        controller.abort();
        return Promise.resolve([]);
      }),
    });
    const runtime = new CfEventsRuntime(makeDeps(client));
    const emitted: string[] = [];
    await runtime.watchEvents(
      "orders-srv",
      CREDENTIALS,
      { intervalMs: 5, lookback: "5m", types: [] },
      (event) => {
        emitted.push(event.guid);
      },
      controller.signal,
    );
    expect(emitted).toEqual(["e1", "e2"]);
  });

  it("de-duplicates events seen across polling ticks", async () => {
    const controller = new AbortController();
    let calls = 0;
    const client = makeClient({
      fetchAuditEvents: vi.fn().mockImplementation(() => {
        calls += 1;
        if (calls === 1) {
          return Promise.resolve([
            makeEvent({ guid: "e1", createdAt: "2026-05-22T10:01:00.000Z" }),
          ]);
        }
        if (calls === 2) {
          return Promise.resolve([
            makeEvent({ guid: "e2", createdAt: "2026-05-22T10:02:00.000Z" }),
            makeEvent({ guid: "e1", createdAt: "2026-05-22T10:01:00.000Z" }),
          ]);
        }
        controller.abort();
        return Promise.resolve([]);
      }),
    });
    const runtime = new CfEventsRuntime(makeDeps(client));
    const emitted: string[] = [];
    await runtime.watchEvents(
      "orders-srv",
      CREDENTIALS,
      { intervalMs: 5, lookback: "5m", types: ["audit.app.start"] },
      (event) => {
        emitted.push(event.guid);
      },
      controller.signal,
    );
    expect(emitted).toEqual(["e1", "e2"]);
  });

  it("does not poll at all when the signal is already aborted", async () => {
    const fetchAuditEvents = vi.fn().mockResolvedValue([]);
    const runtime = new CfEventsRuntime(makeDeps(makeClient({ fetchAuditEvents })));
    const controller = new AbortController();
    controller.abort();
    await runtime.watchEvents(
      "orders-srv",
      CREDENTIALS,
      { intervalMs: 5, lookback: "5m", types: [] },
      () => {
        throw new Error("should not emit");
      },
      controller.signal,
    );
    expect(fetchAuditEvents).not.toHaveBeenCalled();
  });
});

describe("createDefaultDependencies", () => {
  it("exposes the default wiring", () => {
    const deps = createDefaultDependencies();
    expect(typeof deps.resolveSelector).toBe("function");
    expect(typeof deps.withCfApp).toBe("function");
    expect(deps.now()).toBeInstanceOf(Date);
  });
});
