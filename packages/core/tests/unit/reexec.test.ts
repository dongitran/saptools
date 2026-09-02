import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import type { SpawnLike } from "../../src/self-update/process-types.js";
import { buildReexecArgv, reexecEnvironment, REEXEC_MARKER_ENV, reexecProcess } from "../../src/self-update/reexec.js";
import type { ReexecRequest, ReexecRuntime } from "../../src/self-update/reexec.js";

const REQUEST: ReexecRequest = {
  execPath: "/usr/bin/node",
  execArgv: ["--enable-source-maps"],
  binPath: "/opt/homebrew/bin/demo",
  args: ["names", "--json"],
  env: { HOME: "/home/x" },
};

class FakeChild extends EventEmitter {
  readonly signals: NodeJS.Signals[] = [];
  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal ?? "SIGTERM");
    return true;
  }
}

function fakeRuntime(script: (child: FakeChild) => void): { runtime: Partial<ReexecRuntime>; child: FakeChild; spawnArgs: unknown[]; handlers: Map<string, (signal: NodeJS.Signals) => void>; exit: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn> } {
  const child = new FakeChild();
  const spawnArgs: unknown[] = [];
  const handlers = new Map<string, (signal: NodeJS.Signals) => void>();
  const spawnImpl: SpawnLike = (file, args, options) => {
    spawnArgs.push(file, args, options);
    queueMicrotask(() => {
      script(child);
    });
    return child as unknown as ChildProcess;
  };
  const exit = vi.fn();
  const kill = vi.fn();
  return {
    child,
    spawnArgs,
    handlers,
    exit,
    kill,
    runtime: {
      platform: "linux",
      execve: undefined,
      spawnImpl,
      onSignal: (signal, handler): void => {
        handlers.set(signal, handler);
      },
      offSignal: (signal): void => {
        handlers.delete(signal);
      },
      kill,
      exit,
    },
  };
}

describe("pure helpers", () => {
  it("rebuilds the node argv and marks the environment", () => {
    expect(buildReexecArgv(REQUEST)).toEqual(["--enable-source-maps", "/opt/homebrew/bin/demo", "names", "--json"]);
    expect(reexecEnvironment({ A: "1" })).toEqual({ A: "1", [REEXEC_MARKER_ENV]: "1" });
  });
});

describe("reexecProcess", () => {
  it("prefers execve on POSIX and falls back to a child when execve refuses", async () => {
    const execve = vi.fn(() => {
      throw new Error("EACCES");
    });
    const { runtime, exit } = fakeRuntime((child) => {
      child.emit("exit", 0, null);
    });
    await reexecProcess(REQUEST, { ...runtime, execve });
    expect(execve).toHaveBeenCalledWith("/usr/bin/node", ["/usr/bin/node", "--enable-source-maps", "/opt/homebrew/bin/demo", "names", "--json"], { HOME: "/home/x", [REEXEC_MARKER_ENV]: "1" });
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("never calls execve on Windows", async () => {
    const execve = vi.fn<(file: string, args: readonly string[], env: NodeJS.ProcessEnv) => never>(() => {
      throw new Error("must not run");
    });
    const { runtime, exit } = fakeRuntime((child) => {
      child.emit("exit", 2, null);
    });
    await reexecProcess(REQUEST, { ...runtime, platform: "win32", execve });
    expect(execve).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(2);
  });

  it("inherits stdio, forwards terminal signals to the child, and detaches the handlers afterwards", async () => {
    const { runtime, child, spawnArgs, handlers, exit } = fakeRuntime((c) => {
      handlers.get("SIGINT")?.("SIGINT");
      c.emit("exit", 130, null);
    });
    await reexecProcess(REQUEST, runtime);
    expect(spawnArgs[0]).toBe("/usr/bin/node");
    expect(spawnArgs[1]).toEqual(["--enable-source-maps", "/opt/homebrew/bin/demo", "names", "--json"]);
    expect(spawnArgs[2]).toEqual({ stdio: "inherit", env: { HOME: "/home/x", [REEXEC_MARKER_ENV]: "1" } });
    expect(child.signals).toEqual(["SIGINT"]);
    expect(handlers.size).toBe(0);
    expect(exit).toHaveBeenCalledWith(130);
  });

  it("mirrors a signal death by re-raising it and exiting 128+n as a fallback", async () => {
    const { runtime, exit, kill } = fakeRuntime((child) => {
      child.emit("exit", null, "SIGTERM");
    });
    await reexecProcess(REQUEST, runtime);
    expect(kill).toHaveBeenCalledWith(process.pid, "SIGTERM");
    expect(exit).toHaveBeenCalledWith(143);
  });

  it("uses exit code 1 when the child reports neither code nor signal", async () => {
    const { runtime, exit } = fakeRuntime((child) => {
      child.emit("exit", null, null);
    });
    await reexecProcess(REQUEST, runtime);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("rejects when the child cannot be started", async () => {
    const { runtime, handlers } = fakeRuntime((child) => {
      child.emit("error", new Error("spawn ENOENT"));
    });
    await expect(reexecProcess(REQUEST, runtime)).rejects.toThrow("spawn ENOENT");
    expect(handlers.size).toBe(0);
  });
});
