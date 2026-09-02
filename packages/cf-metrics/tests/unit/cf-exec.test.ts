import { afterEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ execFile: execFileMock }));

function ok(stdout: string): void {
  execFileMock.mockImplementationOnce((_bin: string, _args: string[], _opts: unknown, cb: (err: unknown, res: { stdout: string; stderr: string }) => void) => {
    cb(undefined, { stdout, stderr: "" });
  });
}

function fail(err: { message: string; stderr?: string; killed?: boolean; code?: string | number }): void {
  execFileMock.mockImplementationOnce((_bin: string, _args: string[], _opts: unknown, cb: (err: unknown) => void) => {
    cb(err);
  });
}

afterEach(() => {
  execFileMock.mockReset();
  vi.unstubAllEnvs();
});

describe("cf.ts exec wrappers", () => {
  it("runs cf api/auth/target with the expected argv and env, inside an isolated CF_HOME", async () => {
    const cf = await import("../../src/cf.js");
    ok("");
    ok("");
    ok("");
    await cf.withCfSession(async (ctx) => {
      expect(ctx.cfHome).toBeTruthy();
      await cf.cfApi("https://api.cf.eu10.hana.ondemand.com", ctx);
      await cf.cfAuth("user@example.com", "pw", ctx);
      await cf.cfTargetSpace("org", "space", ctx);
    });

    expect(execFileMock).toHaveBeenCalledTimes(3);
    const [apiCall, authCall, targetCall] = execFileMock.mock.calls as [string, string[], NodeJS.ProcessEnv & { env: NodeJS.ProcessEnv }][];
    expect(apiCall?.[1]).toEqual(["api", "https://api.cf.eu10.hana.ondemand.com"]);
    expect(authCall?.[1]).toEqual(["auth"]);
    const authEnv = (authCall as unknown as [string, string[], { env: Record<string, string> }])[2].env;
    expect(authEnv["CF_USERNAME"]).toBe("user@example.com");
    expect(authEnv["CF_PASSWORD"]).toBe("pw");
    expect(targetCall?.[1]).toEqual(["target", "-o", "org", "-s", "space"]);
  });

  /**
   * The ambient context runs in the user's own `cf` session, so it must leave
   * CF_HOME exactly as the parent process had it — and the three commands that
   * would rewrite that session's target must refuse to run there at all.
   */
  it("leaves CF_HOME untouched for the ambient context instead of pointing it at a temp dir", async () => {
    vi.stubEnv("CF_HOME", "/home/user/.cf-custom");
    const cf = await import("../../src/cf.js");
    ok("11111111-2222-3333-4444-555555555555\n");

    await cf.cfServiceGuid("cloud-logging", cf.AMBIENT_CF_CONTEXT);

    const call = execFileMock.mock.calls[0] as unknown as [string, string[], { env: Record<string, string | undefined> }];
    expect(call[2].env["CF_HOME"]).toBe("/home/user/.cf-custom");
  });

  it("refuses to run cf api/auth/target in the ambient session, before spawning anything", async () => {
    const cf = await import("../../src/cf.js");

    await expect(cf.cfApi("https://api.cf.eu10.hana.ondemand.com", cf.AMBIENT_CF_CONTEXT)).rejects.toThrow(/refusing to run `cf api`/);
    await expect(cf.cfAuth("user@example.com", "pw", cf.AMBIENT_CF_CONTEXT)).rejects.toThrow(/refusing to run `cf auth`/);
    await expect(cf.cfTargetSpace("org", "space", cf.AMBIENT_CF_CONTEXT)).rejects.toThrow(/refusing to run `cf target`/);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("reads a space GUID and rejects anything that is not one", async () => {
    const cf = await import("../../src/cf.js");
    ok("  1af3e621-59f5-439c-9838-4508ae8be431 \n");
    await expect(cf.cfSpaceGuid("app", { cfHome: "/tmp/fake" })).resolves.toBe("1af3e621-59f5-439c-9838-4508ae8be431");
    expect((execFileMock.mock.calls[0] as unknown as [string, string[]])[1]).toEqual(["space", "app", "--guid"]);

    ok("Space app not found\n");
    await expect(cf.cfSpaceGuid("app", { cfHome: "/tmp/fake" })).rejects.toThrow(/did not return a GUID/);
  });

  it("strips SAP_EMAIL/SAP_PASSWORD from the child environment even if set in the parent", async () => {
    vi.stubEnv("SAP_EMAIL", "leaked@example.com");
    vi.stubEnv("SAP_PASSWORD", "leaked-secret");
    const cf = await import("../../src/cf.js");
    ok("");
    await cf.withCfSession(async (ctx) => {
      await cf.cfApi("https://api.cf.eu10.hana.ondemand.com", ctx);
    });
    const call = execFileMock.mock.calls[0] as unknown as [string, string[], { env: Record<string, string | undefined> }];
    expect(call[2].env["SAP_EMAIL"]).toBeUndefined();
    expect(call[2].env["SAP_PASSWORD"]).toBeUndefined();
  });

  it("retries a transient network failure and eventually succeeds", async () => {
    const cf = await import("../../src/cf.js");
    fail({ message: "connection reset" });
    ok("api endpoint: https://api.cf.eu10.hana.ondemand.com\norg: o\nspace: s\n");
    const target = await cf.readCurrentCfTarget();
    expect(target?.orgName).toBe("o");
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a non-transient failure (fails fast)", async () => {
    const cf = await import("../../src/cf.js");
    fail({ message: "not logged in" });
    const result = await cf.readCurrentCfTarget();
    expect(result).toBeUndefined();
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("never retries cfUpdateService or cfCreateServiceKey even on a transient-looking failure", async () => {
    const cf = await import("../../src/cf.js");
    fail({ message: "connection reset" });
    await cf.withCfSession(async (ctx) => {
      await expect(cf.cfUpdateService("cloud-logging", "/tmp/params.json", ctx)).rejects.toThrow();
    });
    expect(execFileMock).toHaveBeenCalledTimes(1);

    execFileMock.mockReset();
    fail({ message: "connection reset" });
    await cf.withCfSession(async (ctx) => {
      await expect(cf.cfCreateServiceKey("cloud-logging", "key1", ctx)).rejects.toThrow();
    });
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("normalizes cf command failures into one clear error message", async () => {
    const cf = await import("../../src/cf.js");
    fail({ message: "boom", stderr: "detailed reason" });
    await cf.withCfSession(async (ctx) => {
      await expect(cf.cfServiceParams("cloud-logging", ctx)).rejects.toThrow(/cf service cloud-logging --params failed: detailed reason/);
    });
  });

  /**
   * `withCfSession` runs on EVERY command invocation and its temp `CF_HOME`
   * holds a live CF OAuth refresh token after `cf auth`, so a leak leaves a
   * usable credential on disk. The cleanup lives in a `finally`, but nothing
   * verified it against the real filesystem — and the success path passing
   * says nothing about the throw path, which is the one that matters. These
   * check the actual directory, not a mock.
   */
  it("removes the temporary CF_HOME after the work function resolves", async () => {
    const cf = await import("../../src/cf.js");
    const { stat } = await import("node:fs/promises");
    let captured = "";

    await cf.withCfSession(async (ctx) => {
      captured = ctx.cfHome ?? "";
      await expect(stat(captured)).resolves.toBeDefined();
    });

    expect(captured).not.toBe("");
    await expect(stat(captured)).rejects.toThrow(/ENOENT/);
  });

  it("removes the temporary CF_HOME even when the work function throws", async () => {
    const cf = await import("../../src/cf.js");
    const { stat } = await import("node:fs/promises");
    let captured = "";

    await expect(
      cf.withCfSession(async (ctx) => {
        captured = ctx.cfHome ?? "";
        await expect(stat(captured)).resolves.toBeDefined();
        throw new Error("work blew up");
      }),
    ).rejects.toThrow("work blew up");

    expect(captured).not.toBe("");
    await expect(stat(captured)).rejects.toThrow(/ENOENT/);
  });

});
