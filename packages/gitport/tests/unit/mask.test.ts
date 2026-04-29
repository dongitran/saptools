import { describe, expect, it } from "vitest";

import { maskSensitiveText, maskTokenInUrl } from "../../src/mask.js";

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
});
