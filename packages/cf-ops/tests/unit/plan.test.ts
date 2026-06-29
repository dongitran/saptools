import { describe, expect, it } from "vitest";

import { buildLifecyclePlan, buildScalePlan, parseInstanceCount, parseRestartStrategy, parseSize } from "../../src/plan.js";

describe("parseInstanceCount", () => {
  it("accepts zero and positive integers", () => {
    expect(parseInstanceCount("0")).toBe(0);
    expect(parseInstanceCount("3")).toBe(3);
  });

  it("rejects non-integer values", () => {
    expect(() => parseInstanceCount("1.5")).toThrow(/non-negative integer/);
    expect(() => parseInstanceCount("-1")).toThrow(/non-negative integer/);
  });
});

describe("parseSize", () => {
  it("normalizes Cloud Foundry size values", () => {
    expect(parseSize("512m", "memory")).toBe("512M");
    expect(parseSize("1gb", "disk")).toBe("1GB");
  });

  it("rejects unsupported size values", () => {
    expect(() => parseSize("large", "memory")).toThrow(/Cloud Foundry size/);
  });

  it("rejects zero-sized memory and disk values", () => {
    expect(() => parseSize("0M", "memory")).toThrow(/greater than zero/);
    expect(() => parseSize("0GB", "disk")).toThrow(/greater than zero/);
  });
});

describe("parseRestartStrategy", () => {
  it("accepts default, rolling, and omitted strategy values", () => {
    expect(parseRestartStrategy(undefined)).toBe("default");
    expect(parseRestartStrategy("default")).toBe("default");
    expect(parseRestartStrategy("rolling")).toBe("rolling");
  });

  it("rejects unknown restart strategy values", () => {
    expect(() => parseRestartStrategy("blue-green")).toThrow(/default or rolling/);
  });
});

describe("buildLifecyclePlan", () => {
  it("builds a rolling restart plan", () => {
    expect(buildLifecyclePlan(" orders-srv ", "restart", "rolling")).toEqual({
      appName: "orders-srv",
      action: "restart",
      strategy: "rolling",
    });
  });

  it("rejects rolling strategy for non-restart actions", () => {
    expect(() => buildLifecyclePlan("orders-srv", "restage", "rolling")).toThrow(/only supported/);
  });
});

describe("buildScalePlan", () => {
  it("builds cf scale arguments", () => {
    expect(
      buildScalePlan({
        appName: "orders-srv",
        instances: 3,
        memory: "1g",
        disk: "2G",
        restart: false,
        strategy: "default",
      }),
    ).toEqual({
      appName: "orders-srv",
      args: ["scale", "orders-srv", "-i", "3", "-m", "1G", "-k", "2G"],
    });
  });

  it("adds a restart plan when requested", () => {
    expect(
      buildScalePlan({
        appName: "orders-srv",
        instances: 2,
        restart: true,
        strategy: "rolling",
      }).restartAfterScale,
    ).toEqual({ appName: "orders-srv", action: "restart", strategy: "rolling" });
  });

  it("requires at least one scale dimension", () => {
    expect(() =>
      buildScalePlan({ appName: "orders-srv", restart: false, strategy: "default" }),
    ).toThrow(/at least one/);
  });

  it("rejects a rolling restart after scale when the app name is blank", () => {
    expect(() =>
      buildScalePlan({ appName: "   ", instances: 1, restart: true, strategy: "rolling" }),
    ).toThrow(/app name is required/);
  });
});
