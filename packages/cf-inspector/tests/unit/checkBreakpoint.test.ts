import { describe, expect, it, vi } from "vitest";

import type { CdpClient } from "../../src/cdp/client.js";
import { internalsForTesting } from "../../src/cli/commands/checkBreakpoint.js";
import type { InspectorSession } from "../../src/inspector/types.js";

function sessionWithScript(response: unknown): InspectorSession {
  return {
    client: {
      send: vi.fn(async (): Promise<unknown> => response),
    } as unknown as CdpClient,
    target: { id: "target", type: "node" } as never,
    isolate: { kind: "worker", workerId: "42" },
    scripts: new Map([["script-1", {
      scriptId: "script-1",
      url: "file:///home/vcap/app/dist/handler.js",
    }]]),
    pauseBuffer: [],
    pauseWaitGate: { active: false },
    debuggerState: {},
    dispose: async (): Promise<void> => undefined,
  };
}

describe("breakpoint precheck", () => {
  it("reports exact breakable locations for matching loaded scripts", async () => {
    const session = sessionWithScript({
      locations: [{ scriptId: "script-1", lineNumber: 41, columnNumber: 2 }],
    });
    const checks = await internalsForTesting.checkSession(session, /dist\/handler\.js$/u, 42);

    expect(checks).toEqual([{
      isolate: { kind: "worker", workerId: "42" },
      scriptId: "script-1",
      url: "file:///home/vcap/app/dist/handler.js",
      locations: [{ scriptId: "script-1", lineNumber: 41, columnNumber: 2 }],
    }]);
  });

  it("distinguishes a loaded but unbreakable exact line", async () => {
    const session = sessionWithScript({
      locations: [{ scriptId: "script-1", lineNumber: 42, columnNumber: 0 }],
    });
    const checks = await internalsForTesting.checkSession(session, /dist\/handler\.js$/u, 42);
    expect(checks).toHaveLength(1);
    expect(checks[0]?.locations).toEqual([]);
  });

  it("returns no script checks for a file that is not loaded", async () => {
    const session = sessionWithScript({ locations: [] });
    await expect(internalsForTesting.checkSession(session, /missing\.js$/u, 42))
      .resolves.toEqual([]);
  });
});
