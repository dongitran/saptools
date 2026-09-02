import { describe, expect, it } from "vitest";

import { compareSemver, isNewerRelease, parseSemver } from "../../src/self-update/semver.js";

describe("parseSemver", () => {
  it("parses a release and a prerelease, tolerating a leading v and build metadata", () => {
    expect(parseSemver("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(parseSemver("v0.7.0-beta.2+build.5")).toEqual({ major: 0, minor: 7, patch: 0, prerelease: ["beta", "2"] });
  });

  it.each(["", "1.2", "1.2.3.4", "01.2.3", "latest", "1.2.x", "1.2.3-"])("rejects %j", (text) => {
    expect(parseSemver(text)).toBeUndefined();
  });
});

describe("compareSemver", () => {
  const compare = (left: string, right: string): number => {
    const a = parseSemver(left);
    const b = parseSemver(right);
    if (a === undefined || b === undefined) {
      throw new Error("test fixture is not semver");
    }
    return compareSemver(a, b);
  };

  it("orders by major, minor, patch numerically", () => {
    expect(compare("0.9.9", "0.10.0")).toBe(-1);
    expect(compare("2.0.0", "1.99.99")).toBe(1);
    expect(compare("1.2.3", "1.2.3")).toBe(0);
  });

  it("ranks a release above its prereleases and orders prerelease identifiers per semver", () => {
    expect(compare("1.0.0", "1.0.0-rc.1")).toBe(1);
    expect(compare("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1);
    expect(compare("1.0.0-alpha.1", "1.0.0-alpha.beta")).toBe(-1);
    expect(compare("1.0.0-beta.2", "1.0.0-beta.11")).toBe(-1);
    expect(compare("1.0.0-beta.11", "1.0.0-rc.1")).toBe(-1);
    expect(compare("1.0.0-rc.1", "1.0.0-rc.1")).toBe(0);
    expect(compare("1.0.0-rc.1", "1.0.0-beta")).toBe(1);
  });
});

describe("isNewerRelease", () => {
  it("is true only for a strictly newer release", () => {
    expect(isNewerRelease("0.7.0", "0.6.0")).toBe(true);
    expect(isNewerRelease("0.6.0", "0.6.0")).toBe(false);
    expect(isNewerRelease("0.5.9", "0.6.0")).toBe(false);
  });

  it("never targets a prerelease, and never acts on garbage", () => {
    expect(isNewerRelease("0.7.0-beta.1", "0.6.0")).toBe(false);
    expect(isNewerRelease("1.0.0", "0.9.0-rc.1")).toBe(true);
    expect(isNewerRelease("latest", "0.6.0")).toBe(false);
    expect(isNewerRelease("0.7.0", "dev")).toBe(false);
  });
});
