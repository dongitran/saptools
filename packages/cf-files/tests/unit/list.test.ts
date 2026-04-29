import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildListCommand,
  parseListOutput,
  quoteRemoteShellArg,
  resolveRemotePath,
} from "../../src/list.js";

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("../../src/cf.js");
  vi.doUnmock("../../src/session.js");
});

describe("resolveRemotePath", () => {
  it("returns absolute paths unchanged", () => {
    expect(resolveRemotePath("/etc/foo", "/home/vcap/app")).toBe("/etc/foo");
  });

  it("joins relative paths onto appPath", () => {
    expect(resolveRemotePath("package.json", "/home/vcap/app")).toBe(
      "/home/vcap/app/package.json",
    );
  });

  it("strips trailing slashes from appPath", () => {
    expect(resolveRemotePath("package.json", "/home/vcap/app/")).toBe(
      "/home/vcap/app/package.json",
    );
  });

  it("strips leading slashes from relative paths", () => {
    expect(resolveRemotePath("./package.json", "/home/vcap/app")).toBe(
      "/home/vcap/app/./package.json",
    );
  });

  it("returns base when target is empty", () => {
    expect(resolveRemotePath("", "/home/vcap/app")).toBe("/home/vcap/app");
  });

  it("handles nested relative paths", () => {
    expect(resolveRemotePath("src/main/handler.js", "/app")).toBe("/app/src/main/handler.js");
  });
});

describe("quoteRemoteShellArg", () => {
  it("single-quotes paths with shell metacharacters", () => {
    expect(quoteRemoteShellArg("/home/vcap/app/a file;$(nope).txt")).toBe(
      "'/home/vcap/app/a file;$(nope).txt'",
    );
  });

  it("escapes embedded single quotes", () => {
    expect(quoteRemoteShellArg("/home/vcap/app/it's.txt")).toBe(
      "'/home/vcap/app/it'\\''s.txt'",
    );
  });

  it("rejects newline characters", () => {
    expect(() => quoteRemoteShellArg("/home/vcap/app/a\nb")).toThrow(/newline/);
  });
});

describe("buildListCommand", () => {
  it("uses -- and a quoted remote path", () => {
    expect(buildListCommand("/home/vcap/app/file name.txt")).toBe(
      "ls -la -- '/home/vcap/app/file name.txt'",
    );
  });
});

describe("parseListOutput", () => {
  it("parses standard ls -la output", () => {
    const raw = [
      "total 64",
      "drwxr-xr-x  8 vcap vcap 4096 Apr 20 10:00 .",
      "drwxr-xr-x  3 vcap vcap 4096 Apr 20 10:00 ..",
      "-rw-r--r--  1 vcap vcap  512 Apr 20 10:00 package.json",
      "drwxr-xr-x  2 vcap vcap 4096 Apr 20 10:00 src",
      "",
    ].join("\n");

    const entries = parseListOutput(raw);
    expect(entries).toEqual([
      {
        name: "package.json",
        isDirectory: false,
        permissions: "-rw-r--r--",
        size: 512,
      },
      {
        name: "src",
        isDirectory: true,
        permissions: "drwxr-xr-x",
        size: 4096,
      },
    ]);
  });

  it("skips empty lines and totals", () => {
    expect(parseListOutput("")).toEqual([]);
    expect(parseListOutput("total 0")).toEqual([]);
    expect(parseListOutput("total 0\n\n")).toEqual([]);
  });

  it("skips . and ..", () => {
    const raw = [
      "drwxr-xr-x 2 vcap vcap 4096 Apr 20 10:00 .",
      "drwxr-xr-x 2 vcap vcap 4096 Apr 20 10:00 ..",
    ].join("\n");
    expect(parseListOutput(raw)).toEqual([]);
  });

  it("skips malformed lines with too few fields", () => {
    expect(parseListOutput("too few fields\n")).toEqual([]);
  });

  it("preserves filenames with spaces", () => {
    const raw = "-rw-r--r-- 1 vcap vcap 10 Apr 20 10:00 my file.txt\n";
    expect(parseListOutput(raw)).toEqual([
      {
        name: "my file.txt",
        isDirectory: false,
        permissions: "-rw-r--r--",
        size: 10,
      },
    ]);
  });

  it("handles non-numeric size defensively", () => {
    const raw = "-rw-r--r-- 1 vcap vcap foo Apr 20 10:00 odd.bin\n";
    const entries = parseListOutput(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.size).toBe(0);
  });
});

describe("listFiles", () => {
  it("opens a session and parses ls output", async () => {
    const sessionContext = { env: { CF_HOME: "/tmp/cf-files-test-home" } };
    const dispose = vi.fn().mockResolvedValue(undefined);
    const openCfSession = vi.fn().mockResolvedValue({ context: sessionContext, dispose });
    const cfSsh = vi.fn().mockResolvedValue(
      [
        "total 16",
        "drwxr-xr-x 2 vcap vcap 4096 Apr 20 10:00 .",
        "drwxr-xr-x 3 vcap vcap 4096 Apr 20 10:00 ..",
        "-rw-r--r-- 1 vcap vcap   42 Apr 20 10:00 index.js",
        "",
      ].join("\n"),
    );

    vi.doMock("../../src/session.js", () => ({ openCfSession }));
    vi.doMock("../../src/cf.js", () => ({ cfSsh }));

    const { listFiles } = await import("../../src/list.js");
    const entries = await listFiles({
      target: { region: "ap10", org: "o", space: "s", app: "demo-app" },
      remotePath: "/home/vcap/app",
    });

    expect(openCfSession).toHaveBeenCalledOnce();
    expect(cfSsh).toHaveBeenCalledWith(
      "demo-app",
      "ls -la -- '/home/vcap/app'",
      sessionContext,
    );
    expect(dispose).toHaveBeenCalledOnce();
    expect(entries).toEqual([
      { name: "index.js", isDirectory: false, permissions: "-rw-r--r--", size: 42 },
    ]);
  });

  it("disposes the session when remote path validation fails", async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    vi.doMock("../../src/session.js", () => ({
      openCfSession: vi.fn().mockResolvedValue({
        context: { env: { CF_HOME: "/tmp/cf-files-test-home" } },
        dispose,
      }),
    }));
    vi.doMock("../../src/cf.js", () => ({ cfSsh: vi.fn() }));

    const { listFiles } = await import("../../src/list.js");
    await expect(
      listFiles({
        target: { region: "ap10", org: "o", space: "s", app: "demo-app" },
        remotePath: "/home/vcap/app/a\nb",
      }),
    ).rejects.toThrow(/newline/);
    expect(dispose).toHaveBeenCalledOnce();
  });
});
