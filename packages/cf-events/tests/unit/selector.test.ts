import type { CfStructure } from "@saptools/cf-sync";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock("@saptools/cf-sync");
});

function makeStructure(): CfStructure {
  return {
    syncedAt: "2026-05-22T00:00:00.000Z",
    regions: [
      {
        key: "ap10",
        label: "Australia (Sydney) - AWS (ap10)",
        apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
        accessible: true,
        orgs: [
          {
            name: "demo-org",
            spaces: [
              { name: "dev", apps: [{ name: "orders-srv" }, { name: "shared-app" }] },
              { name: "prod", apps: [{ name: "prod-only" }] },
            ],
          },
        ],
      },
      {
        key: "eu10",
        label: "Europe (Frankfurt) - AWS (eu10)",
        apiEndpoint: "https://api.cf.eu10.hana.ondemand.com",
        accessible: true,
        orgs: [{ name: "eu-org", spaces: [{ name: "dev", apps: [{ name: "shared-app" }] }] }],
      },
    ],
  };
}

function mockStructure(structure: CfStructure | undefined): void {
  vi.doMock("@saptools/cf-sync", () => ({
    readStructure: vi.fn().mockResolvedValue(structure),
  }));
}

describe("parseSelector", () => {
  it("parses a bare app name", async () => {
    const { parseSelector } = await import("../../src/selector.js");
    expect(parseSelector("orders-srv")).toEqual({ kind: "appName", appName: "orders-srv" });
  });

  it("parses a full region/org/space/app selector", async () => {
    const { parseSelector } = await import("../../src/selector.js");
    expect(parseSelector("ap10/demo-org/dev/orders-srv")).toEqual({
      kind: "explicit",
      regionKey: "ap10",
      orgName: "demo-org",
      spaceName: "dev",
      appName: "orders-srv",
    });
  });

  it("rejects an empty selector", async () => {
    const { parseSelector } = await import("../../src/selector.js");
    expect(() => parseSelector("   ")).toThrow(/selector is required/);
  });

  it("rejects a selector with the wrong number of segments", async () => {
    const { parseSelector } = await import("../../src/selector.js");
    expect(() => parseSelector("ap10/demo-org/dev")).toThrow(/Invalid selector/);
  });

  it("rejects a selector with an empty segment", async () => {
    const { parseSelector } = await import("../../src/selector.js");
    expect(() => parseSelector("ap10//dev/orders-srv")).toThrow(/non-empty/);
  });
});

describe("resolveSelector", () => {
  it("resolves an explicit selector against the snapshot", async () => {
    mockStructure(makeStructure());
    const { resolveSelector } = await import("../../src/selector.js");
    await expect(resolveSelector("ap10/demo-org/dev/orders-srv")).resolves.toEqual({
      raw: "ap10/demo-org/dev/orders-srv",
      regionKey: "ap10",
      apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
      orgName: "demo-org",
      spaceName: "dev",
      appName: "orders-srv",
    });
  });

  it("resolves a unique bare app name", async () => {
    mockStructure(makeStructure());
    const { resolveSelector } = await import("../../src/selector.js");
    await expect(resolveSelector("orders-srv")).resolves.toMatchObject({
      regionKey: "ap10",
      spaceName: "dev",
      appName: "orders-srv",
    });
  });

  it("throws when no topology snapshot exists", async () => {
    mockStructure(undefined);
    const { resolveSelector } = await import("../../src/selector.js");
    await expect(resolveSelector("orders-srv")).rejects.toThrow(/No CF topology snapshot/);
  });

  it("throws when the region is missing from the snapshot", async () => {
    mockStructure(makeStructure());
    const { resolveSelector } = await import("../../src/selector.js");
    await expect(resolveSelector("us10/demo-org/dev/orders-srv")).rejects.toThrow(
      /Region "us10" is not in the CF topology snapshot/,
    );
  });

  it("throws when the org, space, or app is missing", async () => {
    mockStructure(makeStructure());
    const { resolveSelector } = await import("../../src/selector.js");
    await expect(resolveSelector("ap10/missing/dev/orders-srv")).rejects.toThrow(/Org "missing"/);
    await expect(resolveSelector("ap10/demo-org/missing/orders-srv")).rejects.toThrow(
      /Space "missing"/,
    );
    await expect(resolveSelector("ap10/demo-org/dev/missing")).rejects.toThrow(/App "missing"/);
  });

  it("throws when a bare app name is not found", async () => {
    mockStructure(makeStructure());
    const { resolveSelector } = await import("../../src/selector.js");
    await expect(resolveSelector("ghost-app")).rejects.toThrow(/was not found/);
  });

  it("throws when a bare app name is ambiguous", async () => {
    mockStructure(makeStructure());
    const { resolveSelector } = await import("../../src/selector.js");
    await expect(resolveSelector("shared-app")).rejects.toThrow(/is ambiguous/);
  });
});
