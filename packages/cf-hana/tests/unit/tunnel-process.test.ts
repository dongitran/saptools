import { EventEmitter } from "node:events";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as cf from "../../src/cf.js";
import { CfHanaError, CredentialsNotFoundError } from "../../src/errors.js";
import {
  allocateLocalPort,
  killTunnelProcess,
  probeLocalPort,
  spawnTunnel,
  withScopedCfSession,
} from "../../src/tunnel/process.js";
import type { SpawnTunnelProcessFn, TunnelChildProcess } from "../../src/tunnel/process.js";

class FakeChild extends EventEmitter implements TunnelChildProcess {
  unrefCalled = false;
  constructor(readonly pid: number | undefined) {
    super();
  }
  unref(): void {
    this.unrefCalled = true;
  }
}

interface FakeSpawnCall {
  readonly command: string;
  readonly args: readonly string[];
}

function fakeSpawnProcess(child: TunnelChildProcess): {
  readonly spawnProcess: SpawnTunnelProcessFn;
  readonly calls: FakeSpawnCall[];
} {
  const calls: FakeSpawnCall[] = [];
  const spawnProcess: SpawnTunnelProcessFn = (command, args) => {
    calls.push({ command, args: [...args] });
    return child;
  };
  return { spawnProcess, calls };
}

const BASE_PARAMS = {
  cfHome: undefined,
  app: "target-app",
  hanaHost: "hana.example.internal",
  hanaPort: 443,
  keepaliveSeconds: 1200,
  candidateTimeoutMs: 15_000,
};

describe("allocateLocalPort", () => {
  it("returns a bindable local port", async () => {
    const port = await allocateLocalPort();
    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThan(0);
  });
});

describe("probeLocalPort", () => {
  it("resolves true once a listener is bound and false once it is closed", async () => {
    const port = await allocateLocalPort();
    const { createServer } = await import("node:net");
    const server = createServer();
    await new Promise<void>((resolve) => {
      server.listen(port, "127.0.0.1", resolve);
    });
    await expect(probeLocalPort(port)).resolves.toBe(true);
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    await expect(probeLocalPort(port)).resolves.toBe(false);
  });
});

describe("spawnTunnel", () => {
  it("spawns cf ssh with a local forward and detached/ignored stdio", async () => {
    const child = new FakeChild(4242);
    const { spawnProcess, calls } = fakeSpawnProcess(child);
    const resultPromise = spawnTunnel(
      { ...BASE_PARAMS, deadline: Date.now() + 10_000 },
      { spawnProcess, probePort: () => Promise.resolve(true) },
    );

    const result = await resultPromise;
    expect(result?.pid).toBe(4242);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args.slice(0, 2)).toEqual(["ssh", "target-app"]);
    expect(calls[0]?.args[2]).toBe("-L");
    expect(calls[0]?.args[3]).toMatch(/^\d+:hana\.example\.internal:443$/);
    expect(calls[0]?.args.slice(4)).toEqual(["-c", "sleep 1200"]);
  });

  it("unrefs the child once the tunnel is confirmed ready", async () => {
    const child = new FakeChild(4242);
    const { spawnProcess } = fakeSpawnProcess(child);
    await spawnTunnel(
      { ...BASE_PARAMS, deadline: Date.now() + 10_000 },
      { spawnProcess, probePort: () => Promise.resolve(true) },
    );
    expect(child.unrefCalled).toBe(true);
  });

  it("resolves undefined without crashing when the binary cannot be spawned (ENOENT)", async () => {
    const child = new FakeChild(undefined);
    const { spawnProcess } = fakeSpawnProcess(child);
    const killProcess = vi.fn();
    // allocatePort is injected as an already-resolved promise so the whole
    // chain up to `child.on(...)` attachment settles within one microtask
    // tick, before the queued emit below — the real allocator's socket I/O
    // is not guaranteed to finish that fast, which would otherwise risk
    // emitting before a listener exists and hanging the test.
    const resultPromise = spawnTunnel(
      { ...BASE_PARAMS, deadline: Date.now() + 10_000 },
      {
        spawnProcess,
        probePort: () => Promise.resolve(false),
        killProcess,
        allocatePort: () => Promise.resolve(39_001),
      },
    );

    queueMicrotask(() => {
      child.emit("error", Object.assign(new Error("spawn cf ENOENT"), { code: "ENOENT" }));
    });

    await expect(resultPromise).resolves.toBeUndefined();
  });

  it("resolves undefined when the process exits before the port opens", async () => {
    const child = new FakeChild(4242);
    const { spawnProcess } = fakeSpawnProcess(child);
    const resultPromise = spawnTunnel(
      { ...BASE_PARAMS, deadline: Date.now() + 10_000 },
      {
        spawnProcess,
        probePort: () => Promise.resolve(false),
        allocatePort: () => Promise.resolve(39_002),
      },
    );

    queueMicrotask(() => {
      child.emit("exit", 1);
    });

    await expect(resultPromise).resolves.toBeUndefined();
  });

  it("rejects a non-positive-integer keepalive before attempting to spawn", async () => {
    const child = new FakeChild(4242);
    const { spawnProcess, calls } = fakeSpawnProcess(child);
    await expect(
      spawnTunnel(
        { ...BASE_PARAMS, keepaliveSeconds: 0, deadline: Date.now() + 10_000 },
        { spawnProcess },
      ),
    ).rejects.toBeInstanceOf(CfHanaError);
    expect(calls).toHaveLength(0);
  });

  it("returns undefined immediately, without spawning, once the shared deadline has already passed", async () => {
    const child = new FakeChild(4242);
    const { spawnProcess, calls } = fakeSpawnProcess(child);
    const result = await spawnTunnel(
      { ...BASE_PARAMS, deadline: Date.now() - 1 },
      { spawnProcess },
    );
    expect(result).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  describe("with fake timers", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("gives up at the remaining shared deadline, not the (larger) per-candidate ceiling", async () => {
      const child = new FakeChild(4242);
      const { spawnProcess } = fakeSpawnProcess(child);
      const killProcess = vi.fn();
      const start = Date.now();
      const resultPromise = spawnTunnel(
        {
          ...BASE_PARAMS,
          candidateTimeoutMs: 100_000,
          deadline: start + 5_000,
        },
        {
          spawnProcess,
          probePort: () => Promise.resolve(false),
          killProcess,
          allocatePort: () => Promise.resolve(39_003),
        },
      );

      await vi.advanceTimersByTimeAsync(4_999);
      expect(killProcess).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2);
      await expect(resultPromise).resolves.toBeUndefined();
      expect(killProcess).toHaveBeenCalledWith(4242);
    });

    it("gives up at the per-candidate ceiling when it is tighter than the shared deadline", async () => {
      const child = new FakeChild(4242);
      const { spawnProcess } = fakeSpawnProcess(child);
      const start = Date.now();
      const resultPromise = spawnTunnel(
        {
          ...BASE_PARAMS,
          candidateTimeoutMs: 3_000,
          deadline: start + 100_000,
        },
        {
          spawnProcess,
          probePort: () => Promise.resolve(false),
          allocatePort: () => Promise.resolve(39_004),
        },
      );

      await vi.advanceTimersByTimeAsync(2_999);
      let settled = false;
      void resultPromise.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(2);
      await expect(resultPromise).resolves.toBeUndefined();
    });
  });
});

describe("killTunnelProcess", () => {
  it("does not throw for a pid that no longer exists", () => {
    expect(() => {
      killTunnelProcess(999_999_999);
    }).not.toThrow();
  });

  it("does nothing for an undefined pid", () => {
    expect(() => {
      killTunnelProcess(undefined);
    }).not.toThrow();
  });
});

const AMBIENT_TARGET = {
  apiEndpoint: "https://api.cf.eu10.hana.ondemand.com",
  orgName: "example-org",
  spaceName: "space-demo",
};

describe("withScopedCfSession", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs work directly against the ambient environment for an ambient selector", async () => {
    const cfApi = vi.spyOn(cf, "cfApi");
    const work = vi.fn().mockResolvedValue("done");

    const result = await withScopedCfSession("ambient", AMBIENT_TARGET, undefined, work);

    expect(result).toBe("done");
    expect(work).toHaveBeenCalledWith();
    expect(cfApi).not.toHaveBeenCalled();
  });

  it("throws when an explicit selector has no SAP credentials to authenticate a session with", async () => {
    const work = vi.fn();
    await expect(
      withScopedCfSession("explicit", AMBIENT_TARGET, undefined, work),
    ).rejects.toBeInstanceOf(CredentialsNotFoundError);
    expect(work).not.toHaveBeenCalled();
  });

  it("authenticates a fresh CF_HOME and defers cleanup until work settles, for an explicit selector", async () => {
    const cfApiSpy = vi.spyOn(cf, "cfApi").mockResolvedValue(undefined);
    const cfAuthSpy = vi.spyOn(cf, "cfAuth").mockResolvedValue(undefined);
    const cfTargetSpaceSpy = vi.spyOn(cf, "cfTargetSpace").mockResolvedValue(undefined);
    let capturedCfHome: string | undefined;
    let releaseWork: (() => void) | undefined;
    const workGate = new Promise<void>((resolve) => {
      releaseWork = resolve;
    });

    const sessionPromise = withScopedCfSession(
      "explicit",
      AMBIENT_TARGET,
      { email: "user@example.com", password: "secret" },
      async (ctx) => {
        capturedCfHome = ctx?.cfHome;
        await workGate;
        return "done";
      },
    );

    await vi.waitFor(() => {
      expect(capturedCfHome).toBeDefined();
    });
    const cfHome = capturedCfHome;
    if (cfHome === undefined) {
      throw new Error("cfHome was not captured");
    }
    await expect(access(cfHome)).resolves.toBeUndefined();

    expect(cfApiSpy).toHaveBeenCalledWith(AMBIENT_TARGET.apiEndpoint, { cfHome });
    expect(cfAuthSpy).toHaveBeenCalledWith("user@example.com", "secret", { cfHome });
    expect(cfTargetSpaceSpy).toHaveBeenCalledWith(
      AMBIENT_TARGET.orgName,
      AMBIENT_TARGET.spaceName,
      { cfHome },
    );

    releaseWork?.();
    await expect(sessionPromise).resolves.toBe("done");
    await expect(access(cfHome)).rejects.toThrow();
  });

  it("still cleans up the CF_HOME when work throws", async () => {
    vi.spyOn(cf, "cfApi").mockResolvedValue(undefined);
    vi.spyOn(cf, "cfAuth").mockResolvedValue(undefined);
    vi.spyOn(cf, "cfTargetSpace").mockResolvedValue(undefined);
    let capturedCfHome: string | undefined;

    await expect(
      withScopedCfSession(
        "explicit",
        AMBIENT_TARGET,
        { email: "user@example.com", password: "secret" },
        async (ctx) => {
          capturedCfHome = ctx?.cfHome;
          throw new Error("establishment failed");
        },
      ),
    ).rejects.toThrow("establishment failed");

    const cfHome = capturedCfHome;
    if (cfHome === undefined) {
      throw new Error("cfHome was not captured");
    }
    await expect(access(cfHome)).rejects.toThrow();
  });
});

describe("temp dir sanity", () => {
  it("mkdtemp under the OS tmp dir works as expected (self-check for the fixture above)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cf-hana-process-test-"));
    await expect(access(dir)).resolves.toBeUndefined();
  });
});
