import { describe, expect, it, vi } from "vitest";

import {
  deleteJiraIssueComment,
  fetchJiraIssueComment,
  parseJiraIssueCommentDetail,
} from "../../src/issue-comments.js";

const apiRoot = "https://jira-api.example.com/ex/jira";
const commentBody = {
  type: "doc" as const,
  version: 1,
  content: [{ type: "paragraph", content: [{ type: "text", text: "Recover me" }] }],
};
type FetchInput = Parameters<typeof fetch>[0];

describe("Jira issue comment client", () => {
  it("fetches and maps the full recovery content for one comment", async () => {
    const fetchMock = vi.fn(async (_input: FetchInput, _init?: RequestInit) => {
      return await Promise.resolve(jsonResponse({
        author: { accountId: "account-reviewer", displayName: "Synthetic Reviewer" },
        body: commentBody,
        created: "2026-07-24T08:00:00.000+0000",
        id: 10098,
        updated: "2026-07-24T09:00:00.000+0000",
      }));
    });

    await expect(fetchJiraIssueComment({
      accessToken: "secret-access-token",
      apiRoot,
      cloudId: "cloud-1",
      commentId: "10098",
      fetchImpl: fetchMock,
      issueKey: "OPS/123",
    })).resolves.toEqual({
      authorDisplayName: "Synthetic Reviewer",
      body: commentBody,
      created: "2026-07-24T08:00:00.000+0000",
      id: "10098",
      updated: "2026-07-24T09:00:00.000+0000",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://jira-api.example.com/ex/jira/cloud-1/rest/api/3/issue/OPS%2F123/comment/10098",
      {
        headers: {
          Accept: "application/json",
          Authorization: "Bearer secret-access-token",
        },
      },
    );
  });

  it("rejects malformed comment responses without returning partial content", () => {
    expect(() => parseJiraIssueCommentDetail({
      author: { displayName: "Synthetic Reviewer" },
      body: commentBody,
      created: "2026-07-24T08:00:00.000+0000",
      id: "10098",
    })).toThrow("Jira issue comment response was not valid.");
  });

  it("uses neutral load failures without exposing Jira response bodies", async () => {
    const fetchMock = vi.fn(async () => {
      return await Promise.resolve(new Response("private Jira detail", { status: 404 }));
    });

    await expect(fetchJiraIssueComment({
      accessToken: "secret-access-token",
      apiRoot,
      cloudId: "cloud-1",
      commentId: "missing",
      fetchImpl: fetchMock,
      issueKey: "OPS-123",
    })).rejects.toThrow("Jira issue comment could not be loaded.");

    const invalidJsonFetch = vi.fn(async () => {
      return await Promise.resolve(new Response("private comment detail", { status: 200 }));
    });
    await expect(fetchJiraIssueComment({
      accessToken: "secret-access-token",
      apiRoot,
      cloudId: "cloud-1",
      commentId: "missing",
      fetchImpl: invalidJsonFetch,
      issueKey: "OPS-123",
    })).rejects.toThrow("Jira issue comment response was not valid.");
  });

  it("rejects a response for a different comment ID", async () => {
    const fetchMock = vi.fn(async () => {
      return await Promise.resolve(jsonResponse({
        author: { displayName: "Synthetic Reviewer" },
        body: commentBody,
        created: "2026-07-24T08:00:00.000+0000",
        id: "different-comment",
        updated: "2026-07-24T09:00:00.000+0000",
      }));
    });

    await expect(fetchJiraIssueComment({
      accessToken: "secret-access-token",
      apiRoot,
      cloudId: "cloud-1",
      commentId: "10098",
      fetchImpl: fetchMock,
      issueKey: "OPS-123",
    })).rejects.toThrow("Jira issue comment response was not valid.");
  });

  it("deletes exactly one comment and accepts Jira's empty 204 response", async () => {
    const fetchMock = vi.fn(async () => {
      return await Promise.resolve(new Response(null, { status: 204 }));
    });

    await expect(deleteJiraIssueComment({
      accessToken: "secret-access-token",
      apiRoot,
      cloudId: "cloud-1",
      commentId: "10098",
      fetchImpl: fetchMock,
      issueKey: "OPS-123",
    })).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://jira-api.example.com/ex/jira/cloud-1/rest/api/3/issue/OPS-123/comment/10098",
      {
        headers: {
          Accept: "application/json",
          Authorization: "Bearer secret-access-token",
        },
        method: "DELETE",
      },
    );
  });

  it("surfaces a neutral delete failure without retries or response details", async () => {
    const fetchMock = vi.fn(async () => {
      return await Promise.resolve(new Response("private Jira detail", { status: 500 }));
    });

    await expect(deleteJiraIssueComment({
      accessToken: "secret-access-token",
      apiRoot,
      cloudId: "cloud-1",
      commentId: "10098",
      fetchImpl: fetchMock,
      issueKey: "OPS-123",
    })).rejects.toThrow("Jira issue comment could not be deleted.");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}
