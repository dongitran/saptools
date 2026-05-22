import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

function succeedWith(stdout: string) {
  return (_cmd: string, _args: readonly string[], _opts: unknown, cb: ExecFileCallback): void => {
    cb(null, stdout, "");
  };
}

function failWith(message: string, stderr: string) {
  return (_cmd: string, _args: readonly string[], _opts: unknown, cb: ExecFileCallback): void => {
    cb(Object.assign(new Error(message), { stderr }), "", stderr);
  };
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock("node:child_process");
});

describe("runCfCommand", () => {
  it("returns stdout on success", async () => {
    const execFileMock = vi.fn(succeedWith("hello\n"));
    vi.doMock("node:child_process", () => ({ execFile: execFileMock }));
    const { runCfCommand } = await import("../../src/cf.js");
    const out = await runCfCommand(["orgs"], { cfHomeDir: "/tmp/cf-events-test" }, "Failed.");
    expect(out).toBe("hello\n");
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("retries transient failures before succeeding", async () => {
    const execFileMock = vi
      .fn()
      .mockImplementationOnce(failWith("boom", "connection timeout"))
      .mockImplementationOnce(succeedWith("recovered"));
    vi.doMock("node:child_process", () => ({ execFile: execFileMock }));
    const { runCfCommand } = await import("../../src/cf.js");
    const out = await runCfCommand(["orgs"], { cfHomeDir: "/tmp/cf-events-test" }, "Failed.");
    expect(out).toBe("recovered");
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry authentication failures", async () => {
    const execFileMock = vi.fn(failWith("denied", "Credentials were rejected"));
    vi.doMock("node:child_process", () => ({ execFile: execFileMock }));
    const { runCfCommand } = await import("../../src/cf.js");
    await expect(
      runCfCommand(["auth"], { cfHomeDir: "/tmp/cf-events-test" }, "Auth failed."),
    ).rejects.toThrow(/Auth failed/);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });
});

describe("prepareCfCliSession", () => {
  it("runs api, auth, and target with credentials in the environment", async () => {
    const calls: { args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
    const execFileMock = vi.fn(
      (
        _cmd: string,
        args: readonly string[],
        opts: { readonly env: NodeJS.ProcessEnv },
        cb: ExecFileCallback,
      ): void => {
        calls.push({ args, env: opts.env });
        cb(null, "ok", "");
      },
    );
    vi.doMock("node:child_process", () => ({ execFile: execFileMock }));
    const { prepareCfCliSession } = await import("../../src/cf.js");
    await prepareCfCliSession(
      {
        apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
        orgName: "demo-org",
        spaceName: "dev",
        credentials: { email: "user@example.com", password: "secret" },
      },
      { cfHomeDir: "/tmp/cf-events-test" },
    );
    expect(calls).toHaveLength(3);
    expect(calls[0]?.args).toContain("api");
    expect(calls[1]?.args).toContain("auth");
    expect(calls[1]?.env["CF_USERNAME"]).toBe("user@example.com");
    expect(calls[1]?.env["CF_PASSWORD"]).toBe("secret");
    expect(calls[2]?.args).toEqual(["target", "-o", "demo-org", "-s", "dev"]);
  });
});

describe("cfAppGuid", () => {
  it("returns a trimmed GUID", async () => {
    const execFileMock = vi.fn(succeedWith("  a1b2c3d4-e5f6-7890-abcd-ef1234567890  \n"));
    vi.doMock("node:child_process", () => ({ execFile: execFileMock }));
    const { cfAppGuid } = await import("../../src/cf.js");
    expect(await cfAppGuid("orders-srv", { cfHomeDir: "/tmp/cf-events-test" })).toBe(
      "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    );
  });

  it("throws when the CLI returns an unexpected value", async () => {
    const execFileMock = vi.fn(succeedWith("FAILED: app not found"));
    vi.doMock("node:child_process", () => ({ execFile: execFileMock }));
    const { cfAppGuid } = await import("../../src/cf.js");
    await expect(cfAppGuid("ghost", { cfHomeDir: "/tmp/cf-events-test" })).rejects.toThrow(
      /Could not resolve/,
    );
  });
});

describe("cfCurl", () => {
  it("invokes cf curl with the requested path", async () => {
    let capturedArgs: readonly string[] = [];
    const execFileMock = vi.fn(
      (_cmd: string, args: readonly string[], _opts: unknown, cb: ExecFileCallback): void => {
        capturedArgs = args;
        cb(null, "{}", "");
      },
    );
    vi.doMock("node:child_process", () => ({ execFile: execFileMock }));
    const { cfCurl } = await import("../../src/cf.js");
    await cfCurl("/v3/apps/app-1", { cfHomeDir: "/tmp/cf-events-test" });
    expect(capturedArgs).toEqual(["curl", "/v3/apps/app-1"]);
  });
});

describe("withCfSession", () => {
  it("provides an ephemeral CF_HOME and removes it afterwards", async () => {
    const { withCfSession } = await import("../../src/cf.js");
    const { stat } = await import("node:fs/promises");
    let captured = "";
    const result = await withCfSession(async (ctx) => {
      captured = ctx.cfHomeDir;
      await expect(stat(ctx.cfHomeDir)).resolves.toBeDefined();
      return "done";
    });
    expect(result).toBe("done");
    await expect(stat(captured)).rejects.toThrow();
  });
});
