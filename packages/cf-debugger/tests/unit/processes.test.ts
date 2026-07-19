import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isPidAlive: vi.fn(),
  isProcessGroupAlive: vi.fn(),
}));

vi.mock("../../src/state.js", () => ({
  isPidAlive: mocks.isPidAlive,
  isProcessGroupAlive: mocks.isProcessGroupAlive,
}));

const { terminatePidOrGroup } = await import("../../src/debug-session/processes.js");

describe("tunnel process termination", () => {
  beforeEach((): void => {
    vi.useFakeTimers();
    mocks.isPidAlive.mockReturnValue(false);
  });

  afterEach((): void => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.runIf(process.platform !== "win32")(
    "returns still-alive when a pinned group survives SIGKILL",
    async (): Promise<void> => {
      mocks.isProcessGroupAlive.mockReturnValue(true);
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
      const termination = terminatePidOrGroup(44_001, 200);

      await vi.runAllTimersAsync();

      await expect(termination).resolves.toBe("still-alive");
      expect(killSpy).toHaveBeenCalledWith(-44_001, "SIGTERM");
      expect(killSpy).toHaveBeenCalledWith(-44_001, "SIGKILL");
      expect(killSpy).not.toHaveBeenCalledWith(44_001, "SIGKILL");
    },
  );

  it.runIf(process.platform !== "win32")(
    "returns terminated when SIGKILL ends the pinned group",
    async (): Promise<void> => {
      let groupAlive = true;
      mocks.isProcessGroupAlive.mockImplementation(() => groupAlive);
      const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (pid === -44_001 && signal === "SIGKILL") {
          groupAlive = false;
        }
        return true;
      });
      const termination = terminatePidOrGroup(44_001, 200);

      await vi.runAllTimersAsync();

      await expect(termination).resolves.toBe("terminated");
      expect(killSpy).toHaveBeenCalledWith(-44_001, "SIGTERM");
      expect(killSpy).toHaveBeenCalledWith(-44_001, "SIGKILL");
      expect(killSpy).not.toHaveBeenCalledWith(44_001, "SIGKILL");
    },
  );
});
