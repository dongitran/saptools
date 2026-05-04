import { describe, expect, it } from "vitest";

import { GitportError } from "../../src/errors.js";
import {
  ensureDraftTitle,
  nextPageFromHeaders,
  parseCommit,
  parseCreatedMergeRequest,
  parseCurrentUser,
  parseMergeRequest,
} from "../../src/gitlab/response.js";

describe("GitLab response parsing", () => {
  it("parses merge request metadata into internal field names", () => {
    expect(
      parseMergeRequest({
        iid: 123,
        title: "Source MR",
        sha: "abc123",
        source_branch: "feature/gitport",
        web_url: "https://gitlab.example.com/repo-a/-/merge_requests/123",
      }),
    ).toEqual({
      iid: 123,
      title: "Source MR",
      headSha: "abc123",
      sourceBranch: "feature/gitport",
      webUrl: "https://gitlab.example.com/repo-a/-/merge_requests/123",
    });
  });

  it("parses merge request head SHA from diff refs when sha is absent", () => {
    expect(
      parseMergeRequest({
        iid: 123,
        title: "Source MR",
        diff_refs: {
          head_sha: "def456",
        },
        source_branch: "feature/gitport",
        web_url: "https://gitlab.example.com/repo-a/-/merge_requests/123",
      }),
    ).toMatchObject({
      headSha: "def456",
    });
  });

  it("keeps merge request head SHA optional", () => {
    expect(
      parseMergeRequest({
        iid: 123,
        title: "Source MR",
        source_branch: "feature/gitport",
        web_url: "https://gitlab.example.com/repo-a/-/merge_requests/123",
      }),
    ).toEqual({
      iid: 123,
      title: "Source MR",
      sourceBranch: "feature/gitport",
      webUrl: "https://gitlab.example.com/repo-a/-/merge_requests/123",
    });
  });

  it("rejects malformed merge request metadata", () => {
    expect(() => parseMergeRequest([])).toThrow(GitportError);
    expect(() => parseMergeRequest({ iid: 123, title: "Source MR" })).toThrow(
      /MR response is missing fields/,
    );
  });

  it("parses the current user response", () => {
    expect(parseCurrentUser({ id: 42, username: "gitport-bot" })).toEqual({
      id: 42,
      username: "gitport-bot",
    });
  });

  it("parses commits and falls back to the title when message is absent", () => {
    expect(parseCommit({ id: "abc123", title: "port change" })).toEqual({
      sha: "abc123",
      title: "port change",
      message: "port change",
    });
    expect(
      parseCommit({
        id: "def456",
        title: "port change",
        message: "port change\n\nbody",
      }),
    ).toEqual({
      sha: "def456",
      title: "port change",
      message: "port change\n\nbody",
    });
  });

  it("parses created merge requests and defaults missing draft to true", () => {
    expect(
      parseCreatedMergeRequest({
        iid: 7,
        web_url: "https://gitlab.example.com/repo-b/-/merge_requests/7",
      }),
    ).toEqual({
      iid: 7,
      webUrl: "https://gitlab.example.com/repo-b/-/merge_requests/7",
      draft: true,
    });
    expect(
      parseCreatedMergeRequest({
        iid: 8,
        web_url: "https://gitlab.example.com/repo-b/-/merge_requests/8",
        draft: false,
      }),
    ).toEqual({
      iid: 8,
      webUrl: "https://gitlab.example.com/repo-b/-/merge_requests/8",
      draft: false,
    });
  });

  it("normalizes Draft merge request titles without double-prefixing", () => {
    expect(ensureDraftTitle("JIR-112 carry feature")).toBe("Draft: JIR-112 carry feature");
    expect(ensureDraftTitle("Draft: Existing title")).toBe("Draft: Existing title");
  });

  it("reads next pages from GitLab pagination headers", () => {
    const xNextPageHeaders = new Headers({
      link: '<https://gitlab.example.com/api/v4/projects/repo/commits?page=3>; rel="next"',
      "x-next-page": " 2 ",
    });
    expect(nextPageFromHeaders(xNextPageHeaders)).toBe("2");

    const linkHeaders = new Headers({
      link: '<https://gitlab.example.com/api/v4/projects/repo/commits?page=3&per_page=100>; rel="next"',
    });
    expect(nextPageFromHeaders(linkHeaders)).toBe("3");
    expect(nextPageFromHeaders(new Headers())).toBeUndefined();
  });
});
