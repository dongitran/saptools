import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { CdpClient, createNodeWorkerClient } from "../../src/cdp/client.js";
import type { CdpTransport } from "../../src/cdp/client.js";
import { CfInspectorError } from "../../src/types.js";

class MockTransport extends EventEmitter {
  public sent: string[] = [];
  public closed = false;
  public readyState = 1;

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    this.closed = true;
    this.emit("close");
  }

  // satisfy CdpTransport via EventEmitter on/off
  public override on(event: string, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }
  public override off(event: string, listener: (...args: unknown[]) => void): this {
    return super.off(event, listener);
  }

  // helper
  receive(message: object): void {
    this.emit("message", JSON.stringify(message));
  }
}

async function connect(): Promise<{ client: CdpClient; transport: MockTransport }> {
  const transport = new MockTransport();
  const client = await CdpClient.connect({
    url: "ws://test",
    transportFactory: async (): Promise<CdpTransport> => transport as unknown as CdpTransport,
    requestTimeoutMs: 200,
  });
  return { client, transport };
}

describe("CdpClient", () => {
  it("correlates request and response by id", async () => {
    const { client, transport } = await connect();
    const sendPromise = client.send("Debugger.enable");
    expect(transport.sent).toHaveLength(1);
    const sentRaw = transport.sent[0];
    expect(sentRaw).toBeDefined();
    const parsed = JSON.parse(sentRaw!) as { id: number; method: string };
    expect(parsed.method).toBe("Debugger.enable");
    transport.receive({ id: parsed.id, result: { ok: true } });
    await expect(sendPromise).resolves.toEqual({ ok: true });
    client.dispose();
  });

  it("rejects with CfInspectorError on protocol error reply", async () => {
    const { client, transport } = await connect();
    const sendPromise = client.send("Bogus.method");
    const parsed = JSON.parse(transport.sent[0] ?? "{}") as { id: number };
    transport.receive({ id: parsed.id, error: { code: -32601, message: "method not found" } });
    await expect(sendPromise).rejects.toBeInstanceOf(CfInspectorError);
    client.dispose();
  });

  it("times out a hung request with CDP_REQUEST_FAILED", async () => {
    const { client } = await connect();
    await expect(client.send("Stuck.method")).rejects.toMatchObject({
      code: "CDP_REQUEST_FAILED",
    });
    client.dispose();
  });

  it("emits subscribed events to listeners", async () => {
    const { client, transport } = await connect();
    const handler = vi.fn();
    client.on("Debugger.paused", handler);
    transport.receive({ method: "Debugger.paused", params: { reason: "breakpoint" } });
    expect(handler).toHaveBeenCalledWith({ reason: "breakpoint" });
    client.dispose();
  });

  it("waitFor resolves when a matching event arrives", async () => {
    const { client, transport } = await connect();
    const promise = client.waitFor<{ reason: string }>("Debugger.paused", {
      timeoutMs: 200,
      predicate: (params) => params.reason === "breakpoint",
    });
    transport.receive({ method: "Debugger.paused", params: { reason: "step" } });
    transport.receive({ method: "Debugger.paused", params: { reason: "breakpoint" } });
    await expect(promise).resolves.toEqual({ reason: "breakpoint" });
    client.dispose();
  });

  it("waitFor rejects with BREAKPOINT_NOT_HIT on timeout", async () => {
    const { client } = await connect();
    await expect(
      client.waitFor("Debugger.paused", { timeoutMs: 50 }),
    ).rejects.toMatchObject({ code: "BREAKPOINT_NOT_HIT" });
    client.dispose();
  });

  it("waitFor rejects immediately when its signal is already aborted", async () => {
    const { client } = await connect();
    const controller = new AbortController();
    controller.abort();

    await expect(client.waitFor("Debugger.paused", {
      timeoutMs: 200,
      signal: controller.signal,
    })).rejects.toMatchObject({ code: "ABORTED" });
    client.dispose();
  });

  it("waitFor rejects when its signal aborts during an active wait", async () => {
    const { client } = await connect();
    const controller = new AbortController();
    const pending = client.waitFor("Debugger.paused", {
      timeoutMs: 200,
      signal: controller.signal,
    });

    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    client.dispose();
  });

  it("cleans up an aborted wait so the client can wait for the same event again", async () => {
    const { client, transport } = await connect();
    const controller = new AbortController();
    const aborted = client.waitFor("Debugger.paused", {
      timeoutMs: 200,
      signal: controller.signal,
    });
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ code: "ABORTED" });

    const next = client.waitFor<{ reason: string }>("Debugger.paused", { timeoutMs: 200 });
    transport.receive({ method: "Debugger.paused", params: { reason: "step" } });

    await expect(next).resolves.toEqual({ reason: "step" });
    client.dispose();
  });

  it("rejects pending requests when the transport closes", async () => {
    const { client, transport } = await connect();
    const promise = client.send("Debugger.enable");
    transport.emit("close");
    await expect(promise).rejects.toBeInstanceOf(CfInspectorError);
    expect(client.isClosed).toBe(true);
  });

  it("sending after dispose throws", async () => {
    const { client } = await connect();
    client.dispose();
    await expect(client.send("Debugger.enable")).rejects.toBeInstanceOf(CfInspectorError);
  });

  it("waitFor on a disposed client rejects with INSPECTOR_CONNECTION_FAILED", async () => {
    const { client } = await connect();
    client.dispose();
    await expect(client.waitFor("Debugger.paused", { timeoutMs: 50 })).rejects.toBeInstanceOf(
      CfInspectorError,
    );
  });

  it("rejects send when the transport throws synchronously", async () => {
    const transport = new MockTransport();
    const client = await CdpClient.connect({
      url: "ws://test",
      transportFactory: async () => transport as unknown as CdpTransport,
      requestTimeoutMs: 200,
    });
    transport.send = (): void => {
      throw new Error("transport down");
    };
    await expect(client.send("Debugger.enable")).rejects.toMatchObject({
      code: "CDP_REQUEST_FAILED",
    });
    client.dispose();
  });

  it("dispose is idempotent", async () => {
    const { client } = await connect();
    client.dispose();
    client.dispose();
    expect(client.isClosed).toBe(true);
  });

  it("onClose fires for an already-closed client", async () => {
    const { client } = await connect();
    client.dispose();
    const handler = vi.fn();
    client.onClose(handler);
    await new Promise((r) => setTimeout(r, 0));
    expect(handler).toHaveBeenCalled();
  });

  it("onClose fires when the transport later closes", async () => {
    const { client, transport } = await connect();
    const handler = vi.fn();
    const off = client.onClose(handler);
    transport.emit("close");
    expect(handler).toHaveBeenCalled();
    off();
  });

  it("forwards connectTimeoutMs to the transport factory so the WS handshake cannot hang forever", async () => {
    const factoryArgs: { url: string; options: unknown }[] = [];
    const transport = new MockTransport();
    await CdpClient.connect({
      url: "ws://test",
      transportFactory: async (url, options): Promise<CdpTransport> => {
        factoryArgs.push({ url, options });
        return transport as unknown as CdpTransport;
      },
      connectTimeoutMs: 1234,
    });
    expect(factoryArgs).toHaveLength(1);
    expect(factoryArgs[0]?.options).toEqual({ connectTimeoutMs: 1234 });
  });

  it("omits connectTimeoutMs from factory options when not provided", async () => {
    const factoryArgs: { url: string; options: unknown }[] = [];
    const transport = new MockTransport();
    await CdpClient.connect({
      url: "ws://test",
      transportFactory: async (url, options): Promise<CdpTransport> => {
        factoryArgs.push({ url, options });
        return transport as unknown as CdpTransport;
      },
    });
    expect(factoryArgs[0]?.options).toEqual({});
  });

  it("treats a throwing predicate as a rejection so the message pipeline keeps running", async () => {
    const { client, transport } = await connect();
    let predicateCalls = 0;
    const promise = client.waitFor<{ reason: string }>("Debugger.paused", {
      timeoutMs: 200,
      predicate: (params) => {
        predicateCalls += 1;
        if (params.reason === "boom") {
          throw new Error("predicate exploded");
        }
        return params.reason === "ok";
      },
    });
    transport.receive({ method: "Debugger.paused", params: { reason: "boom" } });
    transport.receive({ method: "Debugger.paused", params: { reason: "ok" } });
    await expect(promise).resolves.toEqual({ reason: "ok" });
    expect(predicateCalls).toBe(2);
    client.dispose();
  });

  it("does not crash the message pipeline when a subscribed listener throws", async () => {
    const { client, transport } = await connect();
    const settled: unknown[] = [];
    client.on("Debugger.paused", () => {
      throw new Error("listener exploded");
    });
    client.on("Debugger.paused", (params) => {
      settled.push(params);
    });
    // Without safeEmit, the first listener's throw would prevent later
    // listeners (and, more importantly, response correlation on subsequent
    // messages) from running.
    transport.receive({ method: "Debugger.paused", params: { reason: "x" } });
    expect(settled).toEqual([{ reason: "x" }]);
    // Subsequent request/response must still complete.
    const sendPromise = client.send("Debugger.enable");
    const parsed = JSON.parse(transport.sent[0] ?? "{}") as { id: number };
    transport.receive({ id: parsed.id, result: { ok: true } });
    await expect(sendPromise).resolves.toEqual({ ok: true });
    client.dispose();
  });

  it("routes nested worker requests through NodeWorker.sendMessageToWorker", async () => {
    const { client: parent, transport } = await connect();
    const worker = await createNodeWorkerClient(parent, "worker-session-1");
    const resultPromise = worker.send("Runtime.evaluate", { expression: "workerValue" });
    const outer = JSON.parse(transport.sent[0] ?? "{}") as {
      id?: number;
      method?: string;
      params?: { sessionId?: string; message?: string };
    };
    expect(outer.method).toBe("NodeWorker.sendMessageToWorker");
    expect(outer.params?.sessionId).toBe("worker-session-1");
    const inner = JSON.parse(outer.params?.message ?? "{}") as { id?: number; method?: string };
    expect(inner.method).toBe("Runtime.evaluate");
    transport.receive({ id: outer.id, result: {} });
    transport.receive({
      method: "NodeWorker.receivedMessageFromWorker",
      params: {
        sessionId: "worker-session-1",
        message: JSON.stringify({ id: inner.id, result: { result: { value: 42 } } }),
      },
    });
    await expect(resultPromise).resolves.toEqual({ result: { value: 42 } });
    worker.dispose();
    parent.dispose();
  });

  it("isolates nested worker events by session id", async () => {
    const { client: parent, transport } = await connect();
    const first = await createNodeWorkerClient(parent, "worker-session-1");
    const second = await createNodeWorkerClient(parent, "worker-session-2");
    const firstListener = vi.fn();
    const secondListener = vi.fn();
    first.on("Debugger.paused", firstListener);
    second.on("Debugger.paused", secondListener);
    transport.receive({
      method: "NodeWorker.receivedMessageFromWorker",
      params: {
        sessionId: "worker-session-2",
        message: JSON.stringify({ method: "Debugger.paused", params: { reason: "other" } }),
      },
    });
    expect(firstListener).not.toHaveBeenCalled();
    expect(secondListener).toHaveBeenCalledWith({ reason: "other" });
    first.dispose();
    second.dispose();
    parent.dispose();
  });

  it("closes only the matching nested client when a worker detaches", async () => {
    const { client: parent, transport } = await connect();
    const first = await createNodeWorkerClient(parent, "worker-session-1");
    const second = await createNodeWorkerClient(parent, "worker-session-2");
    transport.receive({
      method: "NodeWorker.detachedFromWorker",
      params: { sessionId: "worker-session-1" },
    });
    expect(first.isClosed).toBe(true);
    expect(second.isClosed).toBe(false);
    expect(parent.isClosed).toBe(false);
    second.dispose();
    parent.dispose();
  });
});
