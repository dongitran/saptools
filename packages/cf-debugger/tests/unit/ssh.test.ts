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

const { cfSshOneShot } = await import("../../src/cloud-foundry/ssh.js");

function createChild(): EventEmitter & {
  readonly stderr: EventEmitter;
  readonly kill: ReturnType<typeof vi.fn>;
} {
  const child = new EventEmitter() as EventEmitter & {
    readonly stderr: EventEmitter;
    readonly kill: ReturnType<typeof vi.fn>;
  };
  Object.assign(child, {
    stderr: new EventEmitter(),
    kill: vi.fn(() => true),
  });
  return child;
}

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("cfSshOneShot", () => {
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

    await vi.advanceTimersByTimeAsync(15_000);

    await expect(resultPromise).resolves.toEqual({
      exitCode: null,
      stderr: "",
      timedOutAfterMs: 25,
    });
    expect(child.kill).toHaveBeenCalledTimes(1);
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
      stderr: "",
    });
  });
});
