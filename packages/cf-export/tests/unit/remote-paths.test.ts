import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import * as cfModule from "../../src/cf.js";
import { fetchRemoteTextFile } from "../../src/remote-paths.js";

describe("buildRemoteFilePaths (via fetch)", () => {
  it("prefers remoteRoot when provided", () => {
    // indirect: we will spy on build inside fetch flow
  });
});

describe("fetchRemoteTextFile", () => {
  const appName = "demo-app";

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns content from first successful path", async () => {
    const cfSsh = vi.spyOn(cfModule, "cfSsh").mockResolvedValueOnce(
      `__SAPTOOLS_CF_EXPORT_FILE_CONTENT__\n{"name":"demo"}\n`,
    );

    const res = await fetchRemoteTextFile({
      appName,
      fileName: "package.json",
      remoteRoot: "/custom/root",
    });

    expect(res).toBe('{"name":"demo"}\n');
    expect(cfSsh).toHaveBeenCalledTimes(1);
    expect(cfSsh).toHaveBeenCalledWith(
      appName,
      expect.stringContaining("/custom/root/package.json"),
      undefined,
    );
  });

  it("falls back through locations and returns null when all fail", async () => {
    vi.spyOn(cfModule, "cfSsh").mockRejectedValue(new Error("no such file"));

    const res = await fetchRemoteTextFile({
      appName,
      fileName: ".npmrc",
    });

    expect(res).toBeNull();
  });

  it("returns null when sentinel is missing (command succeeded but no marker)", async () => {
    vi.spyOn(cfModule, "cfSsh").mockResolvedValue("some random output without sentinel\n");

    const res = await fetchRemoteTextFile({ appName, fileName: "pnpm-lock.yaml" });
    expect(res).toBeNull();
  });
});
