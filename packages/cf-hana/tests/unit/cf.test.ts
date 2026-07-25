import { execFile } from "node:child_process";

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import {
  cfAppsDirect,
  cfAuth,
  cfEnvDirect,
  extractCfEnvApplicationIdentity,
  parseCfAppsOutput,
  readCurrentCfTarget,
  resolveCfBin,
  withCfSession,
} from "../../src/cf.js";

vi.mock("node:child_process", () => {
  return {
    execFile: vi.fn(),
  };
});

// Avoid actually removing things during tests when withCfSession is called
vi.mock("node:fs/promises", () => {
  return {
    rm: vi.fn(),
    mkdtemp: vi.fn().mockResolvedValue("/tmp/fake-cf-home"),
  };
});

describe("CF CLI retries for network resilience", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries on network timeout and succeeds", async () => {
    const execFileMock = vi.mocked(execFile);
    let attempts = 0;
    execFileMock.mockImplementation(((file: string, args: string[], options: unknown, cb: (error: Error | null, result?: { stdout: string; stderr: string }) => void) => {
      attempts++;
      if (attempts < 3) {
        const err = new Error("Timeout") as Error & { killed?: boolean };
        err.killed = true; // Simulate SIGKILL/timeout
        cb(err);
      } else {
        cb(null, { stdout: "VCAP_SERVICES: {}", stderr: "" });
      }
      return {} as unknown;
    }) as unknown as typeof execFile);

    const promise = cfEnvDirect("my-app");
    
    // Fast-forward all retry delays
    await vi.runAllTimersAsync();
    const result = await promise;
    
    expect(attempts).toBe(3);
    expect(result).toBe("VCAP_SERVICES: {}");
    
    // Verify timeout options
    expect(execFileMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ timeout: 60000, killSignal: "SIGKILL" }),
      expect.any(Function)
    );
  });

  it("retries readCurrentCfTarget on network flakes (e.g. 502 bad gateway) and succeeds", async () => {
    const execFileMock = vi.mocked(execFile);
    let attempts = 0;
    execFileMock.mockImplementation(((file: string, args: string[], options: unknown, cb: (error: Error | null, result?: { stdout: string; stderr: string }) => void) => {
      attempts++;
      if (attempts < 3) {
        const err = new Error("Request failed") as Error & { stderr?: string };
        err.stderr = "502 Bad Gateway";
        cb(err);
      } else {
        const stdout = `API endpoint:   https://api.cf.eu10-005.hana.ondemand.com\norg:            example-org\nspace:          space-demo`;
        cb(null, { stdout, stderr: "" });
      }
      return {} as unknown;
    }) as unknown as typeof execFile);

    const promise = readCurrentCfTarget();
    
    await vi.runAllTimersAsync();
    const result = await promise;
    
    expect(attempts).toBe(3);
    expect(result).toEqual({
      apiEndpoint: "https://api.cf.eu10-005.hana.ondemand.com",
      orgName: "example-org",
      spaceName: "space-demo",
      regionKey: "eu10-005",
    });
  });

  it("fails fast without retrying on user errors", async () => {
    const execFileMock = vi.mocked(execFile);
    execFileMock.mockImplementation(((file: string, args: string[], options: unknown, cb: (error: Error | null, result?: { stdout: string; stderr: string }) => void) => {
      const err = new Error("Command failed") as Error & { stderr?: string };
      err.stderr = "App not found";
      cb(err);
      return {} as unknown;
    }) as unknown as typeof execFile);

    const promise = cfEnvDirect("my-app").catch((e: unknown) => e);
    
    await vi.runAllTimersAsync();
    const err = await promise;
    
    expect(err).toBeInstanceOf(Error);
    expect(execFileMock).toHaveBeenCalledTimes(1); // No retries!
  });

  it("fails fast without retrying on ENOENT (binary missing)", async () => {
    const execFileMock = vi.mocked(execFile);
    execFileMock.mockImplementation(((file: string, args: string[], options: unknown, cb: (error: Error | null, result?: { stdout: string; stderr: string }) => void) => {
      const err = new Error("spawn cf ENOENT") as Error & { code?: string };
      err.code = "ENOENT";
      cb(err);
      return {} as unknown;
    }) as unknown as typeof execFile);

    const promise = cfEnvDirect("my-app").catch((e: unknown) => e);
    
    await vi.runAllTimersAsync();
    const err = await promise;
    
    expect(err).toBeInstanceOf(Error);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("fails if it exhausts all retry attempts for a network flake", async () => {
    const execFileMock = vi.mocked(execFile);
    execFileMock.mockImplementation(((file: string, args: string[], options: unknown, cb: (error: Error | null, result?: { stdout: string; stderr: string }) => void) => {
      const err = new Error("Connection reset") as Error & { stderr?: string };
      err.stderr = "connection reset";
      cb(err);
      return {} as unknown;
    }) as unknown as typeof execFile);

    const promise = cfEnvDirect("my-app").catch((e: unknown) => e);
    
    await vi.runAllTimersAsync();
    const err = await promise;
    
    expect(err).toBeDefined();
    if (err instanceof Error) {
      expect(err.message).toBe("Connection reset");
    }
    expect(execFileMock).toHaveBeenCalledTimes(3); // CF_RETRY_ATTEMPTS is 3
  });

  it("retries cfAppsDirect on network timeout and succeeds", async () => {
    const execFileMock = vi.mocked(execFile);
    let attempts = 0;
    execFileMock.mockImplementation(((file: string, args: string[], options: unknown, cb: (error: Error | null, result?: { stdout: string; stderr: string }) => void) => {
      attempts++;
      if (attempts < 3) {
        const err = new Error("Timeout") as Error & { killed?: boolean };
        err.killed = true;
        cb(err);
      } else {
        cb(null, { stdout: "name   requested state\napp-a   started", stderr: "" });
      }
      return {} as unknown;
    }) as unknown as typeof execFile);

    const promise = cfAppsDirect();
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(attempts).toBe(3);
    expect(result).toContain("app-a");
    expect(execFileMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining(["apps"]),
      expect.objectContaining({ timeout: 60000, killSignal: "SIGKILL" }),
      expect.any(Function),
    );
  });

  it("formats error messages and redacts passwords for cf auth", async () => {
    const execFileMock = vi.mocked(execFile);
    execFileMock.mockImplementation(((file: string, args: string[], options: unknown, cb: (error: Error | null, result?: { stdout: string; stderr: string }) => void) => {
      const err = new Error("Auth failed") as Error & { stderr?: string };
      err.stderr = "Invalid username or password";
      cb(err);
      return {} as unknown;
    }) as unknown as typeof execFile);

    const promise = withCfSession(ctx => cfAuth("admin", "secret-password", ctx)).catch((e: unknown) => e);
    
    await vi.runAllTimersAsync();
    const err = await promise;
    
    expect(err).toBeInstanceOf(Error);
    if (err instanceof Error) {
      expect(err.message).toBe("cf auth failed: Invalid username or password");
      expect(err.message).not.toContain("secret-password");
    }
  });
});

describe("extractCfEnvApplicationIdentity", () => {
  it("parses the application identity from cf env output", () => {
    const stdout = `VCAP_SERVICES: {}
VCAP_APPLICATION: {
  "application_name": "app-demo",
  "cf_api": "https://api.cf.eu10-005.hana.ondemand.com/",
  "organization_name": "example-org",
  "space_name": "space-demo"
}
User-Provided:
(empty)`;

    expect(extractCfEnvApplicationIdentity(stdout)).toEqual({
      appName: "app-demo",
      apiEndpoint: "https://api.cf.eu10-005.hana.ondemand.com",
      orgName: "example-org",
      spaceName: "space-demo",
    });
  });

  it.each([
    "application_name",
    "cf_api",
    "organization_name",
    "space_name",
  ])("rejects a missing %s identity field", (missingField) => {
    const identity = Object.fromEntries(
      Object.entries({
        application_name: "app-demo",
        cf_api: "https://api.cf.eu10-005.hana.ondemand.com",
        organization_name: "example-org",
        space_name: "space-demo",
      }).filter(([field]) => field !== missingField),
    );
    const stdout = `VCAP_SERVICES: {}\nVCAP_APPLICATION: ${JSON.stringify(identity)}`;

    expect(() => extractCfEnvApplicationIdentity(stdout)).toThrow(missingField);
  });

  it("rejects malformed VCAP_APPLICATION JSON", () => {
    expect(() =>
      extractCfEnvApplicationIdentity(
        "VCAP_SERVICES: {}\nVCAP_APPLICATION: {\"application_name\":\"app-demo\"",
      ),
    ).toThrow(/Malformed VCAP_APPLICATION JSON/);
  });
});

describe("resolveCfBin", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to the plain cf binary with no argument prefix", () => {
    vi.stubEnv("CF_HANA_CF_BIN", undefined);
    expect(resolveCfBin()).toEqual({ bin: "cf", argsPrefix: [] });
  });

  it("uses the current Node executable to run a .js/.mjs cf shim, with the shim as the first argument", () => {
    vi.stubEnv("CF_HANA_CF_BIN", "/path/to/fake-cf.mjs");
    expect(resolveCfBin()).toEqual({
      bin: process.execPath,
      argsPrefix: ["/path/to/fake-cf.mjs"],
    });
  });

  it("uses a custom non-JS binary path directly", () => {
    vi.stubEnv("CF_HANA_CF_BIN", "/usr/local/bin/cf8");
    expect(resolveCfBin()).toEqual({ bin: "/usr/local/bin/cf8", argsPrefix: [] });
  });
});

describe("parseCfAppsOutput", () => {
  it("parses name and requested state from a realistic cf apps table", () => {
    const stdout = `Getting apps in org my-org / space my-space as user@example.com...

name          requested state   processes           routes
app-a         started            web:1/1             app-a.cf.example.com
app-b         stopped            web:0/1             app-b.cf.example.com
`;
    expect(parseCfAppsOutput(stdout)).toEqual([
      { name: "app-a", state: "started" },
      { name: "app-b", state: "stopped" },
    ]);
  });

  it("tolerates a trailing blank line and extra whitespace", () => {
    const stdout = "name    requested state\n\n  app-a    started  \n\n";
    expect(parseCfAppsOutput(stdout)).toEqual([{ name: "app-a", state: "started" }]);
  });

  it("returns an empty list when no recognizable header is present", () => {
    expect(parseCfAppsOutput("No apps found\n")).toEqual([]);
  });
});
