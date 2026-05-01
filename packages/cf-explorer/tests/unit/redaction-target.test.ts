import { describe, expect, it } from "vitest";

import {
  normalizeTarget,
  parseNonNegativeInteger,
  parsePositiveInteger,
  requireNonEmptyText,
  resolveApiEndpoint,
  resolveCredentials,
  resolveInstance,
  resolveInstanceSelector,
  resolveProcessName,
} from "../../src/cf/target.js";
import { buildRedactionRules, redactText } from "../../src/core/redaction.js";

describe("redaction and target helpers", () => {
  it("redacts credentials and extra values", () => {
    const rules = buildRedactionRules(
      { email: "user@example.com", password: "secret" },
      ["token"],
    );
    expect(redactText("user@example.com secret token", rules)).toBe(
      "[REDACTED] [REDACTED] [REDACTED]",
    );
    expect(buildRedactionRules(undefined, ["", "token", "token"])).toEqual([
      { value: "token", replacement: "[REDACTED]" },
    ]);
  });

  it("skips too-short redaction values to prevent text bleed", () => {
    expect(buildRedactionRules({ email: "u@x", password: "ok" }, ["pw"])).toEqual([]);
    const rules = buildRedactionRules({ email: "user@example.com", password: "abcd" });
    expect(rules.map((rule) => rule.value)).toEqual(["user@example.com", "abcd"]);
  });

  it("normalizes target fields", () => {
    expect(normalizeTarget({ region: " ap10 ", org: " org ", space: " dev ", app: " app " }))
      .toEqual({ region: "ap10", org: "org", space: "dev", app: "app" });
    expect(normalizeTarget({
      region: "ap10",
      org: "org",
      space: "dev",
      app: "app",
      apiEndpoint: " https://api.example.test ",
    })).toMatchObject({ apiEndpoint: "https://api.example.test" });
    expect(normalizeTarget({
      region: "ap10",
      org: "org",
      space: "dev",
      app: "app",
      apiEndpoint: " ",
    })).not.toHaveProperty("apiEndpoint");
    expect(() => normalizeTarget({
      region: "ap10",
      org: "org",
      space: "dev",
      app: "app",
      apiEndpoint: "https://api.example.test\nbad",
    })).toThrow(/line breaks/);
  });

  it("resolves region endpoints and explicit endpoint overrides", () => {
    expect(resolveApiEndpoint({
      region: "ap10",
      org: "org",
      space: "dev",
      app: "demo-app",
    })).toContain("ap10");
    expect(resolveApiEndpoint({
      region: "unknown",
      org: "org",
      space: "dev",
      app: "demo-app",
      apiEndpoint: "https://api.example.test",
    })).toBe("https://api.example.test");
    expect(() => resolveApiEndpoint({
      region: "unknown",
      org: "org",
      space: "dev",
      app: "demo-app",
    })).toThrow(/Unknown/);
  });

  it("resolves credentials from explicit runtime or env", () => {
    expect(resolveCredentials({
      credentials: { email: "direct@example.com", password: " secret " },
    })).toEqual({ email: "direct@example.com", password: " secret " });
    expect(resolveCredentials({
      env: { SAP_EMAIL: "env@example.com", SAP_PASSWORD: "pw" },
    }).password).toBe("pw");
    expect(() => resolveCredentials({
      credentials: { email: "direct@example.com", password: "bad\nsecret" },
    })).toThrow(/line breaks/);
  });

  it("validates integer flags", () => {
    expect(parsePositiveInteger("3", "--max-files")).toBe(3);
    expect(parseNonNegativeInteger("0", "--instance")).toBe(0);
    expect(() => parsePositiveInteger("0", "--max-files")).toThrow(/positive/);
    expect(() => parseNonNegativeInteger("-1", "--instance")).toThrow(/non-negative/);
    expect(() => parsePositiveInteger("10abc", "--timeout")).toThrow(/integer/);
    expect(() => parseNonNegativeInteger("1.5", "--instance")).toThrow(/integer/);
    expect(() => parsePositiveInteger("9007199254740993", "--timeout")).toThrow(/safe/);
    expect(parsePositiveInteger(undefined, "--max-files")).toBeUndefined();
    expect(parseNonNegativeInteger(undefined, "--instance")).toBeUndefined();
  });

  it("rejects conflicting instance selectors", () => {
    expect(resolveInstanceSelector({ instance: 0 })).toMatchObject({ instance: 0 });
    expect(resolveInstanceSelector({ allInstances: true })).toMatchObject({ allInstances: true });
    expect(() => resolveInstanceSelector({ instance: 0, allInstances: true })).toThrow(/either/);
  });

  it("validates required text, process, and instance defaults", () => {
    expect(requireNonEmptyText(" value ", "field")).toBe("value");
    expect(resolveProcessName(undefined)).toBe("web");
    expect(resolveInstance(undefined)).toBe(0);
    expect(() => requireNonEmptyText("\n", "field")).toThrow(/required/);
    expect(() => requireNonEmptyText("a\nb", "field")).toThrow(/line breaks/);
    expect(() => resolveInstance(-1)).toThrow(/non-negative/);
    expect(() => resolveCredentials({ env: { SAP_PASSWORD: "pw" } })).toThrow(/SAP email/);
    expect(() => resolveCredentials({ env: { SAP_EMAIL: "e2e@example.com" } })).toThrow(/SAP password/);
  });
});
