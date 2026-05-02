import { describe, expect, it } from "vitest";

import { parseBruEnvFile } from "../../src/bruno/parser.js";
import { ensureSecretEntry, upsertVars } from "../../src/bruno/writer.js";

describe("upsertVars", () => {
  it("creates a new vars block when none exists", () => {
    const updates = new Map([["foo", "bar"]]);
    const { content, changed } = upsertVars("", updates);
    expect(changed).toBe(true);
    const parsed = parseBruEnvFile(content);
    expect(parsed.vars.entries.get("foo")).toBe("bar");
  });

  it("appends a vars block to non-empty content with a blank separator", () => {
    const { content, changed } = upsertVars("meta {\n  name: Alpha\n}", new Map([["foo", "bar"]]));
    expect(changed).toBe(true);
    expect(content).toBe("meta {\n  name: Alpha\n}\n\nvars {\n  foo: bar\n}\n");
  });

  it("updates an existing key without changing the block structure", () => {
    const raw = "meta {\n  name: X\n}\n\nvars {\n  a: 1\n}\n";
    const updates = new Map([["a", "2"]]);
    const { content, changed } = upsertVars(raw, updates);
    expect(changed).toBe(true);
    expect(content).toContain("meta {");
    const parsed = parseBruEnvFile(content);
    expect(parsed.vars.entries.get("a")).toBe("2");
  });

  it("adds a new key to the existing block", () => {
    const raw = "vars {\n  a: 1\n}\n";
    const updates = new Map([["b", "2"]]);
    const { content, changed } = upsertVars(raw, updates);
    expect(changed).toBe(true);
    const parsed = parseBruEnvFile(content);
    expect(parsed.vars.entries.get("a")).toBe("1");
    expect(parsed.vars.entries.get("b")).toBe("2");
  });

  it("preserves values containing colons", () => {
    const raw = "vars {\n  baseUrl: https://example.com\n}\n";
    const { content } = upsertVars(raw, new Map([["callbackUrl", "https://example.com:443/callback"]]));
    const parsed = parseBruEnvFile(content);
    expect(parsed.vars.entries.get("callbackUrl")).toBe("https://example.com:443/callback");
  });

  it("is idempotent when values match", () => {
    const raw = "vars {\n  a: 1\n}\n";
    const { content, changed } = upsertVars(raw, new Map([["a", "1"]]));
    expect(changed).toBe(false);
    expect(content).toBe(raw);
  });
});

describe("ensureSecretEntry", () => {
  it("creates a secrets block when none exists", () => {
    const { content, changed } = ensureSecretEntry("", "accessToken");
    expect(changed).toBe(true);
    expect(content).toContain("vars:secret [");
    expect(content).toContain("accessToken");
  });

  it("appends a new secret to an existing block", () => {
    const raw = "vars:secret [\n  other\n]\n";
    const { content, changed } = ensureSecretEntry(raw, "accessToken");
    expect(changed).toBe(true);
    expect(content).toContain("other");
    expect(content).toContain("accessToken");
  });

  it("does not treat commented secret entries as active entries", () => {
    const raw = "vars:secret [\n  // accessToken\n]\n";
    const { content, changed } = ensureSecretEntry(raw, "accessToken");
    expect(changed).toBe(true);
    expect(parseBruEnvFile(content).secrets).toEqual(["accessToken"]);
  });

  it("is idempotent when secret already present", () => {
    const raw = "vars:secret [\n  accessToken\n]\n";
    const { content, changed } = ensureSecretEntry(raw, "accessToken");
    expect(changed).toBe(false);
    expect(content).toBe(raw);
  });

  it("handles files without trailing newline", () => {
    const { content, changed } = ensureSecretEntry("meta { name: X }", "s");
    expect(changed).toBe(true);
    expect(content).toContain("vars:secret [");
  });

  it("upsertVars handles files without trailing newline and empty input", () => {
    const a = upsertVars("meta { name: X }", new Map([["k", "v"]]));
    expect(a.changed).toBe(true);
    const b = upsertVars("", new Map());
    expect(b.changed).toBe(false);
  });
});
