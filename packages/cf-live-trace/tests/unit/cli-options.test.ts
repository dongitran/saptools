import { describe, expect, it } from "vitest";

import { buildRunOptions, parsePositiveInteger } from "../../src/cli/options.js";

describe("CLI option parsing", () => {
  it("builds run options with credentials from flags before environment", () => {
    const options = buildRunOptions(
      {
        apiEndpoint: "https://api.example.com",
        org: "demo-org",
        space: "dev",
        app: "orders-api",
        email: "flag-user",
        password: "flag-password",
        instance: "2",
        maxBodyBytes: "0",
        duration: "5",
        maxEvents: "10",
        format: "ndjson",
      },
      { SAP_EMAIL: "env-user", SAP_PASSWORD: "env-password" },
    );

    expect(options.target).toEqual(
      expect.objectContaining({
        email: "flag-user",
        password: "flag-password",
        instanceIndex: 2,
      }),
    );
    expect(options.trace.maxBodyBytes).toBe(0);
    expect(options.limits).toEqual({ durationMs: 5000, maxEvents: 10 });
  });

  it("rejects invalid positive integers", () => {
    expect(() => parsePositiveInteger("0", "--duration")).toThrow("Invalid --duration");
    expect(() => parsePositiveInteger("1.5", "--duration")).toThrow("Invalid --duration");
  });

  it("requires either region or api endpoint", () => {
    expect(() =>
      buildRunOptions(
        {
          org: "demo-org",
          space: "dev",
          app: "orders-api",
          email: "user",
          password: "password",
        },
        {},
      ),
    ).toThrow("Either --region or --api-endpoint is required.");
  });

  it("uses region targets, environment credentials, and disabled capture flags", () => {
    const options = buildRunOptions(
      {
        region: "eu10",
        org: "demo-org",
        space: "dev",
        app: "orders-api",
        cfHome: "/tmp/cf-home",
        cfCommand: "/tmp/fake-cf.mjs",
        captureHeaders: false,
        captureRequestBody: false,
        captureResponseBody: false,
        uninstallOnExit: false,
        quiet: true,
        format: "summary",
      },
      { SAP_EMAIL: "env-user", SAP_PASSWORD: "env-password" },
    );

    expect(options.target).toEqual(
      expect.objectContaining({
        region: "eu10",
        email: "env-user",
        password: "env-password",
        cfHomeDir: "/tmp/cf-home",
        command: "/tmp/fake-cf.mjs",
      }),
    );
    expect(options.trace).toEqual(
      expect.objectContaining({
        captureHeaders: false,
        captureRequestBody: false,
        captureResponseBody: false,
      }),
    );
    expect(options.format).toBe("summary");
    expect(options.uninstallOnExit).toBe(false);
    expect(options.quiet).toBe(true);
  });

  it("rejects invalid format, missing credentials, and invalid body limit", () => {
    const base = {
      apiEndpoint: "https://api.example.com",
      org: "demo-org",
      space: "dev",
      app: "orders-api",
    };

    expect(() => buildRunOptions({ ...base, email: "user", password: "pass", format: "xml" }, {})).toThrow("Invalid --format");
    expect(() => buildRunOptions({ ...base, email: "user", password: "pass", maxBodyBytes: "-1" }, {})).toThrow("Invalid --max-body-bytes");
    expect(() => buildRunOptions(base, {})).toThrow("Missing required environment variable: SAP_EMAIL");
  });
});
