import { vi, describe, it, expect, beforeEach, type MockInstance } from "vitest";
import { platform, homedir } from "node:os";
import { existsSync } from "node:fs";
import { writeFile, rm } from "node:fs/promises";
import { exec, execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { Writable } from "node:stream";
import process from "node:process";

vi.mock("node:os");
vi.mock("node:fs");
vi.mock("node:fs/promises");
vi.mock("node:child_process");

// Import AFTER mocks are defined
import { cronjobEnable, cronjobDisable, cronjobStatus, runCronjob } from "../cronjob.js";

describe("cronjob management", () => {
  const mockEmail = "test@example.com";
  const mockPassword = "safe-password";

  beforeEach(() => {
    vi.resetAllMocks();
    process.env["SAP_EMAIL"] = mockEmail;
    process.env["SAP_PASSWORD"] = mockPassword;
    vi.mocked(homedir).mockReturnValue("/home/user");
  });

  // Helper to mock exec/execFile correctly for manual promises
  const setupExecMock = (
    mockFn: unknown,
    result: { stdout: string; stderr: string } = { stdout: "", stderr: "" },
    error: Error | null = null
  ): void => {
    (vi.mocked(mockFn) as MockInstance).mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1];
      if (typeof cb === "function") {
        (cb as (err: Error | null, stdout: string, stderr: string) => void)(
          error, 
          result.stdout, 
          result.stderr
        );
      }
      return {} as ChildProcess;
    });
  };

  describe("macOS (darwin)", () => {
    beforeEach(() => {
      vi.mocked(platform).mockReturnValue("darwin");
    });

    it("should enable background sync via launchd", async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      setupExecMock(execFile);

      await cronjobEnable();

      expect(writeFile).toHaveBeenCalledWith(
        expect.stringContaining("com.saptools.sync.plist"),
        expect.stringContaining("<key>Label</key><string>com.saptools.sync</string>"),
        "utf-8"
      );
      expect(execFile).toHaveBeenCalledWith("launchctl", ["load", expect.any(String)], expect.any(Function));
    });

    it("should inject email and password into generated plist", async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      setupExecMock(execFile);

      await cronjobEnable();

      const plistContent = vi.mocked(writeFile).mock.calls[0]?.[1] as string;
      expect(plistContent).toContain("<key>SAP_EMAIL</key><string>test@example.com</string>");
      expect(plistContent).toContain("<key>SAP_PASSWORD</key><string>safe-password</string>");
      expect(plistContent).toContain("<integer>900</integer>");
    });

    it("should disable background sync via launchd", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      setupExecMock(execFile);

      await cronjobDisable();

      expect(execFile).toHaveBeenCalledWith("launchctl", ["unload", expect.any(String)], expect.any(Function));
      expect(rm).toHaveBeenCalled();
    });
  });

  describe("Linux/WSL (crontab)", () => {
    beforeEach(() => {
      vi.mocked(platform).mockReturnValue("linux");
    });

    it("should enable background sync via safe crontab - stdin", async () => {
      // Mock existing empty crontab (fails l)
      setupExecMock(exec, { stdout: "", stderr: "" }, new Error("no crontab for user"));

      // Mock spawn for updateCrontab
      const writeMock = vi.fn().mockReturnValue(true);
      const endMock = vi.fn().mockImplementation(() => undefined);
      const mStdin = { write: writeMock, end: endMock } as unknown as Writable;
      
      const mChild = { 
        stdin: mStdin, 
        on: vi.fn().mockImplementation((event: string, cb: (code: number) => void) => {
          if (event === "close") cb(0);
        }) 
      } as unknown as ChildProcess;
      
      vi.mocked(spawn).mockReturnValue(mChild);

      await cronjobEnable();

      // Verify the cron entry was written to stdin
      expect(spawn).toHaveBeenCalledWith("crontab", ["-"]);
      expect(writeMock).toHaveBeenCalledWith(
        expect.stringContaining("SAP_EMAIL='test@example.com' SAP_PASSWORD='safe-password'")
      );
      expect(writeMock).toHaveBeenCalledWith(expect.stringContaining("# saptools-sync"));
    });

    it("should enable and merge with existing non-saptools crontab entries", async () => {
      // Mock existing crontab with both saptools and non-saptools entries
      const existingCrontab = "0 0 * * * daily-backup\n*/15 * * * * old-saptools # saptools-sync\n";
      setupExecMock(exec, { stdout: existingCrontab, stderr: "" });

      const writeMock = vi.fn().mockReturnValue(true);
      const endMock = vi.fn().mockImplementation(() => undefined);
      const mStdin = { write: writeMock, end: endMock } as unknown as Writable;
      const mChild = {
        stdin: mStdin,
        on: vi.fn().mockImplementation((event: string, cb: (code: number) => void) => {
          if (event === "close") cb(0);
        })
      } as unknown as ChildProcess;
      vi.mocked(spawn).mockReturnValue(mChild);

      await cronjobEnable();

      // Verify: old saptools entry removed, daily-backup preserved, new saptools entry added
      const written = writeMock.mock.calls[0]?.[0] as string;
      expect(written).toContain("daily-backup");
      expect(written).not.toContain("old-saptools");
      expect(written).toContain("# saptools-sync");
      expect(written).toContain("SAP_EMAIL");
    });

    it("should disable background sync by filtering existing crontab", async () => {
      // Mock existing crontab with saptools entry
      const existingCrontab = "0 0 * * * other-job\n*/15 * * * * node runner.js # saptools-sync\n";
      setupExecMock(exec, { stdout: existingCrontab, stderr: "" });

      const writeMock = vi.fn().mockReturnValue(true);
      const endMock = vi.fn().mockImplementation(() => undefined);
      const mStdin = { write: writeMock, end: endMock } as unknown as Writable;
      
      const mChild = { 
        stdin: mStdin, 
        on: vi.fn().mockImplementation((event: string, cb: (code: number) => void) => {
          if (event === "close") cb(0);
        }) 
      } as unknown as ChildProcess;
      
      vi.mocked(spawn).mockReturnValue(mChild);

      await cronjobDisable();

      // Verify the filtered crontab was written (only other-job remains)
      expect(writeMock).toHaveBeenCalledWith("0 0 * * * other-job\n");
    });

    it("should detect active status from crontab", async () => {
      const activeCrontab = "*/15 * * * * node runner.js # saptools-sync\n";
      setupExecMock(exec, { stdout: activeCrontab, stderr: "" });

      const consoleSpy = vi.spyOn(process.stdout, "write");
      await cronjobStatus();

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Status: active (via crontab)"));
    });
  });

  describe("Security (Shell Quoting)", () => {
    it("should escape single quotes in email/password", async () => {
      vi.mocked(platform).mockReturnValue("linux");
      process.env["SAP_EMAIL"] = "user's-email@example.com";
      process.env["SAP_PASSWORD"] = "pass'with'quotes";

      // Mock existing empty crontab to prevent exec promise from hanging
      setupExecMock(exec, { stdout: "", stderr: "" }, new Error("no crontab for user"));
      
      const writeMock = vi.fn().mockReturnValue(true);
      const endMock = vi.fn().mockImplementation(() => undefined);
      const mStdin = { write: writeMock, end: endMock } as unknown as Writable;
      
      const mChild = { 
        stdin: mStdin, 
        on: vi.fn().mockImplementation((event: string, cb: (code: number) => void) => {
          if (event === "close") cb(0);
        }) 
      } as unknown as ChildProcess;
      
      vi.mocked(spawn).mockReturnValue(mChild);

      await cronjobEnable();

      // Verify escaping: ' becomes '\''
      expect(writeMock).toHaveBeenCalledWith(
        expect.stringContaining("SAP_EMAIL='user'\\''s-email@example.com'")
      );
      expect(writeMock).toHaveBeenCalledWith(
        expect.stringContaining("SAP_PASSWORD='pass'\\''with'\\''quotes'")
      );
    });
  });

  describe("Environment validation", () => {
    it("should throw when SAP_EMAIL is missing", async () => {
      delete process.env["SAP_EMAIL"];

      await expect(cronjobEnable()).rejects.toThrow("SAP_EMAIL and SAP_PASSWORD must be set");
    });

    it("should throw when SAP_PASSWORD is missing", async () => {
      delete process.env["SAP_PASSWORD"];

      await expect(cronjobEnable()).rejects.toThrow("SAP_EMAIL and SAP_PASSWORD must be set");
    });

    it("should throw when both env vars are missing", async () => {
      delete process.env["SAP_EMAIL"];
      delete process.env["SAP_PASSWORD"];

      await expect(cronjobEnable()).rejects.toThrow("SAP_EMAIL and SAP_PASSWORD must be set");
    });
  });

  describe("Unsupported platform", () => {
    it("should throw on unsupported platform (e.g. Windows)", async () => {
      vi.mocked(platform).mockReturnValue("win32");

      await expect(cronjobEnable()).rejects.toThrow("not supported on platform");
    });
  });

  describe("macOS edge cases", () => {
    beforeEach(() => {
      vi.mocked(platform).mockReturnValue("darwin");
    });

    it("should noop disable when plist does not exist", async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      const consoleSpy = vi.spyOn(process.stdout, "write");

      await cronjobDisable();

      expect(execFile).not.toHaveBeenCalled();
      expect(rm).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Cronjob disabled"));
    });

    it("should unload existing plist before re-enabling", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      setupExecMock(execFile);

      await cronjobEnable();

      // First call = unload (from existing), second call = load (new)
      const calls = vi.mocked(execFile).mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(2);
      expect(calls[0]?.[1]).toContain("unload");
      expect(calls[1]?.[1]).toContain("load");
    });

    it("should show status as disabled when plist not found", async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      const consoleSpy = vi.spyOn(process.stdout, "write");

      await cronjobStatus();

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Status: disabled"));
    });

    it("should show active status when launchctl list succeeds", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      setupExecMock(execFile, { stdout: "PID\tStatus\tLabel\n123\t0\tcom.saptools.sync\n", stderr: "" });

      const consoleSpy = vi.spyOn(process.stdout, "write");
      await cronjobStatus();

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Status: active"));
    });

    it("should show 'plist loaded but not running' when launchctl list fails", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      setupExecMock(execFile, { stdout: "", stderr: "" }, new Error("Could not find service"));

      const consoleSpy = vi.spyOn(process.stdout, "write");
      await cronjobStatus();

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("plist loaded but job not currently running"));
    });
  });

  describe("Linux edge cases", () => {
    beforeEach(() => {
      vi.mocked(platform).mockReturnValue("linux");
    });

    it("should call crontab -r when only saptools entry remains after disable", async () => {
      // Only saptools entry exists
      const onlySaptools = "*/15 * * * * node runner.js # saptools-sync\n";
      setupExecMock(exec, { stdout: onlySaptools, stderr: "" });

      await cronjobDisable();

      // Verify crontab -r was called (exec called twice: first crontab -l, then crontab -r)
      const execCalls = vi.mocked(exec).mock.calls;
      const lastCallArgs = execCalls[execCalls.length - 1];
      expect(lastCallArgs?.[0]).toBe("crontab -r");
    });

    it("should return early when crontab -l fails (no crontab)", async () => {
      setupExecMock(exec, { stdout: "", stderr: "" }, new Error("no crontab for user"));
      const consoleSpy = vi.spyOn(process.stdout, "write");

      await cronjobDisable();

      // On Linux, when crontab -l fails, function returns early before printing
      // The "Cronjob disabled" message is still printed because it's after the platform if/else
      // Let's verify exec was called (crontab -l) but spawn was NOT (no update needed)
      expect(exec).toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it("should show disabled status when crontab has no saptools tag", async () => {
      const noSaptoolsCrontab = "0 0 * * * some-other-job\n";
      setupExecMock(exec, { stdout: noSaptoolsCrontab, stderr: "" });

      const consoleSpy = vi.spyOn(process.stdout, "write");
      await cronjobStatus();

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Status: disabled"));
    });
  });

  describe("Unsupported platform status", () => {
    it("should show not-supported message on unknown platform", async () => {
      vi.mocked(platform).mockReturnValue("freebsd");
      const consoleSpy = vi.spyOn(process.stdout, "write");

      await cronjobStatus();

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("not supported on platform"));
    });
  });

  describe("runCronjob CLI routing", () => {
    it("should route 'enable' subcommand to cronjobEnable", async () => {
      vi.mocked(platform).mockReturnValue("linux");
      setupExecMock(exec, { stdout: "", stderr: "" }, new Error("no crontab"));

      const writeMock = vi.fn().mockReturnValue(true);
      const endMock = vi.fn().mockImplementation(() => undefined);
      const mStdin = { write: writeMock, end: endMock } as unknown as Writable;
      const mChild = {
        stdin: mStdin,
        on: vi.fn().mockImplementation((event: string, cb: (code: number) => void) => {
          if (event === "close") cb(0);
        })
      } as unknown as ChildProcess;
      vi.mocked(spawn).mockReturnValue(mChild);

      await runCronjob("enable");

      expect(spawn).toHaveBeenCalledWith("crontab", ["-"]);
    });

    it("should route 'status' subcommand to cronjobStatus", async () => {
      vi.mocked(platform).mockReturnValue("linux");
      setupExecMock(exec, { stdout: "", stderr: "" }, new Error("no crontab"));
      const consoleSpy = vi.spyOn(process.stdout, "write");

      await runCronjob("status");

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("disabled"));
    });

    it("should exit with usage message when no subcommand given", async () => {
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
      const stderrSpy = vi.spyOn(process.stderr, "write");

      await runCronjob(undefined);

      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Usage: saptools cronjob"));
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("should exit with usage message for unknown subcommand", async () => {
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
      const stderrSpy = vi.spyOn(process.stderr, "write");

      await runCronjob("invalid-command");

      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Usage: saptools cronjob"));
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("should route 'disable' subcommand to cronjobDisable", async () => {
      vi.mocked(platform).mockReturnValue("darwin");
      vi.mocked(existsSync).mockReturnValue(false);
      const consoleSpy = vi.spyOn(process.stdout, "write");

      await runCronjob("disable");

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Cronjob disabled"));
    });
  });

  describe("updateCrontab error handling", () => {
    it("should reject when spawn exits with non-zero code", async () => {
      vi.mocked(platform).mockReturnValue("linux");
      setupExecMock(exec, { stdout: "", stderr: "" }, new Error("no crontab"));

      const writeMock = vi.fn().mockReturnValue(true);
      const endMock = vi.fn().mockImplementation(() => undefined);
      const mStdin = { write: writeMock, end: endMock } as unknown as Writable;
      const mChild = {
        stdin: mStdin,
        on: vi.fn().mockImplementation((event: string, cb: (code: number) => void) => {
          if (event === "close") cb(1);
        })
      } as unknown as ChildProcess;
      vi.mocked(spawn).mockReturnValue(mChild);

      await expect(cronjobEnable()).rejects.toThrow("crontab - failed with code 1");
    });

    it("should reject when spawn emits error event", async () => {
      vi.mocked(platform).mockReturnValue("linux");
      setupExecMock(exec, { stdout: "", stderr: "" }, new Error("no crontab"));

      const writeMock = vi.fn().mockReturnValue(true);
      const endMock = vi.fn().mockImplementation(() => undefined);
      const mStdin = { write: writeMock, end: endMock } as unknown as Writable;
      const mChild = {
        stdin: mStdin,
        on: vi.fn().mockImplementation((event: string, cb: (err: Error | number) => void) => {
          if (event === "error") cb(new Error("spawn ENOENT"));
        })
      } as unknown as ChildProcess;
      vi.mocked(spawn).mockReturnValue(mChild);

      await expect(cronjobEnable()).rejects.toThrow("spawn ENOENT");
    });
  });
});
