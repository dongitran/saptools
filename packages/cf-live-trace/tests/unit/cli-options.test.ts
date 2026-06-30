import { randomUUID } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildRunOptions,
  buildRunOptionsWithCurrentTarget,
  parsePositiveInteger,
} from "../../src/cli/options.js";

async function withFakeCfTarget(
  outputLines: readonly string[],
  run: (fakeCf: string) => Promise<void>,
): Promise<void> {
  const root = join(tmpdir(), `cf-live-trace-options-${randomUUID()}`);
  const fakeCf = join(root, "fake-cf.mjs");
  await mkdir(root, { recursive: true });
  await writeFile(fakeCf, [
    "#!/usr/bin/env node",
    "if (process.argv[2] !== 'target') process.exit(1);",
    ...outputLines.map((line) => `process.stdout.write(${JSON.stringify(`${line}\n`)});`),
  ].join("\n"), "utf8");
  await chmod(fakeCf, 0o755);

  try {
    await run(fakeCf);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

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
        maxBodyBytes: "8192",
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
    expect(options.trace.maxBodyBytes).toBe(8192);
    expect(options.limits).toEqual({ durationMs: 5000, maxEvents: 10 });
  });

  it("rejects invalid positive integers", () => {
    expect(() => parsePositiveInteger("0", "--duration")).toThrow("Invalid --duration");
    expect(() => parsePositiveInteger("1.5", "--duration")).toThrow("Invalid --duration");
    expect(() => parsePositiveInteger("9007199254740992", "--duration")).toThrow("Invalid --duration");
    expect(() => buildRunOptions({
      apiEndpoint: "https://api.example.com",
      org: "demo-org",
      space: "dev",
      app: "orders-api",
      email: "user",
      password: "password",
      duration: "2147484",
    }, {})).toThrow("--duration is too large");
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

  it("uses the current CF target when target flags are omitted", async () => {
    await withFakeCfTarget([
      "API endpoint:   https://api.cf.ap10.hana.ondemand.com",
      "org:            demo-org",
      "space:          dev",
    ], async (fakeCf) => {
      const options = await buildRunOptionsWithCurrentTarget(
        {
          app: "orders-api",
          email: "user",
          password: "password",
          cfCommand: fakeCf,
        },
        {},
      );

      expect(options.target).toMatchObject({
        region: "ap10",
        org: "demo-org",
        space: "dev",
        app: "orders-api",
      });
    });
  });

  it("uses the current CF API endpoint when it is not a known region", async () => {
    await withFakeCfTarget([
      "API endpoint:   https://api.example.com",
      "org:            demo-org",
      "space:          dev",
    ], async (fakeCf) => {
      const options = await buildRunOptionsWithCurrentTarget(
        {
          app: "orders-api",
          email: "user",
          password: "password",
          cfCommand: fakeCf,
        },
        {},
      );

      expect(options.target).toMatchObject({
        apiEndpoint: "https://api.example.com",
        org: "demo-org",
        space: "dev",
      });
      expect(options.target).not.toHaveProperty("region");
    });
  });

  it("keeps an explicit API endpoint while filling current org and space", async () => {
    await withFakeCfTarget([
      "API endpoint:   https://api.cf.ap10.hana.ondemand.com",
      "org:            demo-org",
      "space:          dev",
    ], async (fakeCf) => {
      const options = await buildRunOptionsWithCurrentTarget(
        {
          apiEndpoint: "https://api.flag.example",
          app: "orders-api",
          email: "user",
          password: "password",
          cfCommand: fakeCf,
        },
        {},
      );

      expect(options.target).toMatchObject({
        apiEndpoint: "https://api.flag.example",
        org: "demo-org",
        space: "dev",
      });
    });
  });

  it("rejects omitted target flags when cf target is incomplete", async () => {
    await withFakeCfTarget([
      "API endpoint:   https://api.cf.ap10.hana.ondemand.com",
    ], async (fakeCf) => {
      await expect(buildRunOptionsWithCurrentTarget(
        {
          app: "orders-api",
          email: "user",
          password: "password",
          cfCommand: fakeCf,
        },
        {},
      )).rejects.toThrow("No current CF target found");
    });
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
    expect(() => buildRunOptions({ ...base, email: "user", password: "pass", maxBodyBytes: "0" }, {})).toThrow("Invalid --max-body-bytes");
    expect(() => buildRunOptions({ ...base, app: "", email: "user", password: "pass" }, {})).toThrow("--app is required");
    expect(() => buildRunOptions(base, {})).toThrow("Missing required environment variable: SAP_EMAIL");
  });
});
