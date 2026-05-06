import { describe, expect, it, vi } from "vitest";

import type { InspectorSession } from "../../src/inspector/index.js";
import { captureException } from "../../src/snapshot/exception.js";
import type { PauseEvent } from "../../src/types.js";

function makeSession(
  responder: (method: string, params: Record<string, unknown>) => unknown,
): InspectorSession {
  const send = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    return responder(method, params);
  });
  return {
    client: { send } as never,
    target: { id: "t", type: "node" } as never,
    scripts: new Map(),
    pauseBuffer: [],
    pauseWaitGate: { active: false },
    debuggerState: {},
    dispose: async (): Promise<void> => undefined,
  };
}

function pauseFor(reason: string, data?: unknown): PauseEvent {
  return {
    reason,
    hitBreakpoints: [],
    callFrames: [],
    ...(data === undefined ? {} : { data }),
  };
}

describe("captureException", () => {
  it("returns undefined for non-exception pauses", async () => {
    const session = makeSession(() => ({}));
    expect(await captureException(session, pauseFor("other"), 4096)).toBeUndefined();
  });

  it("returns an explanatory error when no exception data is attached", async () => {
    const session = makeSession(() => ({}));
    const result = await captureException(session, pauseFor("exception"), 4096);
    expect(result?.error).toContain("no exception data");
  });

  it("renders a primitive string exception as a JSON-quoted value", async () => {
    const session = makeSession(() => ({}));
    const result = await captureException(
      session,
      pauseFor("exception", { type: "string", value: "boom" }),
      4096,
    );
    expect(result?.value).toBe("\"boom\"");
    expect(result?.type).toBe("string");
  });

  it("renders a primitive number exception", async () => {
    const session = makeSession(() => ({}));
    const result = await captureException(
      session,
      pauseFor("exception", { type: "number", value: 42 }),
      4096,
    );
    expect(result?.value).toBe("42");
    expect(result?.type).toBe("number");
  });

  it("walks the exception object via Runtime.getProperties and surfaces the message", async () => {
    const session = makeSession((method, params) => {
      if (method === "Runtime.getProperties") {
        const objectId = params["objectId"];
        if (objectId === "exc-1") {
          return {
            result: [
              { name: "message", value: { type: "string", value: "thing went wrong" } },
              { name: "name", value: { type: "string", value: "Error" } },
            ],
          };
        }
      }
      return {};
    });
    const result = await captureException(
      session,
      pauseFor("exception", {
        type: "object",
        description: "Error: thing went wrong",
        objectId: "exc-1",
      }),
      4096,
    );
    expect(result?.type).toBe("object");
    const parsed = JSON.parse(result?.value ?? "{}") as { message?: string; name?: string };
    expect(parsed.message).toBe("thing went wrong");
    expect(parsed.name).toBe("Error");
    expect(result?.description).toBe("thing went wrong");
  });

  it("falls back to the description when object materialization yields nothing readable", async () => {
    const session = makeSession((method) => {
      if (method === "Runtime.getProperties") {
        return { result: [] };
      }
      return {};
    });
    const result = await captureException(
      session,
      pauseFor("exception", {
        type: "object",
        description: "Error: opaque",
        objectId: "exc-2",
      }),
      4096,
    );
    expect(result?.value).toBe("Error: opaque");
    expect(result?.description).toBe("Error: opaque");
  });

  it("handles promiseRejection pauses the same way as exception pauses", async () => {
    const session = makeSession(() => ({ result: [] }));
    const result = await captureException(
      session,
      pauseFor("promiseRejection", {
        type: "object",
        description: "Rejected!",
        objectId: "exc-rej",
      }),
      4096,
    );
    expect(result?.value).toBe("Rejected!");
  });

  it("limits exception value length to maxValueLength", async () => {
    const session = makeSession(() => ({}));
    const result = await captureException(
      session,
      pauseFor("exception", { type: "string", value: "a".repeat(20) }),
      8,
    );
    expect(result?.value?.endsWith("...")).toBe(true);
    expect(result?.value?.length ?? 0).toBeLessThanOrEqual(11);
  });
});
