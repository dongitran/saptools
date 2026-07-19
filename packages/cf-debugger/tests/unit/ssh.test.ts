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

const { buildCfSshArgs, cfSshOneShot, spawnSshTunnel } = await import(
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
    });
    expect(child.kill).toHaveBeenCalledTimes(1);
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
  });

  it("uses the same explicit target for a tunnel and drains its output", () => {
    const child = createChild();
    mocks.spawn.mockReturnValue(child);

    expect(spawnSshTunnel(
      "demo-app",
      20_001,
      9229,
      { cfHome: "/tmp/cf-home", command: "cf" },
      { process: "worker", instance: 2 },
    )).toBe(child);
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
    expect(child.stdout.resume).toHaveBeenCalledTimes(1);
    expect(child.stderr.resume).toHaveBeenCalledTimes(1);
  });
});
