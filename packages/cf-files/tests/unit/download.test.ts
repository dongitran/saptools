import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "cf-files-download-"));
  vi.resetModules();
});

afterEach(async () => {
  vi.doUnmock("../../src/cf.js");
  vi.doUnmock("../../src/session.js");
  await rm(tempDir, { recursive: true, force: true });
});

describe("downloadFile", () => {
  it("builds a quoted cat command", async () => {
    const { buildDownloadCommand } = await import("../../src/download.js");
    expect(buildDownloadCommand("/home/vcap/app/it's;$(safe).txt")).toBe(
      "cat -- '/home/vcap/app/it'\\''s;$(safe).txt'",
    );
  });

  it("writes the content returned by cf ssh cat", async () => {
    const sessionContext = { env: { CF_HOME: join(tempDir, "cf-home") } };
    const dispose = vi.fn().mockResolvedValue(undefined);
    const openCfSession = vi.fn().mockResolvedValue({ context: sessionContext, dispose });
    const cfSshBuffer = vi.fn().mockResolvedValue(Buffer.from("hello world\n", "utf8"));

    vi.doMock("../../src/session.js", () => ({ openCfSession }));
    vi.doMock("../../src/cf.js", () => ({ cfSshBuffer }));

    const { downloadFile } = await import("../../src/download.js");
    const outPath = join(tempDir, "out.txt");

    const result = await downloadFile({
      target: { region: "ap10", org: "o", space: "s", app: "a" },
      remotePath: "/home/vcap/app/package.json",
      outPath,
    });

    expect(openCfSession).toHaveBeenCalledOnce();
    expect(cfSshBuffer).toHaveBeenCalledWith(
      "a",
      "cat -- '/home/vcap/app/package.json'",
      sessionContext,
    );
    expect(dispose).toHaveBeenCalledOnce();
    expect(result.outPath).toBe(outPath);
    expect(result.bytes).toBe(Buffer.byteLength("hello world\n", "utf8"));
    expect(await readFile(outPath, "utf8")).toBe("hello world\n");
  });

  it("preserves binary bytes", async () => {
    const bytes = Buffer.from([0x00, 0xff, 0x01, 0x80]);
    vi.doMock("../../src/session.js", () => ({
      openCfSession: vi.fn().mockResolvedValue({
        context: { env: { CF_HOME: join(tempDir, "cf-home") } },
        dispose: vi.fn().mockResolvedValue(undefined),
      }),
    }));
    vi.doMock("../../src/cf.js", () => ({
      cfSshBuffer: vi.fn().mockResolvedValue(bytes),
    }));

    const { downloadFile } = await import("../../src/download.js");
    const outPath = join(tempDir, "out.bin");
    const result = await downloadFile({
      target: { region: "ap10", org: "o", space: "s", app: "a" },
      remotePath: "/home/vcap/app/blob.bin",
      outPath,
    });

    expect(result.bytes).toBe(4);
    expect(await readFile(outPath)).toEqual(bytes);
  });

  it("creates nested output directories", async () => {
    vi.doMock("../../src/session.js", () => ({
      openCfSession: vi.fn().mockResolvedValue({
        context: { env: { CF_HOME: join(tempDir, "cf-home") } },
        dispose: vi.fn().mockResolvedValue(undefined),
      }),
    }));
    vi.doMock("../../src/cf.js", () => ({
      cfSshBuffer: vi.fn().mockResolvedValue(Buffer.from("payload", "utf8")),
    }));

    const { downloadFile } = await import("../../src/download.js");
    const outPath = join(tempDir, "a", "b", "c.txt");
    const result = await downloadFile({
      target: { region: "ap10", org: "o", space: "s", app: "a" },
      remotePath: "/x",
      outPath,
    });
    expect(result.bytes).toBe(7);
    expect(await readFile(outPath, "utf8")).toBe("payload");
  });
});
