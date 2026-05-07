import { describe, expect, it } from "vitest";

import { buildRedactionRules, redactText } from "../../src/redact.js";

describe("redact", () => {
  it("buildRedactionRules keeps non-empty unique secrets", () => {
    const rules = buildRedactionRules({
      email: "sample@example.com",
      password: "sample-password",
      secrets: ["sample-password", "", "sample-token"],
    });

    expect(rules.map((rule) => rule.value)).toEqual([
      "sample@example.com",
      "sample-password",
      "sample-token",
    ]);
  });

  it("redactText replaces every configured secret with a safe marker", () => {
    const rules = buildRedactionRules({
      email: "sample@example.com",
      password: "sample-password",
      secrets: ["sample-token"],
    });

    const redacted = redactText(
      "login sample@example.com sample-password sample-token untouched",
      rules,
    );

    expect(redacted).toBe("login *** *** *** untouched");
  });

  it("redactText skips empty rules and honors explicit replacements", () => {
    const redacted = redactText("alpha beta", [
      { value: "", replacement: "X" },
      { value: "alpha", replacement: "[hidden]" },
    ]);

    expect(redacted).toBe("[hidden] beta");
  });
});
