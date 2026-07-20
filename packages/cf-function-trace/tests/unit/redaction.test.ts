import process from "node:process";

import { describe, expect, it } from "vitest";

import { redactValue } from "../../src/redaction.js";

const SENSITIVE_KEYS_ENV = "CF_FUNCTION_TRACE_SENSITIVE_KEYS";

function withEnv(name: string, value: string, run: () => void): void {
  const original = process.env[name];
  process.env[name] = value;
  try {
    run();
  } finally {
    if (original === undefined) {
      Reflect.deleteProperty(process.env, name);
    } else {
      process.env[name] = original;
    }
  }
}

describe("runtime state redaction", () => {
  it("redacts sensitive keys and credential-shaped values recursively", () => {
    const value = redactValue({
      authorization: "Bearer raw-access-value",
      nested: {
        sessionToken: "raw-session-value",
        certificate: "-----BEGIN PRIVATE KEY-----\nraw-key\n-----END PRIVATE KEY-----",
        endpoint: "https://alice:raw-password@example.invalid/path",
      },
      label: "safe-value",
    });
    const text = JSON.stringify(value);
    expect(text).not.toContain("raw-access-value");
    expect(text).not.toContain("raw-session-value");
    expect(text).not.toContain("raw-password");
    expect(text).not.toContain("raw-key");
    expect(text).toContain("safe-value");
  });

  it("does not redact ordinary words containing key-like substrings", () => {
    expect(redactValue({ monkey: "banana", keyboard: "mechanical" })).toEqual({
      monkey: "banana",
      keyboard: "mechanical",
    });
  });

  it("redacts authentication schemes and JWT-shaped values inside arrays", () => {
    const value = redactValue([
      "Basic credential-value",
      "prefix eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature suffix",
      "ordinary text",
    ]);

    expect(value).toEqual(["[REDACTED]", "prefix [REDACTED] suffix", "ordinary text"]);
  });

  it("redacts password-bearing connection strings that are not standard URLs", () => {
    const value = redactValue([
      "Server=db.example;User ID=alice;Password=connection-secret;Encrypt=true",
      "jdbc:postgresql://alice:jdbc-secret@db.example:5432/orders",
      "Host=db.example User=alice Pwd=space-secret SSL Mode=require",
    ]);
    const text = JSON.stringify(value);

    expect(text).not.toContain("connection-secret");
    expect(text).not.toContain("jdbc-secret");
    expect(text).not.toContain("space-secret");
  });

  it("redacts common abbreviated credential keys and underscored assignments", () => {
    const value = redactValue({
      "scope.0.local.pwd": "pwd-sentinel",
      passwd: "passwd-sentinel",
      passphrase: "passphrase-sentinel",
      notes: [
        "api_key=api-sentinel",
        "private_key=private-sentinel",
        "connection_string=connection-sentinel",
        "x-api-key: header-sentinel",
      ],
    });
    const text = JSON.stringify(value);

    for (const sentinel of ["pwd-sentinel", "passwd-sentinel", "passphrase-sentinel", "api-sentinel", "private-sentinel", "connection-sentinel", "header-sentinel"]) {
      expect(text).not.toContain(sentinel);
    }
  });

  it("redacts a bare business email address even under an unrelated key name", () => {
    // Reproduces a real finding: a plain "userID" field holding a work email
    // address is not a credential-shaped key/value by any existing pattern.
    const value = redactValue({
      userID: "panasonic.sg.dev@laidon.com",
      note: "contact alice.smith@example.invalid for details",
      label: "safe-value",
    });
    const text = JSON.stringify(value);
    expect(text).not.toContain("panasonic.sg.dev@laidon.com");
    expect(text).not.toContain("alice.smith@example.invalid");
    expect(text).toContain("for details");
    expect(text).toContain("safe-value");
  });

  it("redacts additional key names supplied via CF_FUNCTION_TRACE_SENSITIVE_KEYS", () => {
    withEnv(SENSITIVE_KEYS_ENV, "employeeId, taxId", () => {
      expect(redactValue({ employeeId: "E-90210", taxId: "T-1", label: "safe-value" })).toEqual({
        employeeId: { kind: "redacted" },
        taxId: { kind: "redacted" },
        label: "safe-value",
      });
    });
  });

  it("ignores an unset or blank sensitive-key environment variable", () => {
    withEnv(SENSITIVE_KEYS_ENV, "  , ", () => {
      expect(redactValue({ employeeId: "E-90210" })).toEqual({ employeeId: "E-90210" });
    });
  });

  it("does not spill a configured multi-word sensitive key onto unrelated fields sharing one word", () => {
    // A project configuring a domain-specific key (the doc-comment's own
    // examples: employeeId/taxId/vendorBankAccount) must not, as a side
    // effect, redact every OTHER field that happens to share a single
    // component word -- "id"/"account"/"bank"/"vendor" are common,
    // non-sensitive field-name fragments on their own.
    withEnv(SENSITIVE_KEYS_ENV, "employeeId, taxId, vendorBankAccount", () => {
      expect(redactValue({
        employeeId: "E-90210",
        orderId: "ORD-123",
        userId: "U-456",
        accountBalance: "1000.00",
        bankName: "First National",
        vendorName: "Acme Corp",
        label: "safe-value",
      })).toEqual({
        employeeId: { kind: "redacted" },
        orderId: "ORD-123",
        userId: "U-456",
        accountBalance: "1000.00",
        bankName: "First National",
        vendorName: "Acme Corp",
        label: "safe-value",
      });
    });
  });

  it("replaces cyclic input without traversing it indefinitely", () => {
    const value: { name: string; self?: unknown } = { name: "safe" };
    value.self = value;

    expect(redactValue(value)).toEqual({
      name: "safe",
      self: { kind: "unavailable", description: "cyclic-input" },
    });
  });
});
