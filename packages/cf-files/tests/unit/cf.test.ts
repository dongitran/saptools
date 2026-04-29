import { describe, expect, it } from "vitest";

import { internals, cfApi, cfAuth, cfEnv, cfSsh, cfTargetSpace } from "../../src/cf.js";

const { describeCfCommand, sanitizeCfErrorDetail, redactSensitiveValue } = internals;

describe("describeCfCommand", () => {
  it("returns 'cf' when no command is given", () => {
    expect(describeCfCommand([])).toBe("cf");
  });

  it("hides credentials for auth command", () => {
    expect(describeCfCommand(["auth", "user@example.com", "hunter2"])).toBe("cf auth");
  });

  it("describes env-based auth without credentials", () => {
    expect(describeCfCommand(["auth"])).toBe("cf auth");
  });

  it("echoes the full command for non-auth", () => {
    expect(describeCfCommand(["target", "-o", "demo", "-s", "dev"])).toBe(
      "cf target -o demo -s dev",
    );
  });
});

describe("sanitizeCfErrorDetail", () => {
  it("returns detail unchanged for non-auth args", () => {
    expect(sanitizeCfErrorDetail("boom", ["orgs"])).toBe("boom");
  });

  it("redacts email and password for auth", () => {
    const detail = "failed: user@example.com / hunter2";
    const sanitized = sanitizeCfErrorDetail(detail, ["auth"], ["user@example.com", "hunter2"]);
    expect(sanitized).toBe("failed: [REDACTED] / [REDACTED]");
  });

  it("still redacts auth credentials if they appear in argv-shaped details", () => {
    const detail = "failed: user@example.com / hunter2";
    const sanitized = sanitizeCfErrorDetail(detail, ["auth", "user@example.com", "hunter2"]);
    expect(sanitized).toBe("failed: [REDACTED] / [REDACTED]");
  });
});

describe("redactSensitiveValue", () => {
  it("is a no-op for empty values", () => {
    expect(redactSensitiveValue("hello", "")).toBe("hello");
  });

  it("replaces every occurrence", () => {
    expect(redactSensitiveValue("a-b-a", "a")).toBe("[REDACTED]-b-[REDACTED]");
  });
});

describe("cf wrapper (happy path)", () => {
  it("cfApi resolves when the underlying command succeeds", async () => {
    await expect(
      cfApi("https://api.cf.ap10.hana.ondemand.com", { command: "true" }),
    ).resolves.toBeUndefined();
  });

  it("cfAuth resolves when the underlying command succeeds", async () => {
    await expect(cfAuth("user@example.com", "secret", { command: "true" })).resolves.toBeUndefined();
  });

  it("cfTargetSpace resolves when the underlying command succeeds", async () => {
    await expect(cfTargetSpace("org", "space", { command: "true" })).resolves.toBeUndefined();
  });

  it("cfEnv returns stdout from the underlying command", async () => {
    const out = await cfEnv("demo-app", { command: "echo" });
    expect(out).toContain("env demo-app");
  });

  it("cfSsh returns stdout from the underlying command", async () => {
    const out = await cfSsh("demo-app", "ls -la /tmp", { command: "echo" });
    expect(out).toContain("ssh demo-app --disable-pseudo-tty -c ls -la /tmp");
  });

  it("cfSshBuffer returns raw stdout bytes from the underlying command", async () => {
    const { cfSshBuffer } = await import("../../src/cf.js");
    const out = await cfSshBuffer("demo-app", "cat /tmp/file", { command: "echo" });
    expect(out.toString("utf8")).toContain("ssh demo-app --disable-pseudo-tty -c cat /tmp/file");
  });
});

describe("cf wrapper (error handling)", () => {
  it("wraps non-auth failures with command context", async () => {
    await expect(cfEnv("demo-app", { command: "false" })).rejects.toThrow(/cf env demo-app failed/);
  });

  it("redacts credentials when auth fails", async () => {
    const password = "supersecret-hunter2";
    try {
      await cfAuth("user@example.com", password, { command: "false" });
      throw new Error("expected cfAuth to reject");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toContain("cf auth failed");
      expect(msg).not.toContain("user@example.com");
      expect(msg).not.toContain(password);
    }
  });

  it("surfaces the error when the cf binary is missing", async () => {
    await expect(
      cfEnv("demo-app", { command: "/definitely/not/a/real/cf/binary" }),
    ).rejects.toThrow(/cf env demo-app failed/);
  });
});
