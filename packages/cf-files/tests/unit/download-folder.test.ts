import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "cf-files-download-folder-"));
  vi.resetModules();
});

afterEach(async () => {
  vi.doUnmock("../../src/cf.js");
  vi.doUnmock("../../src/session.js");
  await rm(tempDir, { recursive: true, force: true });
});

const sessionContext = { env: { CF_HOME: "/tmp/cf-files-test-home" } };

function makeLsOutput(entries: { name: string; isDir: boolean; size: number }[]): string {
  const lines = [
    `total ${String(entries.length * 4)}`,
    "drwxr-xr-x  2 vcap vcap 4096 Apr 20 10:00 .",
    "drwxr-xr-x  3 vcap vcap 4096 Apr 20 10:00 ..",
  ];
  for (const e of entries) {
    const perms = e.isDir ? "drwxr-xr-x" : "-rw-r--r--";
    const links = e.isDir ? " 2" : " 1";
    lines.push(`${perms}${links} vcap vcap ${String(e.size).padStart(5)} Apr 20 10:00 ${e.name}`);
  }
  return `${lines.join("\n")}\n`;
}

describe("downloadFolder", () => {
  it("downloads all files in a flat directory", async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    const openCfSession = vi.fn().mockResolvedValue({ context: sessionContext, dispose });
    const cfSsh = vi.fn().mockResolvedValue(
      makeLsOutput([
        { name: "a.txt", isDir: false, size: 5 },
        { name: "b.txt", isDir: false, size: 3 },
      ]),
    );
    const cfSshBuffer = vi.fn()
      .mockResolvedValueOnce(Buffer.from("hello"))
      .mockResolvedValueOnce(Buffer.from("bye"));

    vi.doMock("../../src/session.js", () => ({ openCfSession }));
    vi.doMock("../../src/cf.js", () => ({ cfSsh, cfSshBuffer }));

    const { downloadFolder } = await import("../../src/download-folder.js");
    const outDir = join(tempDir, "out");
    const result = await downloadFolder({
      target: { region: "ap10", org: "o", space: "s", app: "a" },
      remotePath: "/home/vcap/app",
      outDir,
    });

    expect(result.files).toBe(2);
    expect(result.bytes).toBe(8);
    expect(result.outDir).toBe(outDir);
    expect(await readFile(join(outDir, "a.txt"), "utf8")).toBe("hello");
    expect(await readFile(join(outDir, "b.txt"), "utf8")).toBe("bye");
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("recursively downloads nested directories", async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    const openCfSession = vi.fn().mockResolvedValue({ context: sessionContext, dispose });
    const cfSsh = vi.fn()
      .mockResolvedValueOnce(
        makeLsOutput([
          { name: "root.txt", isDir: false, size: 4 },
          { name: "sub", isDir: true, size: 4096 },
        ]),
      )
      .mockResolvedValueOnce(
        makeLsOutput([{ name: "child.txt", isDir: false, size: 5 }]),
      );
    const cfSshBuffer = vi.fn()
      .mockResolvedValueOnce(Buffer.from("root"))
      .mockResolvedValueOnce(Buffer.from("child"));

    vi.doMock("../../src/session.js", () => ({ openCfSession }));
    vi.doMock("../../src/cf.js", () => ({ cfSsh, cfSshBuffer }));

    const { downloadFolder } = await import("../../src/download-folder.js");
    const outDir = join(tempDir, "out");
    const result = await downloadFolder({
      target: { region: "ap10", org: "o", space: "s", app: "a" },
      remotePath: "/home/vcap/app",
      outDir,
    });

    expect(result.files).toBe(2);
    expect(result.bytes).toBe(9);
    expect(await readFile(join(outDir, "root.txt"), "utf8")).toBe("root");
    expect(await readFile(join(outDir, "sub", "child.txt"), "utf8")).toBe("child");
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("handles deeply nested three-level directory tree", async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    const openCfSession = vi.fn().mockResolvedValue({ context: sessionContext, dispose });
    const cfSsh = vi.fn()
      .mockResolvedValueOnce(makeLsOutput([{ name: "level1", isDir: true, size: 4096 }]))
      .mockResolvedValueOnce(makeLsOutput([{ name: "level2", isDir: true, size: 4096 }]))
      .mockResolvedValueOnce(makeLsOutput([{ name: "deep.txt", isDir: false, size: 4 }]));
    const cfSshBuffer = vi.fn().mockResolvedValue(Buffer.from("deep"));

    vi.doMock("../../src/session.js", () => ({ openCfSession }));
    vi.doMock("../../src/cf.js", () => ({ cfSsh, cfSshBuffer }));

    const { downloadFolder } = await import("../../src/download-folder.js");
    const outDir = join(tempDir, "out");
    const result = await downloadFolder({
      target: { region: "ap10", org: "o", space: "s", app: "a" },
      remotePath: "/home/vcap/app",
      outDir,
    });

    expect(result.files).toBe(1);
    expect(await readFile(join(outDir, "level1", "level2", "deep.txt"), "utf8")).toBe("deep");
  });

  it("handles empty directory — returns zero files", async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    const openCfSession = vi.fn().mockResolvedValue({ context: sessionContext, dispose });
    const cfSsh = vi.fn().mockResolvedValue("total 0\n");
    const cfSshBuffer = vi.fn();

    vi.doMock("../../src/session.js", () => ({ openCfSession }));
    vi.doMock("../../src/cf.js", () => ({ cfSsh, cfSshBuffer }));

    const { downloadFolder } = await import("../../src/download-folder.js");
    const outDir = join(tempDir, "out");
    const result = await downloadFolder({
      target: { region: "ap10", org: "o", space: "s", app: "a" },
      remotePath: "/home/vcap/app",
      outDir,
    });

    expect(result.files).toBe(0);
    expect(result.bytes).toBe(0);
    expect(cfSshBuffer).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("disposes session even when cf ssh fails", async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    const openCfSession = vi.fn().mockResolvedValue({ context: sessionContext, dispose });
    const cfSsh = vi.fn().mockRejectedValue(new Error("ssh failure"));

    vi.doMock("../../src/session.js", () => ({ openCfSession }));
    vi.doMock("../../src/cf.js", () => ({ cfSsh, cfSshBuffer: vi.fn() }));

    const { downloadFolder } = await import("../../src/download-folder.js");
    await expect(
      downloadFolder({
        target: { region: "ap10", org: "o", space: "s", app: "a" },
        remotePath: "/home/vcap/app",
        outDir: join(tempDir, "out"),
      }),
    ).rejects.toThrow("ssh failure");
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("disposes session even when file download fails mid-walk", async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    const openCfSession = vi.fn().mockResolvedValue({ context: sessionContext, dispose });
    const cfSsh = vi.fn().mockResolvedValue(
      makeLsOutput([{ name: "file.txt", isDir: false, size: 5 }]),
    );
    const cfSshBuffer = vi.fn().mockRejectedValue(new Error("download error"));

    vi.doMock("../../src/session.js", () => ({ openCfSession }));
    vi.doMock("../../src/cf.js", () => ({ cfSsh, cfSshBuffer }));

    const { downloadFolder } = await import("../../src/download-folder.js");
    await expect(
      downloadFolder({
        target: { region: "ap10", org: "o", space: "s", app: "a" },
        remotePath: "/home/vcap/app",
        outDir: join(tempDir, "out"),
      }),
    ).rejects.toThrow("download error");
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("resolves relative remotePath against DEFAULT_APP_PATH", async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    const openCfSession = vi.fn().mockResolvedValue({ context: sessionContext, dispose });
    const cfSsh = vi.fn().mockResolvedValue("total 0\n");

    vi.doMock("../../src/session.js", () => ({ openCfSession }));
    vi.doMock("../../src/cf.js", () => ({ cfSsh, cfSshBuffer: vi.fn() }));

    const { downloadFolder } = await import("../../src/download-folder.js");
    await downloadFolder({
      target: { region: "ap10", org: "o", space: "s", app: "a" },
      remotePath: "src",
      outDir: join(tempDir, "out"),
    });

    expect(cfSsh).toHaveBeenCalledWith(
      "a",
      "ls -la -- '/home/vcap/app/src'",
      sessionContext,
    );
  });

  it("resolves relative remotePath against custom appPath", async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    const openCfSession = vi.fn().mockResolvedValue({ context: sessionContext, dispose });
    const cfSsh = vi.fn().mockResolvedValue("total 0\n");

    vi.doMock("../../src/session.js", () => ({ openCfSession }));
    vi.doMock("../../src/cf.js", () => ({ cfSsh, cfSshBuffer: vi.fn() }));

    const { downloadFolder } = await import("../../src/download-folder.js");
    await downloadFolder({
      target: { region: "ap10", org: "o", space: "s", app: "a" },
      remotePath: "code",
      outDir: join(tempDir, "out"),
      appPath: "/custom/root",
    });

    expect(cfSsh).toHaveBeenCalledWith(
      "a",
      "ls -la -- '/custom/root/code'",
      sessionContext,
    );
  });

  it("uses absolute remotePath as-is", async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    const openCfSession = vi.fn().mockResolvedValue({ context: sessionContext, dispose });
    const cfSsh = vi.fn().mockResolvedValue("total 0\n");

    vi.doMock("../../src/session.js", () => ({ openCfSession }));
    vi.doMock("../../src/cf.js", () => ({ cfSsh, cfSshBuffer: vi.fn() }));

    const { downloadFolder } = await import("../../src/download-folder.js");
    await downloadFolder({
      target: { region: "ap10", org: "o", space: "s", app: "a" },
      remotePath: "/custom/absolute/path",
      outDir: join(tempDir, "out"),
    });

    expect(cfSsh).toHaveBeenCalledWith(
      "a",
      "ls -la -- '/custom/absolute/path'",
      sessionContext,
    );
  });

  it("preserves binary file content in downloaded files", async () => {
    const bytes = Buffer.from([0x00, 0xff, 0x01, 0x80]);
    const dispose = vi.fn().mockResolvedValue(undefined);
    const openCfSession = vi.fn().mockResolvedValue({ context: sessionContext, dispose });
    const cfSsh = vi.fn().mockResolvedValue(
      makeLsOutput([{ name: "data.bin", isDir: false, size: 4 }]),
    );
    const cfSshBuffer = vi.fn().mockResolvedValue(bytes);

    vi.doMock("../../src/session.js", () => ({ openCfSession }));
    vi.doMock("../../src/cf.js", () => ({ cfSsh, cfSshBuffer }));

    const { downloadFolder } = await import("../../src/download-folder.js");
    const outDir = join(tempDir, "out");
    const result = await downloadFolder({
      target: { region: "ap10", org: "o", space: "s", app: "a" },
      remotePath: "/home/vcap/app",
      outDir,
    });

    expect(result.bytes).toBe(4);
    expect(await readFile(join(outDir, "data.bin"))).toEqual(bytes);
  });

  it("builds correct cat command for child files within folder", async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    const openCfSession = vi.fn().mockResolvedValue({ context: sessionContext, dispose });
    const cfSsh = vi.fn().mockResolvedValue(
      makeLsOutput([{ name: "package.json", isDir: false, size: 20 }]),
    );
    const cfSshBuffer = vi.fn().mockResolvedValue(Buffer.from("{}"));

    vi.doMock("../../src/session.js", () => ({ openCfSession }));
    vi.doMock("../../src/cf.js", () => ({ cfSsh, cfSshBuffer }));

    const { downloadFolder } = await import("../../src/download-folder.js");
    await downloadFolder({
      target: { region: "ap10", org: "o", space: "s", app: "a" },
      remotePath: "/home/vcap/app",
      outDir: join(tempDir, "out"),
    });

    expect(cfSshBuffer).toHaveBeenCalledWith(
      "a",
      "cat -- '/home/vcap/app/package.json'",
      sessionContext,
    );
  });

  it("uses a single CF session for the entire recursive walk", async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    const openCfSession = vi.fn().mockResolvedValue({ context: sessionContext, dispose });
    const cfSsh = vi.fn()
      .mockResolvedValueOnce(makeLsOutput([{ name: "sub", isDir: true, size: 4096 }]))
      .mockResolvedValueOnce(makeLsOutput([{ name: "file.txt", isDir: false, size: 3 }]));
    const cfSshBuffer = vi.fn().mockResolvedValue(Buffer.from("hi!"));

    vi.doMock("../../src/session.js", () => ({ openCfSession }));
    vi.doMock("../../src/cf.js", () => ({ cfSsh, cfSshBuffer }));

    const { downloadFolder } = await import("../../src/download-folder.js");
    await downloadFolder({
      target: { region: "ap10", org: "o", space: "s", app: "a" },
      remotePath: "/home/vcap/app",
      outDir: join(tempDir, "out"),
    });

    expect(openCfSession).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
