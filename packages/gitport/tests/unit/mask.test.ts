import { performance } from "node:perf_hooks";

import { describe, expect, it } from "vitest";

import { maskGitRemotes, maskSensitiveText, maskTokenInUrl } from "../../src/mask.js";

describe("maskSensitiveText", () => {
  it("redacts explicit token values from text", () => {
    const masked = maskSensitiveText("failed with token abc123 in URL abc123", ["abc123"]);
    expect(masked).toBe("failed with token [REDACTED] in URL [REDACTED]");
  });

  it("ignores empty secrets", () => {
    expect(maskSensitiveText("safe", [""])).toBe("safe");
  });
});

describe("maskTokenInUrl", () => {
  it("redacts HTTPS credentials embedded in a remote URL", () => {
    expect(maskTokenInUrl("https://oauth2:abc123@gitlab.example.com/repo-a.git")).toBe(
      "https://oauth2:[REDACTED]@gitlab.example.com/repo-a.git",
    );
  });

  it("leaves non-URL values unchanged", () => {
    expect(maskTokenInUrl("/tmp/repo-a.git")).toBe("/tmp/repo-a.git");
  });

  it("leaves malformed credential URLs unchanged", () => {
    for (const value of [
      "https://host/path:user@example.test",
      "https://host/path",
      "https://user:@example.test",
      "https://user:secret",
    ]) {
      expect(maskTokenInUrl(value)).toBe(value);
    }
  });
});

describe("maskGitRemotes", () => {
  it("redacts every credential-bearing remote URL", () => {
    expect(maskGitRemotes([
      "origin https://oauth2:first@example.test/repo.git",
      "backup http://user:second@example.test/repo.git",
    ].join("\n"))).toBe([
      "origin https://oauth2:[REDACTED]@example.test/repo.git",
      "backup http://user:[REDACTED]@example.test/repo.git",
    ].join("\n"));
    expect(maskGitRemotes("https://user:a/b:c@example.test/repo.git")).toBe(
      "https://user:[REDACTED]@example.test/repo.git",
    );
  });

  it("handles malformed remote-like text within a bounded time", () => {
    const input = "http://!:!".repeat(10_000);
    const startedAt = performance.now();

    expect(maskGitRemotes(input)).toBe(input);
    expect(performance.now() - startedAt).toBeLessThan(250);
  });
});
