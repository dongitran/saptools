import { describe, expect, it } from "vitest";

import {
  inspectProcessIdentity,
  parseLinuxProcessStartTime,
  readProcessIdentity,
} from "../../src/debug-session/process-identity.js";

function linuxStatLine(command: string, startTime: string): string {
  const fieldsThreeThroughTwentyOne = [
    "R",
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "10",
    "11",
    "12",
    "13",
    "14",
    "15",
    "16",
    "17",
    "18",
  ];
  return `4242 (${command}) ${fieldsThreeThroughTwentyOne.join(" ")} ${startTime} 23 24`;
}

describe("process identity", () => {
  it("parses Linux starttime after the last closing parenthesis", () => {
    const stat = linuxStatLine("worker name ) with a close", "987654321");

    expect(parseLinuxProcessStartTime(stat)).toBe("987654321");
  });

  it("rejects malformed Linux stat input", () => {
    expect(parseLinuxProcessStartTime("4242 no-command-fields")).toBeUndefined();
    expect(parseLinuxProcessStartTime(linuxStatLine("worker", "not-a-number"))).toBeUndefined();
  });

  it("uses PID-only compatibility when no persisted token exists", async () => {
    await expect(inspectProcessIdentity(process.pid, undefined)).resolves.toBe("match");
  });

  it.runIf(process.platform === "linux" || process.platform === "darwin")(
    "distinguishes a matching token from a reused PID token",
    async () => {
      const identity = await readProcessIdentity(process.pid);
      expect(identity).toEqual(expect.any(String));
      if (identity === undefined) {
        return;
      }

      await expect(inspectProcessIdentity(process.pid, identity)).resolves.toBe("match");
      await expect(inspectProcessIdentity(process.pid, `${identity}-different`)).resolves.toBe(
        "mismatch",
      );
    },
  );
});
