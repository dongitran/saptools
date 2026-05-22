import { afterEach, describe, expect, it, vi } from "vitest";

import { envName, readEnv, readSapCredentials } from "../../src/config.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("config", () => {
  it("builds CF_HANA-prefixed environment variable names", () => {
    expect(envName("DRIVER")).toBe("CF_HANA_DRIVER");
  });

  it("reads a defined environment variable", () => {
    vi.stubEnv("CF_HANA_TEST_VALUE", "hello");
    expect(readEnv("CF_HANA_TEST_VALUE")).toBe("hello");
  });

  it("trims surrounding whitespace and treats blank values as absent", () => {
    vi.stubEnv("CF_HANA_TEST_PADDED", "  spaced  ");
    vi.stubEnv("CF_HANA_TEST_BLANK", "   ");
    expect(readEnv("CF_HANA_TEST_PADDED")).toBe("spaced");
    expect(readEnv("CF_HANA_TEST_BLANK")).toBeUndefined();
  });

  it("returns undefined for an unset environment variable", () => {
    expect(readEnv("CF_HANA_DEFINITELY_UNSET_VARIABLE")).toBeUndefined();
  });

  it("reads SAP credentials from the environment", () => {
    vi.stubEnv("SAP_EMAIL", "user@example.com");
    vi.stubEnv("SAP_PASSWORD", "secret");
    expect(readSapCredentials()).toEqual({
      email: "user@example.com",
      password: "secret",
    });
  });

  it("prefers explicit credential overrides", () => {
    vi.stubEnv("SAP_EMAIL", "env@example.com");
    vi.stubEnv("SAP_PASSWORD", "env-secret");
    expect(
      readSapCredentials({ email: "override@example.com", password: "override-secret" }),
    ).toEqual({ email: "override@example.com", password: "override-secret" });
  });

  it("returns undefined when credentials are incomplete", () => {
    vi.stubEnv("SAP_EMAIL", "user@example.com");
    expect(readSapCredentials()).toBeUndefined();
  });
});
