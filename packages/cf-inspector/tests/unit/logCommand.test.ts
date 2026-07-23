import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CdpClient } from "../../src/cdp/client.js";
import type {
  CdpTransport,
  CdpTransportEventMap,
} from "../../src/cdp/client.js";
import { internalsForTesting } from "../../src/cli/commands/log.js";
import type { InspectorSession, InspectorSessionGroup } from "../../src/inspector/types.js";

interface SentMessage {
  readonly id: number;
  readonly method: string;
}

class CommandTransport extends EventEmitter implements CdpTransport {
  public readonly sent: SentMessage[] = [];
  public readyState = 1;
  private closed = false;

  public constructor(private readonly holdCompile: boolean) {
    super();
  }

  public send(payload: string): void {
    const message = JSON.parse(payload) as SentMessage;
    this.sent.push(message);
    if (this.holdCompile && message.method === "Runtime.compileScript") {
      return;
    }
    const result = message.method === "Debugger.setBreakpointByUrl"
      ? { breakpointId: `bp-${message.id.toString()}`, locations: [] }
      : {};
    queueMicrotask(() => {
      this.emit("message", JSON.stringify({ id: message.id, result }));
    });
  }

  public close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.readyState = 3;
    this.emit("close");
  }

  public override on<E extends keyof CdpTransportEventMap>(
    event: E,
    listener: CdpTransportEventMap[E],
  ): this {
    return super.on(event, listener);
  }

  public override off<E extends keyof CdpTransportEventMap>(
    event: E,
    listener: CdpTransportEventMap[E],
  ): this {
    return super.off(event, listener);
  }
}

class LogSessionGroup implements InspectorSessionGroup {
  public readonly targetIndex = 0;
  public readonly targetCount = 1;
  public readonly workerDiscoverySupported = true;
  private readonly sessions: InspectorSession[] = [];
  private readonly sessionListeners = new Set<(session: InspectorSession) => void>();
  private readonly removedListeners = new Set<(session: InspectorSession) => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();

  public add(session: InspectorSession): void {
    this.sessions.push(session);
  }

  public remove(session: InspectorSession): void {
    const index = this.sessions.indexOf(session);
    if (index >= 0) {
      this.sessions.splice(index, 1);
    }
    for (const listener of this.removedListeners) {
      listener(session);
    }
    session.client.dispose();
  }

  public fail(error: Error): void {
    for (const listener of this.errorListeners) {
      listener(error);
    }
  }

  public list(): readonly InspectorSession[] {
    return this.sessions;
  }

  public onSession(listener: (session: InspectorSession) => void): () => void {
    this.sessionListeners.add(listener);
    for (const session of this.sessions) {
      listener(session);
    }
    return (): void => {
      this.sessionListeners.delete(listener);
    };
  }

  public onSessionRemoved(listener: (session: InspectorSession) => void): () => void {
    this.removedListeners.add(listener);
    return (): void => {
      this.removedListeners.delete(listener);
    };
  }

  public onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener);
    return (): void => {
      this.errorListeners.delete(listener);
    };
  }

  public dispose(): Promise<void> {
    return Promise.resolve();
  }
}

const writeErrorSpy = vi.spyOn(process.stderr, "write");

afterEach(() => {
  writeErrorSpy.mockReset();
});

async function makeSession(
  id: string,
  holdCompile: boolean,
  isolate: NonNullable<InspectorSession["isolate"]>,
): Promise<{ readonly session: InspectorSession; readonly transport: CommandTransport }> {
  const transport = new CommandTransport(holdCompile);
  const client = await CdpClient.connect({
    url: `ws://${id}`,
    transportFactory: (): Promise<CdpTransport> => Promise.resolve(transport),
    requestTimeoutMs: 1_000,
  });
  return {
    session: {
      client,
      target: {
        description: "",
        id,
        title: id,
        type: "node",
        url: `file:///${id}.mjs`,
        webSocketDebuggerUrl: `ws://${id}`,
      },
      isolate,
      scripts: new Map(),
      pauseBuffer: [],
      pauseWaitGate: { active: false },
      debuggerState: {},
      dispose: async (): Promise<void> => {
        client.dispose();
      },
    },
    transport,
  };
}

describe("log command readiness", () => {
  it("does not emit readiness when an initially pending worker detaches", async () => {
    let stderr = "";
    writeErrorSpy.mockImplementation((chunk: string | Uint8Array): boolean => {
      stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    });
    const group = new LogSessionGroup();
    const main = await makeSession("main", false, { kind: "main" });
    const worker = await makeSession("worker", true, { kind: "worker", workerId: "1" });
    group.add(main.session);
    group.add(worker.session);
    const pending = internalsForTesting.runLogGroup(group, {
      location: { file: "worker.mjs", line: 1 },
      expression: "value",
      remoteRoot: { kind: "none" },
      durationMs: 500,
      maxValueLength: 100,
      json: true,
      emitReadyEvent: true,
      signal: new AbortController().signal,
    });
    await vi.waitFor(() => {
      expect(main.transport.sent.some((message) =>
        message.method === "Debugger.setBreakpointByUrl")).toBe(true);
      expect(worker.transport.sent.some((message) =>
        message.method === "Runtime.compileScript")).toBe(true);
    });

    group.remove(worker.session);

    await expect(pending).rejects.toMatchObject({
      code: "INSPECTOR_CONNECTION_FAILED",
      message: expect.stringContaining("detached before logpoint arming"),
    });
    expect(stderr).not.toContain('"event":"breakpoint-armed"');
    main.session.client.dispose();
  });

  it("does not emit readiness when the session group fails during arming", async () => {
    let stderr = "";
    writeErrorSpy.mockImplementation((chunk: string | Uint8Array): boolean => {
      stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    });
    const group = new LogSessionGroup();
    const main = await makeSession("main", true, { kind: "main" });
    group.add(main.session);
    const pending = internalsForTesting.runLogGroup(group, {
      location: { file: "worker.mjs", line: 1 },
      expression: "value",
      remoteRoot: { kind: "none" },
      durationMs: 500,
      maxValueLength: 100,
      json: true,
      emitReadyEvent: true,
      signal: new AbortController().signal,
    });
    await vi.waitFor(() => {
      expect(main.transport.sent.some((message) =>
        message.method === "Runtime.compileScript")).toBe(true);
    });

    group.fail(new Error("worker attach failure during initial arming"));
    main.session.client.dispose();

    await expect(pending).rejects.toThrow("worker attach failure during initial arming");
    expect(stderr).not.toContain('"event":"breakpoint-armed"');
  });

  it("keeps the pre-existing default stream behavior when a session-group error occurs", async () => {
    const group = new LogSessionGroup();
    const main = await makeSession("main", false, { kind: "main" });
    group.add(main.session);
    const pending = internalsForTesting.runLogGroup(group, {
      location: { file: "worker.mjs", line: 1 },
      expression: "value",
      remoteRoot: { kind: "none" },
      durationMs: 100,
      maxValueLength: 100,
      json: true,
      emitReadyEvent: false,
      signal: new AbortController().signal,
    });
    await vi.waitFor(() => {
      expect(main.transport.sent.some((message) =>
        message.method === "Debugger.setBreakpointByUrl")).toBe(true);
    });

    group.fail(new Error("ignored late-worker attach error"));

    await expect(pending).resolves.toMatchObject({
      emitted: 0,
      stoppedReason: "duration",
    });
    main.session.client.dispose();
  });
});
