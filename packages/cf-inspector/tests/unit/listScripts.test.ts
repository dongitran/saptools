import { afterEach, describe, expect, it, vi } from "vitest";

import {
  compileScriptUrlFilter,
  warnOnListScriptsSelection,
} from "../../src/cli/commands/listScripts.js";

const writeErrorSpy = vi.spyOn(process.stderr, "write");

afterEach(() => {
  writeErrorSpy.mockReset();
});

function captureStderr(fn: () => void): string {
  let output = "";
  writeErrorSpy.mockImplementation((chunk: string | Uint8Array): boolean => {
    output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  });
  fn();
  return output;
}

describe("list-scripts filtering", () => {
  it("matches escaped literal characters in script URL patterns", () => {
    const filter = compileScriptUrlFilter("sample-app\\.mjs");

    expect(filter?.("file:///repo/packages/cf-inspector/tests/e2e/fixtures/sample-app.mjs")).toBe(true);
    expect(filter?.("file:///repo/packages/cf-inspector/tests/e2e/fixtures/sample-appxmjs")).toBe(false);
  });

  it("supports documented wildcard and alternative script URL patterns without RegExp input", () => {
    const wildcard = compileScriptUrlFilter("dist/.+\\.js");
    const alternative = compileScriptUrlFilter("/home/vcap/app|ValidatePayloadWorker");

    expect(wildcard?.("file:///home/vcap/app/dist/service.js")).toBe(true);
    expect(wildcard?.("file:///home/vcap/app/dist/.js")).toBe(false);
    expect(alternative?.("file:///home/vcap/app/srv/server.js")).toBe(true);
    expect(alternative?.("worker://ValidatePayloadWorker/index.js")).toBe(true);
  });

  it("treats unsupported regex metacharacters as literals", () => {
    const filter = compileScriptUrlFilter("[sample]");

    expect(filter?.("file:///tmp/[sample]/app.js")).toBe(true);
    expect(filter?.("file:///tmp/sample/app.js")).toBe(false);
  });

  it("ignores empty alternatives instead of matching every script URL", () => {
    const filter = compileScriptUrlFilter("|sample-app\\.mjs|");

    expect(filter?.("file:///tmp/sample-app.mjs")).toBe(true);
    expect(filter?.("file:///tmp/other.mjs")).toBe(false);
  });
});

describe("list-scripts selection diagnostics", () => {
  const workerTargets = [{
    sessionId: "session-1",
    workerId: "1",
    type: "worker",
    title: "[worker 1]",
    url: "file:///app/worker.mjs",
  }];

  it("retains the implicit raw-target notice while suppressing obsolete worker advice during fan-out", () => {
    const output = captureStderr(() => {
      warnOnListScriptsSelection(
        { kind: "port", port: 9229, host: "127.0.0.1" },
        { targetCount: 2, targetIndex: 0, workerTargets },
      );
    });

    expect(output).toContain("target 0 of 2");
    expect(output).not.toContain("main isolate");
  });

  it("retains single-isolate worker advice when --target explicitly narrows the command", () => {
    const output = captureStderr(() => {
      warnOnListScriptsSelection(
        { kind: "port", port: 9229, host: "127.0.0.1", targetIndex: 1 },
        { targetCount: 2, targetIndex: 1, workerTargets },
      );
    });

    expect(output).not.toContain("target 1 of 2");
    expect(output).toContain("main isolate");
    expect(output).toContain("--worker-id <id>");
  });
});
