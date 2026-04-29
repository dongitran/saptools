import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
  buildAuthenticatedRemote,
  encodeProjectPath,
  parseRepoRef,
  parseSourceMergeRequestRef,
} from "../../src/repo-url.js";

describe("parseRepoRef", () => {
  it("parses HTTPS GitLab repo URLs", () => {
    const spec = parseRepoRef("https://gitlab.example.com/repo-a.git");
    expect(spec.projectPath).toBe("repo-a");
    expect(spec.defaultApiBase).toBe("https://gitlab.example.com/api/v4");
    expect(spec.name).toBe("repo-a");
  });

  it("parses HTTPS GitLab repo URLs without .git suffixes", () => {
    const spec = parseRepoRef("https://gitlab.example.com/team/repo-a");
    expect(spec.original).toBe("https://gitlab.example.com/team/repo-a");
    expect(spec.projectPath).toBe("team/repo-a");
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

describe("parseSourceMergeRequestRef", () => {
  it("parses GitLab MR URLs into a source repo ref and IID", () => {
    const spec = parseSourceMergeRequestRef(
      "https://gitlab.example.com/team/repo-a/-/merge_requests/280",
    );

    expect(spec.sourceRepo.original).toBe("https://gitlab.example.com/team/repo-a");
    expect(spec.sourceRepo.projectPath).toBe("team/repo-a");
    expect(spec.sourceMergeRequestIid).toBe(280);
    expect(spec.sourceMergeRequestUrl).toBe(
      "https://gitlab.example.com/team/repo-a/-/merge_requests/280",
    );
  });

  it("normalizes GitLab MR tab URLs into the base MR URL", () => {
    const refs = [
      "https://gitlab.example.com/team/repo-a/-/merge_requests/280/diffs",
      "https://gitlab.example.com/team/repo-a/-/merge_requests/280/commits",
      "https://gitlab.example.com/team/repo-a/-/merge_requests/280/pipelines?tab=jobs#L1",
      "https://gitlab.example.com/team/repo-a/-/merge_requests/280/",
    ];

    for (const ref of refs) {
      const spec = parseSourceMergeRequestRef(ref);
      expect(spec.sourceRepo.original).toBe("https://gitlab.example.com/team/repo-a");
      expect(spec.sourceMergeRequestIid).toBe(280);
      expect(spec.sourceMergeRequestUrl).toBe(
        "https://gitlab.example.com/team/repo-a/-/merge_requests/280",
      );
    }
  });

  it("parses local MR refs for offline fixtures", () => {
    const spec = parseSourceMergeRequestRef("/tmp/example/repo-a.git/-/merge_requests/123");

    expect(spec.sourceRepo.original).toBe("/tmp/example/repo-a.git");
    expect(spec.sourceRepo.projectPath).toBe("repo-a");
    expect(spec.sourceMergeRequestIid).toBe(123);
  });

  it("normalizes local MR tab refs into the base MR ref", () => {
    const spec = parseSourceMergeRequestRef("/tmp/example/repo-a.git/-/merge_requests/123/diffs");

    expect(spec.sourceRepo.original).toBe("/tmp/example/repo-a.git");
    expect(spec.sourceMergeRequestIid).toBe(123);
    expect(spec.sourceMergeRequestUrl).toBe("/tmp/example/repo-a.git/-/merge_requests/123");
  });

  it("rejects source refs that are not merge request URLs", () => {
    expect(() => parseSourceMergeRequestRef("https://gitlab.example.com/team/repo-a")).toThrow(
      /Source repo must be a GitLab merge request URL/,
    );
  });

  it("rejects invalid merge request IIDs", () => {
    expect(() =>
      parseSourceMergeRequestRef("https://gitlab.example.com/team/repo-a/-/merge_requests/abc"),
    ).toThrow(/Source repo must be a GitLab merge request URL/);
  });

  it("rejects unsafe merge request IIDs", () => {
    expect(() =>
      parseSourceMergeRequestRef(
        "https://gitlab.example.com/team/repo-a/-/merge_requests/9007199254740993",
      ),
    ).toThrow(/Source repo must be a GitLab merge request URL/);
  });

  it("rejects merge request URLs without an IID", () => {
    expect(() =>
      parseSourceMergeRequestRef("https://gitlab.example.com/team/repo-a/-/merge_requests/"),
    ).toThrow(/Source repo must be a GitLab merge request URL/);
  });
});

describe("buildAuthenticatedRemote", () => {
  it("embeds OAuth token for HTTPS remotes", () => {
    const remote = buildAuthenticatedRemote("https://gitlab.example.com/repo-a.git", "abc123");
    expect(remote).toBe("https://oauth2:abc123@gitlab.example.com/repo-a.git");
  });

  it("embeds OAuth token for HTTPS remotes without .git suffixes", () => {
    const remote = buildAuthenticatedRemote("https://gitlab.example.com/team/repo-a", "abc123");
    expect(remote).toBe("https://oauth2:abc123@gitlab.example.com/team/repo-a");
  });

  it("does not mutate local paths", () => {
    expect(buildAuthenticatedRemote("/tmp/repo-a.git", "abc123")).toBe("/tmp/repo-a.git");
  });

  it("does not mutate file remotes", () => {
    expect(buildAuthenticatedRemote("file:///tmp/repo-a.git", "abc123")).toBe("file:///tmp/repo-a.git");
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
