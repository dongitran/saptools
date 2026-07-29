import { describe, expect, it } from "vitest";

import {
  CLEANUP_FAILURE_EXIT_CODE,
  CleanupFailureError,
  cliErrorExitCode,
  hasTunnelTerminationFailure,
  stopAllExitCode,
} from "../../src/cli-errors.js";
import { CfDebuggerError } from "../../src/types.js";

describe("CLI error exit codes", () => {
  it("maps incomplete tunnel cleanup to its dedicated nonzero code", () => {
    const failure = new CfDebuggerError(
      "TUNNEL_TERMINATION_FAILED",
      "tunnel remains alive",
    );

    expect(hasTunnelTerminationFailure(failure)).toBe(true);
    expect(cliErrorExitCode(failure)).toBe(CLEANUP_FAILURE_EXIT_CODE);
    expect(CLEANUP_FAILURE_EXIT_CODE).toBe(70);
  });

  it("finds cleanup failure nested under the original startup error", () => {
    const failure = new AggregateError([
      new CfDebuggerError("CF_LOGIN_FAILED", "login failed"),
      new CfDebuggerError("TUNNEL_TERMINATION_FAILED", "cleanup failed"),
    ]);

    expect(cliErrorExitCode(failure)).toBe(70);
  });

  it("maps every incomplete failed-startup cleanup to the cleanup exit code", () => {
    const failure = new CleanupFailureError(
      [
        new CfDebuggerError("CF_LOGIN_FAILED", "login failed"),
        Object.assign(new Error("CF home removal failed"), { code: "EACCES" }),
      ],
      new Error("CF home removal failed"),
    );

    expect(cliErrorExitCode(failure)).toBe(70);
  });

  it("keeps caller abort and ordinary failures distinct", () => {
    expect(cliErrorExitCode(new CfDebuggerError("ABORTED", "cancelled"))).toBe(130);
    expect(cliErrorExitCode(new CfDebuggerError("UNKNOWN_REGION", "bad region"))).toBe(1);
  });

  it("preserves a SIGTERM-specific exit code attached at the CLI boundary", () => {
    const failure = new CfDebuggerError("ABORTED", "cancelled");
    Reflect.set(failure, "cliExitCode", 143);

    expect(cliErrorExitCode(failure)).toBe(143);
  });

  it("uses the cleanup-failure exit code for stop --all when any cleanup failed", () => {
    expect(stopAllExitCode([
      new CfDebuggerError("SESSION_NOT_FOUND", "gone"),
      new CfDebuggerError("TUNNEL_TERMINATION_FAILED", "still alive"),
    ])).toBe(CLEANUP_FAILURE_EXIT_CODE);
    expect(stopAllExitCode([new CfDebuggerError("SESSION_NOT_FOUND", "gone")])).toBe(1);
    expect(stopAllExitCode([])).toBeUndefined();
  });
});
