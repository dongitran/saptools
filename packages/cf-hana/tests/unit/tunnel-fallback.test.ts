import { EventEmitter } from "node:events";
import { writeSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as cf from "../../src/cf.js";
import {
  DEFAULT_TUNNEL_CANDIDATE_TIMEOUT_MS,
  DEFAULT_TUNNEL_FALLBACK_BUDGET_MS,
} from "../../src/config.js";
import { CfHanaError, QueryError } from "../../src/errors.js";
import * as cacheModule from "../../src/tunnel/cache.js";
import { claimEstablishing, readTunnelCacheEntry } from "../../src/tunnel/cache.js";
import type { TunnelCacheOptions } from "../../src/tunnel/cache.js";
import { connectWithTunnelFallback } from "../../src/tunnel/fallback.js";
import type { TunnelFallbackConfig, TunnelFallbackOverrides } from "../../src/tunnel/fallback.js";
import type { SpawnTunnelProcessFn, TunnelChildProcess } from "../../src/tunnel/process.js";

import { FakeHanaDriver } from "./fixtures/fake-driver.js";
import { sampleConnectionConfig } from "./fixtures/samples.js";

class FakeChild extends EventEmitter implements TunnelChildProcess {
  constructor(readonly pid: number | undefined) {
    super();
  }
  unref(): void {
    // no-op for tests
  }
}

interface FakeSpawnCall {
  readonly command: string;
  readonly args: readonly string[];
}

function fakeSpawnProcess(
  child: TunnelChildProcess,
): { readonly spawnProcess: SpawnTunnelProcessFn; readonly calls: FakeSpawnCall[] } {
  const calls: FakeSpawnCall[] = [];
  const spawnProcess: SpawnTunnelProcessFn = (command, args) => {
    calls.push({ command, args: [...args] });
    return child;
  };
  return { spawnProcess, calls };
}

async function tempRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "cf-hana-tunnel-fallback-"));
}

function cacheOverrides(root: string, extra: Partial<TunnelCacheOptions> = {}): TunnelCacheOptions {
  return {
    saptoolsRoot: root,
    isProcessAlive: () => true,
    probePort: () => Promise.resolve(true),
    ...extra,
  };
}

function connectivityError(message = "Could not connect to any host: [ host:443 - refused ]"): CfHanaError {
  return new CfHanaError("CONNECTION", `Failed to connect to HANA: ${message}`, {
    cause: Object.assign(new Error(message), { code: "EHDBOPENCONN" }),
  });
}

function privilegeError(): QueryError {
  return new QueryError("insufficient privilege: not authorized", { databaseCode: 258 });
}

function ambientConfig(overrides: Partial<TunnelFallbackConfig> = {}): TunnelFallbackConfig {
  return sampleConnectionConfig({ selectorSource: "ambient", ...overrides });
}

function successOverrides(root: string, pid = 4242, port = 39100): TunnelFallbackOverrides {
  const child = new FakeChild(pid);
  const { spawnProcess } = fakeSpawnProcess(child);
  return {
    cache: cacheOverrides(root),
    process: {
      spawnProcess,
      probePort: () => Promise.resolve(true),
      allocatePort: () => Promise.resolve(port),
    },
  };
}

beforeEach(() => {
  // Every test here uses an ambient selector; candidate discovery would
  // otherwise shell out to a real `cf apps` binary. An empty table is fine -
  // these tests only need the target app itself as a candidate.
  vi.spyOn(cf, "cfAppsDirect").mockResolvedValue("name   requested state\n");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("connectWithTunnelFallback: direct path (auto mode)", () => {
  it("calls driver.connect exactly once, with only its timeout bounded, and never touches the tunnel machinery on success", async () => {
    const driver = new FakeHanaDriver();
    const root = await tempRoot();
    const config = ambientConfig();
    let statusCalls = 0;

    const connection = await connectWithTunnelFallback(
      driver,
      { ...config, onTunnelStatus: () => { statusCalls += 1; } },
      { cache: cacheOverrides(root) },
    );

    expect(connection).toBeDefined();
    expect(driver.connectCalls).toEqual([
      {
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        schema: config.schema,
        certificate: config.certificate,
        // config.connectTimeoutMs (30s) exceeds the tunnel-candidate ceiling
        // (15s), so the direct attempt's own timeout is capped to it - see
        // the dedicated "direct-connect timeout bound" tests below.
        connectTimeoutMs: DEFAULT_TUNNEL_CANDIDATE_TIMEOUT_MS,
      },
    ]);
    expect(statusCalls).toBe(0);
    await expect(readTunnelCacheEntry(config.host, cacheOverrides(root))).resolves.toBeUndefined();
  });

  it("rethrows a non-connectivity direct failure immediately, without attempting discovery", async () => {
    const driver = new FakeHanaDriver();
    driver.connectError = privilegeError();
    const root = await tempRoot();

    await expect(
      connectWithTunnelFallback(driver, ambientConfig(), { cache: cacheOverrides(root) }),
    ).rejects.toBeInstanceOf(QueryError);
    expect(driver.connectCalls).toHaveLength(1);
  });

  it("falls back to a tunnel on a classified connectivity failure and rewrites host/port/servername", async () => {
    const driver = new FakeHanaDriver();
    driver.connectErrors.push(connectivityError());
    const root = await tempRoot();
    const config = ambientConfig();

    const connection = await connectWithTunnelFallback(driver, config, successOverrides(root));

    expect(connection).toBeDefined();
    expect(driver.connectCalls).toHaveLength(2);
    expect(driver.connectCalls[0]).toMatchObject({ host: config.host, port: config.port });
    expect(driver.connectCalls[1]).toMatchObject({
      host: "127.0.0.1",
      port: 39100,
      servername: config.host,
    });
    const cached = await readTunnelCacheEntry(config.host, cacheOverrides(root));
    expect(cached).toMatchObject({ status: "ready", localPort: 39100, pid: 4242 });
  });

  it("evicts the cache and continues to fresh discovery when a reused tunnel fails connectivity-shaped", async () => {
    const driver = new FakeHanaDriver();
    const root = await tempRoot();
    const config = ambientConfig();

    // Prime the cache with a real, working tunnel first.
    driver.connectErrors.push(connectivityError()); // priming call's direct attempt fails
    await connectWithTunnelFallback(driver, config, successOverrides(root, 4242, 39100));
    expect(driver.connectCalls).toHaveLength(2); // direct (failed), tunneled@39100 (succeeded)

    // Now poison it: the cached tunnel's reuse fails, and so does this call's
    // own fresh direct attempt - forcing it through candidate discovery again.
    // reuse of the cached tunnel fails, then this call's own direct attempt also fails
    driver.connectErrors.push(connectivityError(), connectivityError());
    const connection = await connectWithTunnelFallback(
      driver,
      config,
      successOverrides(root, 5555, 39200),
    );

    expect(connection).toBeDefined();
    const secondCallCalls = driver.connectCalls.slice(2);
    expect(secondCallCalls).toHaveLength(3);
    expect(secondCallCalls[0]).toMatchObject({ host: "127.0.0.1", port: 39100 }); // reuse (failed)
    expect(secondCallCalls[1]).toMatchObject({ host: config.host }); // direct (failed)
    expect(secondCallCalls[2]).toMatchObject({ host: "127.0.0.1", port: 39200 }); // fresh tunnel (ok)
    const cached = await readTunnelCacheEntry(config.host, cacheOverrides(root));
    expect(cached).toMatchObject({ localPort: 39200 });
  });

  it("caches the tunnel and rethrows immediately when the retry fails non-connectivity-shaped", async () => {
    const driver = new FakeHanaDriver();
    driver.connectErrors.push(connectivityError(), privilegeError());
    const root = await tempRoot();
    const config = ambientConfig();

    await expect(
      connectWithTunnelFallback(driver, config, successOverrides(root)),
    ).rejects.toBeInstanceOf(QueryError);

    const cached = await readTunnelCacheEntry(config.host, cacheOverrides(root));
    expect(cached).toMatchObject({ status: "ready", localPort: 39100 });
  });

  it("rethrows the original direct-connection error once every candidate is exhausted", async () => {
    const driver = new FakeHanaDriver();
    const direct = connectivityError("direct failure");
    driver.connectError = direct; // every attempt fails, including through any tunnel
    const root = await tempRoot();
    const child = new FakeChild(undefined);
    // Scheduled from inside the mock itself (not at the top level of the
    // test) so it is guaranteed to fire after spawnTunnel's synchronous
    // listener attachment, regardless of how many other async hops (mocked
    // cfAppsDirect, withScopedCfSession, ...) precede this call.
    const spawnProcess: SpawnTunnelProcessFn = (_command, _args) => {
      queueMicrotask(() => {
        child.emit("exit", 1);
      });
      return child;
    };

    const rejection = connectWithTunnelFallback(driver, ambientConfig(), {
      cache: cacheOverrides(root),
      process: { spawnProcess, probePort: () => Promise.resolve(false), allocatePort: () => Promise.resolve(39999) },
    });

    await expect(rejection).rejects.toBe(direct);
  });
});

describe("connectWithTunnelFallback: candidate discovery ordering and budget", () => {
  it("tries the target app before ever calling cf apps for candidate discovery", async () => {
    const driver = new FakeHanaDriver();
    driver.connectErrors.push(connectivityError());
    const root = await tempRoot();
    const config = ambientConfig();
    const cfAppsSpy = vi.spyOn(cf, "cfAppsDirect").mockResolvedValue("name   requested state\n");

    const connection = await connectWithTunnelFallback(driver, config, successOverrides(root));

    expect(connection).toBeDefined();
    expect(cfAppsSpy).not.toHaveBeenCalled();
  });

  it("bounds cf apps discovery to the remaining shared deadline instead of retrying a slow call", async () => {
    const driver = new FakeHanaDriver();
    driver.connectErrors.push(connectivityError());
    const root = await tempRoot();
    const config = ambientConfig();
    const cfAppsSpy = vi.spyOn(cf, "cfAppsDirect").mockResolvedValue("name   requested state\n");

    const child = new FakeChild(undefined);
    const spawnProcess: SpawnTunnelProcessFn = (_command, _args) => {
      // The lone known candidate (the target app) fails fast, forcing the
      // loop into discovery - scheduled from inside the mock itself so it
      // fires after spawnTunnel's own synchronous listener attachment.
      queueMicrotask(() => {
        child.emit("exit", 1);
      });
      return child;
    };

    await connectWithTunnelFallback(driver, config, {
      cache: cacheOverrides(root),
      process: {
        spawnProcess,
        probePort: () => Promise.resolve(false),
        allocatePort: () => Promise.resolve(39_500),
      },
    }).catch(() => {
      // Total exhaustion is expected here; only the discovery call itself is under test.
    });

    expect(cfAppsSpy).toHaveBeenCalledTimes(1);
    const timeoutArg = cfAppsSpy.mock.calls[0]?.[0];
    expect(timeoutArg).toBeDefined();
    expect(timeoutArg).toBeGreaterThan(0);
    expect(timeoutArg).toBeLessThanOrEqual(DEFAULT_TUNNEL_FALLBACK_BUDGET_MS);
  });
});

describe("connectWithTunnelFallback: candidate failure diagnostics", () => {
  it("surfaces a failed candidate's stderr tail via onTunnelStatus", async () => {
    const driver = new FakeHanaDriver();
    driver.connectErrors.push(connectivityError());
    const root = await tempRoot();
    const config = ambientConfig();
    const statusMessages: string[] = [];

    const child = new FakeChild(undefined);
    const spawnProcess: SpawnTunnelProcessFn = (_command, _args, options) => {
      const { stdio } = options;
      if (Array.isArray(stdio) && typeof stdio[2] === "number") {
        writeSync(stdio[2], "You are not authorized to perform the requested action\n");
      }
      queueMicrotask(() => {
        child.emit("exit", 1);
      });
      return child;
    };

    await connectWithTunnelFallback(
      driver,
      {
        ...config,
        onTunnelStatus: (message) => {
          statusMessages.push(message);
        },
      },
      {
        cache: cacheOverrides(root),
        process: {
          spawnProcess,
          probePort: () => Promise.resolve(false),
          allocatePort: () => Promise.resolve(39_600),
        },
      },
    ).catch(() => {
      // Total exhaustion is expected here; only the diagnostic is under test.
    });

    expect(
      statusMessages.some(
        (message) =>
          message.includes(`tunnel via ${config.appName} failed`) &&
          message.includes("not authorized"),
      ),
    ).toBe(true);
  });
});

describe("connectWithTunnelFallback: establishment follower does not stall on a stuck leader", () => {
  it("bounds the wait for another process's establishment to the per-candidate ceiling, not the full shared deadline", async () => {
    const driver = new FakeHanaDriver();
    driver.connectErrors.push(connectivityError());
    const root = await tempRoot();
    const config = ambientConfig();
    const cacheOptions = cacheOverrides(root);

    // Another process has already claimed "establishing" for this host, so
    // claimEstablishing hands this invocation "wait" - exactly the path
    // under test. waitForEstablishment is spied purely to inspect what
    // deadline tryCandidate computes and passes to it.
    //
    // What this test deliberately does NOT prove: that a subsequent
    // candidate actually benefits from the bound. Since the tunnel cache
    // is keyed by host (not by candidate app - see cache.ts), a later
    // candidate's own claimEstablishing call contends for the exact same
    // marker, not an independent one; it only gets a materially different
    // outcome than an identical wait would if the marker's owner pid has
    // died in the meantime (claimEstablishing's staleness check reclaims a
    // dead-owner marker immediately, regardless of age). Proving that case
    // end-to-end needs waitForEstablishment to faithfully honor the
    // deadline argument (a bare mockResolvedValue(undefined) can't
    // distinguish "the bound is computed correctly" from "the bound
    // achieves nothing downstream", since both resolve before any real
    // deadline check would fire) combined with fake timers - attempted and
    // abandoned here: claimEstablishing/reapStaleAndCrossOrgTunnels's real
    // filesystem I/O does not reliably interleave with
    // vi.advanceTimersByTimeAsync/runAllTimersAsync, and the attempt
    // reliably hung instead of completing. The benefit is real (bounding
    // a wait that would otherwise poll until the entire shared deadline is
    // spent, regardless of whether the reason it's stuck is even still
    // relevant, is strictly better than not bounding it) but is currently
    // verified by code reading and manual reasoning, not by an automated
    // test of the full reclaim path.
    await claimEstablishing(
      config.host,
      555_555,
      { apiEndpoint: config.apiEndpoint, orgName: config.orgName },
      cacheOptions,
    );
    const waitSpy = vi
      .spyOn(cacheModule, "waitForEstablishment")
      .mockResolvedValue(undefined);

    await connectWithTunnelFallback(driver, config, { cache: cacheOptions }).catch(() => {
      // Total exhaustion is an expected outcome of this setup; only the
      // deadline bound passed to waitForEstablishment is under test.
    });

    expect(waitSpy).toHaveBeenCalled();
    const boundedDeadline = waitSpy.mock.calls[0]?.[1];
    expect(boundedDeadline).toBeDefined();
    expect((boundedDeadline ?? 0) - Date.now()).toBeLessThanOrEqual(
      DEFAULT_TUNNEL_CANDIDATE_TIMEOUT_MS + 50,
    );
  });
});

describe("connectWithTunnelFallback: unattributed post-connect failures are not cached as ready", () => {
  it("evicts a freshly-established tunnel whose post-connect setup fails with no databaseCode/sqlState", async () => {
    const driver = new FakeHanaDriver();
    driver.connectErrors.push(connectivityError(), new QueryError("connection reset"));
    const root = await tempRoot();
    const config = ambientConfig();

    // Without this fix, finalizeCandidateConnection's catch would treat the
    // QueryError as non-connectivity-shaped, cache the dead tunnel as ready
    // anyway, and rethrow it directly. With the fix, this candidate is
    // evicted instead, discovery is exhausted (the fake `cf apps` table has
    // nothing else), and the *original* direct-connect error surfaces.
    await expect(
      connectWithTunnelFallback(driver, config, successOverrides(root)),
    ).rejects.not.toBeInstanceOf(QueryError);

    const cached = await readTunnelCacheEntry(config.host, cacheOverrides(root));
    expect(cached).toBeUndefined();
  });

  it("evicts a reused cached tunnel whose post-connect setup fails with no databaseCode/sqlState, falling through to a fresh one", async () => {
    const driver = new FakeHanaDriver();
    const root = await tempRoot();
    const config = ambientConfig();
    driver.connectErrors.push(connectivityError()); // priming call's direct attempt fails
    await connectWithTunnelFallback(driver, config, successOverrides(root, 4242, 39100));

    // reuse's own post-connect setup fails, then this call's own direct attempt also fails
    driver.connectErrors.push(new QueryError("connection reset"), connectivityError());
    const connection = await connectWithTunnelFallback(
      driver,
      config,
      successOverrides(root, 5555, 39200),
    );

    expect(connection).toBeDefined();
    const secondCallCalls = driver.connectCalls.slice(2);
    expect(secondCallCalls).toHaveLength(3);
    expect(secondCallCalls[0]).toMatchObject({ host: "127.0.0.1", port: 39100 }); // reuse (failed, unattributed)
    expect(secondCallCalls[1]).toMatchObject({ host: config.host }); // direct (failed)
    expect(secondCallCalls[2]).toMatchObject({ host: "127.0.0.1", port: 39200 }); // fresh tunnel (ok)
    const cached = await readTunnelCacheEntry(config.host, cacheOverrides(root));
    expect(cached).toMatchObject({ localPort: 39200 });
  });
});

describe("connectWithTunnelFallback: direct-connect timeout bound", () => {
  it("caps the direct attempt's connectTimeoutMs to the tunnel-candidate ceiling when the configured value is larger", async () => {
    const driver = new FakeHanaDriver();
    const root = await tempRoot();
    const config = ambientConfig({ connectTimeoutMs: 60_000 });

    await connectWithTunnelFallback(driver, config, { cache: cacheOverrides(root) });

    expect(driver.connectCalls[0]).toMatchObject({
      connectTimeoutMs: DEFAULT_TUNNEL_CANDIDATE_TIMEOUT_MS,
    });
  });

  it("leaves a configured connectTimeoutMs unchanged when it is already at or below the ceiling", async () => {
    const driver = new FakeHanaDriver();
    const root = await tempRoot();
    const config = ambientConfig({ connectTimeoutMs: 5_000 });

    await connectWithTunnelFallback(driver, config, { cache: cacheOverrides(root) });

    expect(driver.connectCalls[0]).toMatchObject({ connectTimeoutMs: 5_000 });
  });
});

describe("connectWithTunnelFallback: always mode", () => {
  it("never attempts a direct connection", async () => {
    const driver = new FakeHanaDriver();
    const root = await tempRoot();
    const config = ambientConfig({ tunnelMode: "always" });

    const connection = await connectWithTunnelFallback(driver, config, successOverrides(root));

    expect(connection).toBeDefined();
    expect(driver.connectCalls).toHaveLength(1);
    expect(driver.connectCalls[0]).toMatchObject({ host: "127.0.0.1", port: 39100 });
  });

  it("throws a clearly-worded exhaustion error (no direct error exists to reuse)", async () => {
    const driver = new FakeHanaDriver();
    const root = await tempRoot();
    const child = new FakeChild(undefined);
    const spawnProcess: SpawnTunnelProcessFn = (_command, _args) => {
      queueMicrotask(() => {
        child.emit("exit", 1);
      });
      return child;
    };

    await expect(
      connectWithTunnelFallback(driver, ambientConfig({ tunnelMode: "always" }), {
        cache: cacheOverrides(root),
        process: { spawnProcess, probePort: () => Promise.resolve(false), allocatePort: () => Promise.resolve(39998) },
      }),
    ).rejects.toMatchObject({
      code: "CONNECTION",
      message: expect.stringContaining("Could not establish an SSH tunnel"),
    });
  });
});

describe("connectWithTunnelFallback: cache reuse", () => {
  it("reuses a live cached tunnel immediately, skipping direct and discovery, in auto mode", async () => {
    const driver = new FakeHanaDriver();
    const root = await tempRoot();
    const config = ambientConfig();
    driver.connectErrors.push(connectivityError()); // priming call's direct attempt fails
    await connectWithTunnelFallback(driver, { ...config }, successOverrides(root));

    const second = await connectWithTunnelFallback(driver, config, {
      cache: cacheOverrides(root),
    });

    expect(second).toBeDefined();
    expect(driver.connectCalls).toHaveLength(3); // direct(fail), tunneled(ok), reuse(ok)
    expect(driver.connectCalls[2]).toMatchObject({ host: "127.0.0.1", port: 39100 });
  });

  it("reuses a live cached tunnel immediately in always mode too", async () => {
    const driver = new FakeHanaDriver();
    const root = await tempRoot();
    const config = ambientConfig();
    driver.connectErrors.push(connectivityError()); // priming call's direct attempt fails
    await connectWithTunnelFallback(driver, config, successOverrides(root));

    const second = await connectWithTunnelFallback(driver, ambientConfig({ tunnelMode: "always" }), {
      cache: cacheOverrides(root),
    });

    expect(second).toBeDefined();
    expect(driver.connectCalls).toHaveLength(3); // direct(fail), tunneled(ok), reuse(ok)
  });

  it("reuses the same live tunnel across several sequential connections (pool-wide reuse)", async () => {
    const driver = new FakeHanaDriver();
    driver.connectErrors.push(connectivityError());
    const root = await tempRoot();
    const config = ambientConfig();
    const child = new FakeChild(4242);
    const { spawnProcess, calls: spawnCalls } = fakeSpawnProcess(child);
    const overrides: TunnelFallbackOverrides = {
      cache: cacheOverrides(root),
      process: { spawnProcess, probePort: () => Promise.resolve(true), allocatePort: () => Promise.resolve(39100) },
    };

    await connectWithTunnelFallback(driver, config, overrides);
    await connectWithTunnelFallback(driver, config, overrides);
    await connectWithTunnelFallback(driver, config, overrides);
    await connectWithTunnelFallback(driver, config, overrides);

    const directCalls = driver.connectCalls.filter((p) => p.host === config.host);
    const tunneledCalls = driver.connectCalls.filter((p) => p.host === "127.0.0.1");
    expect(directCalls).toHaveLength(1);
    expect(tunneledCalls).toHaveLength(4);
    expect(spawnCalls).toHaveLength(1);
  });

  it("--refresh-tunnel bypasses a live cached tunnel, establishes a fresh one, and kills the superseded process", async () => {
    const driver = new FakeHanaDriver();
    const root = await tempRoot();
    const config = ambientConfig();
    driver.connectErrors.push(connectivityError()); // priming call's direct attempt fails
    await connectWithTunnelFallback(driver, config, successOverrides(root, 4242, 39100));

    driver.connectErrors.push(connectivityError()); // the refreshed call's own direct attempt also fails
    const killProcess = vi.fn();
    const refreshed = await connectWithTunnelFallback(
      driver,
      { ...config, refreshTunnel: true },
      {
        cache: cacheOverrides(root, { killProcess }),
        process: successOverrides(root, 9999, 39300).process ?? {},
      },
    );

    expect(refreshed).toBeDefined();
    const tunneledCalls = driver.connectCalls.filter((p) => p.host === "127.0.0.1");
    expect(tunneledCalls).toHaveLength(2);
    expect(tunneledCalls[1]).toMatchObject({ port: 39300 });
    const cached = await readTunnelCacheEntry(config.host, cacheOverrides(root));
    expect(cached).toMatchObject({ localPort: 39300, pid: 9999 });
    // The superseded tunnel's process (pid 4242) must be killed, not leaked.
    expect(killProcess).toHaveBeenCalledWith(4242);
    expect(killProcess).not.toHaveBeenCalledWith(9999);
  });
});
