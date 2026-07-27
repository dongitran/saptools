import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: mocks.execFile,
  spawn: mocks.spawn,
}));

const {
  buildCfSshArgs,
  cfSshOneShot,
  formatTunnelDiagnostics,
  getTunnelDiagnostics,
  spawnSshTunnel,
} = await import(
  "../../src/cloud-foundry/ssh.js"
);

function createChild(): EventEmitter & {
  readonly stdout: EventEmitter & { readonly resume: ReturnType<typeof vi.fn> };
  readonly stderr: EventEmitter & { readonly resume: ReturnType<typeof vi.fn> };
  readonly kill: ReturnType<typeof vi.fn>;
} {
  const child = new EventEmitter() as EventEmitter & {
    readonly stdout: EventEmitter & { readonly resume: ReturnType<typeof vi.fn> };
    readonly stderr: EventEmitter & { readonly resume: ReturnType<typeof vi.fn> };
    readonly kill: ReturnType<typeof vi.fn>;
  };
  Object.assign(child, {
    stdout: Object.assign(new EventEmitter(), { resume: vi.fn() }),
    stderr: Object.assign(new EventEmitter(), { resume: vi.fn() }),
    kill: vi.fn(() => true),
  });
  return child;
}

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("cfSshOneShot", () => {
  it("omits the v7-only process flag for web and retains it for custom processes", () => {
    expect(buildCfSshArgs("demo-app", {}, ["-N"])).toEqual([
      "ssh",
      "demo-app",
      "-i",
      "0",
      "-N",
    ]);
    expect(buildCfSshArgs("demo-app", { process: "web", instance: 2 }, ["-N"])).toEqual([
      "ssh",
      "demo-app",
      "-i",
      "2",
      "-N",
    ]);
    expect(buildCfSshArgs("demo-app", { process: "worker", instance: 2 }, ["-N"])).toEqual([
      "ssh",
      "demo-app",
      "--process",
      "worker",
      "-i",
      "2",
      "-N",
    ]);
  });

  it("reports the configured timeout instead of an unexplained null exit code", async () => {
    vi.useFakeTimers();
    const child = createChild();
    mocks.spawn.mockReturnValue(child);

    const resultPromise = cfSshOneShot(
      "demo-app",
      "kill -s USR1 $(pidof node)",
      { cfHome: "/tmp/cf-home", command: "cf" },
      25,
    );

    await vi.advanceTimersByTimeAsync(25);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.emit("close", null, "SIGTERM");

    await expect(resultPromise).resolves.toEqual({
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOutAfterMs: 25,
      outputTruncated: false,
      stdoutTruncated: false,
      stderrTruncated: false,
    });
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("terminates the one-shot SSH process when the caller aborts", async () => {
    const child = createChild();
    const controller = new AbortController();
    mocks.spawn.mockReturnValue(child);

    const resultPromise = cfSshOneShot(
      "demo-app",
      "printf markers",
      { cfHome: "/tmp/cf-home", command: "cf", signal: controller.signal },
      60_000,
    );
    controller.abort();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.emit("close", null, "SIGTERM");

    await expect(resultPromise).rejects.toMatchObject({ code: "ABORTED" });
  });

  it("does not miss an abort that occurs while the SSH child is spawning", async () => {
    const child = createChild();
    const controller = new AbortController();
    mocks.spawn.mockImplementation(() => {
      controller.abort();
      return child;
    });

    const resultPromise = cfSshOneShot(
      "demo-app",
      "printf markers",
      { cfHome: "/tmp/cf-home", command: "cf", signal: controller.signal },
      60_000,
    );

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.emit("close", null, "SIGTERM");
    await expect(resultPromise).rejects.toMatchObject({ code: "ABORTED" });
  });

  it("does not spawn after an abort or startup deadline has already elapsed", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(cfSshOneShot(
      "demo-app",
      "printf markers",
      { cfHome: "/tmp/cf-home", command: "cf", signal: controller.signal },
    )).rejects.toMatchObject({ code: "ABORTED" });
    await expect(cfSshOneShot(
      "demo-app",
      "printf markers",
      {
        cfHome: "/tmp/cf-home",
        command: "cf",
        deadlineAt: Date.now() - 1,
        phase: "remote signalling",
      },
    )).rejects.toMatchObject({ code: "STARTUP_TIMEOUT" });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("preserves the terminating signal when the process closes without an exit code", async () => {
    const child = createChild();
    mocks.spawn.mockReturnValue(child);

    const resultPromise = cfSshOneShot(
      "demo-app",
      "kill -s USR1 $(pidof node)",
      { cfHome: "/tmp/cf-home", command: "cf" },
      25,
    );
    child.emit("close", null, "SIGTERM");

    await expect(resultPromise).resolves.toEqual({
      exitCode: null,
      signal: "SIGTERM",
      stdout: "",
      stderr: "",
      outputTruncated: false,
      stdoutTruncated: false,
      stderrTruncated: false,
    });
  });

  it("forwards a custom target and bounds stdout and stderr", async () => {
    const child = createChild();
    mocks.spawn.mockReturnValue(child);

    const resultPromise = cfSshOneShot(
      "demo-app",
      "printf markers",
      { cfHome: "/tmp/cf-home", command: "cf" },
      { process: "worker", instance: 2, timeoutMs: 1000, maxOutputBytes: 8 },
    );
    child.stdout.emit("data", "1234567890");
    child.stderr.emit("data", "abcdefghij");
    child.emit("close", 0, null);

    await expect(resultPromise).resolves.toEqual({
      exitCode: 0,
      stdout: "12345678",
      stderr: "abcdefgh",
      outputTruncated: true,
      stdoutTruncated: true,
      stderrTruncated: true,
    });
    expect(mocks.spawn.mock.calls.at(0)?.[0]).toBe("cf");
    expect(mocks.spawn.mock.calls.at(0)?.[1]).toEqual([
      "ssh",
      "demo-app",
      "--process",
      "worker",
      "-i",
      "2",
      "--disable-pseudo-tty",
      "-c",
      "printf markers",
    ]);
    expect(mocks.spawn.mock.calls.at(0)?.[2]).toMatchObject({
      env: expect.objectContaining({
        CF_COLOR: "false",
        CF_HOME: "/tmp/cf-home",
      }),
    });
  });

  it("reports truncation per stream", async () => {
    const child = createChild();
    mocks.spawn.mockReturnValue(child);

    const resultPromise = cfSshOneShot(
      "demo-app",
      "printf markers",
      { cfHome: "/tmp/cf-home", command: "cf" },
      { timeoutMs: 1000, maxOutputBytes: 8 },
    );
    child.stdout.emit("data", "ok");
    child.stderr.emit("data", "abcdefghij");
    child.emit("close", 0, null);

    await expect(resultPromise).resolves.toMatchObject({
      outputTruncated: true,
      stderr: "abcdefgh",
      stderrTruncated: true,
      stdout: "ok",
      stdoutTruncated: false,
    });
  });

  it("redacts one-shot diagnostics when a value spans chunks", async () => {
    const child = createChild();
    mocks.spawn.mockReturnValue(child);

    const resultPromise = cfSshOneShot(
      "demo-app",
      "printf markers",
      {
        cfHome: "/tmp/cf-home",
        command: "cf",
        sensitiveValues: ["credential-42"],
      },
    );
    child.stderr.emit("data", "failure: credential-");
    child.stderr.emit("data", "42");
    child.emit("close", 1, null);

    const result = await resultPromise;
    expect(result.stderr).toBe("failure: <redacted>");
    expect(result.stderr).not.toContain("credential-42");
  });

  it("retains a bounded tail for long-running tunnel diagnostics", () => {
    const child = createChild();
    mocks.spawn.mockReturnValue(child);
    const tunnel = spawnSshTunnel(
      "demo-app",
      20_001,
      9229,
      { cfHome: "/tmp/cf-home", command: "cf" },
    );

    child.stderr.emit(
      "data",
      `discarded-head${"x".repeat(70_000)}retained-tail`,
    );
    const diagnostics = getTunnelDiagnostics(tunnel);
    expect(Buffer.byteLength(diagnostics.stderr)).toBeLessThanOrEqual(65_536);
    expect(diagnostics.stderr).not.toContain("discarded-head");
    expect(diagnostics.stderr).toMatch(/retained-tail$/);
    expect(diagnostics.stderrTruncated).toBe(true);
  });

  it("redacts cross-chunk live tunnel output and flushes the final line", () => {
    const child = createChild();
    const liveOutput: string[] = [];
    mocks.spawn.mockReturnValue(child);
    const tunnel = spawnSshTunnel(
      "demo-app",
      20_001,
      9229,
      {
        cfHome: "/tmp/cf-home",
        command: "cf",
        sensitiveValues: ["credential-42"],
        onTunnelOutput: (stream, text): void => {
          liveOutput.push(`${stream}:${text}`);
        },
      },
    );

    child.stderr.emit("data", "first credential-");
    child.stderr.emit("data", "42 line\nlast credential-");
    child.stderr.emit("data", "42 line");
    child.emit("close", 1, null);

    expect(liveOutput).toEqual([
      "stderr:first <redacted> line",
      "stderr:last <redacted> line",
    ]);
    const diagnostics = getTunnelDiagnostics(tunnel);
    expect(diagnostics.stderr).toContain("<redacted>");
    expect(diagnostics.stderr).not.toContain("credential-42");
  });

  it("redacts live UTF-8 credentials split inside a multibyte character", () => {
    const child = createChild();
    const liveOutput: string[] = [];
    mocks.spawn.mockReturnValue(child);
    spawnSshTunnel(
      "demo-app",
      20_001,
      9229,
      {
        cfHome: "/tmp/cf-home",
        command: "cf",
        sensitiveValues: ["päss"],
        onTunnelOutput: (_stream, text): void => {
          liveOutput.push(text);
        },
      },
    );
    const diagnostic = Buffer.from("failure: päss\n", "utf8");
    const splitAt = diagnostic.indexOf(Buffer.from("ä", "utf8")) + 1;

    child.stderr.emit("data", diagnostic.subarray(0, splitAt));
    child.stderr.emit("data", diagnostic.subarray(splitAt));

    expect(liveOutput).toEqual(["failure: <redacted>"]);
    expect(liveOutput.join("\n")).not.toContain("p��ss");
  });

  it("suppresses live and retained diagnostics for multiline sensitive values", () => {
    const child = createChild();
    const liveOutput: string[] = [];
    mocks.spawn.mockReturnValue(child);
    const tunnel = spawnSshTunnel(
      "demo-app",
      20_001,
      9229,
      {
        cfHome: "/tmp/cf-home",
        command: "cf",
        sensitiveValues: ["first-line\nsecond-line"],
        onTunnelOutput: (_stream, text): void => {
          liveOutput.push(text);
        },
      },
    );

    child.stderr.emit("data", "first-line\nsecond-line\n");
    child.emit("close", 1, null);

    expect(liveOutput).toEqual([
      "[diagnostic output omitted to protect a sensitive value]",
      "[diagnostic output omitted to protect a sensitive value]",
    ]);
    expect(getTunnelDiagnostics(tunnel).stderr).toBe(
      "[diagnostic output omitted to protect a sensitive value]",
    );
  });

  it("suppresses the rest of an oversized live line without leaking its next chunk", () => {
    const child = createChild();
    const liveOutput: string[] = [];
    mocks.spawn.mockReturnValue(child);
    spawnSshTunnel(
      "demo-app",
      20_001,
      9229,
      {
        cfHome: "/tmp/cf-home",
        command: "cf",
        sensitiveValues: ["credential-42"],
        onTunnelOutput: (_stream, text): void => {
          liveOutput.push(text);
        },
      },
    );

    child.stderr.emit("data", `${"x".repeat(65_530)}credential-`);
    child.stderr.emit("data", "42 must-not-surface\nsafe line\n");

    expect(liveOutput).toEqual([
      "[output line omitted: exceeded live diagnostic limit]",
      "safe line",
    ]);
  });

  it("captures a tunnel spawn error as a redacted diagnostic", () => {
    const child = createChild();
    mocks.spawn.mockReturnValue(child);
    const tunnel = spawnSshTunnel(
      "demo-app",
      20_001,
      9229,
      {
        cfHome: "/tmp/cf-home",
        command: "cf",
        sensitiveValues: ["credential-42"],
      },
    );

    child.emit("error", new Error("spawn rejected credential-42"));
    expect(getTunnelDiagnostics(tunnel).stderr).toBe("spawn rejected <redacted>\n");
  });

  it("formats both bounded streams and their truncation markers for errors", () => {
    expect(formatTunnelDiagnostics({
      stdout: "forward stdout",
      stderr: "forward stderr",
      stdoutTruncated: true,
      stderrTruncated: true,
    })).toBe(
      "[tunnel stdout]\nforward stdout\n" +
        "[tunnel stdout tail was truncated]\n" +
        "[tunnel stderr]\nforward stderr\n" +
        "[tunnel stderr tail was truncated]",
    );
  });

  it("uses the same explicit target and isolated environment for a tunnel", () => {
    const child = createChild();
    mocks.spawn.mockReturnValue(child);

    const tunnel = spawnSshTunnel(
      "demo-app",
      20_001,
      9229,
      { cfHome: "/tmp/cf-home", command: "cf" },
      { process: "worker", instance: 2 },
    );
    expect(tunnel).toBe(child);
    expect(mocks.spawn.mock.calls.at(0)?.[0]).toBe("cf");
    expect(mocks.spawn.mock.calls.at(0)?.[1]).toEqual([
      "ssh",
      "demo-app",
      "--process",
      "worker",
      "-i",
      "2",
      "-N",
      "-L",
      "20001:localhost:9229",
    ]);
    expect(mocks.spawn.mock.calls.at(0)?.[2]).toMatchObject({
      env: expect.objectContaining({
        CF_COLOR: "false",
        CF_HOME: "/tmp/cf-home",
      }),
    });
    child.stderr.emit("data", "ssh handshake rejected");
    child.emit("close", 1, null);
    expect(getTunnelDiagnostics(tunnel)).toMatchObject({
      stderr: "ssh handshake rejected",
      stderrTruncated: false,
    });
  });
});
