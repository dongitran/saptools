import { describe, expect, it, vi } from "vitest";

import { LiveTraceSession } from "../../src/session.js";
import type {
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

    await session.start({ maxBodyBytes: 4096 });

    expect(states.at(-1)).toEqual(
      expect.objectContaining({
        state: "error",
        message: "Node Inspector is not reachable on 127.0.0.1:9229.",
      }),
    );
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
): ConstructorParameters<typeof LiveTraceSession>[1] {
  return {
    prepareCfSession: vi.fn(async () => undefined),
    ensureSshEnabled: vi.fn(async () => undefined),
    tryStartNodeInspector: vi.fn(async () => true),
    openInspectorTunnel: vi.fn(async (): Promise<TunnelOpenResult> => ({
      status: "ready",
      handle: { localPort: 51234, stop: vi.fn() },
    })),
    connectInspector: vi.fn(async () => client),
    setInterval: vi.fn((callback: () => void) => {
      onInterval(callback);
      return 10 as unknown as NodeJS.Timeout;
    }),
    clearInterval: vi.fn(),
  };
}
