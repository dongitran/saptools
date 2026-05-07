import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { CdpClient } from "../../src/cdp/client.js";
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
});
