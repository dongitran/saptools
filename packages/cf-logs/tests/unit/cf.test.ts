import type { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.fn();
const spawnMock = vi.fn();

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
  spawn: spawnMock,
}));

describe("cf transport", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    spawnMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("resolveApiEndpoint prefers explicit api endpoint and otherwise uses region mapping", async () => {
    const { resolveApiEndpoint } = await import("../../src/cf.js");

    expect(
      resolveApiEndpoint({
        apiEndpoint: "https://custom.example.com",
        region: "ap10",
      }),
    ).toBe("https://custom.example.com");

    expect(resolveApiEndpoint({ region: "ap10" })).toBe(
      "https://api.cf.ap10.hana.ondemand.com",
    );
  });

  it("resolveApiEndpoint throws for an unknown region", async () => {
    const { resolveApiEndpoint } = await import("../../src/cf.js");

    expect(() => resolveApiEndpoint({ region: "xx99" })).toThrow("Unknown CF region: xx99");
  });

  it("parseCfAppsOutput keeps only running counts from CF CLI output", async () => {
    const { parseCfAppsOutput } = await import("../../src/cf.js");

    const rows = parseCfAppsOutput(
      [
        "name  requested state  processes  routes",
        "demo-api  started  web:2/2, worker:0/1  demo.example.com",
        "demo-worker  stopped  web:0/1  -",
      ].join("\n"),
    );

    expect(rows).toEqual([
      { name: "demo-api", requestedState: "started", runningInstances: 2 },
      { name: "demo-worker", requestedState: "stopped", runningInstances: 0 },
    ]);
  });

  it("fetchRecentLogs runs cf api/auth/target/logs in sequence", async () => {
    execFileMock.mockImplementation(
      (
        _command: string,
        _args: readonly string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        callback(null, "", "");
      },
    );
    execFileMock
      .mockImplementationOnce(
        (
          _command: string,
          _args: readonly string[],
          _options: unknown,
          callback: (error: Error | null, stdout: string, stderr: string) => void,
        ) => {
          callback(null, "", "");
        },
      )
      .mockImplementationOnce(
        (
          _command: string,
          _args: readonly string[],
          _options: unknown,
          callback: (error: Error | null, stdout: string, stderr: string) => void,
        ) => {
          callback(null, "", "");
        },
      )
      .mockImplementationOnce(
        (
          _command: string,
          _args: readonly string[],
          _options: unknown,
          callback: (error: Error | null, stdout: string, stderr: string) => void,
        ) => {
          callback(null, "", "");
        },
      )
      .mockImplementationOnce(
        (
          _command: string,
          _args: readonly string[],
          _options: unknown,
          callback: (error: Error | null, stdout: string, stderr: string) => void,
        ) => {
          callback(null, "sample-log-output", "");
        },
      );

    const { fetchRecentLogs } = await import("../../src/cf.js");
    const result = await fetchRecentLogs({
      region: "ap10",
      email: "sample@example.com",
      password: "sample-password",
      org: "sample-org",
      space: "sample",
      app: "demo-app",
      cfHomeDir: "/tmp/demo-cf-home",
      command: "sample-cf",
    });

    expect(result).toBe("sample-log-output");
    expect(execFileMock).toHaveBeenCalledTimes(4);
    expect(execFileMock).toHaveBeenNthCalledWith(
      4,
      "sample-cf",
      ["logs", "demo-app", "--recent"],
      expect.objectContaining({
        env: expect.objectContaining({ CF_HOME: "/tmp/demo-cf-home" }),
      }),
      expect.any(Function),
    );
  });

  it("fetchRecentLogs returns a safe message when cf logs fails", async () => {
    execFileMock
      .mockImplementationOnce(
        (
          _command: string,
          _args: readonly string[],
          _options: unknown,
          callback: (error: Error | null, stdout: string, stderr: string) => void,
        ) => {
          callback(null, "", "");
        },
      )
      .mockImplementationOnce(
        (
          _command: string,
          _args: readonly string[],
          _options: unknown,
          callback: (error: Error | null, stdout: string, stderr: string) => void,
        ) => {
          callback(null, "", "");
        },
      )
      .mockImplementationOnce(
        (
          _command: string,
          _args: readonly string[],
          _options: unknown,
          callback: (error: Error | null, stdout: string, stderr: string) => void,
        ) => {
          callback(null, "", "");
        },
      )
      .mockImplementationOnce(
        (
          _command: string,
          _args: readonly string[],
          _options: unknown,
          callback: (error: Error | null, stdout: string, stderr: string) => void,
        ) => {
          callback(new Error("sample failure"), "", "App not found");
        },
      );

    const { fetchRecentLogs } = await import("../../src/cf.js");

    await expect(
      fetchRecentLogs({
        region: "ap10",
        email: "sample@example.com",
        password: "sample-password",
        org: "sample-org",
        space: "sample",
        app: "missing-app",
      }),
    ).rejects.toThrow('Failed to fetch recent logs for app "missing-app".');
  });

  it("spawnLogStreamFromTarget uses the configured binary and CF_HOME", async () => {
    const fakeProcess = {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
    } as unknown as EventEmitter;
    spawnMock.mockReturnValue(fakeProcess);

    const { spawnLogStreamFromTarget } = await import("../../src/cf.js");
    const handle = spawnLogStreamFromTarget({
      appName: "demo-app",
      cfHomeDir: "/tmp/demo-cf-home",
      command: "sample-cf",
    });

    expect(handle).toBeDefined();
    expect(spawnMock).toHaveBeenCalledWith(
      "sample-cf",
      ["logs", "demo-app"],
      expect.objectContaining({
        env: expect.objectContaining({ CF_HOME: "/tmp/demo-cf-home" }),
      }),
    );
  });

  it("runCfCommand retries on transient ECONNRESET and returns on recovery", async () => {
    execFileMock
      .mockImplementationOnce(
        (
          _command: string,
          _args: readonly string[],
          _options: unknown,
          callback: (error: Error | null, stdout: string, stderr: string) => void,
        ) => {
          const error = Object.assign(new Error("read ECONNRESET"), { stderr: "read ECONNRESET" });
          callback(error, "", "read ECONNRESET");
        },
      )
      .mockImplementationOnce(
        (
          _command: string,
          _args: readonly string[],
          _options: unknown,
          callback: (error: Error | null, stdout: string, stderr: string) => void,
        ) => {
          callback(null, "recovered-output", "");
        },
      );

    const { fetchRecentLogsFromTarget } = await import("../../src/cf.js");
    const result = await fetchRecentLogsFromTarget({ appName: "demo-app" });

    expect(result).toBe("recovered-output");
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it("runCfCommand does not retry on auth-style failures", async () => {
    execFileMock.mockImplementation(
      (
        _command: string,
        _args: readonly string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        const error = Object.assign(new Error("auth"), { stderr: "Credentials were rejected, please try again." });
        callback(error, "", "Credentials were rejected, please try again.");
      },
    );

    const { fetchRecentLogsFromTarget } = await import("../../src/cf.js");

    await expect(fetchRecentLogsFromTarget({ appName: "demo-app" })).rejects.toThrow(
      /Failed to fetch recent logs for app "demo-app"\./,
    );
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("fetchStartedAppsViaCfCli filters only started apps with running instances", async () => {
    execFileMock
      .mockImplementationOnce(
        (
          _command: string,
          _args: readonly string[],
          _options: unknown,
          callback: (error: Error | null, stdout: string, stderr: string) => void,
        ) => {
          callback(null, "", "");
        },
      )
      .mockImplementationOnce(
        (
          _command: string,
          _args: readonly string[],
          _options: unknown,
          callback: (error: Error | null, stdout: string, stderr: string) => void,
        ) => {
          callback(null, "", "");
        },
      )
      .mockImplementationOnce(
        (
          _command: string,
          _args: readonly string[],
          _options: unknown,
          callback: (error: Error | null, stdout: string, stderr: string) => void,
        ) => {
          callback(null, "", "");
        },
      )
      .mockImplementationOnce(
        (
          _command: string,
          _args: readonly string[],
          _options: unknown,
          callback: (error: Error | null, stdout: string, stderr: string) => void,
        ) => {
          callback(
            null,
            [
              "name  requested state  processes  routes",
              "demo-api  started  web:2/2  demo.example.com",
              "demo-worker  started  web:0/1  -",
              "demo-idle  stopped  web:1/1  -",
            ].join("\n"),
            "",
          );
        },
      );

    const { fetchStartedAppsViaCfCli } = await import("../../src/cf.js");
    const apps = await fetchStartedAppsViaCfCli({
      region: "ap10",
      email: "sample@example.com",
      password: "sample-password",
      org: "sample-org",
      space: "sample",
    });

    expect(apps).toEqual([{ name: "demo-api", runningInstances: 2 }]);
  });
});
