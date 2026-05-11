import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MockReturn = { stdout: string; stderr: string } | { error: Error & { stderr?: string } };

interface ExecOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly maxBuffer?: number;
  readonly timeout?: number;
}

let mockImpl: ((cmd: string, args: readonly string[], opts: ExecOptions) => MockReturn) | undefined;

beforeEach(() => {
  vi.resetModules();
  const execFileFn = (
    cmd: string,
    args: readonly string[],
    opts: ExecOptions,
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ): void => {
    const result = mockImpl ? mockImpl(cmd, args, opts) : { stdout: "", stderr: "" };
    if ("error" in result) {
      cb(result.error, "", result.error.stderr ?? "");
    } else {
      cb(null, result.stdout, result.stderr);
    }
  };

  (execFileFn as unknown as Record<symbol, unknown>)[promisify.custom] = (
    cmd: string,
    args: readonly string[],
    opts: ExecOptions,
  ): Promise<{ stdout: string; stderr: string }> => {
    const result = mockImpl ? mockImpl(cmd, args, opts) : { stdout: "", stderr: "" };
    if ("error" in result) {
      return Promise.reject(result.error);
    }
    return Promise.resolve({ stdout: result.stdout, stderr: result.stderr });
  };

  vi.doMock("node:child_process", () => ({ execFile: execFileFn }));
});

afterEach(() => {
  mockImpl = undefined;
  vi.doUnmock("node:child_process");
});

describe("cf CLI wrappers", () => {
  it("cfApi calls `cf api <endpoint>`", async () => {
    const seen: { cmd?: string; args?: readonly string[] } = {};
    mockImpl = (cmd, args) => {
      seen.cmd = cmd;
      seen.args = args;
      return { stdout: "", stderr: "" };
    };
    const { cfApi } = await import("../../src/cf.js");
    await cfApi("https://api.cf.ap10.hana.ondemand.com");
    expect(seen.cmd).toBe("cf");
    expect(seen.args).toEqual(["api", "https://api.cf.ap10.hana.ondemand.com"]);
  });

  it("uses a configured cf binary and merges context environment", async () => {
    const previousCfBin = process.env["CF_SYNC_CF_BIN"];
    process.env["CF_SYNC_CF_BIN"] = "/opt/tools/cf";
    const seen: {
      cmd?: string;
      env: NodeJS.ProcessEnv | undefined;
      maxBuffer: number | undefined;
    } = {
      env: undefined,
      maxBuffer: undefined,
    };
    mockImpl = (cmd, _args, opts) => {
      seen.cmd = cmd;
      seen.env = opts.env;
      seen.maxBuffer = opts.maxBuffer;
      return { stdout: "", stderr: "" };
    };

    try {
      const { cfApi } = await import("../../src/cf.js");
      await cfApi("https://api.example.test", {
        env: {
          CF_HOME: "/tmp/cf-home",
          CF_TRACE: "true",
        },
      });
    } finally {
      if (previousCfBin === undefined) {
        delete process.env["CF_SYNC_CF_BIN"];
      } else {
        process.env["CF_SYNC_CF_BIN"] = previousCfBin;
      }
    }

    expect(seen.cmd).toBe("/opt/tools/cf");
    expect(seen.env?.["CF_HOME"]).toBe("/tmp/cf-home");
    expect(seen.env?.["CF_TRACE"]).toBe("true");
    expect(seen.env?.["PATH"]).toBe(process.env["PATH"]);
    expect(seen.maxBuffer).toBe(16 * 1024 * 1024);
  });

  it("uses a default cf command timeout", async () => {
    const seen: { timeout: number | undefined } = { timeout: undefined };
    mockImpl = (_cmd, _args, opts) => {
      seen.timeout = opts.timeout;
      return { stdout: "", stderr: "" };
    };

    const { cfApi } = await import("../../src/cf.js");
    await cfApi("https://api.example.test");

    expect(seen.timeout).toBe(30_000);
  });

  it("allows callers to override the cf command timeout", async () => {
    const seen: { timeout: number | undefined } = { timeout: undefined };
    mockImpl = (_cmd, _args, opts) => {
      seen.timeout = opts.timeout;
      return { stdout: "", stderr: "" };
    };

    const { cfApi } = await import("../../src/cf.js");
    await cfApi("https://api.example.test", { timeoutMs: 120_000 });

    expect(seen.timeout).toBe(120_000);
  });

  it("cfAuth passes email and password", async () => {
    const seen: { args?: readonly string[] } = {};
    mockImpl = (_cmd, args) => {
      seen.args = args;
      return { stdout: "", stderr: "" };
    };
    const { cfAuth } = await import("../../src/cf.js");
    await cfAuth("e@x.com", "pw");
    expect(seen.args).toEqual(["auth", "e@x.com", "pw"]);
  });

  it("cfOrgs parses name table", async () => {
    mockImpl = () => ({ stdout: "name\norg-a\norg-b\n", stderr: "" });
    const { cfOrgs } = await import("../../src/cf.js");
    expect(await cfOrgs()).toEqual(["org-a", "org-b"]);
  });

  it("cfTargetOrg uses -o flag", async () => {
    const seen: { args?: readonly string[] } = {};
    mockImpl = (_cmd, args) => {
      seen.args = args;
      return { stdout: "", stderr: "" };
    };
    const { cfTargetOrg } = await import("../../src/cf.js");
    await cfTargetOrg("my-org");
    expect(seen.args).toEqual(["target", "-o", "my-org"]);
  });

  it("cfTargetSpace uses -o and -s flags", async () => {
    const seen: { args?: readonly string[] } = {};
    mockImpl = (_cmd, args) => {
      seen.args = args;
      return { stdout: "", stderr: "" };
    };
    const { cfTargetSpace } = await import("../../src/cf.js");
    await cfTargetSpace("o", "s");
    expect(seen.args).toEqual(["target", "-o", "o", "-s", "s"]);
  });

  it("cfSpaces parses names", async () => {
    mockImpl = () => ({ stdout: "name\ndev\nstaging\n", stderr: "" });
    const { cfSpaces } = await import("../../src/cf.js");
    expect(await cfSpaces()).toEqual(["dev", "staging"]);
  });

  it("cfApps parses app names from header row", async () => {
    mockImpl = () => ({
      stdout: "name  requested state\napp1  started\napp2  stopped\n",
      stderr: "",
    });
    const { cfApps } = await import("../../src/cf.js");
    expect(await cfApps()).toEqual(["app1", "app2"]);
  });

  it("cfAppDetails parses app runtime metadata from header row", async () => {
    mockImpl = () => ({
      stdout: [
        "name  requested state  processes  routes",
        "sample-api  started  web:1/1  sample-api.cfapps.example.com",
        "sample-job  started  web:0/1  ",
      ].join("\n"),
      stderr: "",
    });
    const { cfAppDetails } = await import("../../src/cf.js");
    expect(await cfAppDetails()).toEqual([
      {
        name: "sample-api",
        requestedState: "started",
        runningInstances: 1,
        totalInstances: 1,
        routes: ["sample-api.cfapps.example.com"],
      },
      {
        name: "sample-job",
        requestedState: "started",
        runningInstances: 0,
        totalInstances: 1,
        routes: [],
      },
    ]);
  });

  it("cfEnv returns raw stdout", async () => {
    mockImpl = () => ({ stdout: "VCAP_SERVICES: {}", stderr: "" });
    const { cfEnv } = await import("../../src/cf.js");
    expect(await cfEnv("my-app")).toContain("VCAP_SERVICES");
  });

  it("cfCurl returns raw stdout", async () => {
    mockImpl = () => ({ stdout: '{"guid":"x"}', stderr: "" });
    const { cfCurl } = await import("../../src/cf.js");
    expect(await cfCurl("/v3/apps")).toContain("guid");
  });

  it("throws with stderr on error", async () => {
    mockImpl = () => {
      const err = new Error("boom") as Error & { stderr?: string };
      err.stderr = "cf cli said no";
      return { error: err };
    };
    const { cfApi } = await import("../../src/cf.js");
    await expect(cfApi("https://x")).rejects.toThrow(/cf api/);
  });

  it("redacts credentials from cfAuth failures", async () => {
    mockImpl = () => {
      const err = new Error("boom") as Error & { stderr?: string };
      err.stderr = 'FAILED\n{"error":"invalid_grant","error_description":"User authentication failed."}';
      return { error: err };
    };
    const { cfAuth } = await import("../../src/cf.js");

    await expect(cfAuth("user@example.com", "super-secret-password")).rejects.toThrow(/cf auth failed/);
    await expect(cfAuth("user@example.com", "super-secret-password")).rejects.not.toThrow(/user@example.com/);
    await expect(cfAuth("user@example.com", "super-secret-password")).rejects.not.toThrow(
      /super-secret-password/,
    );
  });
});
