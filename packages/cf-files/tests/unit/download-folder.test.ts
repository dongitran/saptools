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

// ── internals: path filtering helpers ─────────────────────────────────────────

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
    // 'dependencies' must not match prefix 'deps'
    expect(internals.pathStartsWith("dependencies/pkg", "deps")).toBe(false);
  });

  it("returns true for empty prefix", async () => {
    const { internals } = await import("../../src/download-folder.js");
    expect(internals.pathStartsWith("anything", "")).toBe(true);
  });
});

describe("internals.shouldDownloadFile", () => {
  it("allows file when no filters", async () => {
    const { internals } = await import("../../src/download-folder.js");
    expect(internals.shouldDownloadFile("readme.md", [], [])).toBe(true);
  });

  it("blocks file under excluded path", async () => {
    const { internals } = await import("../../src/download-folder.js");
    expect(internals.shouldDownloadFile("deps/pkg/index.js", ["deps"], [])).toBe(false);
  });

  it("allows file when include overrides exclude", async () => {
    const { internals } = await import("../../src/download-folder.js");
    expect(
      internals.shouldDownloadFile("deps/@vendor/pkg/index.js", ["deps"], ["deps/@vendor"]),
    ).toBe(true);
  });

  it("blocks file not covered by include even when other include exists", async () => {
    const { internals } = await import("../../src/download-folder.js");
    expect(
      internals.shouldDownloadFile("deps/other/index.js", ["deps"], ["deps/@vendor"]),
    ).toBe(false);
  });

  it("allows file when excluded but exact include matches", async () => {
    const { internals } = await import("../../src/download-folder.js");
    expect(internals.shouldDownloadFile("dist/file.js", ["dist"], ["dist"])).toBe(true);
  });
});

describe("internals.shouldRecurseDir", () => {
  it("recurses into non-excluded dir", async () => {
    const { internals } = await import("../../src/download-folder.js");
    expect(internals.shouldRecurseDir("src", ["deps"], [])).toBe(true);
  });

  it("skips excluded dir with no include patterns", async () => {
    const { internals } = await import("../../src/download-folder.js");
    expect(internals.shouldRecurseDir("deps", ["deps"], [])).toBe(false);
  });

  it("recurses into excluded dir when an include lives beneath it", async () => {
    const { internals } = await import("../../src/download-folder.js");
    expect(internals.shouldRecurseDir("deps", ["deps"], ["deps/@vendor"])).toBe(true);
  });

  it("skips sibling dirs that have no include underneath", async () => {
    const { internals } = await import("../../src/download-folder.js");
    // deps/other has no include under it — skip
    expect(internals.shouldRecurseDir("deps/other", ["deps"], ["deps/@vendor"])).toBe(false);
  });

  it("recurses into the exact include dir even though parent is excluded", async () => {
    const { internals } = await import("../../src/download-folder.js");
    expect(internals.shouldRecurseDir("deps/@vendor", ["deps"], ["deps/@vendor"])).toBe(true);
  });

  it("recurses into a child of an include dir", async () => {
    const { internals } = await import("../../src/download-folder.js");
    expect(
      internals.shouldRecurseDir("deps/@vendor/pkg", ["deps"], ["deps/@vendor"]),
    ).toBe(true);
  });
});

// ── downloadFolder integration ─────────────────────────────────────────────────

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
      remotePath: "sub",
      outDir: join(tempDir, "out"),
    });

    expect(cfSsh).toHaveBeenCalledWith("a", "ls -la -- '/home/vcap/app/sub'", sessionContext);
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
      remotePath: "/absolute/path",
      outDir: join(tempDir, "out"),
    });

    expect(cfSsh).toHaveBeenCalledWith(
      "a",
      "ls -la -- '/absolute/path'",
      sessionContext,
    );
  });

  it("preserves binary file content", async () => {
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
    await downloadFolder({
      target: { region: "ap10", org: "o", space: "s", app: "a" },
      remotePath: "/home/vcap/app",
      outDir,
    });

    expect(await readFile(join(outDir, "data.bin"))).toEqual(bytes);
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

  // ── exclude / include filtering ───────────────────────────────────────────

  it("skips an excluded top-level directory entirely", async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    const openCfSession = vi.fn().mockResolvedValue({ context: sessionContext, dispose });
    const cfSsh = vi.fn().mockResolvedValue(
      makeLsOutput([
        { name: "readme.md", isDir: false, size: 10 },
        { name: "deps", isDir: true, size: 4096 },
      ]),
    );
    const cfSshBuffer = vi.fn().mockResolvedValue(Buffer.from("readme"));

    vi.doMock("../../src/session.js", () => ({ openCfSession }));
    vi.doMock("../../src/cf.js", () => ({ cfSsh, cfSshBuffer }));

    const { downloadFolder } = await import("../../src/download-folder.js");
    const outDir = join(tempDir, "out");
    const result = await downloadFolder({
      target: { region: "ap10", org: "o", space: "s", app: "a" },
      remotePath: "/home/vcap/app",
      outDir,
      exclude: ["deps"],
    });

    expect(result.files).toBe(1);
    // cfSsh called once for root only, never recurses into deps
    expect(cfSsh).toHaveBeenCalledOnce();
    expect(await readFile(join(outDir, "readme.md"), "utf8")).toBe("readme");
  });

  it("skips multiple excluded directories", async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    const openCfSession = vi.fn().mockResolvedValue({ context: sessionContext, dispose });
    const cfSsh = vi.fn().mockResolvedValue(
      makeLsOutput([
        { name: "index.js", isDir: false, size: 5 },
        { name: "deps", isDir: true, size: 4096 },
        { name: "build", isDir: true, size: 4096 },
      ]),
    );
    const cfSshBuffer = vi.fn().mockResolvedValue(Buffer.from("hello"));

    vi.doMock("../../src/session.js", () => ({ openCfSession }));
    vi.doMock("../../src/cf.js", () => ({ cfSsh, cfSshBuffer }));

    const { downloadFolder } = await import("../../src/download-folder.js");
    const result = await downloadFolder({
      target: { region: "ap10", org: "o", space: "s", app: "a" },
      remotePath: "/home/vcap/app",
      outDir: join(tempDir, "out"),
      exclude: ["deps", "build"],
    });

    expect(result.files).toBe(1);
    expect(cfSsh).toHaveBeenCalledOnce();
  });

  it("recurses into excluded dir to retrieve an included subdir", async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    const openCfSession = vi.fn().mockResolvedValue({ context: sessionContext, dispose });

    // root: readme.md + deps/
    // deps/: vendor-a/ + @org/
    // deps/vendor-a/: index.js   ← excluded, not included
    // deps/@org/: pkg/           ← included
    // deps/@org/pkg/: helper.js  ← included
    const cfSsh = vi.fn()
      .mockResolvedValueOnce(
        makeLsOutput([
          { name: "readme.md", isDir: false, size: 6 },
          { name: "deps", isDir: true, size: 4096 },
        ]),
      )
      .mockResolvedValueOnce(
        makeLsOutput([
          { name: "vendor-a", isDir: true, size: 4096 },
          { name: "@org", isDir: true, size: 4096 },
        ]),
      )
      .mockResolvedValueOnce(
        makeLsOutput([{ name: "pkg", isDir: true, size: 4096 }]),
      )
      .mockResolvedValueOnce(
        makeLsOutput([{ name: "helper.js", isDir: false, size: 8 }]),
      );
    const cfSshBuffer = vi.fn()
      .mockResolvedValueOnce(Buffer.from("# readme"))
      .mockResolvedValueOnce(Buffer.from("// helper"));

    vi.doMock("../../src/session.js", () => ({ openCfSession }));
    vi.doMock("../../src/cf.js", () => ({ cfSsh, cfSshBuffer }));

    const { downloadFolder } = await import("../../src/download-folder.js");
    const outDir = join(tempDir, "out");
    const result = await downloadFolder({
      target: { region: "ap10", org: "o", space: "s", app: "a" },
      remotePath: "/home/vcap/app",
      outDir,
      exclude: ["deps"],
      include: ["deps/@org"],
    });

    // readme.md + deps/@org/pkg/helper.js = 2 files
    expect(result.files).toBe(2);
    expect(await readFile(join(outDir, "readme.md"), "utf8")).toBe("# readme");
    expect(
      await readFile(join(outDir, "deps", "@org", "pkg", "helper.js"), "utf8"),
    ).toBe("// helper");
    // vendor-a was never listed (skipped)
    expect(cfSsh).toHaveBeenCalledTimes(4);
  });

  it("include normalizes paths with leading slash and trailing slash", async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    const openCfSession = vi.fn().mockResolvedValue({ context: sessionContext, dispose });
    const cfSsh = vi.fn()
      .mockResolvedValueOnce(makeLsOutput([{ name: "deps", isDir: true, size: 4096 }]))
      .mockResolvedValueOnce(makeLsOutput([{ name: "@org", isDir: true, size: 4096 }]))
      .mockResolvedValueOnce(makeLsOutput([{ name: "file.js", isDir: false, size: 3 }]));
    const cfSshBuffer = vi.fn().mockResolvedValue(Buffer.from("ok"));

    vi.doMock("../../src/session.js", () => ({ openCfSession }));
    vi.doMock("../../src/cf.js", () => ({ cfSsh, cfSshBuffer }));

    const { downloadFolder } = await import("../../src/download-folder.js");
    const result = await downloadFolder({
      target: { region: "ap10", org: "o", space: "s", app: "a" },
      remotePath: "/home/vcap/app",
      outDir: join(tempDir, "out"),
      exclude: ["/deps/"],   // leading slash + trailing slash
      include: ["./deps/@org/"], // leading ./ + trailing slash
    });

    expect(result.files).toBe(1);
  });

  it("empty exclude and include arrays behave like no filters", async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    const openCfSession = vi.fn().mockResolvedValue({ context: sessionContext, dispose });
    const cfSsh = vi.fn()
      .mockResolvedValueOnce(makeLsOutput([{ name: "file.txt", isDir: false, size: 4 }]));
    const cfSshBuffer = vi.fn().mockResolvedValue(Buffer.from("data"));

    vi.doMock("../../src/session.js", () => ({ openCfSession }));
    vi.doMock("../../src/cf.js", () => ({ cfSsh, cfSshBuffer }));

    const { downloadFolder } = await import("../../src/download-folder.js");
    const result = await downloadFolder({
      target: { region: "ap10", org: "o", space: "s", app: "a" },
      remotePath: "/home/vcap/app",
      outDir: join(tempDir, "out"),
      exclude: [],
      include: [],
    });

    expect(result.files).toBe(1);
  });
});
