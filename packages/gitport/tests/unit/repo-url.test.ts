import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { buildAuthenticatedRemote, encodeProjectPath, parseRepoRef } from "../../src/repo-url.js";

describe("parseRepoRef", () => {
  it("parses HTTPS GitLab repo URLs", () => {
    const spec = parseRepoRef("https://gitlab.example.com/repo-a.git");
    expect(spec.projectPath).toBe("repo-a");
    expect(spec.defaultApiBase).toBe("https://gitlab.example.com/api/v4");
    expect(spec.name).toBe("repo-a");
  });

  it("parses SSH scp-style repo URLs", () => {
    const spec = parseRepoRef("git@gitlab.example.com:team/repo-a.git");
    expect(spec.projectPath).toBe("team/repo-a");
    expect(spec.defaultApiBase).toBe("https://gitlab.example.com/api/v4");
    expect(spec.name).toBe("repo-a");
  });

  it("parses local bare repo paths for offline tests", () => {
    const spec = parseRepoRef("/tmp/example/repo-a.git");
    expect(spec.projectPath).toBe("repo-a");
    expect(spec.name).toBe("repo-a");
    expect(spec.defaultApiBase).toBeUndefined();
  });

  it("parses file URLs for offline tests", () => {
    const spec = parseRepoRef(pathToFileURL("/tmp/example/repo-a.git").toString());
    expect(spec.projectPath).toBe("repo-a");
    expect(spec.kind).toBe("file");
  });

  it("rejects empty repo refs", () => {
    expect(() => parseRepoRef("   ")).toThrow(/cannot be empty/);
  });

  it("rejects HTTP URLs without a project path", () => {
    expect(() => parseRepoRef("https://gitlab.example.com")).toThrow(/Invalid repo URL/);
  });

  it("rejects local paths without a repository name", () => {
    expect(() => parseRepoRef("/")).toThrow(/Invalid repo path/);
  });

  it("rejects unsupported URL protocols", () => {
    expect(() => parseRepoRef("ftp://gitlab.example.com/repo-a.git")).toThrow(
      /Unsupported repo URL scheme/,
    );
  });
});

describe("encodeProjectPath", () => {
  it("URL-encodes nested GitLab project paths", () => {
    expect(encodeProjectPath("team/sub/repo-a")).toBe(["team", "sub", "repo-a"].join("%2F"));
  });
});

describe("buildAuthenticatedRemote", () => {
  it("embeds OAuth token for HTTPS remotes", () => {
    const remote = buildAuthenticatedRemote("https://gitlab.example.com/repo-a.git", "abc123");
    expect(remote).toBe("https://oauth2:abc123@gitlab.example.com/repo-a.git");
  });

  it("does not mutate local paths", () => {
    expect(buildAuthenticatedRemote("/tmp/repo-a.git", "abc123")).toBe("/tmp/repo-a.git");
  });

  it("does not mutate SSH remotes", () => {
    expect(buildAuthenticatedRemote("git@gitlab.example.com:repo-a.git", "abc123")).toBe(
      "git@gitlab.example.com:repo-a.git",
    );
  });

  it("does not mutate malformed URL strings", () => {
    expect(buildAuthenticatedRemote("https://", "abc123")).toBe("https://");
  });
});
