import { describe, expect, it, vi } from "vitest";

import { LiveTraceSession } from "../../src/session.js";
import type {
  InspectorStartupResult,
  InspectorRuntimeClient,
  LiveTraceEvent,
  LiveTraceStateEvent,
  TunnelOpenResult,
} from "../../src/types.js";

describe("LiveTraceSession", () => {
  it("prepares CF, opens a tunnel, injects the hook, drains events, and cleans up", async () => {
    let pollCallback: (() => void) | undefined;
    const states: LiveTraceStateEvent[] = [];
    const events: LiveTraceEvent[] = [];
    const tunnelStop = vi.fn();
    const client: InspectorRuntimeClient = {
      evaluate: vi.fn(async (expression: string) => {
        if (expression.includes("?.drainEvents")) {
          return {
            events: [{ id: "runtime-1", url: "/health", method: "GET", responseBodyPreview: "{}" }],
            droppedCount: 0,
            queueSize: 0,
          };
        }
        return { installed: true };
      }),
      close: vi.fn(async () => undefined),
    };

    const session = new LiveTraceSession(
      {
        target: {
          apiEndpoint: "https://api.example.com",
          email: "user@example.com",
          password: "secret",
          org: "demo-org",
          space: "dev",
          app: "orders-api",
          cfHomeDir: "/tmp/cf-home",
          instanceIndex: 0,
        },
        onState: (state) => states.push(state),
        onEvents: (batch) => events.push(...batch),
      },
      {
        prepareCfSession: vi.fn(async () => undefined),
        ensureSshEnabled: vi.fn(async () => undefined),
        tryStartNodeInspector: vi.fn(async () => true),
        openInspectorTunnel: vi.fn(async (): Promise<TunnelOpenResult> => ({
          status: "ready",
          handle: { localPort: 51234, stop: tunnelStop },
        })),
        connectInspector: vi.fn(async () => client),
        setInterval: vi.fn((callback: () => void) => {
          pollCallback = callback;
          return 10 as unknown as NodeJS.Timeout;
        }),
        clearInterval: vi.fn(),
      },
    );

    await session.start({ maxBodyBytes: 4096 });
    pollCallback?.();
    await vi.waitFor(() => {
      expect(events).toHaveLength(1);
    });
    await session.stop({ uninstallRuntimeHook: true, reason: "user" });

    expect(states.map((state) => state.state)).toEqual([
      "preparing",
      "enabling-ssh",
      "starting-inspector",
      "opening-tunnel",
      "injecting",
      "streaming",
      "stopping",
      "stopped",
    ]);
    const evaluateCalls = (client.evaluate as unknown as { readonly mock: { readonly calls: readonly [string, number][] } }).mock.calls;
    expect(evaluateCalls[0]).toEqual([expect.stringContaining(".install("), 5000]);
    expect(evaluateCalls.some(([expression, timeout]) => expression.includes(".uninstall()") && timeout === 5000)).toBe(true);
    expect(tunnelStop).toHaveBeenCalledTimes(1);
  });

  it("retries transient drain timeouts before failing the stream", async () => {
    let pollCallback: (() => void) | undefined;
    const states: LiveTraceStateEvent[] = [];
    const logs: string[] = [];
    let drainCalls = 0;
    const client: InspectorRuntimeClient = {
      evaluate: vi.fn(async (expression: string) => {
        if (!expression.includes("?.drainEvents")) {
          return { installed: true };
        }
        drainCalls += 1;
        if (drainCalls === 1) {
          throw new Error("CDP method Runtime.evaluate timed out after 10000ms");
        }
        return { events: [], droppedCount: 0, queueSize: 0 };
      }),
      close: vi.fn(async () => undefined),
    };

    const session = new LiveTraceSession(
      {
        target: createTarget(),
        onState: (state) => states.push(state),
        onLog: (message) => logs.push(message),
      },
      createReadyDependencies(client, (callback) => {
        pollCallback = callback;
      }),
    );

    await session.start({ maxBodyBytes: 0 });
    pollCallback?.();
    await vi.waitFor(() => {
      expect(logs).toContain("Live Trace drain timed out for orders-api; retrying (1/3).");
    });
    pollCallback?.();
    await vi.waitFor(() => {
      expect(drainCalls).toBe(2);
    });

    expect(states.at(-1)?.state).toBe("streaming");
  });

  it("rejects startup failures instead of leaving callers waiting for a stop condition", async () => {
    const states: LiveTraceStateEvent[] = [];
    const logs: string[] = [];
    const session = new LiveTraceSession(
      {
        target: createTarget(),
        onState: (state) => states.push(state),
        onLog: (message) => logs.push(message),
      },
      {
        prepareCfSession: vi.fn(async () => {
          throw new Error("cf auth failed");
        }),
        ensureSshEnabled: vi.fn(async () => undefined),
        tryStartNodeInspector: vi.fn(async () => true),
        openInspectorTunnel: vi.fn(async (): Promise<TunnelOpenResult> => ({ status: "not-reachable" })),
        connectInspector: vi.fn(),
      },
    );

    await expect(session.start({ maxBodyBytes: 4096 })).rejects.toThrow("Runtime HTTP trace could not be started.");

    expect(states.map((state) => state.state)).toEqual(["preparing", "error"]);
    expect(logs).toEqual([
      "Live Trace startup failed for orders-api: cf auth failed",
    ]);
  });

  it("keeps the error state when stopped after startup failure cleanup", async () => {
    const states: LiveTraceStateEvent[] = [];
    const session = new LiveTraceSession(
      {
        target: createTarget(),
        onState: (state) => states.push(state),
      },
      {
        prepareCfSession: vi.fn(async () => {
          throw new Error("cf auth failed");
        }),
        ensureSshEnabled: vi.fn(async () => undefined),
        tryStartNodeInspector: vi.fn(async () => true),
        openInspectorTunnel: vi.fn(async (): Promise<TunnelOpenResult> => ({ status: "not-reachable" })),
        connectInspector: vi.fn(),
      },
    );

    await expect(session.start({ maxBodyBytes: 4096 })).rejects.toThrow("Runtime HTTP trace could not be started.");
    await session.stop({ uninstallRuntimeHook: true, reason: "error" });

    expect(states.map((state) => state.state)).toEqual(["preparing", "error"]);
  });

  it("reports an error when the inspector tunnel is not reachable", async () => {
    const states: LiveTraceStateEvent[] = [];
    const session = new LiveTraceSession(
      {
        target: createTarget(),
        onState: (state) => states.push(state),
      },
      {
        prepareCfSession: vi.fn(async () => undefined),
        ensureSshEnabled: vi.fn(async () => undefined),
        tryStartNodeInspector: vi.fn(async () => false),
        openInspectorTunnel: vi.fn(async (): Promise<TunnelOpenResult> => ({ status: "not-reachable" })),
        connectInspector: vi.fn(),
      },
    );

    await expect(session.start({ maxBodyBytes: 4096 })).rejects.toThrow(
      "Node Inspector is not reachable on 127.0.0.1:9229.",
    );

    expect(states.at(-1)).toEqual(
      expect.objectContaining({
        state: "error",
        message: "Node Inspector is not reachable on 127.0.0.1:9229.",
      }),
    );
  });

  it("logs inspector startup diagnostics before reporting an unreachable tunnel", async () => {
    const logs: string[] = [];
    const inspectorStartup: InspectorStartupResult = {
      status: "not-ready",
      detail: "saptools-inspector-node-not-found",
    };
    const session = new LiveTraceSession(
      {
        target: createTarget(),
        onLog: (message) => logs.push(message),
      },
      {
        prepareCfSession: vi.fn(async () => undefined),
        ensureSshEnabled: vi.fn(async () => undefined),
        tryStartNodeInspector: vi.fn(async () => inspectorStartup),
        openInspectorTunnel: vi.fn(async (): Promise<TunnelOpenResult> => ({ status: "not-reachable" })),
        connectInspector: vi.fn(),
      },
    );

    await expect(session.start({ maxBodyBytes: 4096 })).rejects.toThrow("Node Inspector is not reachable");

    expect(logs).toEqual([
      "Node Inspector startup was not confirmed for orders-api: saptools-inspector-node-not-found",
      "Live Trace startup failed for orders-api: Node Inspector is not reachable on 127.0.0.1:9229.",
    ]);
  });

  it("stops the tunnel even when inspector close fails during cleanup", async () => {
    let pollCallback: (() => void) | undefined;
    const logs: string[] = [];
    const tunnelStop = vi.fn();
    const client: InspectorRuntimeClient = {
      evaluate: vi.fn(async () => ({ installed: true })),
      close: vi.fn(async () => {
        throw new Error("close failed");
      }),
    };
    const session = new LiveTraceSession(
      {
        target: createTarget(),
        onLog: (message) => logs.push(message),
      },
      createReadyDependencies(client, (callback) => {
        pollCallback = callback;
      }, tunnelStop),
    );

    await session.start({ maxBodyBytes: 4096 });
    pollCallback?.();
    await session.stop({ uninstallRuntimeHook: true, reason: "user" });

    expect(tunnelStop).toHaveBeenCalledTimes(1);
    expect(logs).toEqual(["Live Trace inspector close failed for orders-api: close failed"]);
  });

  it("logs tunnel cleanup failures without throwing during stop", async () => {
    const logs: string[] = [];
    const tunnelStop = vi.fn(() => {
      throw new Error("kill failed");
    });
    const client: InspectorRuntimeClient = {
      evaluate: vi.fn(async () => ({ installed: true })),
      close: vi.fn(async () => undefined),
    };
    const session = new LiveTraceSession(
      {
        target: createTarget(),
        onLog: (message) => logs.push(message),
      },
      createReadyDependencies(client, () => {
        return;
      }, tunnelStop),
    );

    await session.start({ maxBodyBytes: 4096 });
    await session.stop({ uninstallRuntimeHook: true, reason: "user" });

    expect(logs).toEqual(["Live Trace tunnel cleanup failed for orders-api: kill failed"]);
  });

  it("stops idempotently when no runtime hook is running", async () => {
    const states: LiveTraceStateEvent[] = [];
    const session = new LiveTraceSession({
      target: createTarget(),
      onState: (state) => states.push(state),
    });

    await session.stop({ uninstallRuntimeHook: true, reason: "user" });

    expect(states).toEqual([
      expect.objectContaining({ state: "stopped", runtimeHookInstalled: false }),
    ]);
  });
});

function createTarget(): ConstructorParameters<typeof LiveTraceSession>[0]["target"] {
  return {
    apiEndpoint: "https://api.example.com",
    email: "user@example.com",
    password: "secret",
    org: "demo-org",
    space: "dev",
    app: "orders-api",
    instanceIndex: 0,
  };
}

function createReadyDependencies(
  client: InspectorRuntimeClient,
  onInterval: (callback: () => void) => void,
  tunnelStop = vi.fn(),
): ConstructorParameters<typeof LiveTraceSession>[1] {
  return {
    prepareCfSession: vi.fn(async () => undefined),
    ensureSshEnabled: vi.fn(async () => undefined),
    tryStartNodeInspector: vi.fn(async () => true),
    openInspectorTunnel: vi.fn(async (): Promise<TunnelOpenResult> => ({
      status: "ready",
      handle: { localPort: 51234, stop: tunnelStop },
    })),
    connectInspector: vi.fn(async () => client),
    setInterval: vi.fn((callback: () => void) => {
      onInterval(callback);
      return 10 as unknown as NodeJS.Timeout;
    }),
    clearInterval: vi.fn(),
  };
}
