import { describe, expect, it } from "vitest";

import {
  DEFAULT_JIRA_API_ROOT,
  buildAssignedIssuesSearchBody,
  buildAssignedIssuesSearchUrl,
  buildJiraAssignableUserSearchUrl,
  buildJiraAttachmentContentUrl,
  buildJiraAttachmentThumbnailUrl,
  buildJiraCloudBaseUrl,
  buildJiraCurrentUserUrl,
  buildJiraIssueAssigneeUrl,
  buildJiraIssueCommentCreateUrl,
  buildJiraIssueCommentUrl,
  buildJiraIssueCommentsUrl,
  buildJiraIssueDescriptionUrl,
  buildJiraIssueDetailUrl,
  buildJiraIssueUpdateUrl,
  buildJiraIssueRemoteLinksUrl,
  buildJiraIssueTransitionsUrl,
  buildJiraIssueWorklogUrl,
} from "../../src/urls.js";

const gatewayBase = buildJiraCloudBaseUrl("cloud 1");
const siteBase = "https://acme.atlassian.net";

describe("Jira URL builders", () => {
  it("composes the gateway base URL from the cloud ID with encoded path segments", () => {
    expect(DEFAULT_JIRA_API_ROOT).toBe("https://api.atlassian.com/ex/jira");
    expect(gatewayBase).toBe("https://api.atlassian.com/ex/jira/cloud%201");
    expect(buildJiraCloudBaseUrl("cloud-1", "http://127.0.0.1:30129/ex/jira/")).toBe(
      "http://127.0.0.1:30129/ex/jira/cloud-1",
    );
  });

  it("builds Atlassian Cloud URLs with encoded path segments", () => {
    expect(buildAssignedIssuesSearchUrl(gatewayBase)).toBe(
      "https://api.atlassian.com/ex/jira/cloud%201/rest/api/3/search/jql",
    );
    expect(buildJiraIssueDetailUrl(gatewayBase, "OPS/123")).toBe(
      "https://api.atlassian.com/ex/jira/cloud%201/rest/api/3/issue/OPS%2F123?fields=summary%2Cstatus%2Cpriority%2Cassignee%2Cupdated%2Cissuetype%2Cdescription%2Ccomment%2Cattachment%2Cissuelinks&expand=renderedFields",
    );
    expect(buildJiraIssueRemoteLinksUrl(gatewayBase, "OPS/123")).toBe(
      "https://api.atlassian.com/ex/jira/cloud%201/rest/api/3/issue/OPS%2F123/remotelink",
    );
    expect(buildJiraIssueCommentsUrl(gatewayBase, "OPS/123", 100, 50)).toBe(
      "https://api.atlassian.com/ex/jira/cloud%201/rest/api/3/issue/OPS%2F123/comment?startAt=100&maxResults=50",
    );
    expect(buildJiraIssueCommentCreateUrl(gatewayBase, "OPS/123")).toBe(
      "https://api.atlassian.com/ex/jira/cloud%201/rest/api/3/issue/OPS%2F123/comment",
    );
    expect(buildJiraIssueCommentUrl(gatewayBase, "OPS/123", "100/98")).toBe(
      "https://api.atlassian.com/ex/jira/cloud%201/rest/api/3/issue/OPS%2F123/comment/100%2F98",
    );
    expect(buildJiraIssueDescriptionUrl(gatewayBase, "OPS/123")).toBe(
      "https://api.atlassian.com/ex/jira/cloud%201/rest/api/3/issue/OPS%2F123?fields=description",
    );
    expect(buildJiraIssueUpdateUrl(gatewayBase, "OPS/123", { notifyUsers: false })).toBe(
      "https://api.atlassian.com/ex/jira/cloud%201/rest/api/3/issue/OPS%2F123?notifyUsers=false",
    );
    expect(buildJiraAttachmentContentUrl(gatewayBase, "100/01")).toBe(
      "https://api.atlassian.com/ex/jira/cloud%201/rest/api/3/attachment/content/100%2F01",
    );
    expect(buildJiraAttachmentThumbnailUrl(gatewayBase, "100/01")).toBe(
      "https://api.atlassian.com/ex/jira/cloud%201/rest/api/3/attachment/thumbnail/100%2F01",
    );
    expect(buildJiraCurrentUserUrl(gatewayBase)).toBe(
      "https://api.atlassian.com/ex/jira/cloud%201/rest/api/3/myself",
    );
    expect(buildJiraIssueAssigneeUrl(gatewayBase, "OPS/123")).toBe(
      "https://api.atlassian.com/ex/jira/cloud%201/rest/api/3/issue/OPS%2F123/assignee",
    );
  });

  it("addresses a site base URL directly, as a classic API token requires", () => {
    expect(buildJiraCurrentUserUrl(siteBase)).toBe(
      "https://acme.atlassian.net/rest/api/3/myself",
    );
    expect(buildJiraIssueDetailUrl(siteBase, "OPS-123")).toContain(
      "https://acme.atlassian.net/rest/api/3/issue/OPS-123?",
    );
    expect(buildJiraAttachmentContentUrl(`${siteBase}/`, "20001")).toBe(
      "https://acme.atlassian.net/rest/api/3/attachment/content/20001",
    );
  });

  it("builds action URLs from a custom base URL for deterministic tests", () => {
    const baseUrl = "http://127.0.0.1:30129/ex/jira/cloud-1";

    expect(buildJiraIssueTransitionsUrl(baseUrl, "OPS-123")).toBe(
      "http://127.0.0.1:30129/ex/jira/cloud-1/rest/api/3/issue/OPS-123/transitions",
    );
    expect(buildJiraIssueWorklogUrl(baseUrl, "OPS-123")).toBe(
      "http://127.0.0.1:30129/ex/jira/cloud-1/rest/api/3/issue/OPS-123/worklog",
    );
    expect(buildJiraIssueUpdateUrl(baseUrl, "OPS-123", {})).toBe(
      "http://127.0.0.1:30129/ex/jira/cloud-1/rest/api/3/issue/OPS-123",
    );
  });

  it("builds issue-scoped assignable-user searches with encoded query parameters", () => {
    const byQuery = new URL(buildJiraAssignableUserSearchUrl(
      "http://127.0.0.1:30129/ex/jira/cloud%201",
      "OPS/&? 123",
      { query: "Zoë User + A&B/?" },
    ));
    expect(byQuery.pathname).toBe("/ex/jira/cloud%201/rest/api/3/user/assignable/search");
    expect(byQuery.searchParams.get("issueKey")).toBe("OPS/&? 123");
    expect(byQuery.searchParams.get("query")).toBe("Zoë User + A&B/?");
    expect(byQuery.searchParams.get("maxResults")).toBe("1000");

    const byAccount = new URL(buildJiraAssignableUserSearchUrl(
      "http://127.0.0.1:30129/ex/jira/cloud-1",
      "OPS-123",
      { accountId: "acct +/&?" },
    ));
    expect(byAccount.searchParams.get("accountId")).toBe("acct +/&?");
    expect(byAccount.searchParams.get("maxResults")).toBe("1000");
  });

  it("builds the assigned issue search body used by JiraOps", () => {
    expect(buildAssignedIssuesSearchBody(10)).toEqual({
      fields: ["summary", "status", "priority", "assignee", "updated", "issuetype"],
      jql: "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC",
      maxResults: 10,
    });
  });
});
