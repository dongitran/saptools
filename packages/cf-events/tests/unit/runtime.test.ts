import { describe, expect, it, vi } from "vitest";

import { CfEventsRuntime, createDefaultDependencies } from "../../src/runtime.js";
import type { CfClient, CfEventsDependencies, CfTargetSession } from "../../src/runtime.js";
import type { CfCredentials, ResolvedSelector } from "../../src/types.js";

import { makeEvent } from "./factories.js";

const NOW = new Date("2026-05-22T12:00:00.000Z");
const CREDENTIALS: CfCredentials = { email: "user@example.com", password: "secret" };
const APP_SELECTOR: ResolvedSelector = {
  kind: "app",
  raw: "ap10/demo-org/dev/orders-srv",
  regionKey: "ap10",
  apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
  orgName: "demo-org",
  spaceName: "dev",
  appName: "orders-srv",
};
const SPACE_SELECTOR: ResolvedSelector = {
  kind: "space",
  raw: "ap10/demo-org/dev",
  regionKey: "ap10",
  apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
  orgName: "demo-org",
  spaceName: "dev",
};

function makeClient(overrides: Partial<CfClient> = {}): CfClient {
  return {
    fetchAuditEvents: vi.fn().mockResolvedValue([]),
    fetchApp: vi.fn().mockResolvedValue({ guid: "app-1", name: "orders-srv", state: "STARTED" }),
    fetchSshEnabled: vi.fn().mockResolvedValue({ enabled: true, reason: "" }),
    fetchWebProcessStats: vi.fn().mockResolvedValue([]),
    resolveOrganizationGuid: vi.fn().mockResolvedValue("org-1"),
    resolveSpaceGuid: vi.fn().mockResolvedValue("space-1"),
    ...overrides,
  };
}

function makeDeps(client: CfClient, selector: ResolvedSelector = APP_SELECTOR, resolveAppGuid = vi.fn().mockResolvedValue("app-1")): CfEventsDependencies {
  return {
    resolveSelector: () => Promise.resolve(selector),
    withCfTarget: async <T>(
      target: ResolvedSelector,
      _credentials: CfCredentials,
      work: (session: CfTargetSession) => Promise<T>,
    ): Promise<T> => await work({ selector: target, client, resolveAppGuid }),
    now: () => NOW,
  };
}

describe("CfEventsRuntime.fetchEvents", () => {
  it("queries app audit events with one resolved app GUID", async () => {
    const events = [makeEvent({ guid: "e1" })];
    const fetchAuditEvents = vi.fn().mockResolvedValue(events);
    const resolveAppGuid = vi.fn().mockResolvedValue("app-1");
    const runtime = new CfEventsRuntime(makeDeps(makeClient({ fetchAuditEvents }), APP_SELECTOR, resolveAppGuid));
    const result = await runtime.fetchEvents("orders-srv", CREDENTIALS, {
      limit: 20,
      since: "1h",
      types: ["audit.app.start"],
    });
    expect(result).toBe(events);
    expect(resolveAppGuid).toHaveBeenCalledTimes(1);
    expect(fetchAuditEvents).toHaveBeenCalledWith({
      scope: { kind: "app", appGuid: "app-1" },
      types: ["audit.app.start"],
      createdAfter: "2026-05-22T11:00:00Z",
      limit: 20,
    });
  });

  it("queries space audit events without resolving an app GUID", async () => {
    const fetchAuditEvents = vi.fn().mockResolvedValue([]);
    const resolveAppGuid = vi.fn().mockResolvedValue("app-1");
    const client = makeClient({ fetchAuditEvents });
    const runtime = new CfEventsRuntime(makeDeps(client, SPACE_SELECTOR, resolveAppGuid));
    await runtime.fetchEvents("ap10/demo-org/dev", CREDENTIALS, { limit: 10, since: undefined, types: [] });
    expect(resolveAppGuid).not.toHaveBeenCalled();
    expect(fetchAuditEvents).toHaveBeenCalledWith({
      scope: { kind: "space", spaceGuid: "space-1" },
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
        makeEvent({ guid: "s1", type: "audit.app.ssh-authorized", createdAt: "2026-05-22T11:55:00.000Z" }),
      ]),
    });
    const runtime = new CfEventsRuntime(makeDeps(client));
    const status = await runtime.getSshStatus("orders-srv", CREDENTIALS, "24h");
    expect(status.sshEnabled).toBe(true);
    expect(status.sessions).toHaveLength(1);
    expect(status.activeSessionCount).toBe(1);
    expect(client.fetchAuditEvents).toHaveBeenCalledWith({
      scope: { kind: "app", appGuid: "app-1" },
      types: ["audit.app.ssh-authorized", "audit.app.ssh-unauthorized"],
      createdAfter: "2026-05-21T12:00:00Z",
      limit: 200,
    });
  });

  it("rejects a space selector", async () => {
    const runtime = new CfEventsRuntime(makeDeps(makeClient(), SPACE_SELECTOR));
    await expect(runtime.getSshStatus("ap10/demo-org/dev", CREDENTIALS, "24h")).rejects.toThrow(
      /ssh-status command requires an app selector/,
    );
  });
});

describe("CfEventsRuntime.getCrashes", () => {
  it("summarizes app crash events", async () => {
    const client = makeClient({
      fetchAuditEvents: vi.fn().mockResolvedValue([
        makeEvent({ guid: "c1", type: "audit.app.crash", createdAt: "2026-05-22T09:00:00.000Z" }),
      ]),
    });
    const runtime = new CfEventsRuntime(makeDeps(client));
    const summary = await runtime.getCrashes("orders-srv", CREDENTIALS, { limit: 50, since: "7d" });
    expect("scope" in summary).toBe(false);
    if (!("scope" in summary)) {
      expect(summary.appName).toBe("orders-srv");
    }
    expect(client.fetchAuditEvents).toHaveBeenCalledWith({
      scope: { kind: "app", appGuid: "app-1" },
      types: ["audit.app.crash", "audit.app.process.crash"],
      createdAfter: "2026-05-15T12:00:00Z",
      limit: 50,
    });
  });

  it("groups space crashes by target app", async () => {
    const client = makeClient({
      fetchAuditEvents: vi.fn().mockResolvedValue([
        makeEvent({ guid: "c1", type: "audit.app.crash", target: { guid: "a", type: "app", name: "orders-srv" } }),
        makeEvent({ guid: "c2", type: "audit.app.process.crash", target: { guid: "b", type: "app", name: "billing-srv" } }),
      ]),
    });
    const runtime = new CfEventsRuntime(makeDeps(client, SPACE_SELECTOR));
    const summary = await runtime.getCrashes("ap10/demo-org/dev", CREDENTIALS, { limit: 50, since: "7d" });
    expect("scope" in summary ? summary.scope : undefined).toBe("space");
    if ("scope" in summary) {
      expect(summary.crashCount).toBe(2);
      expect(summary.apps.map((app) => app.appName).sort()).toEqual(["billing-srv", "orders-srv"]);
    }
    expect(client.fetchAuditEvents).toHaveBeenCalledWith({
      scope: { kind: "space", spaceGuid: "space-1" },
      types: ["audit.app.crash", "audit.app.process.crash"],
      createdAfter: "2026-05-15T12:00:00Z",
      limit: 50,
    });
  });
});

describe("CfEventsRuntime.getStatus", () => {
  it("assembles app health from the parallel API calls", async () => {
    const client = makeClient({
      fetchApp: vi.fn().mockResolvedValue({ guid: "app-1", name: "orders-srv", state: "STARTED" }),
      fetchWebProcessStats: vi.fn().mockResolvedValue([{ type: "web", index: 0, state: "RUNNING", uptimeSeconds: 100, cpu: 0.1, memBytes: 1, memQuotaBytes: 2, diskBytes: 1, diskQuotaBytes: 2 }]),
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

  it("rejects a space selector", async () => {
    const runtime = new CfEventsRuntime(makeDeps(makeClient(), SPACE_SELECTOR));
    await expect(runtime.getStatus("ap10/demo-org/dev", CREDENTIALS)).rejects.toThrow(
      /status command requires an app selector/,
    );
  });
});

describe("CfEventsRuntime.watchEvents", () => {
  it("emits new space events oldest-first and stops when aborted", async () => {
    const controller = new AbortController();
    let calls = 0;
    const fetchAuditEvents = vi.fn().mockImplementation(() => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve([
          makeEvent({ guid: "e2", createdAt: "2026-05-22T10:02:00.000Z" }),
          makeEvent({ guid: "e1", createdAt: "2026-05-22T10:01:00.000Z" }),
        ]);
      }
      controller.abort();
      return Promise.resolve([]);
    });
    const client = makeClient({ fetchAuditEvents });
    const runtime = new CfEventsRuntime(makeDeps(client, SPACE_SELECTOR));
    const emitted: string[] = [];
    await runtime.watchEvents("ap10/demo-org/dev", CREDENTIALS, { intervalMs: 5, lookback: "5m", types: [] }, (event) => emitted.push(event.guid), controller.signal);
    expect(emitted).toEqual(["e1", "e2"]);
    expect(fetchAuditEvents).toHaveBeenNthCalledWith(1, {
      scope: { kind: "space", spaceGuid: "space-1" },
      types: undefined,
      createdAfter: "2026-05-22T11:55:00Z",
      limit: 100,
    });
  });

  it("de-duplicates events seen across polling ticks", async () => {
    const controller = new AbortController();
    let calls = 0;
    const fetchAuditEvents = vi.fn().mockImplementation(() => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve([makeEvent({ guid: "e1", createdAt: "2026-05-22T10:01:00.000Z" })]);
      }
      if (calls === 2) {
        return Promise.resolve([makeEvent({ guid: "e2", createdAt: "2026-05-22T10:02:00.000Z" }), makeEvent({ guid: "e1", createdAt: "2026-05-22T10:01:00.000Z" })]);
      }
      controller.abort();
      return Promise.resolve([]);
    });
    const runtime = new CfEventsRuntime(makeDeps(makeClient({ fetchAuditEvents })));
    const emitted: string[] = [];
    await runtime.watchEvents("orders-srv", CREDENTIALS, { intervalMs: 5, lookback: "5m", types: ["audit.app.start"] }, (event) => emitted.push(event.guid), controller.signal);
    expect(emitted).toEqual(["e1", "e2"]);
  });

  it("does not poll at all when the signal is already aborted", async () => {
    const fetchAuditEvents = vi.fn().mockResolvedValue([]);
    const runtime = new CfEventsRuntime(makeDeps(makeClient({ fetchAuditEvents })));
    const controller = new AbortController();
    controller.abort();
    await runtime.watchEvents("orders-srv", CREDENTIALS, { intervalMs: 5, lookback: "5m", types: [] }, () => { throw new Error("should not emit"); }, controller.signal);
    expect(fetchAuditEvents).not.toHaveBeenCalled();
  });
});

describe("createDefaultDependencies", () => {
  it("exposes the default wiring", () => {
    const deps = createDefaultDependencies();
    expect(typeof deps.resolveSelector).toBe("function");
    expect(typeof deps.withCfTarget).toBe("function");
    expect(deps.now()).toBeInstanceOf(Date);
  });
});
