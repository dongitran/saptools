import { describe, expect, it } from "vitest";

import { parseAuthMode, toRequestOptionsFromCredential } from "../../src/cli-shared.js";
import type { JiraCredential } from "../../src/types.js";

describe("CLI credential plumbing", () => {
  it("defaults to auto and accepts only the documented modes", () => {
    expect(parseAuthMode(undefined)).toBe("auto");
    expect(parseAuthMode("auto")).toBe("auto");
    expect(parseAuthMode("api-token")).toBe("api-token");
    expect(parseAuthMode("oauth")).toBe("oauth");

    for (const bad of ["", "basic", "API-TOKEN", "token"]) {
      expect(() => parseAuthMode(bad)).toThrow("--auth <mode> must be auto, api-token, or oauth");
    }
  });

  it("carries the authorization header into request options and nothing else", () => {
    const credential: JiraCredential = {
      authMode: "api-token",
      authorization: "Basic secret",
      baseUrl: "https://acme.atlassian.net",
      cloudId: "acme.atlassian.net",
      cloudName: "acme.atlassian.net",
      email: "fred@example.com",
      siteUrl: "https://acme.atlassian.net",
    };

    expect(toRequestOptionsFromCredential(credential)).toEqual({
      authorization: "Basic secret",
      baseUrl: "https://acme.atlassian.net",
      cloudId: "acme.atlassian.net",
    });
  });
});
