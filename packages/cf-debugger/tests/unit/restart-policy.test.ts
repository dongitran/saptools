import { describe, expect, it } from "vitest";

import {
  applyRestartEnvironmentVeto,
  parseRestartEnvironment,
} from "../../src/restart-policy.js";

describe("restart environment policy", () => {
  it("treats zero as a hard veto without allowing one to grant permission", () => {
    expect(applyRestartEnvironmentVeto(true, "0")).toBe(false);
    expect(applyRestartEnvironmentVeto(false, "1")).toBe(false);
    expect(applyRestartEnvironmentVeto(undefined, "1")).toBe(false);
    expect(applyRestartEnvironmentVeto(true, "1")).toBe(true);
  });

  it("rejects ambiguous environment values", () => {
    expect(parseRestartEnvironment(undefined)).toBe("unset");
    expect(parseRestartEnvironment("0")).toBe("forbid");
    expect(parseRestartEnvironment("1")).toBe("allow");
    expect(() => parseRestartEnvironment("true")).toThrow(
      expect.objectContaining({ code: "UNSAFE_INPUT" }),
    );
  });
});
