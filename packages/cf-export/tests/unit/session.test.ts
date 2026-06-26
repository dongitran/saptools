import { describe, expect, it } from "vitest";

import { resolveSessionEnv } from "../../src/session.js";

describe("resolveSessionEnv", () => {
  it("reads from provided env", () => {
    const env = resolveSessionEnv({ SAP_EMAIL: "a@b.com", SAP_PASSWORD: "s3cr3t" });
    expect(env).toEqual({ email: "a@b.com", password: "s3cr3t" });
  });

  it("throws when missing", () => {
    expect(() => resolveSessionEnv({})).toThrow("SAP_EMAIL must be set");
  });
});
