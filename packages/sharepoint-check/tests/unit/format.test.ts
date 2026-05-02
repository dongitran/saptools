import { describe, expect, it } from "vitest";

import { renderFolderTree, renderValidateResult, summarizeToken } from "../../src/format.js";

describe("summarizeToken", () => {
  it("joins app display + id + tenant + roles", () => {
    const summary = summarizeToken({
      appId: "aid",
      appDisplayName: "Demo",
      tenantId: "tid",
      roles: ["Sites.Selected"],
      scopes: [],
    });
    expect(summary).toContain("App: Demo");
    expect(summary).toContain("AppId: aid");
    expect(summary).toContain("Tenant: tid");
    expect(summary).toContain("Roles: Sites.Selected");
  });

  it("falls back to scopes when roles are empty", () => {
    const summary = summarizeToken({
      appId: "aid",
      roles: [],
      scopes: ["User.Read"],
    });
    expect(summary).toContain("Scopes: User.Read");
  });

  it("reports '(none)' when both roles and scopes are empty", () => {
    const summary = summarizeToken({ appId: "a", roles: [], scopes: [] });
    expect(summary).toContain("Roles: (none)");
  });
});

describe("renderFolderTree", () => {
  it("renders hierarchy with file counts and sizes", () => {
    const output = renderFolderTree({
      name: "Apps",
      path: "Apps",
      fileCount: 0,
      folderCount: 1,
      totalSize: 100,
      children: [
        {
          name: "demo",
          path: "Apps/demo",
          fileCount: 2,
          folderCount: 0,
          totalSize: 50,
          children: [],
        },
      ],
    });
    expect(output).toContain("- Apps");
    expect(output).toContain("2 files");
    expect(output).toContain("50 B");
  });

  it("renders root label '/' for empty path", () => {
    const output = renderFolderTree({
      name: "/",
      path: "",
      fileCount: 0,
      folderCount: 0,
      totalSize: 0,
      children: [],
    });
    expect(output.startsWith("- /")).toBe(true);
  });

  it("formats sizes in KB/MB when large", () => {
    const output = renderFolderTree({
      name: "r",
      path: "",
      fileCount: 1,
      folderCount: 0,
      totalSize: 2_500_000,
      children: [],
    });
    expect(output).toMatch(/\bMB\b/);
  });

  it("uses decimal precision for small KB values", () => {
    const output = renderFolderTree({
      name: "r",
      path: "",
      fileCount: 1,
      folderCount: 0,
      totalSize: 1536,
      children: [],
    });
    expect(output).toContain("1.5 KB");
  });

  it("renders invalid or negative sizes as zero bytes", () => {
    const output = renderFolderTree({
      name: "r",
      path: "",
      fileCount: 1,
      folderCount: 1,
      totalSize: Number.NaN,
      children: [
        {
          name: "child",
          path: "child",
          fileCount: 0,
          folderCount: 0,
          totalSize: -10,
          children: [],
        },
      ],
    });
    expect(output).toContain("(1 files, 1 subfolders, 0 B)");
    expect(output).toContain("(0 files, 0 subfolders, 0 B)");
  });
});

describe("renderValidateResult", () => {
  it("marks present and missing entries with ✔/✘", () => {
    const out = renderValidateResult({
      root: { path: "Apps", exists: true, isFolder: true },
      subdirectories: [
        { path: "Apps/demo", exists: true, isFolder: true },
        { path: "Apps/ghost", exists: false, isFolder: false },
      ],
      allPresent: false,
    });
    expect(out).toContain("✔ root: Apps");
    expect(out).toContain("✔ Apps/demo");
    expect(out).toContain("✘ Apps/ghost");
    expect(out).toContain("missing");
  });

  it("reports success line when allPresent is true", () => {
    const out = renderValidateResult({
      root: { path: "", exists: true, isFolder: true },
      subdirectories: [],
      allPresent: true,
    });
    expect(out).toContain("All expected folders present");
    expect(out).toContain("✔ root: /");
  });
});
