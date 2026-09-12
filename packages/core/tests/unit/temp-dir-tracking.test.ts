import { describe, expect, it, vi } from "vitest";

import { trackTempDir, untrackTempDir, __resetTempDirTrackingForTests, __runTrackedCleanupForTests } from "../../src/temp-dir-tracking.js";

describe("temp-dir-tracking", () => {
  afterEachReset();

  function afterEachReset(): void {
    // no beforeEach hook file-level import cycle needed — reset is called explicitly at the top of each test
  }

  it("cleans up every tracked directory when the process-level cleanup runs", async () => {
    __resetTempDirTrackingForTests();
    // eslint-disable-next-line @typescript-eslint/no-empty-function -- Intentional: vitest spy mock
    const rm = vi.fn(async () => {});
    trackTempDir("/tmp/a", rm);
    trackTempDir("/tmp/b", rm);

    await __runTrackedCleanupForTests();

    expect(rm).toHaveBeenCalledWith("/tmp/a");
    expect(rm).toHaveBeenCalledWith("/tmp/b");
    expect(rm).toHaveBeenCalledTimes(2);
  });

  it("does not clean up a directory that was explicitly untracked", async () => {
    __resetTempDirTrackingForTests();
    // eslint-disable-next-line @typescript-eslint/no-empty-function -- Intentional: vitest spy mock
    const rm = vi.fn(async () => {});
    trackTempDir("/tmp/a", rm);
    untrackTempDir("/tmp/a");

    await __runTrackedCleanupForTests();

    expect(rm).not.toHaveBeenCalled();
  });

  it("tolerates one directory's cleanup throwing, and still cleans up the rest", async () => {
    __resetTempDirTrackingForTests();
    const rm = vi.fn(async (path: string) => {
      if (path === "/tmp/a") {throw new Error("boom");}
    });
    trackTempDir("/tmp/a", rm);
    trackTempDir("/tmp/b", rm);

    await expect(__runTrackedCleanupForTests()).resolves.toBeUndefined();
    expect(rm).toHaveBeenCalledWith("/tmp/b");
  });

  it("installs signal handlers on first trackTempDir call", () => {
    __resetTempDirTrackingForTests();
    const processSpy = vi.spyOn(process, "once");
    // eslint-disable-next-line @typescript-eslint/no-empty-function -- Intentional: vitest spy mock
    const rm = vi.fn(async () => {});

    trackTempDir("/tmp/test", rm);

    expect(processSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(processSpy).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
    processSpy.mockRestore();
  });

  it("does not re-install signal handlers on subsequent trackTempDir calls", () => {
    __resetTempDirTrackingForTests();
    const processSpy = vi.spyOn(process, "once");
    // eslint-disable-next-line @typescript-eslint/no-empty-function -- Intentional: vitest spy mock
    const rm = vi.fn(async () => {});

    trackTempDir("/tmp/a", rm);
    const firstCallCount = processSpy.mock.calls.length;
    trackTempDir("/tmp/b", rm);
    const secondCallCount = processSpy.mock.calls.length;

    expect(secondCallCount).toBe(firstCallCount);
    processSpy.mockRestore();
  });

  it("signal handler runs cleanup and exits on SIGINT", async () => {
    __resetTempDirTrackingForTests();
    // eslint-disable-next-line @typescript-eslint/no-empty-function -- Intentional: vitest spy mock
    const rm = vi.fn(async () => {});
    const processSpy = vi.spyOn(process, "once");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    trackTempDir("/tmp/test", rm);

    // Capture and call the SIGINT handler
    const sigintHandler = processSpy.mock.calls.find(
      (call) => call[0] === "SIGINT",
    )?.[1] as ((this: NodeJS.Process) => void) | undefined;
    expect(sigintHandler).toBeDefined();

    if (sigintHandler) {
      // Give the async cleanup a moment to complete
      sigintHandler.call(process);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(rm).toHaveBeenCalledWith("/tmp/test");
    expect(exitSpy).toHaveBeenCalledWith(1);
    processSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
