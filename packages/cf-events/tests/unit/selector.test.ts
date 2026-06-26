import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock("../../src/cf.js");
});

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
  it("resolves explicit full path using region api map", async () => {
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

  it("resolves bare app name using current CF target (no search)", async () => {
    vi.doMock("../../src/cf.js", async () => {
      const actual = await vi.importActual("../../src/cf.js");
      return {
        ...actual,
        readCurrentCfTarget: vi.fn().mockResolvedValue({
          apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
          orgName: "demo-org",
          spaceName: "dev",
          regionKey: "ap10",
        }),
      };
    });
    const { resolveSelector } = await import("../../src/selector.js");
    await expect(resolveSelector("orders-srv")).resolves.toMatchObject({
      regionKey: "ap10",
      apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
      orgName: "demo-org",
      spaceName: "dev",
      appName: "orders-srv",
    });
  });

  it("throws for bare when no current target", async () => {
    vi.doMock("../../src/cf.js", async () => {
      const actual = await vi.importActual("../../src/cf.js");
      return {
        ...actual,
        readCurrentCfTarget: vi.fn().mockResolvedValue(undefined),
      };
    });
    const { resolveSelector } = await import("../../src/selector.js");
    await expect(resolveSelector("orders-srv")).rejects.toThrow(/No current CF target found/);
  });

  it("throws for unknown region in explicit", async () => {
    const { resolveSelector } = await import("../../src/selector.js");
    await expect(resolveSelector("unknown/demo-org/dev/orders-srv")).rejects.toThrow(
      /Unknown region "unknown"/,
    );
  });

  it("rejects invalid selector format", async () => {
    const { resolveSelector } = await import("../../src/selector.js");
    await expect(resolveSelector("ap10/demo-org")).rejects.toThrow(/Invalid selector/);
  });
});
