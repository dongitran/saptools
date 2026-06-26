import { describe, expect, it } from "vitest";

import { buildRemoteFilePaths, buildCatCommand, parseRemoteFileContent, REMOTE_CONTENT_SENTINEL } from "../../src/cf.js";

describe("buildRemoteFilePaths", () => {
  it("includes remoteRoot first when provided", () => {
    const paths = buildRemoteFilePaths("pnpm-lock.yaml", "/home/vcap/app/sub");
    expect(paths[0]).toBe("/home/vcap/app/sub/pnpm-lock.yaml");
  });

  it("falls back to standard locations", () => {
    const paths = buildRemoteFilePaths(".cdsrc.json", undefined);
    expect(paths).toContain("/home/vcap/app/.cdsrc.json");
    expect(paths).toContain(".cdsrc.json");
  });
});

describe("cat command + parse", () => {
  it("builds guarded cat command containing sentinel", () => {
    const cmd = buildCatCommand("/a/b.txt");
    expect(cmd).toContain("if [ -f ");
    expect(cmd).toContain(REMOTE_CONTENT_SENTINEL);
  });

  it("parses sentinel-prefixed content", () => {
    const raw = `${REMOTE_CONTENT_SENTINEL}\nhello world\n`;
    expect(parseRemoteFileContent(raw)).toBe("hello world\n");
  });

  it("returns null when sentinel missing", () => {
    expect(parseRemoteFileContent("no marker here")).toBeNull();
  });
});
