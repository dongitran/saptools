import { describe, expect, it } from "vitest";

import { redactValue } from "../../src/redaction.js";

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

  it("replaces cyclic input without traversing it indefinitely", () => {
    const value: { name: string; self?: unknown } = { name: "safe" };
    value.self = value;

    expect(redactValue(value)).toEqual({
      name: "safe",
      self: { kind: "unavailable", description: "cyclic-input" },
    });
  });
});
