import { describe, expect, it } from "vitest";

import { TraceDataError } from "../../src/errors.js";
import {
  withTraceSession,
  type DisposableInspectorSession,
  type TraceSessionDependencies,
} from "../../src/session.js";

interface FakeSession extends DisposableInspectorSession {
  readonly name: string;
}

function fakeDependencies(calls: string[]): TraceSessionDependencies<FakeSession> {
  return {
    connectInspector: async (options): Promise<FakeSession> => {
      calls.push(`connect:${options.host}:${options.port.toString()}`);
      return {
        name: "session",
        dispose: async (): Promise<void> => {
          calls.push("session:dispose");
        },
      };
    },
    openCfTunnel: async (target) => {
      if (target.allowSshEnableRestart) {
        throw new Error("trace tunnel did not disable SSH enable/restart side effects");
      }
      calls.push(
        `tunnel:${target.process}:${target.instance.toString()}:` +
        `${target.nodePid?.toString() ?? "auto"}:` +
        `${target.preferredPort?.toString() ?? "auto-port"}:safe`,
      );
      return {
        localPort: 20_123,
        dispose: async (): Promise<void> => {
          calls.push("tunnel:dispose");
        },
      };
    },
  };
}

describe("trace inspector session lifecycle", () => {
  it("opens and disposes a local inspector without a CF tunnel", async () => {
    const calls: string[] = [];
    const result = await withTraceSession({
      kind: "local",
      host: "127.0.0.1",
      port: 9229,
      targetIndex: 1,
    }, async (session): Promise<string> => {
      calls.push(`callback:${session.name}`);
      return "done";
    }, fakeDependencies(calls));

    expect(result).toBe("done");
    expect(calls).toEqual([
      "connect:127.0.0.1:9229",
      "callback:session",
      "session:dispose",
    ]);
  });

  it("requires impact confirmation before opening a remote tunnel", async () => {
    const calls: string[] = [];

    await expect(withTraceSession({
      kind: "cf",
      region: "eu10",
      org: "org-a",
      space: "dev",
      app: "orders",
      process: "web",
      instance: 0,
      confirmImpact: false,
    }, async (): Promise<void> => undefined, fakeDependencies(calls))).rejects.toMatchObject({
      code: "REMOTE_IMPACT_NOT_CONFIRMED",
    });
    expect(calls).toEqual([]);
  });

  it("maps disabled CF SSH to a safe actionable trace error", async () => {
    const calls: string[] = [];
    const dependencies: TraceSessionDependencies<FakeSession> = {
      ...fakeDependencies(calls),
      openCfTunnel: async (): Promise<never> => {
        const error = new Error("credential-sentinel-from-cf-stderr");
        Object.defineProperty(error, "code", { value: "SSH_NOT_ENABLED" });
        throw error;
      },
    };

    await expect(withTraceSession({
      kind: "cf",
      region: "eu10",
      org: "org-a",
      space: "dev",
      app: "orders",
      process: "web",
      instance: 0,
      confirmImpact: true,
    }, async (): Promise<void> => undefined, dependencies)).rejects.toMatchObject({
      code: "SSH_NOT_ENABLED",
      message: "Cloud Foundry SSH is not enabled for the selected app; enable it explicitly before tracing.",
    });
  });

  it("forwards the exact CF selectors and disposes session before tunnel", async () => {
    const calls: string[] = [];
    const callbackError = new Error("callback failed");

    await expect(withTraceSession({
      kind: "cf",
      region: "eu10",
      org: "org-a",
      space: "dev",
      app: "orders",
      process: "worker",
      instance: 2,
      nodePid: 4312,
      preferredPort: 24_321,
      confirmImpact: true,
    }, async (): Promise<never> => {
      calls.push("callback");
      throw callbackError;
    }, fakeDependencies(calls))).rejects.toBe(callbackError);

    expect(calls).toEqual([
      "tunnel:worker:2:4312:24321:safe",
      "connect:127.0.0.1:20123",
      "callback",
      "session:dispose",
      "tunnel:dispose",
    ]);
  });

  it("preserves the operation and every cleanup failure", async () => {
    const calls: string[] = [];
    const operationError = new Error("operation failed");
    const sessionError = new Error("session cleanup failed");
    const tunnelError = new Error("tunnel cleanup failed");
    const dependencies: TraceSessionDependencies<FakeSession> = {
      connectInspector: async (): Promise<FakeSession> => ({
        name: "session",
        dispose: async (): Promise<never> => {
          calls.push("session:dispose");
          throw sessionError;
        },
      }),
      openCfTunnel: async () => ({
        localPort: 20_123,
        dispose: async (): Promise<never> => {
          calls.push("tunnel:dispose");
          throw tunnelError;
        },
      }),
    };
    let received: unknown;
    try {
      await withTraceSession({
        kind: "cf",
        region: "eu10",
        org: "org-a",
        space: "dev",
        app: "orders",
        process: "web",
        instance: 0,
        confirmImpact: true,
      }, async (): Promise<never> => {
        throw operationError;
      }, dependencies);
    } catch (error: unknown) {
      received = error;
    }

    expect(received).toMatchObject({ code: "CLEANUP_FAILED" });
    if (!(received instanceof TraceDataError) || !(received.cause instanceof AggregateError)) {
      throw new Error("session cleanup failures were not aggregated");
    }
    const errors: unknown = Reflect.get(received.cause, "errors");
    expect(errors).toEqual([operationError, sessionError, tunnelError]);
    expect(calls).toEqual(["session:dispose", "tunnel:dispose"]);
  });

  it("forwards cancellation to CF startup and rejects an already-aborted request", async () => {
    const calls: string[] = [];
    const controller = new AbortController();
    const dependencies = fakeDependencies(calls);
    const forwarded: AbortSignal[] = [];
    const trackedDependencies: TraceSessionDependencies<FakeSession> = {
      ...dependencies,
      openCfTunnel: async (target) => {
        if (target.signal !== undefined) {
          forwarded.push(target.signal);
        }
        return await dependencies.openCfTunnel(target);
      },
    };
    const target = {
      kind: "cf" as const,
      region: "eu10",
      org: "org-a",
      space: "dev",
      app: "orders",
      process: "web",
      instance: 0,
      confirmImpact: true,
    };

    await withTraceSession(target, async (): Promise<void> => undefined, trackedDependencies, controller.signal);
    expect(forwarded).toEqual([controller.signal]);

    const aborted = new AbortController();
    aborted.abort();
    calls.length = 0;
    await expect(withTraceSession(
      target,
      async (): Promise<void> => undefined,
      trackedDependencies,
      aborted.signal,
    )).rejects.toMatchObject({ code: "TRACE_ABORTED" });
    expect(calls).toEqual([]);
  });
});
