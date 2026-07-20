import { describe, expect, it } from "vitest";

import {
  createProcessGuard,
  getSharedProcessGuard,
  type GuardedResource,
} from "../../src/process-guard.js";

function resolvedResource(label: string, calls: string[]): GuardedResource {
  return {
    label,
    release: async (): Promise<void> => {
      calls.push(label);
    },
  };
}

describe("process guard", () => {
  it("releases nothing and reports no failures when no resource is registered", async () => {
    const guard = createProcessGuard();
    await expect(guard.runCleanup()).resolves.toEqual([]);
  });

  it("releases registered resources most-recently-registered first", async () => {
    const calls: string[] = [];
    const guard = createProcessGuard();
    guard.register(resolvedResource("tunnel", calls));
    guard.register(resolvedResource("session", calls));
    guard.register(resolvedResource("port", calls));

    const failures = await guard.runCleanup();

    expect(failures).toEqual([]);
    expect(calls).toEqual(["port", "session", "tunnel"]);
  });

  it("unregisters a resource so a later cleanup skips it", async () => {
    const calls: string[] = [];
    const guard = createProcessGuard();
    const unregister = guard.register(resolvedResource("tunnel", calls));
    guard.register(resolvedResource("session", calls));

    unregister();
    await guard.runCleanup();

    expect(calls).toEqual(["session"]);
  });

  it("calling the same unregister function twice is a harmless no-op", async () => {
    const calls: string[] = [];
    const guard = createProcessGuard();
    const unregister = guard.register(resolvedResource("tunnel", calls));

    unregister();
    unregister();
    await guard.runCleanup();

    expect(calls).toEqual([]);
  });

  it("swallows a resource's own release error and reports it instead of throwing", async () => {
    const guard = createProcessGuard();
    const releaseError = new Error("dispose failed");
    guard.register({
      label: "tunnel",
      release: async (): Promise<never> => {
        throw releaseError;
      },
    });

    const failures = await guard.runCleanup();

    expect(failures).toEqual([{ label: "tunnel", error: releaseError }]);
  });

  it("still releases every other resource after one resource's release throws", async () => {
    const calls: string[] = [];
    const guard = createProcessGuard();
    guard.register(resolvedResource("tunnel", calls));
    guard.register({
      label: "session",
      release: async (): Promise<never> => {
        throw new Error("session dispose failed");
      },
    });
    guard.register(resolvedResource("port", calls));

    const failures = await guard.runCleanup();

    expect(failures.map((failure) => failure.label)).toEqual(["session"]);
    expect(calls).toEqual(["port", "tunnel"]);
  });

  it("wraps a non-Error rejection so callers always receive an Error instance", async () => {
    const guard = createProcessGuard();
    guard.register({
      label: "tunnel",
      // A caller's release() might reject with an arbitrary value; reach
      // past the lint-enforced Error convention here specifically to
      // exercise that defensive path.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- intentionally exercising a non-Error rejection.
      release: (): Promise<void> => Promise.reject("opaque-failure"),
    });

    const failures = await guard.runCleanup();

    expect(failures).toHaveLength(1);
    expect(failures[0]?.error).toBeInstanceOf(Error);
    expect(failures[0]?.error.message).toContain("opaque-failure");
  });

  it("bounds a resource release that never settles and reports a timeout failure", async () => {
    const guard = createProcessGuard({ releaseTimeoutMs: 20 });
    guard.register({
      label: "tunnel",
      release: async (): Promise<void> => await new Promise<never>(() => undefined),
    });

    const failures = await guard.runCleanup();

    expect(failures).toHaveLength(1);
    expect(failures[0]?.label).toBe("tunnel");
    expect(failures[0]?.error.message).toContain("timed out");
  });

  it("is idempotent: a second cleanup call reuses the first call's result without releasing again", async () => {
    const calls: string[] = [];
    const guard = createProcessGuard();
    guard.register(resolvedResource("tunnel", calls));

    const [first, second] = await Promise.all([guard.runCleanup(), guard.runCleanup()]);

    expect(first).toBe(second);
    expect(calls).toEqual(["tunnel"]);
  });

  it("a cleanup call issued after the first has already finished still short-circuits", async () => {
    const calls: string[] = [];
    const guard = createProcessGuard();
    guard.register(resolvedResource("tunnel", calls));

    await guard.runCleanup();
    await guard.runCleanup();

    expect(calls).toEqual(["tunnel"]);
  });

  it("exposes one shared guard instance for the whole process", () => {
    expect(getSharedProcessGuard()).toBe(getSharedProcessGuard());
  });
});
