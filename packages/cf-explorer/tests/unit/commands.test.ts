import { describe, expect, it } from "vitest";

import {
  buildFindScript,
  buildGrepScript,
  buildInspectCandidatesScript,
  buildRootsScript,
  buildViewScript,
  quoteRemoteShellArg,
} from "../../src/commands.js";
import { CfExplorerError } from "../../src/errors.js";

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

  it("builds grep with fixed-string search without preview by default", () => {
    const script = buildGrepScript({ root: "/workspace/app", text: "needle-api", maxFiles: 5 });
    expect(script.script).toContain("grep -n -I -F");
    expect(script.script).toContain("CFX\\tGREP\\t%s\\t%s\\t\\n");
    expect(script.script).not.toContain("cfx_preview");
    expect(script.script).toContain("CFX_TEXT='needle-api'");
    expect(script.script).toContain("head -n 5");
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

  it("builds view with bounded line context", () => {
    const script = buildViewScript({ file: "/workspace/app/src/server.js", line: 10, context: 2 });
    expect(script.script).toContain("sed -n '8,12p'");
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
    expect(() => buildFindScript({ root: "/workspace/../app", name: "x" })).toThrow(/parent/);
    expect(() => buildRootsScript(0)).toThrow(/maxFiles/);
    expect(() => buildViewScript({ file: "/workspace/app/a.js", line: 0 })).toThrow(/line/);
    expect(() => buildViewScript({ file: "/workspace/app/a.js", line: 1, context: 99 }))
      .toThrow(/context/);
  });

  it("preserves explicit glob patterns", () => {
    const script = buildFindScript({ root: "/workspace/app", name: "*.js" });
    expect(script.script).toContain("CFX_NAME='*.js'");
  });
});
