import { describe, expect, it } from "vitest";

import type { InstallLocation } from "../../src/self-update/install-location.js";
import { isTruthyFlag, parsePolicy, resolveCheckIntervalMs, resolveUpdatePolicy } from "../../src/self-update/policy.js";
import { REEXEC_MARKER_ENV } from "../../src/self-update/reexec.js";

const GLOBAL: InstallLocation = { kind: "npm-global", packageDirectory: "/p/lib/node_modules/@saptools/demo", prefix: "/p", writable: true, detail: "npm global install under /p" };

function at(kind: InstallLocation["kind"], writable = true): InstallLocation {
  return { ...GLOBAL, kind, writable };
}

describe("parsePolicy / isTruthyFlag", () => {
  it("accepts the documented spellings case-insensitively and rejects the rest", () => {
    expect(parsePolicy("ON")).toBe("on");
    expect(parsePolicy("1")).toBe("on");
    expect(parsePolicy("auto")).toBe("on");
    expect(parsePolicy("notify")).toBe("notify");
    expect(parsePolicy(" check ")).toBe("notify");
    expect(parsePolicy("off")).toBe("off");
    expect(parsePolicy("0")).toBe("off");
    expect(parsePolicy("never")).toBe("off");
    expect(parsePolicy("maybe")).toBeUndefined();
    expect(parsePolicy(undefined)).toBeUndefined();
  });

  it("treats CI-style flags the way CI providers set them", () => {
    expect(isTruthyFlag("true")).toBe(true);
    expect(isTruthyFlag("1")).toBe(true);
    expect(isTruthyFlag("yes")).toBe(true);
    expect(isTruthyFlag("")).toBe(false);
    expect(isTruthyFlag("0")).toBe(false);
    expect(isTruthyFlag("false")).toBe(false);
    expect(isTruthyFlag(undefined)).toBe(false);
  });
});

describe("resolveUpdatePolicy", () => {
  it("defaults to on for a writable global install", () => {
    expect(resolveUpdatePolicy({ env: {}, location: GLOBAL })).toEqual({ policy: "on", reason: "default", explicit: false });
  });

  it("honours the global and the per-package environment variables, per-package winning", () => {
    expect(resolveUpdatePolicy({ env: { SAPTOOLS_AUTO_UPDATE: "notify" }, location: GLOBAL })).toMatchObject({ policy: "notify", explicit: true });
    expect(resolveUpdatePolicy({ env: { SAPTOOLS_AUTO_UPDATE: "off" }, location: GLOBAL })).toMatchObject({ policy: "off", explicit: true });
    expect(resolveUpdatePolicy({ env: { SAPTOOLS_AUTO_UPDATE: "off", CF_METRICS_AUTO_UPDATE: "on" }, envPrefix: "CF_METRICS", location: GLOBAL })).toMatchObject({ policy: "on", explicit: true });
    expect(resolveUpdatePolicy({ env: { SAPTOOLS_AUTO_UPDATE: "on", CF_METRICS_AUTO_UPDATE: "off" }, envPrefix: "CF_METRICS", location: GLOBAL }).policy).toBe("off");
  });

  it("is off after a re-exec and for excluded commands, whatever the environment says", () => {
    expect(resolveUpdatePolicy({ env: { [REEXEC_MARKER_ENV]: "1", SAPTOOLS_AUTO_UPDATE: "on" }, location: GLOBAL })).toMatchObject({ policy: "off", reason: "already re-executed after an update" });
    expect(resolveUpdatePolicy({ env: { SAPTOOLS_AUTO_UPDATE: "on" }, location: GLOBAL, commandPath: "self-update" }).policy).toBe("off");
    expect(resolveUpdatePolicy({ env: {}, location: GLOBAL, commandPath: "db-sync-worker", skipCommands: ["db-sync-worker"] }).reason).toContain("db-sync-worker");
    expect(resolveUpdatePolicy({ env: {}, location: GLOBAL, commandPath: "credential list", skipCommands: ["db-sync-worker"] }).policy).toBe("on");
  });

  it("can never upgrade a checkout or an npx run, and only notifies for an unrecognized location", () => {
    expect(resolveUpdatePolicy({ env: { SAPTOOLS_AUTO_UPDATE: "on" }, location: at("local") })).toMatchObject({ policy: "off", explicit: true });
    expect(resolveUpdatePolicy({ env: {}, location: at("npx") }).policy).toBe("off");
    expect(resolveUpdatePolicy({ env: {}, location: at("unknown", false) })).toMatchObject({ policy: "notify" });
  });

  it("stays quiet in CI, under NO_UPDATE_NOTIFIER and NODE_ENV=test unless the user opted in explicitly", () => {
    expect(resolveUpdatePolicy({ env: { CI: "true" }, location: GLOBAL })).toMatchObject({ policy: "off", reason: "running in CI" });
    expect(resolveUpdatePolicy({ env: { CI: "false" }, location: GLOBAL }).policy).toBe("on");
    expect(resolveUpdatePolicy({ env: { NO_UPDATE_NOTIFIER: "1" }, location: GLOBAL }).policy).toBe("off");
    expect(resolveUpdatePolicy({ env: { NODE_ENV: "test" }, location: GLOBAL }).policy).toBe("off");
    expect(resolveUpdatePolicy({ env: { CI: "true", SAPTOOLS_AUTO_UPDATE: "on" }, location: GLOBAL }).policy).toBe("on");
    expect(resolveUpdatePolicy({ env: { CI: "true", SAPTOOLS_AUTO_UPDATE: "notify" }, location: GLOBAL }).policy).toBe("notify");
  });

  it("downgrades to notify when the install is not writable", () => {
    expect(resolveUpdatePolicy({ env: {}, location: at("npm-global", false) })).toMatchObject({ policy: "notify", reason: "the install directory is not writable by this user" });
    expect(resolveUpdatePolicy({ env: { SAPTOOLS_AUTO_UPDATE: "on" }, location: at("pnpm-global", false) })).toMatchObject({ policy: "notify", explicit: true });
  });

  it("in manual mode ignores exclusions, off and CI, but not the install facts", () => {
    expect(resolveUpdatePolicy({ env: { SAPTOOLS_AUTO_UPDATE: "off", CI: "1", [REEXEC_MARKER_ENV]: "1" }, location: GLOBAL, commandPath: "self-update", manual: true })).toEqual({ policy: "on", reason: "requested explicitly", explicit: true });
    expect(resolveUpdatePolicy({ env: {}, location: at("local"), manual: true }).policy).toBe("off");
    expect(resolveUpdatePolicy({ env: {}, location: at("npm-global", false), manual: true }).policy).toBe("notify");
  });
});

describe("resolveCheckIntervalMs", () => {
  it("defaults to an hour, accepts minutes including zero, and ignores garbage", () => {
    expect(resolveCheckIntervalMs({})).toBe(3_600_000);
    expect(resolveCheckIntervalMs({ SAPTOOLS_UPDATE_INTERVAL_MINUTES: "15" })).toBe(900_000);
    expect(resolveCheckIntervalMs({ SAPTOOLS_UPDATE_INTERVAL_MINUTES: "0" })).toBe(0);
    expect(resolveCheckIntervalMs({ SAPTOOLS_UPDATE_INTERVAL_MINUTES: "1.5" })).toBe(90_000);
    expect(resolveCheckIntervalMs({ SAPTOOLS_UPDATE_INTERVAL_MINUTES: "-3" })).toBe(3_600_000);
    expect(resolveCheckIntervalMs({ SAPTOOLS_UPDATE_INTERVAL_MINUTES: "soon" })).toBe(3_600_000);
  });
});
