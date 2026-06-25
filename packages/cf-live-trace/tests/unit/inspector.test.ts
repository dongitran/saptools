import type { InspectorSession } from "@saptools/cf-inspector";
import { describe, expect, it, vi } from "vitest";

const inspectorMocks = vi.hoisted(() => ({
  connectInspector: vi.fn(),
}));

vi.mock("@saptools/cf-inspector", () => inspectorMocks);

describe("inspector runtime client", () => {
  it("evaluates Runtime expressions with awaitPromise and returnByValue", async () => {
    const { connectRuntimeInspector } = await import("../../src/inspector.js");
    const send = vi.fn(async () => ({ result: { value: { ok: true } } }));
    const dispose = vi.fn(async () => {
      return;
    });
    inspectorMocks.connectInspector.mockResolvedValue({ client: { send }, dispose } as unknown as InspectorSession);

    const client = await connectRuntimeInspector(51234);
    const value = await client.evaluate("globalThis.answer", 1000);
    await client.close();

    expect(inspectorMocks.connectInspector).toHaveBeenCalledWith({ port: 51234, host: "127.0.0.1" });
    expect(value).toEqual({ ok: true });
    expect(send).toHaveBeenCalledWith(
      "Runtime.evaluate",
      expect.objectContaining({
        expression: "globalThis.answer",
        awaitPromise: true,
        returnByValue: true,
      }),
    );
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("throws a generic error when Runtime.evaluate reports exception details", async () => {
    const { connectRuntimeInspector } = await import("../../src/inspector.js");
    const send = vi.fn(async () => ({ exceptionDetails: { text: "ReferenceError" } }));
    inspectorMocks.connectInspector.mockResolvedValue({
      client: { send },
      dispose: vi.fn(async () => {
        return;
      }),
    } as unknown as InspectorSession);

    const client = await connectRuntimeInspector(51235);

    await expect(client.evaluate("missingReference", 1000)).rejects.toThrow("Runtime.evaluate failed.");
  });
});
