import { describe, expect, it } from "vitest";

import { CfExplorerError } from "../../src/core/errors.js";
import {
  buildFindScript,
  buildGrepScript,
  buildInspectCandidatesScript,
  buildLsScript,
  buildRootsScript,
  buildViewScript,
  quoteRemoteShellArg,
} from "../../src/discovery/commands.js";

describe("remote command builders", () => {
  it("quotes shell arguments and escapes single quotes", () => {
    expect(quoteRemoteShellArg("/workspace/app/it's here.js")).toBe(
      "'/workspace/app/it'\\''s here.js'",
    );
  });

  it("rejects command separators before shell quoting", () => {
    expect(() => quoteRemoteShellArg("/workspace/app; rm -rf /")).toThrow(CfExplorerError);
    expect(() => quoteRemoteShellArg("/workspace/app\nnext")).toThrow(/newlines/);
    expect(() => quoteRemoteShellArg("/workspace/app/$(bad)")).toThrow(/unsafe/);
  });

  it("builds a bounded roots script", () => {
    const script = buildRootsScript(3);
    expect(script.script).toContain("CFX_OP='roots'");
    expect(script.script).toContain("emit_root '/workspace/app'");
    expect(script.script).not.toContain("emit_root '/srv'");
    expect(script.script).toContain("find / -maxdepth 4");
    expect(script.script).toContain("-path '*/node_modules'");
    expect(script.script).toContain("head -n 3");
  });

  it("builds find with root validation and default glob wrapping", () => {
    const script = buildFindScript({ root: "/workspace/app", name: "service" });
    expect(script.script).toContain("CFX_ROOT='/workspace/app'");
    expect(script.script).toContain("CFX_NAME='*service*'");
    expect(script.script).toContain("-path '*/node_modules'");
    expect(script.script).toContain("-path '*/node_modules/*'");
  });

  it("builds one-level directory listing with bounded output", () => {
    const script = buildLsScript({ path: "/workspace/app", maxFiles: 5 });
    expect(script.script).toContain("CFX_OP='ls'");
    expect(script.script).toContain("CFX_PATH='/workspace/app'");
    expect(script.script).toContain("-mindepth 1 -maxdepth 1");
    expect(script.script).toContain("CFX\\tLS\\t%s\\t%s\\t%s\\t%s\\n");
    expect(script.script).toContain("readlink");
    expect(script.script).toContain("head -n 5");
  });

  it("builds filtered directory listings and can follow symlinks", () => {
    const script = buildLsScript({
      path: "/workspace/app",
      pattern: "*helper*",
      followSymlinks: true,
    });
    expect(script.script).toContain("CFX_PATTERN='*helper*'");
    expect(script.script).toContain("find -L \"$CFX_PATH\" -mindepth 1 -maxdepth 1 -name \"$CFX_PATTERN\"");
  });

  it("builds grep with fixed-string search without preview by default", () => {
    const script = buildGrepScript({ root: "/workspace/app", text: "needle-api", maxMatches: 5 });
    expect(script.script).toContain("grep -n -I -F");
    expect(script.script).toContain("CFX\\tGREP\\t%s\\t%s\\t\\n");
    expect(script.script).not.toContain("cfx_preview");
    expect(script.script).toContain("CFX_TEXT='needle-api'");
    expect(script.script).toContain("head -n 5");
  });

  it("builds grep and find with symlink-following find commands", () => {
    const grep = buildGrepScript({
      root: "/workspace/app",
      text: "needle-api",
      maxMatches: 4,
      followSymlinks: true,
      includeFiles: true,
    });
    expect(grep.script).toContain("find -L \"$CFX_ROOT\"");
    expect(grep.script).not.toContain("-path '*/node_modules'");
    expect(grep.script).not.toContain("-path '*/node_modules/*'");
    expect(grep.script).toContain("-path '*/.git'");
    expect(grep.script).toContain("head -n 4");

    const find = buildFindScript({ root: "/workspace/app", name: "helper", followSymlinks: true });
    expect(find.script).toContain("find -L \"$CFX_ROOT\"");
    expect(find.script).not.toContain("-path '*/node_modules'");
  });

  it("emits grep preview only when requested", () => {
    const script = buildGrepScript({
      root: "/workspace/app",
      text: "needle-api",
      maxFiles: 5,
      preview: true,
    });
    expect(script.script).toContain("cfx_preview=${cfx_hit#*:}");
    expect(script.script).toContain("CFX\\tGREP\\t%s\\t%s\\t%s\\n");
  });

  it("builds view with large bounded line context", () => {
    const script = buildViewScript({ file: "/workspace/app/src/server.js", line: 140, context: 140 });
    expect(script.script).toContain("CFX_VIEW_START=1");
    expect(script.script).toContain("CFX_VIEW_END=280");
    expect(script.script).toContain("awk -v cfx_start=\"$CFX_VIEW_START\" -v cfx_end=\"$CFX_VIEW_END\"");
    expect(script.script).toContain("printf \"CFX\\tLINE\\t%d\\t%s\\n\", NR, $0");
    expect(script.script).not.toContain("nl -ba");
    expect(script.script).toContain("CFX_FILE='/workspace/app/src/server.js'");
  });

  it("accepts the maximum view context limit", () => {
    const script = buildViewScript({ file: "/workspace/app/src/server.js", line: 20_000, context: 10_000 });
    expect(script.script).toContain("CFX_VIEW_START=10000");
    expect(script.script).toContain("CFX_VIEW_END=30000");
  });

  it("builds inspect candidates from fixed subcommands", () => {
    const script = buildInspectCandidatesScript({
      root: "/workspace/app",
      text: "needle-api",
      name: "connect",
    });
    expect(script.script).toContain("CFX_OP='inspect'");
    expect(script.script).toContain("CFX_ROOT='/workspace/app'");
    expect(script.script).toContain("CFX_TEXT='needle-api'");
    expect(script.script).toContain("inspect_root \"$CFX_ROOT\"");
    expect(script.script).not.toContain("-iname \"$CFX_NAME\"");
  });

  it("builds inspect candidates with file listing only when requested", () => {
    const script = buildInspectCandidatesScript({
      root: "/workspace/app",
      text: "needle-api",
      name: "connect",
      includeFiles: true,
      maxFiles: 7,
      maxMatches: 3,
    });
    expect(script.script).toContain("CFX\\tFIND");
    expect(script.script).toContain("head -n 7");
    expect(script.script).toContain("head -n 3");
  });

  it("builds dynamic inspect candidates across discovered roots when no root is supplied", () => {
    const script = buildInspectCandidatesScript({ text: "needle-api", name: "connect" });
    expect(script.script).toContain("find / -maxdepth 4");
    expect(script.script).toContain("sort -u");
    expect(script.script).toContain("inspect_root \"$cfx_root\"");
    expect(script.script).toContain("CFX_NAME='*connect*'");
  });

  it("rejects invalid roots, line context, and max file limits", () => {
    expect(() => buildFindScript({ root: "relative", name: "x" })).toThrow(/absolute/);
    expect(() => buildLsScript({ path: "relative" })).toThrow(/absolute/);
    expect(() => buildFindScript({ root: "/workspace/../app", name: "x" })).toThrow(/parent/);
    expect(() => buildRootsScript(0)).toThrow(/maxFiles/);
    expect(() => buildViewScript({ file: "/workspace/app/a.js", line: 0 })).toThrow(/line/);
    expect(() => buildViewScript({ file: "/workspace/app/a.js", line: 1, context: 10001 }))
      .toThrow(/context/);
  });

  it("preserves explicit glob patterns", () => {
    const script = buildFindScript({ root: "/workspace/app", name: "*.js" });
    expect(script.script).toContain("CFX_NAME='*.js'");
  });
});
