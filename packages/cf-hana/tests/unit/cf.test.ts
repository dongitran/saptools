import { execFile } from "node:child_process";

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { cfEnvDirect, readCurrentCfTarget, cfAuth, withCfSession } from "../../src/cf.js";

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
