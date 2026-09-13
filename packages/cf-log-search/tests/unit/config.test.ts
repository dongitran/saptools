import { afterEach, describe, expect, it } from "vitest";

import { credentialCacheEnabled, envName, readEnv, readSapCredentials } from "../../src/config.js";

describe("envName", () => {
  it("prefixes with CF_LOG_SEARCH", () => {
    expect(envName("HTTP_TIMEOUT_MS")).toBe("CF_LOG_SEARCH_HTTP_TIMEOUT_MS");
  });
});

describe("readEnv", () => {
  afterEach(() => {
    delete process.env["CF_LOG_SEARCH_TEST_VAR"];
  });
  it("treats a blank value as absent", () => {
    process.env["CF_LOG_SEARCH_TEST_VAR"] = "   ";
    expect(readEnv("CF_LOG_SEARCH_TEST_VAR")).toBeUndefined();
  });
  it("trims and returns a real value", () => {
    process.env["CF_LOG_SEARCH_TEST_VAR"] = " value ";
    expect(readEnv("CF_LOG_SEARCH_TEST_VAR")).toBe("value");
  });
});

describe("credentialCacheEnabled", () => {
  afterEach(() => {
    delete process.env["CF_LOG_SEARCH_CREDENTIAL_CACHE"];
  });
  it("defaults to enabled", () => {
    expect(credentialCacheEnabled()).toBe(true);
  });
  it("is disabled by 0/false/off/no", () => {
    for (const value of ["0", "false", "off", "no"]) {
      process.env["CF_LOG_SEARCH_CREDENTIAL_CACHE"] = value;
      expect(credentialCacheEnabled()).toBe(false);
    }
  });
});

describe("readSapCredentials", () => {
  afterEach(() => {
    delete process.env["SAP_EMAIL"];
    delete process.env["SAP_PASSWORD"];
  });
  it("returns undefined when either half is missing", () => {
    process.env["SAP_EMAIL"] = "e@x.com";
    delete process.env["SAP_PASSWORD"];
    expect(readSapCredentials()).toBeUndefined();
  });
  it("prefers explicit overrides over environment variables", () => {
    process.env["SAP_EMAIL"] = "env@x.com";
    process.env["SAP_PASSWORD"] = "env-pw";
    expect(readSapCredentials({ email: "override@x.com", password: "override-pw" })).toEqual({ email: "override@x.com", password: "override-pw" });
  });
});
