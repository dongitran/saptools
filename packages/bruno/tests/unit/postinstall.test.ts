import { describe, expect, it } from "vitest";

import { buildInstallHint, shouldPrintInstallHint } from "../../src/postinstall.js";

describe("postinstall", () => {
  it("builds a hint that points to saptools-bruno sync", () => {
    expect(buildInstallHint()).toContain("saptools-bruno sync");
  });

  it("stays quiet in CI", () => {
    expect(shouldPrintInstallHint({ CI: "true" })).toBe(false);
  });

  it("stays quiet when npm loglevel is silent", () => {
    expect(shouldPrintInstallHint({ npm_config_loglevel: "silent" })).toBe(false);
  });
});
