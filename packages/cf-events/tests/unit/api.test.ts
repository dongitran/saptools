import { describe, expect, it, vi } from "vitest";

import {
  buildAuditEventsPath,
  fetchApp,
  fetchAuditEvents,
  fetchSshEnabled,
  fetchWebProcessStats,
} from "../../src/api.js";

describe("buildAuditEventsPath", () => {
  it("includes target_guids, ordering, and per_page", () => {
    const path = buildAuditEventsPath(
      { scope: { kind: "app", appGuid: "app-1" }, types: undefined, createdAfter: undefined, limit: 50 },
      25,
    );
    expect(path.startsWith("/v3/audit_events?")).toBe(true);
    expect(path).toContain("target_guids=app-1");
    expect(path).toContain("order_by=-created_at");
    expect(path).toContain("per_page=25");
  });

  it("includes the space filter, type filter, and created_ats lower bound when provided", () => {
    const path = buildAuditEventsPath(
      {
        scope: { kind: "space", spaceGuid: "space-1" },
        types: ["audit.app.crash"],
        createdAfter: "2026-05-22T00:00:00Z",
        limit: 50,
      },
      100,
    );
    expect(path).toContain("space_guids=space-1");
    expect(path).toContain("types=audit.app.crash");
    expect(path).toContain("created_ats%5Bgt%5D=2026-05-22T00%3A00%3A00Z");
    expect(path).not.toContain(".000Z");
  });
});

describe("fetchAuditEvents", () => {
  it("maps audit events from a single page", async () => {
    const curl = vi.fn().mockResolvedValue(
      JSON.stringify({
        pagination: { next: null },
        resources: [
          {
            guid: "e1",
            type: "audit.app.start",
            created_at: "2026-05-22T10:00:00Z",
            updated_at: "2026-05-22T10:00:00Z",
            actor: { guid: "a1", type: "user", name: "user@example.com" },
            target: { guid: "t1", type: "app", name: "orders-srv" },
            data: { foo: "bar" },
            space: { guid: "space-1" },
            organization: { guid: "org-1" },
          },
        ],
      }),
    );
    const events = await fetchAuditEvents(
      { scope: { kind: "app", appGuid: "app-1" }, types: undefined, createdAfter: undefined, limit: 50 },
      curl,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      guid: "e1",
      type: "audit.app.start",
      createdAt: "2026-05-22T10:00:00Z",
      spaceGuid: "space-1",
      organizationGuid: "org-1",
    });
    expect(events[0]?.actor.name).toBe("user@example.com");
  });

  it("follows pagination across pages", async () => {
    const page1 = JSON.stringify({
      pagination: { next: { href: "https://api.cf.example.com/v3/audit_events?page=2" } },
      resources: [{ guid: "e1", type: "audit.app.start" }],
    });
    const page2 = JSON.stringify({
      pagination: { next: null },
      resources: [{ guid: "e2", type: "audit.app.stop" }],
    });
    const curl = vi.fn().mockResolvedValueOnce(page1).mockResolvedValueOnce(page2);
    const events = await fetchAuditEvents(
      { scope: { kind: "app", appGuid: "app-1" }, types: undefined, createdAfter: undefined, limit: 50 },
      curl,
    );
    expect(events.map((event) => event.guid)).toEqual(["e1", "e2"]);
    expect(curl).toHaveBeenCalledTimes(2);
  });

  it("stops at the limit without requesting another page", async () => {
    const curl = vi.fn().mockResolvedValue(
      JSON.stringify({
        pagination: { next: { href: "https://api.cf.example.com/v3/audit_events?page=2" } },
        resources: [
          { guid: "e1", type: "audit.app.start" },
          { guid: "e2", type: "audit.app.stop" },
        ],
      }),
    );
    const events = await fetchAuditEvents(
      { scope: { kind: "app", appGuid: "app-1" }, types: undefined, createdAfter: undefined, limit: 1 },
      curl,
    );
    expect(events.map((event) => event.guid)).toEqual(["e1"]);
    expect(curl).toHaveBeenCalledTimes(1);
  });

  it("throws a clear error when CF returns an errors array", async () => {
    const curl = vi.fn().mockResolvedValue(
      JSON.stringify({
        errors: [
          {
            code: 10005,
            title: "CF-BadQueryParameter",
            detail: "The query parameter is invalid: Created ats has an invalid timestamp format. Timestamps should be formatted as 'YYYY-MM-DDThh:mm:ssZ'",
          },
        ],
      }),
    );
    await expect(
      fetchAuditEvents(
        { scope: { kind: "app", appGuid: "app-1" }, types: undefined, createdAfter: "2026-07-05T00:00:00Z", limit: 5 },
        curl,
      ),
    ).rejects.toThrow(/CF-BadQueryParameter.*YYYY-MM-DDThh:mm:ssZ/);
  });

  it("throws when an audit-event list response has no resources array", async () => {
    const curl = vi.fn().mockResolvedValue(JSON.stringify({ pagination: { next: null } }));
    await expect(
      fetchAuditEvents(
        { scope: { kind: "app", appGuid: "app-1" }, types: undefined, createdAfter: undefined, limit: 5 },
        curl,
      ),
    ).rejects.toThrow(/missing resources array/);
  });

  it("throws when the API returns a non-JSON body", async () => {
    const curl = vi.fn().mockResolvedValue("not json");
    await expect(
      fetchAuditEvents(
        { scope: { kind: "app", appGuid: "app-1" }, types: undefined, createdAfter: undefined, limit: 5 },
        curl,
      ),
    ).rejects.toThrow(/not valid JSON/);
  });
});

describe("fetchApp / fetchSshEnabled / fetchWebProcessStats", () => {
  it("maps the app summary", async () => {
    const curl = vi.fn().mockResolvedValue(
      JSON.stringify({ guid: "app-1", name: "orders-srv", state: "STARTED" }),
    );
    expect(await fetchApp("app-1", curl)).toEqual({
      guid: "app-1",
      name: "orders-srv",
      state: "STARTED",
    });
  });

  it("maps the SSH-enabled response", async () => {
    const curl = vi.fn().mockResolvedValue(JSON.stringify({ enabled: true, reason: "" }));
    expect(await fetchSshEnabled("app-1", curl)).toEqual({ enabled: true, reason: "" });
  });

  it("treats a missing enabled flag as disabled", async () => {
    const curl = vi.fn().mockResolvedValue(JSON.stringify({ reason: "Disabled globally" }));
    expect(await fetchSshEnabled("app-1", curl)).toEqual({
      enabled: false,
      reason: "Disabled globally",
    });
  });

  it("maps process instance stats", async () => {
    const curl = vi.fn().mockResolvedValue(
      JSON.stringify({
        resources: [
          {
            type: "web",
            index: 0,
            state: "RUNNING",
            uptime: 1000,
            usage: { cpu: 0.2, mem: 2048, disk: 1024 },
            mem_quota: 4096,
            disk_quota: 8192,
          },
        ],
      }),
    );
    const stats = await fetchWebProcessStats("app-1", curl);
    expect(stats[0]).toEqual({
      type: "web",
      index: 0,
      state: "RUNNING",
      uptimeSeconds: 1000,
      cpu: 0.2,
      memBytes: 2048,
      memQuotaBytes: 4096,
      diskBytes: 1024,
      diskQuotaBytes: 8192,
    });
  });

  it("returns an empty list when there are no process resources", async () => {
    const curl = vi.fn().mockResolvedValue(JSON.stringify({}));
    expect(await fetchWebProcessStats("app-1", curl)).toEqual([]);
  });
});
