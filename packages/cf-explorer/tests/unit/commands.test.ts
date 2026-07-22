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
    expect(script.script).toContain("CFX_MAX_FILES=3");
    expect(script.script).toContain("CFX_FETCH_FILES=4");
    expect(script.script).toContain("if [ -d '/workspace/app' ]; then printf '%s\\n' '/workspace/app'; fi");
    expect(script.script).not.toContain("if [ -d '/srv' ]; then printf");
    expect(script.script).toContain("find / -maxdepth 4");
    expect(script.script).toContain("-path '*/node_modules'");
    expect(script.script).toContain('head -n "$CFX_FETCH_FILES"');
    expect(script.maxFiles).toBe(3);
  });

  it("builds find with root validation and default glob wrapping", () => {
    const script = buildFindScript({ root: "/workspace/app", name: "service" });
    expect(script.script).toContain("CFX_ROOT='/workspace/app'");
    expect(script.script).toContain("CFX_NAME='*service*'");
    expect(script.script).toContain("CFX_MAX_FILES=200");
    expect(script.script).toContain("CFX_FETCH_FILES=201");
    expect(script.script).toContain("-path '*/node_modules'");
    expect(script.script).toContain("-path '*/node_modules/*'");
    expect(script.script).toContain('head -n "$CFX_FETCH_FILES"');
    expect(script.maxFiles).toBe(200);
  });

  it("builds one-level directory listing with bounded output", () => {
    const script = buildLsScript({ path: "/workspace/app", maxFiles: 5 });
    expect(script.script).toContain("CFX_OP='ls'");
    expect(script.script).toContain("CFX_PATH='/workspace/app'");
    expect(script.script).toContain("-mindepth 1 -maxdepth 1");
    expect(script.script).toContain("CFX\\tLS\\t%s\\t%s\\t%s\\t%s\\n");
    expect(script.script).toContain("readlink");
    expect(script.script).toContain("CFX_MAX_FILES=5");
    expect(script.script).toContain("CFX_FETCH_FILES=6");
    expect(script.script).toContain('head -n "$CFX_FETCH_FILES"');
    expect(script.maxFiles).toBe(5);
  });

  it("builds filtered directory listings and can follow symlinks", () => {
    const script = buildLsScript({
      path: "/workspace/app",
      pattern: "*helper*",
      followSymlinks: true,
    });
    expect(script.script).toContain("CFX_PATTERN='*helper*'");
    expect(script.script).toContain(
      'find -L "$CFX_PATH" -mindepth 1 -maxdepth 1 -name "$CFX_PATTERN" -print 2>/dev/null | sort | head -n "$CFX_FETCH_FILES"',
    );
    expect(script.script.indexOf('-name "$CFX_PATTERN"')).toBeLessThan(
      script.script.indexOf('head -n "$CFX_FETCH_FILES"'),
    );
  });

  it("builds grep with fixed-string search without preview by default", () => {
    const script = buildGrepScript({ root: "/workspace/app", text: "needle-api", maxMatches: 5 });
    expect(script.script).toContain("grep -n -I -F");
    expect(script.script).toContain("CFX\\tGREP\\t%s\\t%s\\t\\n");
    expect(script.script).not.toContain("cfx_preview");
    expect(script.script).toContain("CFX_TEXT='needle-api'");
    expect(script.script).toContain("CFX_MAX_MATCHES=5");
    expect(script.script).toContain("CFX_FETCH_MATCHES=6");
    expect(script.script).toContain('head -n "$CFX_FETCH_MATCHES"');
    expect(script.maxMatches).toBe(5);
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
    expect(grep.script).toContain("CFX_MAX_MATCHES=4");
    expect(grep.script).toContain("CFX_FETCH_MATCHES=5");
    expect(grep.script).toContain('head -n "$CFX_FETCH_MATCHES"');

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
    expect(script.script).toContain("CFX_MAX_FILES=7");
    expect(script.script).toContain("CFX_FETCH_FILES=8");
    expect(script.script).toContain("CFX_MAX_MATCHES=3");
    expect(script.script).toContain("CFX_FETCH_MATCHES=4");
    expect(script.script).toContain('head -n "$CFX_FETCH_FILES"');
    expect(script.script).toContain('head -n "$CFX_FETCH_MATCHES"');
    expect(script.maxFiles).toBe(7);
    expect(script.maxMatches).toBe(3);
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
    expect(() => buildRootsScript(10_001)).toThrow(/maxFiles/);
    expect(() => buildViewScript({ file: "/workspace/app/a.js", line: 0 })).toThrow(/line/);
    expect(() => buildViewScript({ file: "/workspace/app/a.js", line: 1, context: 1001 }))
      .toThrow(/context/);
  });

  it("keeps the user limit at the hard ceiling while probing one extra result", () => {
    const rootsScript = buildRootsScript(10_000);
    expect(rootsScript.script).toContain("CFX_MAX_FILES=10000");
    expect(rootsScript.script).toContain("CFX_FETCH_FILES=10001");
    expect(rootsScript.maxFiles).toBe(10_000);

    const grepScript = buildGrepScript({
      root: "/workspace/app",
      text: "needle-api",
      maxMatches: 10_000,
    });
    expect(grepScript.script).toContain("CFX_MAX_MATCHES=10000");
    expect(grepScript.script).toContain("CFX_FETCH_MATCHES=10001");
    expect(grepScript.maxMatches).toBe(10_000);

    const inspectScript = buildInspectCandidatesScript({
      text: "needle-api",
      maxFiles: 10_000,
      maxMatches: 10_000,
    });
    expect(inspectScript.script).toContain("CFX_MAX_FILES=10000");
    expect(inspectScript.script).toContain("CFX_FETCH_FILES=10001");
    expect(inspectScript.script).toContain("CFX_MAX_MATCHES=10000");
    expect(inspectScript.script).toContain("CFX_FETCH_MATCHES=10001");
  });

  it("preserves explicit glob patterns", () => {
    const script = buildFindScript({ root: "/workspace/app", name: "*.js" });
    expect(script.script).toContain("CFX_NAME='*.js'");
  });
});
