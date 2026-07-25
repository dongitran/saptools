import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  claimEstablishing,
  evictTunnelCache,
  finalizeEstablishingFailed,
  finalizeEstablishingReady,
  isTunnelUsable,
  reapStaleAndCrossOrgTunnels,
  readTunnelCacheEntry,
  tunnelCacheKey,
  waitForEstablishment,
} from "../../src/tunnel/cache.js";
import type { TunnelOrgKey, TunnelReadyRecord } from "../../src/tunnel/cache.js";

const ORG_A: TunnelOrgKey = { apiEndpoint: "https://api.cf.eu10.hana.ondemand.com", orgName: "org-a" };
const ORG_B: TunnelOrgKey = { apiEndpoint: "https://api.cf.eu10.hana.ondemand.com", orgName: "org-b" };
const HOST = "hana.example.internal";

async function tempRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "cf-hana-tunnel-cache-"));
}

function alwaysAlive(): boolean {
  return true;
}
function alwaysDead(): boolean {
  return false;
}
function portOpen(): Promise<boolean> {
  return Promise.resolve(true);
}
function portClosed(): Promise<boolean> {
  return Promise.resolve(false);
}

describe("tunnel cache: write/read round-trip", () => {
  it("keys the cache file by sha256(host) only", async () => {
    const root = await tempRoot();
    await claimEstablishing(HOST, 111, ORG_A, { saptoolsRoot: root });
    const files = await readdir(join(root, "cf-hana", "tunnel"));
    expect(files).toEqual([`${tunnelCacheKey(HOST)}.json`]);
  });

  it("round-trips a finalized ready record", async () => {
    const root = await tempRoot();
    await claimEstablishing(HOST, 111, ORG_A, { saptoolsRoot: root });
    await finalizeEstablishingReady(
      HOST,
      { localPort: 39001, pid: 111, app: "target-app", orgKey: ORG_A, expiresAt: new Date(Date.now() + 60_000).toISOString() },
      { saptoolsRoot: root },
    );
    const entry = await readTunnelCacheEntry(HOST, { saptoolsRoot: root });
    expect(entry).toMatchObject({ status: "ready", localPort: 39001, pid: 111, app: "target-app" });
  });
});

describe("isTunnelUsable", () => {
  function readyRecord(overrides: Partial<TunnelReadyRecord> = {}): TunnelReadyRecord {
    return {
      version: 1,
      status: "ready",
      host: HOST,
      localPort: 39001,
      pid: 111,
      app: "target-app",
      orgKey: ORG_A,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      ...overrides,
    };
  }

  it("is usable when the pid is alive, the port is open, and it has not expired", async () => {
    const usable = await isTunnelUsable(readyRecord(), {
      isProcessAlive: alwaysAlive,
      probePort: portOpen,
    });
    expect(usable).toBe(true);
  });

  it("is not usable when the pid is dead", async () => {
    const usable = await isTunnelUsable(readyRecord(), {
      isProcessAlive: alwaysDead,
      probePort: portOpen,
    });
    expect(usable).toBe(false);
  });

  it("is not usable when the local port no longer accepts connections", async () => {
    const usable = await isTunnelUsable(readyRecord(), {
      isProcessAlive: alwaysAlive,
      probePort: portClosed,
    });
    expect(usable).toBe(false);
  });

  it("is not usable once past its recorded expiry", async () => {
    const usable = await isTunnelUsable(
      readyRecord({ expiresAt: new Date(Date.now() - 1_000).toISOString() }),
      { isProcessAlive: alwaysAlive, probePort: portOpen },
    );
    expect(usable).toBe(false);
  });
});

describe("claimEstablishing concurrency", () => {
  it("lets exactly one of two concurrent claims win; the loser waits for and reuses the ready record", async () => {
    const root = await tempRoot();
    const first = await claimEstablishing(HOST, 111, ORG_A, { saptoolsRoot: root });
    // The racing owner (pid 111) must be treated as genuinely alive here,
    // or the second claim would (correctly, per the staleness rules) treat
    // a fabricated/nonexistent pid as a crashed owner and take over instead
    // of waiting - that is a different scenario, covered separately below.
    const second = await claimEstablishing(HOST, 222, ORG_A, {
      saptoolsRoot: root,
      isProcessAlive: alwaysAlive,
    });

    expect(first.outcome).toBe("claimed");
    expect(second.outcome).toBe("wait");

    const waitPromise = waitForEstablishment(HOST, Date.now() + 5_000, 20, { saptoolsRoot: root });
    await finalizeEstablishingReady(
      HOST,
      {
        localPort: 39001,
        pid: 111,
        app: "target-app",
        orgKey: ORG_A,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      { saptoolsRoot: root },
    );

    const ready = await waitPromise;
    expect(ready).toMatchObject({ status: "ready", pid: 111, localPort: 39001 });
  });

  it("waitForEstablishment resolves undefined once the owner finalizes as failed", async () => {
    const root = await tempRoot();
    await claimEstablishing(HOST, 111, ORG_A, { saptoolsRoot: root });
    const waitPromise = waitForEstablishment(HOST, Date.now() + 5_000, 20, { saptoolsRoot: root });
    await finalizeEstablishingFailed(HOST, { saptoolsRoot: root });
    await expect(waitPromise).resolves.toBeUndefined();
  });

  it("waitForEstablishment gives up at its own deadline", async () => {
    const root = await tempRoot();
    await claimEstablishing(HOST, 111, ORG_A, { saptoolsRoot: root });
    await expect(
      waitForEstablishment(HOST, Date.now() + 30, 10, { saptoolsRoot: root }),
    ).resolves.toBeUndefined();
  });

  it("reports already-ready instead of wait when a ready record already exists", async () => {
    const root = await tempRoot();
    await claimEstablishing(HOST, 111, ORG_A, { saptoolsRoot: root });
    await finalizeEstablishingReady(
      HOST,
      {
        localPort: 39001,
        pid: 111,
        app: "target-app",
        orgKey: ORG_A,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      { saptoolsRoot: root },
    );

    const claim = await claimEstablishing(HOST, 222, ORG_A, { saptoolsRoot: root });
    expect(claim).toMatchObject({ outcome: "already-ready" });
  });
});

describe("claimEstablishing staleness (pid-liveness checked before age)", () => {
  it("takes over a marker immediately when its owner pid is dead, even if it is not yet age-stale", async () => {
    const root = await tempRoot();
    const now = new Date("2026-07-01T00:00:00Z");
    await claimEstablishing(HOST, 111, ORG_A, { saptoolsRoot: root, now: () => now });

    const claim = await claimEstablishing(HOST, 222, ORG_A, {
      saptoolsRoot: root,
      now: () => new Date(now.getTime() + 1_000),
      isProcessAlive: alwaysDead,
    });
    expect(claim).toMatchObject({ outcome: "claimed" });
  });

  it("leaves a marker alone when its owner pid is alive and it is not yet age-stale", async () => {
    const root = await tempRoot();
    const now = new Date("2026-07-01T00:00:00Z");
    await claimEstablishing(HOST, 111, ORG_A, { saptoolsRoot: root, now: () => now });

    const claim = await claimEstablishing(HOST, 222, ORG_A, {
      saptoolsRoot: root,
      now: () => new Date(now.getTime() + 1_000),
      isProcessAlive: alwaysAlive,
    });
    expect(claim).toMatchObject({ outcome: "wait" });
  });

  it("takes over a marker whose owner is alive but past the age threshold", async () => {
    const root = await tempRoot();
    const now = new Date("2026-07-01T00:00:00Z");
    await claimEstablishing(HOST, 111, ORG_A, { saptoolsRoot: root, now: () => now, staleAfterMs: 1_000 });

    const claim = await claimEstablishing(HOST, 222, ORG_A, {
      saptoolsRoot: root,
      now: () => new Date(now.getTime() + 2_000),
      isProcessAlive: alwaysAlive,
      staleAfterMs: 1_000,
    });
    expect(claim).toMatchObject({ outcome: "claimed" });
  });

  it("only one of two simultaneous takeover attempts wins the final exclusive create", async () => {
    const root = await tempRoot();
    const now = new Date("2026-07-01T00:00:00Z");
    await claimEstablishing(HOST, 111, ORG_A, { saptoolsRoot: root, now: () => now, staleAfterMs: 1_000 });

    const laterOptions = {
      saptoolsRoot: root,
      now: () => new Date(now.getTime() + 2_000),
      isProcessAlive: alwaysDead,
      staleAfterMs: 1_000,
    };
    const [claimX, claimY] = await Promise.all([
      claimEstablishing(HOST, 222, ORG_A, laterOptions),
      claimEstablishing(HOST, 333, ORG_A, laterOptions),
    ]);
    const outcomes = [claimX.outcome, claimY.outcome].sort();
    expect(outcomes).toEqual(["claimed", "wait"]);
  });
});

describe("finalization always reaches a terminal state", () => {
  it("finalizeEstablishingReady replaces the establishing marker with a ready record", async () => {
    const root = await tempRoot();
    await claimEstablishing(HOST, 111, ORG_A, { saptoolsRoot: root });
    await finalizeEstablishingReady(
      HOST,
      {
        localPort: 39001,
        pid: 111,
        app: "target-app",
        orgKey: ORG_A,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      { saptoolsRoot: root },
    );
    const entry = await readTunnelCacheEntry(HOST, { saptoolsRoot: root });
    expect(entry?.status).toBe("ready");
  });

  it("finalizeEstablishingFailed removes the marker entirely, not just its status", async () => {
    const root = await tempRoot();
    await claimEstablishing(HOST, 111, ORG_A, { saptoolsRoot: root });
    await finalizeEstablishingFailed(HOST, { saptoolsRoot: root });
    await expect(readTunnelCacheEntry(HOST, { saptoolsRoot: root })).resolves.toBeUndefined();
    const files = await readdir(join(root, "cf-hana", "tunnel")).catch(() => []);
    expect(files).toEqual([]);
  });
});

describe("reapStaleAndCrossOrgTunnels", () => {
  it("removes a dead entry regardless of status, without calling killProcess", async () => {
    const root = await tempRoot();
    await claimEstablishing(HOST, 111, ORG_A, { saptoolsRoot: root });
    const killProcess = vi.fn();

    await reapStaleAndCrossOrgTunnels(ORG_A, {
      saptoolsRoot: root,
      isProcessAlive: alwaysDead,
      killProcess,
    });

    await expect(readTunnelCacheEntry(HOST, { saptoolsRoot: root })).resolves.toBeUndefined();
    expect(killProcess).not.toHaveBeenCalled();
  });

  it("kills and removes a live ready entry tagged with a different org", async () => {
    const root = await tempRoot();
    await claimEstablishing(HOST, 111, ORG_A, { saptoolsRoot: root });
    await finalizeEstablishingReady(
      HOST,
      {
        localPort: 39001,
        pid: 111,
        app: "target-app",
        orgKey: ORG_A,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      { saptoolsRoot: root },
    );
    const killProcess = vi.fn();

    await reapStaleAndCrossOrgTunnels(ORG_B, {
      saptoolsRoot: root,
      isProcessAlive: alwaysAlive,
      probePort: portOpen,
      killProcess,
    });

    await expect(readTunnelCacheEntry(HOST, { saptoolsRoot: root })).resolves.toBeUndefined();
    expect(killProcess).toHaveBeenCalledWith(111);
  });

  it("kills and removes a live ready entry that has expired, even in the same org", async () => {
    const root = await tempRoot();
    await claimEstablishing(HOST, 111, ORG_A, { saptoolsRoot: root });
    await finalizeEstablishingReady(
      HOST,
      {
        localPort: 39001,
        pid: 111,
        app: "target-app",
        orgKey: ORG_A,
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      },
      { saptoolsRoot: root },
    );
    const killProcess = vi.fn();

    await reapStaleAndCrossOrgTunnels(ORG_A, { saptoolsRoot: root, isProcessAlive: alwaysAlive, killProcess });

    await expect(readTunnelCacheEntry(HOST, { saptoolsRoot: root })).resolves.toBeUndefined();
    expect(killProcess).toHaveBeenCalledWith(111);
  });

  it("leaves a live, non-stale establishing marker for a different org completely alone", async () => {
    const root = await tempRoot();
    await claimEstablishing(HOST, 111, ORG_A, { saptoolsRoot: root });
    const killProcess = vi.fn();

    await reapStaleAndCrossOrgTunnels(ORG_B, {
      saptoolsRoot: root,
      isProcessAlive: alwaysAlive,
      killProcess,
    });

    const entry = await readTunnelCacheEntry(HOST, { saptoolsRoot: root });
    expect(entry?.status).toBe("establishing");
    expect(killProcess).not.toHaveBeenCalled();
  });

  it("removes a live but age-stale establishing marker regardless of org", async () => {
    const root = await tempRoot();
    const now = new Date("2026-07-01T00:00:00Z");
    await claimEstablishing(HOST, 111, ORG_A, { saptoolsRoot: root, now: () => now });

    await reapStaleAndCrossOrgTunnels(ORG_A, {
      saptoolsRoot: root,
      now: () => new Date(now.getTime() + 120_000),
      isProcessAlive: alwaysAlive,
      staleAfterMs: 60_000,
    });

    await expect(readTunnelCacheEntry(HOST, { saptoolsRoot: root })).resolves.toBeUndefined();
  });

  it("leaves a live, unexpired, same-org ready entry alone", async () => {
    const root = await tempRoot();
    await claimEstablishing(HOST, 111, ORG_A, { saptoolsRoot: root });
    await finalizeEstablishingReady(
      HOST,
      {
        localPort: 39001,
        pid: 111,
        app: "target-app",
        orgKey: ORG_A,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      { saptoolsRoot: root },
    );
    const killProcess = vi.fn();

    await reapStaleAndCrossOrgTunnels(ORG_A, {
      saptoolsRoot: root,
      isProcessAlive: alwaysAlive,
      killProcess,
    });

    const entry = await readTunnelCacheEntry(HOST, { saptoolsRoot: root });
    expect(entry?.status).toBe("ready");
    expect(killProcess).not.toHaveBeenCalled();
  });
});

describe("evictTunnelCache", () => {
  it("removes a ready record from disk (self-healing after a broken reuse)", async () => {
    const root = await tempRoot();
    await claimEstablishing(HOST, 111, ORG_A, { saptoolsRoot: root });
    await finalizeEstablishingReady(
      HOST,
      {
        localPort: 39001,
        pid: 111,
        app: "target-app",
        orgKey: ORG_A,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      { saptoolsRoot: root },
    );
    await evictTunnelCache(HOST, { saptoolsRoot: root });
    await expect(readTunnelCacheEntry(HOST, { saptoolsRoot: root })).resolves.toBeUndefined();
  });
});

describe("secrets hygiene", () => {
  it("never stores anything resembling credentials in the cache file", async () => {
    const root = await tempRoot();
    await claimEstablishing(HOST, 111, ORG_A, { saptoolsRoot: root });
    await finalizeEstablishingReady(
      HOST,
      {
        localPort: 39001,
        pid: 111,
        app: "target-app",
        orgKey: ORG_A,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      { saptoolsRoot: root },
    );
    const raw = await readFile(join(root, "cf-hana", "tunnel", `${tunnelCacheKey(HOST)}.json`), "utf8");
    expect(raw).not.toContain("password");
    expect(raw).not.toContain("secret");
    expect(raw).not.toContain("sapCredentials");
  });
});
