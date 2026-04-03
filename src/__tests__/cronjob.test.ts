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
import { cronjobEnable, cronjobDisable, cronjobStatus } from "../cronjob.js";

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
});
