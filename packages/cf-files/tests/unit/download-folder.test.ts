import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileAsync = promisify(execFile);

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

/** Create a real .tar.gz buffer from a flat list of path → content entries. */
async function makeTarGz(
  files: { readonly path: string; readonly content: Buffer | string }[],
  options: {
    readonly symlinks?: { readonly path: string; readonly target: string }[];
    readonly dereference?: boolean;
  } = {},
): Promise<Buffer> {
  const srcDir = await mkdtemp(join(tmpdir(), "cf-files-makeTar-"));
  try {
    for (const { path: p, content } of files) {
      const full = join(srcDir, p);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, typeof content === "string" ? Buffer.from(content) : content);
    }
    for (const link of options.symlinks ?? []) {
      const full = join(srcDir, link.path);
      await mkdir(dirname(full), { recursive: true });
      await symlink(link.target, full);
    }
    const args = [
      ...(options.dereference === true ? ["--dereference"] : []),
      "-czf",
      "-",
      "-C",
      srcDir,
      ".",
    ];
    const { stdout } = await execFileAsync("tar", args, {
      encoding: "buffer",
      maxBuffer: 16 * 1024 * 1024,
    });
    return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  } finally {
    await rm(srcDir, { recursive: true, force: true });
  }
}

// internals: path helpers

describe("internals.normalizeFilerPath", () => {
  it("strips leading slash", async () => {
    const { internals } = await import("../../src/download-folder.js");
    expect(internals.normalizeFilerPath("/deps")).toBe("deps");
  });

  it("strips leading ./", async () => {
    const { internals } = await import("../../src/download-folder.js");
    expect(internals.normalizeFilerPath("./deps")).toBe("deps");
  });

  it("strips trailing slash", async () => {
    const { internals } = await import("../../src/download-folder.js");
    expect(internals.normalizeFilerPath("deps/")).toBe("deps");
  });

  it("leaves plain paths unchanged", async () => {
    const { internals } = await import("../../src/download-folder.js");
    expect(internals.normalizeFilerPath("deps/@vendor")).toBe("deps/@vendor");
  });

  it("rejects parent traversal segments", async () => {
    const { internals } = await import("../../src/download-folder.js");
    expect(() => internals.normalizeFilerPath("../secret")).toThrow(/Filter paths/);
    expect(() => internals.normalizeFilerPath("deps/../secret")).toThrow(/Filter paths/);
  });
});

describe("internals.pathStartsWith", () => {
  it("returns true when path equals prefix", async () => {
    const { internals } = await import("../../src/download-folder.js");
    expect(internals.pathStartsWith("deps", "deps")).toBe(true);
  });

  it("returns true for child paths", async () => {
    const { internals } = await import("../../src/download-folder.js");
    expect(internals.pathStartsWith("deps/pkg/index.js", "deps")).toBe(true);
  });

  it("returns false for partial segment matches", async () => {
    const { internals } = await import("../../src/download-folder.js");
    expect(internals.pathStartsWith("dependencies/pkg", "deps")).toBe(false);
  });

  it("returns true for empty prefix", async () => {
    const { internals } = await import("../../src/download-folder.js");
    expect(internals.pathStartsWith("anything", "")).toBe(true);
  });
});

// internals: buildTarCommand

describe("internals.buildTarCommand", () => {
  it("returns simple tar when no filters", async () => {
    const { internals } = await import("../../src/download-folder.js");
    const cmd = internals.buildTarCommand("/home/vcap/app", [], []);
    expect(cmd).toBe("tar --dereference -czf - -C '/home/vcap/app' .");
  });

  it("adds --exclude flags for excludes-only case", async () => {
    const { internals } = await import("../../src/download-folder.js");
    const cmd = internals.buildTarCommand("/home/vcap/app", ["deps", "build"], []);
    expect(cmd).toContain("--exclude='./deps'");
    expect(cmd).toContain("--exclude='./build'");
    expect(cmd).not.toContain("find");
  });

  it("uses find+tar when include overrides an exclude", async () => {
    const { internals } = await import("../../src/download-folder.js");
    const cmd = internals.buildTarCommand("/home/vcap/app", ["deps"], ["deps/@vendor"]);
    expect(cmd).toContain("find");
    expect(cmd).toContain("find -L");
    expect(cmd).toContain("prune");
    expect(cmd).toContain("-print0");
    expect(cmd).toContain("deps/@vendor");
    expect(cmd).toContain("tar --null --dereference --no-recursion");
    expect(cmd).not.toContain("sort -u");
  });

  it("cancels out exclude when include exactly matches it", async () => {
    const { internals } = await import("../../src/download-folder.js");
    const cmd = internals.buildTarCommand("/app", ["dist"], ["dist"]);
    expect(cmd).toBe("tar --dereference -czf - -C '/app' .");
  });

  it("cancels out child excludes when a parent include covers them", async () => {
    const { internals } = await import("../../src/download-folder.js");
    const cmd = internals.buildTarCommand("/app", ["dist/cache"], ["dist"]);
    expect(cmd).toBe("tar --dereference -czf - -C '/app' .");
  });

  it("handles multiple include overrides", async () => {
    const { internals } = await import("../../src/download-folder.js");
    const cmd = internals.buildTarCommand("/app", ["deps"], ["deps/@a", "deps/@b"]);
    expect(cmd).toContain("deps/@a");
    expect(cmd).toContain("deps/@b");
  });

  it("single-quotes a path containing a single quote", async () => {
    const { internals } = await import("../../src/download-folder.js");
    const cmd = internals.buildTarCommand("/path/it's here", [], []);
    expect(cmd).toContain("'\\''");
  });

  it("single-quotes include and exclude paths containing a single quote", async () => {
    const { internals } = await import("../../src/download-folder.js");
    const cmd = internals.buildTarCommand("/app", ["deps"], ["deps/@vendor/it's"]);
    expect(cmd).toContain("./deps/@vendor/it'\\''s");
  });

  it("includes only non-override excludes as --exclude flags in mixed case", async () => {
    const { internals } = await import("../../src/download-folder.js");
    const cmd = internals.buildTarCommand("/app", ["deps", "build"], ["deps/@vendor"]);
    expect(cmd).toContain("find");
    expect(cmd).toContain("./build");
    expect(cmd).toContain("./deps");
  });
});

// downloadFolder integration

describe("downloadFolder", () => {
  it("downloads all files via tar and returns correct stats", async () => {
    const tarBuffer = await makeTarGz([
      { path: "a.txt", content: "hello" },
      { path: "b.txt", content: "bye" },
    ]);

    const dispose = vi.fn().mockResolvedValue(undefined);
    const openCfSession = vi.fn().mockResolvedValue({ context: sessionContext, dispose });
    const cfSshBuffer = vi.fn().mockResolvedValue(tarBuffer);

    vi.doMock("../../src/session.js", () => ({ openCfSession }));
    vi.doMock("../../src/cf.js", () => ({ cfSshBuffer }));

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

  it("downloads nested directory structure via tar", async () => {
    const tarBuffer = await makeTarGz([
      { path: "root.txt", content: "root" },
      { path: "sub/child.txt", content: "child" },
    ]);

    const dispose = vi.fn().mockResolvedValue(undefined);
    const openCfSession = vi.fn().mockResolvedValue({ context: sessionContext, dispose });
    const cfSshBuffer = vi.fn().mockResolvedValue(tarBuffer);

    vi.doMock("../../src/session.js", () => ({ openCfSession }));
    vi.doMock("../../src/cf.js", () => ({ cfSshBuffer }));

    const { downloadFolder } = await import("../../src/download-folder.js");
    const outDir = join(tempDir, "out");
    const result = await downloadFolder({
      target: { region: "ap10", org: "o", space: "s", app: "a" },
      remotePath: "/home/vcap/app",
      outDir,
    });

    expect(result.files).toBe(2);
    expect(await readFile(join(outDir, "root.txt"), "utf8")).toBe("root");
    expect(await readFile(join(outDir, "sub", "child.txt"), "utf8")).toBe("child");
  });

  it("handles empty tar archive — returns zero files", async () => {
    const tarBuffer = await makeTarGz([]);

    const dispose = vi.fn().mockResolvedValue(undefined);
    const openCfSession = vi.fn().mockResolvedValue({ context: sessionContext, dispose });
    const cfSshBuffer = vi.fn().mockResolvedValue(tarBuffer);

    vi.doMock("../../src/session.js", () => ({ openCfSession }));
    vi.doMock("../../src/cf.js", () => ({ cfSshBuffer }));

    const { downloadFolder } = await import("../../src/download-folder.js");
    const outDir = join(tempDir, "out");
    const result = await downloadFolder({
      target: { region: "ap10", org: "o", space: "s", app: "a" },
      remotePath: "/home/vcap/app",
      outDir,
    });

    expect(result.files).toBe(0);
    expect(result.bytes).toBe(0);
  });

  it("preserves binary file content", async () => {
    const binaryData = Buffer.from([0x00, 0xff, 0x01, 0x80]);
    const tarBuffer = await makeTarGz([{ path: "data.bin", content: binaryData }]);

    const dispose = vi.fn().mockResolvedValue(undefined);
    const openCfSession = vi.fn().mockResolvedValue({ context: sessionContext, dispose });
    const cfSshBuffer = vi.fn().mockResolvedValue(tarBuffer);

    vi.doMock("../../src/session.js", () => ({ openCfSession }));
    vi.doMock("../../src/cf.js", () => ({ cfSshBuffer }));

    const { downloadFolder } = await import("../../src/download-folder.js");
    const outDir = join(tempDir, "out");
    await downloadFolder({
      target: { region: "ap10", org: "o", space: "s", app: "a" },
      remotePath: "/home/vcap/app",
      outDir,
    });

    expect(await readFile(join(outDir, "data.bin"))).toEqual(binaryData);
  });

  it("extracts symlinked package directories as regular files", async () => {
    const tarBuffer = await makeTarGz(
      [
        { path: "store/pkg/lib/index.js", content: "module.exports = {};\n" },
      ],
      {
        dereference: true,
        symlinks: [{ path: "node_modules/@scope/pkg", target: "../../store/pkg" }],
      },
    );

    const dispose = vi.fn().mockResolvedValue(undefined);
    const openCfSession = vi.fn().mockResolvedValue({ context: sessionContext, dispose });
    const cfSshBuffer = vi.fn().mockResolvedValue(tarBuffer);

    vi.doMock("../../src/session.js", () => ({ openCfSession }));
    vi.doMock("../../src/cf.js", () => ({ cfSshBuffer }));

    const { downloadFolder } = await import("../../src/download-folder.js");
    const outDir = join(tempDir, "out");
    const result = await downloadFolder({
      target: { region: "ap10", org: "o", space: "s", app: "a" },
      remotePath: "/home/vcap/app",
      outDir,
    });

    expect(result.files).toBe(2);
    const linkedContent = await readFile(
      join(outDir, "node_modules", "@scope", "pkg", "lib", "index.js"),
      "utf8",
    );
    expect(linkedContent).toBe("module.exports = {};\n");
  });

  it("disposes session even when cfSshBuffer fails", async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    const openCfSession = vi.fn().mockResolvedValue({ context: sessionContext, dispose });
    const cfSshBuffer = vi.fn().mockRejectedValue(new Error("ssh failure"));

    vi.doMock("../../src/session.js", () => ({ openCfSession }));
    vi.doMock("../../src/cf.js", () => ({ cfSshBuffer }));

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

  it("disposes session when local tar extraction fails", async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    const openCfSession = vi.fn().mockResolvedValue({ context: sessionContext, dispose });
    const cfSshBuffer = vi.fn().mockResolvedValue(Buffer.from("not a tar archive"));

    vi.doMock("../../src/session.js", () => ({ openCfSession }));
    vi.doMock("../../src/cf.js", () => ({ cfSshBuffer }));

    const { downloadFolder } = await import("../../src/download-folder.js");
    await expect(
      downloadFolder({
        target: { region: "ap10", org: "o", space: "s", app: "a" },
        remotePath: "/home/vcap/app",
        outDir: join(tempDir, "out"),
      }),
    ).rejects.toThrow(/tar extraction failed/);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("sends a simple tar command when no filters are specified", async () => {
    const tarBuffer = await makeTarGz([]);
    const dispose = vi.fn().mockResolvedValue(undefined);
    const openCfSession = vi.fn().mockResolvedValue({ context: sessionContext, dispose });
    const cfSshBuffer = vi.fn().mockResolvedValue(tarBuffer);

    vi.doMock("../../src/session.js", () => ({ openCfSession }));
    vi.doMock("../../src/cf.js", () => ({ cfSshBuffer }));

    const { downloadFolder } = await import("../../src/download-folder.js");
    await downloadFolder({
      target: { region: "ap10", org: "o", space: "s", app: "a" },
      remotePath: "/home/vcap/app",
      outDir: join(tempDir, "out"),
    });

    const [appName, command] = cfSshBuffer.mock.calls[0] ?? [];
    expect(appName).toBe("a");
    expect(command).toContain("tar --dereference -czf -");
    expect(command).toContain("'/home/vcap/app'");
    expect(command).not.toContain("find");
  });

  it("sends tar command with --exclude flags when only excludes are given", async () => {
    const tarBuffer = await makeTarGz([]);
    const dispose = vi.fn().mockResolvedValue(undefined);
    const openCfSession = vi.fn().mockResolvedValue({ context: sessionContext, dispose });
    const cfSshBuffer = vi.fn().mockResolvedValue(tarBuffer);

    vi.doMock("../../src/session.js", () => ({ openCfSession }));
    vi.doMock("../../src/cf.js", () => ({ cfSshBuffer }));

    const { downloadFolder } = await import("../../src/download-folder.js");
    await downloadFolder({
      target: { region: "ap10", org: "o", space: "s", app: "a" },
      remotePath: "/home/vcap/app",
      outDir: join(tempDir, "out"),
      exclude: ["deps", "build"],
    });

    const [, command] = cfSshBuffer.mock.calls[0] ?? [];
    expect(command).toContain("--exclude='./deps'");
    expect(command).toContain("--exclude='./build'");
    expect(command).not.toContain("find");
  });

  it("sends find+tar command when include overrides an exclude", async () => {
    const tarBuffer = await makeTarGz([]);
    const dispose = vi.fn().mockResolvedValue(undefined);
    const openCfSession = vi.fn().mockResolvedValue({ context: sessionContext, dispose });
    const cfSshBuffer = vi.fn().mockResolvedValue(tarBuffer);

    vi.doMock("../../src/session.js", () => ({ openCfSession }));
    vi.doMock("../../src/cf.js", () => ({ cfSshBuffer }));

    const { downloadFolder } = await import("../../src/download-folder.js");
    await downloadFolder({
      target: { region: "ap10", org: "o", space: "s", app: "a" },
      remotePath: "/home/vcap/app",
      outDir: join(tempDir, "out"),
      exclude: ["deps"],
      include: ["deps/@vendor"],
    });

    const [, command] = cfSshBuffer.mock.calls[0] ?? [];
    expect(command).toContain("find");
    expect(command).toContain("deps/@vendor");
    expect(command).toContain("tar --null --dereference --no-recursion");
  });

  it("resolves relative remotePath against DEFAULT_APP_PATH", async () => {
    const tarBuffer = await makeTarGz([]);
    const dispose = vi.fn().mockResolvedValue(undefined);
    const openCfSession = vi.fn().mockResolvedValue({ context: sessionContext, dispose });
    const cfSshBuffer = vi.fn().mockResolvedValue(tarBuffer);

    vi.doMock("../../src/session.js", () => ({ openCfSession }));
    vi.doMock("../../src/cf.js", () => ({ cfSshBuffer }));

    const { downloadFolder } = await import("../../src/download-folder.js");
    await downloadFolder({
      target: { region: "ap10", org: "o", space: "s", app: "a" },
      remotePath: "sub",
      outDir: join(tempDir, "out"),
    });

    const [, command] = cfSshBuffer.mock.calls[0] ?? [];
    expect(command).toContain("'/home/vcap/app/sub'");
  });

  it("resolves relative remotePath against custom appPath", async () => {
    const tarBuffer = await makeTarGz([]);
    const dispose = vi.fn().mockResolvedValue(undefined);
    const openCfSession = vi.fn().mockResolvedValue({ context: sessionContext, dispose });
    const cfSshBuffer = vi.fn().mockResolvedValue(tarBuffer);

    vi.doMock("../../src/session.js", () => ({ openCfSession }));
    vi.doMock("../../src/cf.js", () => ({ cfSshBuffer }));

    const { downloadFolder } = await import("../../src/download-folder.js");
    await downloadFolder({
      target: { region: "ap10", org: "o", space: "s", app: "a" },
      remotePath: "code",
      outDir: join(tempDir, "out"),
      appPath: "/custom/root",
    });

    const [, command] = cfSshBuffer.mock.calls[0] ?? [];
    expect(command).toContain("'/custom/root/code'");
  });

  it("uses absolute remotePath as-is", async () => {
    const tarBuffer = await makeTarGz([]);
    const dispose = vi.fn().mockResolvedValue(undefined);
    const openCfSession = vi.fn().mockResolvedValue({ context: sessionContext, dispose });
    const cfSshBuffer = vi.fn().mockResolvedValue(tarBuffer);

    vi.doMock("../../src/session.js", () => ({ openCfSession }));
    vi.doMock("../../src/cf.js", () => ({ cfSshBuffer }));

    const { downloadFolder } = await import("../../src/download-folder.js");
    await downloadFolder({
      target: { region: "ap10", org: "o", space: "s", app: "a" },
      remotePath: "/absolute/path",
      outDir: join(tempDir, "out"),
    });

    const [, command] = cfSshBuffer.mock.calls[0] ?? [];
    expect(command).toContain("'/absolute/path'");
  });

  it("uses a single CF session for the entire operation", async () => {
    const tarBuffer = await makeTarGz([{ path: "file.txt", content: "hi!" }]);
    const dispose = vi.fn().mockResolvedValue(undefined);
    const openCfSession = vi.fn().mockResolvedValue({ context: sessionContext, dispose });
    const cfSshBuffer = vi.fn().mockResolvedValue(tarBuffer);

    vi.doMock("../../src/session.js", () => ({ openCfSession }));
    vi.doMock("../../src/cf.js", () => ({ cfSshBuffer }));

    const { downloadFolder } = await import("../../src/download-folder.js");
    await downloadFolder({
      target: { region: "ap10", org: "o", space: "s", app: "a" },
      remotePath: "/home/vcap/app",
      outDir: join(tempDir, "out"),
    });

    expect(openCfSession).toHaveBeenCalledOnce();
    expect(cfSshBuffer).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("empty exclude and include arrays behave like no filters", async () => {
    const tarBuffer = await makeTarGz([{ path: "file.txt", content: "data" }]);
    const dispose = vi.fn().mockResolvedValue(undefined);
    const openCfSession = vi.fn().mockResolvedValue({ context: sessionContext, dispose });
    const cfSshBuffer = vi.fn().mockResolvedValue(tarBuffer);

    vi.doMock("../../src/session.js", () => ({ openCfSession }));
    vi.doMock("../../src/cf.js", () => ({ cfSshBuffer }));

    const { downloadFolder } = await import("../../src/download-folder.js");
    const result = await downloadFolder({
      target: { region: "ap10", org: "o", space: "s", app: "a" },
      remotePath: "/home/vcap/app",
      outDir: join(tempDir, "out"),
      exclude: [],
      include: [],
    });

    expect(result.files).toBe(1);
    const [, command] = cfSshBuffer.mock.calls[0] ?? [];
    expect(command).toBe("tar --dereference -czf - -C '/home/vcap/app' .");
  });

  it("normalizes leading slash and trailing slash in exclude/include paths", async () => {
    const tarBuffer = await makeTarGz([]);
    const dispose = vi.fn().mockResolvedValue(undefined);
    const openCfSession = vi.fn().mockResolvedValue({ context: sessionContext, dispose });
    const cfSshBuffer = vi.fn().mockResolvedValue(tarBuffer);

    vi.doMock("../../src/session.js", () => ({ openCfSession }));
    vi.doMock("../../src/cf.js", () => ({ cfSshBuffer }));

    const { downloadFolder } = await import("../../src/download-folder.js");
    await downloadFolder({
      target: { region: "ap10", org: "o", space: "s", app: "a" },
      remotePath: "/home/vcap/app",
      outDir: join(tempDir, "out"),
      exclude: ["/deps/"],
      include: ["./deps/@vendor/"],
    });

    const [, command] = cfSshBuffer.mock.calls[0] ?? [];
    expect(command).toContain("deps");
    expect(command).toContain("deps/@vendor");
  });
});
